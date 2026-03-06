// ─────────────────────────────────────────────────────────────────────────────
// src/webview/MissionControlViewProvider.ts — Activity Bar sidebar provider
// ─────────────────────────────────────────────────────────────────────────────

import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import type { HostToWebviewMessage, WebviewToHostMessage } from '../types/index.js';
import type { Engine } from '../engine/Engine.js';
import type { SessionManager } from '../session/SessionManager.js';
import { formatSessionDirName } from '../session/SessionManager.js';
import type { ADKController } from '../adk/ADKController.js';
import { StateManager } from '../state/StateManager.js';
import { isValidWebviewMessage } from './ipcValidator.js';
import type { CoogentMCPServer } from '../mcp/CoogentMCPServer.js';
import type { MCPClientBridge } from '../mcp/MCPClientBridge.js';
import { RESOURCE_URIS } from '../mcp/types.js';
import { getWebviewHtml } from './webviewHtml.js';
import log from '../logger/log.js';
import * as path from 'node:path';

/** Signature for the injected pre-flight Git check function. */
type PreFlightGitCheckFn = () => Promise<{ blocked: true; message: string } | { blocked: false }>;

/** Callback invoked when CMD_RESET creates a new session. */
type OnResetFn = (newSessionDir: string, newSessionDirName: string) => void;

/**
 * WebviewViewProvider for the Coogent Activity Bar sidebar panel.
 *
 * Renders the same Svelte "Mission Control" app as the editor-tab panel
 * but inside the sidebar. Both can be open simultaneously — broadcasts
 * are sent to whichever is active.
 */
export class MissionControlViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'coogent.missionControlView';

    private static currentView: vscode.WebviewView | undefined;
    private disposables: vscode.Disposable[] = [];

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly engine: Engine,
        private readonly sessionManager?: SessionManager,
        private readonly adkController?: ADKController,
        private readonly preFlightGitCheck?: PreFlightGitCheckFn,
        private readonly onReset?: OnResetFn,
        private readonly mcpServer?: CoogentMCPServer,
        private readonly mcpClientBridge?: MCPClientBridge
    ) { }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Static API
    // ═══════════════════════════════════════════════════════════════════════════

    /** Broadcast a message to the active sidebar view (no-op if none open). */
    public static broadcast(message: HostToWebviewMessage): void {
        MissionControlViewProvider.currentView?.webview.postMessage(message);
    }

    /** Whether the user opted to skip sandbox branch creation. */
    public static shouldSkipSandbox(): boolean {
        return false; // Sidebar doesn't drive sandbox skip — Panel does
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  WebviewViewProvider implementation
    // ═══════════════════════════════════════════════════════════════════════════

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        MissionControlViewProvider.currentView = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'webview-ui', 'dist')],
        };

        webviewView.webview.html = getWebviewHtml(webviewView.webview, this.extensionUri);

        webviewView.webview.onDidReceiveMessage(
            (message: unknown) => this.handleMessage(message, webviewView.webview),
            null,
            this.disposables
        );

        webviewView.onDidDispose(() => {
            MissionControlViewProvider.currentView = undefined;
            for (const d of this.disposables) d.dispose();
            this.disposables = [];
        }, null, this.disposables);

        // Re-send state snapshot when sidebar becomes visible
        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this.sendStateSnapshot(webviewView.webview);
            }
        }, null, this.disposables);

        // Broadcast initial conversation mode
        if (this.adkController) {
            const settings = this.adkController.conversationSettings;
            webviewView.webview.postMessage({
                type: 'CONVERSATION_MODE',
                payload: {
                    mode: settings.mode,
                    smartSwitchTokenThreshold: settings.smartSwitchTokenThreshold,
                },
            });
        }

        // Send initial state snapshot
        this.sendStateSnapshot(webviewView.webview);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Message Handling
    // ═══════════════════════════════════════════════════════════════════════════

    private async handleMessage(raw: unknown, webview: vscode.Webview): Promise<void> {
        // Host-side pass-through: PLAN_SUMMARY → forward to webview
        if (
            typeof raw === 'object' && raw !== null &&
            (raw as Record<string, unknown>).type === 'PLAN_SUMMARY'
        ) {
            const msg = raw as { type: 'PLAN_SUMMARY'; payload?: { summary?: unknown } };
            if (typeof msg.payload?.summary !== 'string') {
                log.warn('[MissionControlView] PLAN_SUMMARY: invalid payload.');
                return;
            }
            webview.postMessage({
                type: 'PLAN_SUMMARY',
                payload: { summary: msg.payload.summary },
            });
            return;
        }

        if (!isValidWebviewMessage(raw)) {
            log.warn('[MissionControlView] Invalid message:', raw);
            return;
        }

        const message = raw as WebviewToHostMessage;
        log.info(`[MissionControlView] Webview → Host: ${message.type}`);

        switch (message.type) {
            case 'CMD_START': {
                if (this.preFlightGitCheck) {
                    const check = await this.preFlightGitCheck();
                    if (check.blocked) {
                        const choice = await vscode.window.showWarningMessage(
                            `Coogent: ${check.message}`,
                            'Continue on Current Branch',
                            'Cancel'
                        );
                        if (choice !== 'Continue on Current Branch') return;
                    }
                }
                this.engine.start().catch(err => this.handleError(err, webview));
                break;
            }
            case 'CMD_PAUSE':
                this.engine.pause();
                break;
            case 'CMD_ABORT':
                this.engine.abort().catch(err => this.handleError(err, webview));
                break;
            case 'CMD_RETRY':
                this.engine.retry(message.payload.phaseId).catch(err => this.handleError(err, webview));
                break;
            case 'CMD_SKIP_PHASE':
                this.engine.skipPhase(message.payload.phaseId).catch(err => this.handleError(err, webview));
                break;
            case 'CMD_PAUSE_PHASE':
                this.engine.pausePhase(message.payload.phaseId);
                break;
            case 'CMD_STOP_PHASE':
                this.engine.stopPhase(message.payload.phaseId).catch(err => this.handleError(err, webview));
                break;
            case 'CMD_RESTART_PHASE':
                this.engine.restartPhase(message.payload.phaseId).catch(err => this.handleError(err, webview));
                break;
            case 'CMD_EDIT_PHASE':
                this.engine.editPhase(message.payload.phaseId, message.payload.patch)
                    .catch(err => this.handleError(err, webview));
                break;
            case 'CMD_LOAD_RUNBOOK':
                this.engine.loadRunbook(message.payload?.filePath).catch(err => this.handleError(err, webview));
                break;
            case 'CMD_REQUEST_STATE':
                this.sendStateSnapshot(webview);
                break;
            case 'CMD_PLAN_REQUEST': {
                if (this.preFlightGitCheck) {
                    const check = await this.preFlightGitCheck();
                    if (check.blocked) {
                        const choice = await vscode.window.showWarningMessage(
                            `Coogent: ${check.message}`,
                            'Continue on Current Branch',
                            'Cancel'
                        );
                        if (choice !== 'Continue on Current Branch') return;
                    }
                }
                this.engine.planRequest(message.payload.prompt);
                break;
            }
            case 'CMD_PLAN_APPROVE':
                this.engine.planApproved().catch(err => this.handleError(err, webview));
                break;
            case 'CMD_PLAN_REJECT':
                this.engine.planRejected(message.payload.feedback);
                break;
            case 'CMD_PLAN_EDIT_DRAFT':
                this.engine.updatePlanDraft(message.payload.draft);
                break;
            case 'CMD_PLAN_RETRY_PARSE':
                this.engine.planRetryParse();
                break;
            case 'CMD_RESET': {
                const newSessionId = randomUUID();
                const newSessionDirName = formatSessionDirName(newSessionId);
                const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                if (workspaceRoot) {
                    const newSessionDir = path.join(workspaceRoot, '.coogent', 'ipc', newSessionDirName);
                    const freshStateManager = new StateManager(newSessionDir);
                    this.engine.reset(freshStateManager).catch(err => this.handleError(err, webview));
                    this.sessionManager?.setCurrentSessionId(newSessionId);
                    this.onReset?.(newSessionDir, newSessionDirName);
                } else {
                    this.engine.reset().catch(err => this.handleError(err, webview));
                }
                break;
            }
            case 'CMD_LIST_SESSIONS':
                this.handleListSessions(webview);
                break;
            case 'CMD_SEARCH_SESSIONS':
                this.handleSearchSessions(message.payload.query, webview);
                break;
            case 'CMD_LOAD_SESSION':
                this.handleLoadSession(message.payload.sessionId, webview);
                break;
            case 'CMD_SET_CONVERSATION_MODE':
                this.handleSetConversationMode(message.payload.mode, webview);
                break;
            case 'CMD_REQUEST_REPORT':
                this.handleRequestReport(webview);
                break;
            case 'CMD_DELETE_SESSION':
                this.handleDeleteSession(message.payload.sessionId, webview);
                break;
            case 'CMD_REQUEST_PLAN':
                this.handleRequestPlan(webview);
                break;
            case 'CMD_REVIEW_DIFF':
                this.engine.reviewDiff(message.payload.phaseId).catch(err => this.handleError(err, webview));
                break;
            case 'CMD_RESUME_PENDING':
                this.engine.resumePending().catch(err => this.handleError(err, webview));
                break;
            case 'MCP_FETCH_RESOURCE':
                this.handleMCPFetchResource(message.payload.uri, message.payload.requestId, webview);
                break;
            default: {
                const _exhaustive: never = message;
                log.warn('[MissionControlView] Unknown message:', _exhaustive);
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Helpers
    // ═══════════════════════════════════════════════════════════════════════════

    private sendStateSnapshot(webview: vscode.Webview): void {
        const runbook = this.engine.getRunbook();
        const draft = this.engine.getPlanDraft();
        const state = this.engine.getState();
        const masterTaskId = this.engine.getSessionDirName();
        webview.postMessage({
            type: 'STATE_SNAPSHOT',
            payload: {
                runbook: runbook ?? draft ?? { project_id: '', status: 'idle', current_phase: 0, phases: [] },
                engineState: state,
                ...(masterTaskId ? { masterTaskId } : {}),
            },
        });
    }

    private handleError(err: unknown, webview: vscode.Webview): void {
        const message = err instanceof Error ? err.message : String(err);
        log.error('[MissionControlView] Error:', message);
        webview.postMessage({
            type: 'ERROR',
            payload: { code: 'COMMAND_ERROR', message },
        });
    }

    private handleListSessions(webview: vscode.Webview): void {
        if (!this.sessionManager) return;
        this.sessionManager.listSessions().then(sessions => {
            webview.postMessage({ type: 'SESSION_LIST', payload: { sessions } });
        }).catch(log.onError);
    }

    private handleSearchSessions(query: string, webview: vscode.Webview): void {
        if (!this.sessionManager) return;
        this.sessionManager.searchSessions(query).then(sessions => {
            webview.postMessage({ type: 'SESSION_SEARCH_RESULTS', payload: { query, sessions } });
        }).catch(log.onError);
    }

    private handleLoadSession(sessionId: string, webview: vscode.Webview): void {
        if (!this.sessionManager) return;
        const sessionDir = this.sessionManager.getSessionDir(sessionId);
        const newStateManager = new StateManager(sessionDir);
        this.engine.switchSession(newStateManager).catch(err => this.handleError(err, webview));
    }

    private handleSetConversationMode(mode: 'isolated' | 'continuous' | 'smart', webview: vscode.Webview): void {
        if (!this.adkController) return;
        this.adkController.setConversationSettings({ mode });
        const settings = this.adkController.conversationSettings;
        webview.postMessage({
            type: 'CONVERSATION_MODE',
            payload: {
                mode: settings.mode,
                smartSwitchTokenThreshold: settings.smartSwitchTokenThreshold,
            },
        });
    }

    private handleRequestReport(webview: vscode.Webview): void {
        const masterTaskId = this.engine.getSessionDirName();
        if (!masterTaskId) {
            webview.postMessage({
                type: 'ERROR',
                payload: { code: 'COMMAND_ERROR', message: 'No active session.' },
            });
            return;
        }

        if (this.mcpClientBridge) {
            this.mcpClientBridge.readResource(RESOURCE_URIS.taskReport(masterTaskId))
                .then(content => {
                    if (content) {
                        webview.postMessage({ type: 'CONSOLIDATION_REPORT', payload: { report: content } });
                    } else {
                        webview.postMessage({
                            type: 'ERROR',
                            payload: { code: 'COMMAND_ERROR', message: 'No consolidation report available for this session.' },
                        });
                    }
                })
                .catch(err => this.handleError(err, webview));
            return;
        }

        if (!this.mcpServer) {
            webview.postMessage({
                type: 'ERROR',
                payload: { code: 'COMMAND_ERROR', message: 'MCP server not available.' },
            });
            return;
        }
        const task = this.mcpServer.getTaskState(masterTaskId);
        const report = task?.consolidationReport;
        if (report) {
            webview.postMessage({ type: 'CONSOLIDATION_REPORT', payload: { report } });
        } else {
            webview.postMessage({
                type: 'ERROR',
                payload: { code: 'COMMAND_ERROR', message: 'No consolidation report available for this session.' },
            });
        }
    }

    private handleDeleteSession(sessionId: string, webview: vscode.Webview): void {
        if (!this.sessionManager) return;
        this.sessionManager.deleteSession(sessionId)
            .then(() => this.handleListSessions(webview))
            .catch(err => this.handleError(err, webview));
    }

    private handleRequestPlan(webview: vscode.Webview): void {
        const masterTaskId = this.engine.getSessionDirName();
        if (!masterTaskId) {
            webview.postMessage({
                type: 'ERROR',
                payload: { code: 'COMMAND_ERROR', message: 'No active session. Cannot load implementation plan.' },
            });
            return;
        }

        if (this.mcpClientBridge) {
            this.mcpClientBridge.readResource(RESOURCE_URIS.taskPlan(masterTaskId))
                .then(content => {
                    if (content) {
                        webview.postMessage({ type: 'IMPLEMENTATION_PLAN', payload: { plan: content } });
                    } else {
                        webview.postMessage({
                            type: 'ERROR',
                            payload: { code: 'COMMAND_ERROR', message: 'No implementation plan available for this session.' },
                        });
                    }
                })
                .catch(err => this.handleError(err, webview));
            return;
        }

        if (!this.mcpServer) {
            webview.postMessage({
                type: 'ERROR',
                payload: { code: 'COMMAND_ERROR', message: 'MCP server not available.' },
            });
            return;
        }
        const task = this.mcpServer.getTaskState(masterTaskId);
        const plan = task?.implementationPlan;
        if (plan) {
            webview.postMessage({ type: 'IMPLEMENTATION_PLAN', payload: { plan } });
        } else {
            webview.postMessage({
                type: 'ERROR',
                payload: { code: 'COMMAND_ERROR', message: 'No implementation plan available for this session.' },
            });
        }
    }

    private handleMCPFetchResource(uri: string, requestId: string, webview: vscode.Webview): void {
        log.info(`[MissionControlView] MCP_FETCH_RESOURCE: uri=${uri}, requestId=${requestId}`);

        if (!this.mcpClientBridge) {
            webview.postMessage({
                type: 'MCP_RESOURCE_DATA',
                payload: { requestId, data: '', error: 'MCP Client Bridge not available.' },
            });
            return;
        }

        this.mcpClientBridge.readResource(uri)
            .then(content => {
                let data: string | object = content;
                try { data = JSON.parse(content); } catch { /* leave as string */ }
                webview.postMessage({
                    type: 'MCP_RESOURCE_DATA',
                    payload: { requestId, data },
                });
            })
            .catch(err => {
                const message = err instanceof Error ? err.message : String(err);
                log.error('[MissionControlView] MCP_FETCH_RESOURCE error:', message);
                webview.postMessage({
                    type: 'MCP_RESOURCE_DATA',
                    payload: { requestId, data: '', error: message },
                });
            });
    }
}
