// ─────────────────────────────────────────────────────────────────────────────
// src/webview/messageRouter.ts — Extracted message routing from MissionControlPanel
//
// Handles all webview → host message dispatching. MissionControlPanel delegates
// to `routeWebviewMessage()` which contains the switch logic and helper methods.
// ─────────────────────────────────────────────────────────────────────────────

import * as vscode from 'vscode';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getSessionDir } from '../constants/paths.js';
import { asTimestamp, type HostToWebviewMessage, type WebviewToHostMessage } from '../types/index.js';
import type { Engine } from '../engine/Engine.js';
import { formatSessionDirName } from '../session/session-utils.js';
import type { SessionManager } from '../session/SessionManager.js';
import type { ADKController } from '../adk/ADKController.js';
import { StateManager } from '../state/StateManager.js';
import { isValidWebviewMessage } from './ipcValidator.js';
import type { CoogentMCPServer } from '../mcp/CoogentMCPServer.js';
import type { MCPClientBridge } from '../mcp/MCPClientBridge.js';
import { RESOURCE_URIS } from '../mcp/types.js';
import log from '../logger/log.js';
import type { AgentRegistry } from '../agent-selection/AgentRegistry.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Types
// ═══════════════════════════════════════════════════════════════════════════════

/** Timeout (ms) for MCP resource fetch calls from the webview. */
const MCP_FETCH_TIMEOUT_MS = 15_000;

/** All dependencies needed by the message router. */
export interface MessageRouterDeps {
    engine: Engine;
    sendToWebview: (message: HostToWebviewMessage) => void;
    isPanelAlive: () => boolean;
    getSkipSandboxBranch: () => boolean;
    setSkipSandboxBranch: (v: boolean) => void;
    sessionManager: SessionManager | undefined;
    adkController: ADKController | undefined;
    preFlightGitCheck: (() => Promise<{ blocked: true; message: string } | { blocked: false }>) | undefined;
    onReset: ((newSessionDir: string, newSessionDirName: string, newStateManager?: StateManager) => void) | undefined;
    mcpServer: CoogentMCPServer | undefined;
    mcpClientBridge: MCPClientBridge | undefined;
    agentRegistry: AgentRegistry | undefined;
    coogentDir: string | undefined;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Message Router
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Route a raw webview message through validation and dispatch.
 * This is the extracted core of `MissionControlPanel.handleMessage()`.
 */
export async function routeWebviewMessage(raw: unknown, deps: MessageRouterDeps): Promise<void> {
    // ── Host-side pass-through: PLAN_SUMMARY → forward to webview ──
    if (
        typeof raw === 'object' && raw !== null &&
        (raw as Record<string, unknown>).type === 'PLAN_SUMMARY'
    ) {
        const msg = raw as { type: 'PLAN_SUMMARY'; payload?: { summary?: unknown } };
        if (typeof msg.payload?.summary !== 'string') {
            log.warn('[MissionControl] PLAN_SUMMARY: invalid payload (missing or non-string summary).');
            return;
        }
        log.info('[MissionControl] Host → Webview (pass-through): PLAN_SUMMARY');
        deps.sendToWebview({
            type: 'PLAN_SUMMARY',
            payload: { summary: msg.payload.summary },
        });
        return;
    }

    // ── Legacy CMD_PAUSE guard ──
    if (typeof raw === 'object' && raw !== null && (raw as Record<string, unknown>).type === 'CMD_PAUSE') {
        log.warn('[MissionControl] Received deprecated CMD_PAUSE (no phaseId). Use CMD_PAUSE_PHASE instead. Ignoring.');
        return;
    }

    if (!isValidWebviewMessage(raw)) {
        log.warn('[MissionControl] Invalid or malformed message:', raw);
        return;
    }

    const message = raw as WebviewToHostMessage;
    log.info(`[MissionControl] Webview → Host: ${message.type} `);

    switch (message.type) {
        case 'CMD_START': {
            if (deps.preFlightGitCheck) {
                const check = await deps.preFlightGitCheck();
                if (check.blocked) {
                    const choice = await vscode.window.showWarningMessage(
                        `Coogent: ${check.message} `,
                        'Continue on Current Branch',
                        'Cancel'
                    );
                    if (choice !== 'Continue on Current Branch') return;
                    deps.setSkipSandboxBranch(true);
                }
            }
            deps.engine.start().catch(err => handleError(err, deps));
            break;
        }

        case 'CMD_ABORT':
            deps.engine.abort().catch(err => handleError(err, deps));
            break;
        case 'CMD_RETRY':
            deps.engine.retry(message.payload.phaseId).catch(err => handleError(err, deps));
            break;
        case 'CMD_SKIP_PHASE':
            deps.engine.skipPhase(message.payload.phaseId).catch(err => handleError(err, deps));
            break;
        case 'CMD_PAUSE_PHASE':
            deps.engine.pausePhase(message.payload.phaseId);
            break;
        case 'CMD_STOP_PHASE':
            deps.engine.stopPhase(message.payload.phaseId).catch(err => handleError(err, deps));
            break;
        case 'CMD_RESTART_PHASE':
            deps.engine.restartPhase(message.payload.phaseId).catch(err => handleError(err, deps));
            break;
        case 'CMD_EDIT_PHASE':
            deps.engine.editPhase(
                message.payload.phaseId,
                message.payload.patch
            ).catch(err => handleError(err, deps));
            break;
        case 'CMD_LOAD_RUNBOOK':
            deps.engine.loadRunbook(message.payload?.filePath).catch(err => handleError(err, deps));
            break;
        case 'CMD_REQUEST_STATE': {
            const runbook = deps.engine.getRunbook();
            const draft = deps.engine.getPlanDraft();
            const state = deps.engine.getState();
            const _masterTaskId = deriveMasterTaskId(deps);
            deps.sendToWebview({
                type: 'STATE_SNAPSHOT',
                payload: {
                    runbook: runbook ?? draft ?? { project_id: '', status: 'idle', current_phase: 0, phases: [] },
                    engineState: state,
                    ...(_masterTaskId ? { masterTaskId: _masterTaskId } : {}),
                },
            });
            break;
        }
        case 'CMD_PLAN_REQUEST': {
            const pendingPrompt = message.payload.prompt;
            log.info('[MissionControl] CMD_PLAN_REQUEST: prompt received, starting pre-flight...');

            if (deps.preFlightGitCheck) {
                try {
                    const check = await deps.preFlightGitCheck();
                    log.info(`[MissionControl] CMD_PLAN_REQUEST: pre-flight result — blocked=${check.blocked}`);
                    if (check.blocked) {
                        const choice = await vscode.window.showWarningMessage(
                            `Coogent: ${check.message} `,
                            'Continue on Current Branch',
                            'Cancel'
                        );
                        if (choice !== 'Continue on Current Branch') {
                            deps.sendToWebview({
                                type: 'RESTORE_PROMPT',
                                payload: { prompt: pendingPrompt },
                            });
                            // Keep existing LAST_PROMPT log for backward compatibility
                            deps.sendToWebview({
                                type: 'LOG_ENTRY',
                                payload: {
                                    timestamp: asTimestamp(),
                                    level: 'warn',
                                    message: `[LAST_PROMPT] ${pendingPrompt}`,
                                },
                            });
                            return;
                        }
                        deps.setSkipSandboxBranch(true);
                    }
                } catch (err) {
                    log.warn('[MissionControl] CMD_PLAN_REQUEST: pre-flight check threw — skipping:', err);
                }
            }
            log.info('[MissionControl] CMD_PLAN_REQUEST: invoking engine.planRequest()');
            deps.engine.planRequest(pendingPrompt);
            break;
        }
        case 'CMD_PLAN_APPROVE':
            deps.engine.planApproved().catch(err => handleError(err, deps));
            break;
        case 'CMD_PLAN_REJECT':
            deps.engine.planRejected(message.payload.feedback);
            break;
        case 'CMD_PLAN_EDIT_DRAFT':
            deps.engine.updatePlanDraft(message.payload.draft);
            break;
        case 'CMD_PLAN_RETRY_PARSE':
            deps.engine.planRetryParse();
            break;
        case 'CMD_RESET': {
            deps.setSkipSandboxBranch(false);
            const newSessionId = randomUUID();
            const newSessionDirName = formatSessionDirName(newSessionId);

            if (deps.mcpServer) {
                deps.mcpServer.upsertSession(newSessionDirName, newSessionId, '', Date.now());
                log.info(`[MissionControl] CMD_RESET: registered new session ${newSessionDirName} in sessions table`);
            }

            if (!deps.coogentDir) {
                deps.engine.reset().catch(err => handleError(err, deps));
                break;
            }
            {
                const newSessionDir = getSessionDir(deps.coogentDir, newSessionDirName);
                const oldTaskId = deps.engine.getSessionDirName();

                if (oldTaskId && deps.mcpServer) {
                    const runbook = deps.engine.getRunbook();
                    if (runbook) {
                        try {
                            deps.mcpServer.getArtifactDB()?.tasks.upsert(oldTaskId, {
                                runbookJson: JSON.stringify(runbook),
                                completedAt: Date.now(),
                            });
                            log.info(`[MissionControl] CMD_RESET: persisted outgoing session runbook for ${oldTaskId}`);
                        } catch (err) {
                            log.warn('[MissionControl] CMD_RESET: failed to persist outgoing session:', err);
                        }
                    }

                    try {
                        const db = deps.mcpServer.getArtifactDB();
                        if (db) {
                            const existingRows = db.sessions.list();
                            const match = existingRows.find(r => r.sessionDirName === oldTaskId);
                            if (!match) {
                                deps.mcpServer.upsertSession(oldTaskId, oldTaskId, '', Date.now());
                                log.info(`[MissionControl] CMD_RESET: created missing sessions row for outgoing session ${oldTaskId}`);
                            }
                        }
                    } catch (err) {
                        log.warn('[MissionControl] CMD_RESET: failed to ensure outgoing session row:', err);
                    }
                }

                if (oldTaskId) {
                    deps.mcpServer?.purgeTaskKeepSession(oldTaskId);
                }
                const freshStateManager = new StateManager(newSessionDir);
                deps.engine.reset(freshStateManager).catch(err => handleError(err, deps));
                deps.onReset?.(newSessionDir, newSessionDirName, freshStateManager);
            }
            break;
        }
        case 'CMD_SET_CONVERSATION_MODE':
            handleSetConversationMode(message.payload.mode, deps);
            break;
        case 'CMD_REQUEST_REPORT':
            handleRequestReport(deps);
            break;
        case 'CMD_REQUEST_PLAN':
            handleRequestPlan(deps);
            break;
        case 'CMD_REVIEW_DIFF':
            deps.engine.reviewDiff(message.payload.phaseId).catch(err => handleError(err, deps));
            break;
        case 'CMD_RESUME_PENDING':
            deps.engine.resumePending().catch(err => handleError(err, deps));
            break;
        case 'MCP_FETCH_RESOURCE':
            handleMCPFetchResource(message.payload.uri, message.payload.requestId, deps);
            break;
        case 'CMD_UPLOAD_FILE':
            handleUploadFile(false, deps);
            break;
        case 'CMD_UPLOAD_IMAGE':
            handleUploadFile(true, deps);
            break;

        // ── Session management (webview-initiated) ─────────────────────────────
        case 'CMD_LIST_SESSIONS': {
            if (!deps.sessionManager) break;
            const sessions = await deps.sessionManager.listSessions();
            deps.sendToWebview({ type: 'SESSION_LIST', payload: { sessions } });
            break;
        }
        case 'CMD_SEARCH_SESSIONS': {
            if (!deps.sessionManager) break;
            const results = await deps.sessionManager.searchSessions(message.payload.query);
            deps.sendToWebview({
                type: 'SESSION_SEARCH_RESULTS',
                payload: { query: message.payload.query, sessions: results },
            });
            break;
        }
        case 'CMD_LOAD_SESSION': {
            await vscode.commands.executeCommand('coogent.loadSession', message.payload.sessionId);
            break;
        }
        case 'CMD_DELETE_SESSION': {
            await vscode.commands.executeCommand(
                'coogent.deleteSession',
                { session: { sessionId: message.payload.sessionId } }
            );
            break;
        }

        // ── Worker Studio (webview-initiated) ─────────────────────────────
        case 'workers:request': {
            if (!deps.agentRegistry) {
                deps.sendToWebview({ type: 'workers:loaded', workers: [] });
                break;
            }
            try {
                const workers = await deps.agentRegistry.getAgents();
                deps.sendToWebview({ type: 'workers:loaded', workers });
            } catch (err) {
                log.error('[MissionControl] workers:request failed:', err);
                deps.sendToWebview({ type: 'workers:loaded', workers: [] });
            }
            break;
        }

        default: {
            const _exhaustive: never = message;
            log.warn('[MissionControl] Unknown message:', _exhaustive);
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Handler Helpers
// ═══════════════════════════════════════════════════════════════════════════════

/** Derive the masterTaskId from the Engine's active session directory. */
export function deriveMasterTaskId(deps: MessageRouterDeps): string | undefined {
    return deps.engine.getSessionDirName();
}

/** Forward async errors to the webview as ERROR messages. */
function handleError(err: unknown, deps: MessageRouterDeps): void {
    const message = err instanceof Error ? err.message : String(err);
    log.error('[MissionControl] Error:', message);
    deps.sendToWebview({
        type: 'ERROR',
        payload: {
            code: 'COMMAND_ERROR',
            message,
        },
    });
}

function handleSetConversationMode(mode: 'isolated' | 'continuous' | 'smart', deps: MessageRouterDeps): void {
    if (!deps.adkController) return;
    deps.adkController.setConversationSettings({ mode });
    const settings = deps.adkController.conversationSettings;
    deps.sendToWebview({
        type: 'CONVERSATION_MODE',
        payload: {
            mode: settings.mode,
            smartSwitchTokenThreshold: settings.smartSwitchTokenThreshold,
        },
    });
}

async function handleUploadFile(imageOnly: boolean, deps: MessageRouterDeps): Promise<void> {
    const filters = imageOnly
        ? { Images: ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp'] }
        : undefined;

    const uris = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: true,
        openLabel: imageOnly ? 'Attach Image' : 'Attach File',
        ...(filters ? { filters } : {}),
    });

    if (!uris || uris.length === 0) return;

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const paths = uris.map(uri => {
        if (workspaceRoot && uri.fsPath.startsWith(workspaceRoot)) {
            return path.relative(workspaceRoot, uri.fsPath);
        }
        return uri.fsPath;
    });

    deps.sendToWebview({
        type: 'ATTACHMENT_SELECTED',
        payload: { paths },
    });
}

/** Broadcast context-aware suggestion data for @ mention and / workflow popups. */
export function broadcastSuggestionData(deps: MessageRouterDeps): void {
    const runbook = deps.engine.getRunbook() ?? deps.engine.getPlanDraft();
    const mentions: { label: string; description: string; insert: string }[] = [
        { label: '@file', description: 'Reference a file', insert: '@file ' },
        { label: '@context', description: 'Attach context', insert: '@context ' },
    ];

    if (runbook?.phases) {
        for (const phase of runbook.phases) {
            mentions.push({
                label: `@phase-${phase.id} `,
                description: phase.context_summary ?? phase.prompt.slice(0, 40),
                insert: `@phase-${phase.id} `,
            });
        }
    }

    const workflows = [
        { label: '/plan', description: 'Generate a plan', insert: '/plan ' },
        { label: '/run', description: 'Execute the runbook', insert: '/run ' },
        { label: '/history', description: 'Show session history', insert: '/history ' },
        { label: '/abort', description: 'Abort execution', insert: '/abort ' },
        { label: '/reset', description: 'Start new chat', insert: '/reset ' },
    ];

    deps.sendToWebview({
        type: 'SUGGESTION_DATA',
        payload: { mentions, workflows },
    });
}

function handleMCPFetchResource(uri: string, requestId: string, deps: MessageRouterDeps): void {
    log.info(`[MissionControl] MCP_FETCH_RESOURCE: uri = ${uri}, requestId = ${requestId} `);

    if (!deps.mcpClientBridge) {
        deps.sendToWebview({
            type: 'MCP_RESOURCE_DATA',
            payload: { requestId, data: '', error: 'MCP Client Bridge not available.' },
        });
        return;
    }

    const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`MCP_FETCH_RESOURCE timed out after ${MCP_FETCH_TIMEOUT_MS / 1_000} s`)), MCP_FETCH_TIMEOUT_MS)
    );

    Promise.race([deps.mcpClientBridge.readResource(uri), timeoutPromise])
        .then(content => {
            if (!deps.isPanelAlive()) return;
            let data: string | object = content;
            try { data = JSON.parse(content); } catch { /* leave as string */ }
            deps.sendToWebview({
                type: 'MCP_RESOURCE_DATA',
                payload: { requestId, data },
            });
        })
        .catch(err => {
            if (!deps.isPanelAlive()) return;
            const message = err instanceof Error ? err.message : String(err);
            log.error('[MissionControl] MCP_FETCH_RESOURCE error:', message);
            deps.sendToWebview({
                type: 'MCP_RESOURCE_DATA',
                payload: { requestId, data: '', error: message },
            });
        });
}

/**
 * Read a resource via MCPClientBridge, or fallback to direct state map access.
 * Returns `null` and sends an ERROR if no content is available.
 */
async function readMCPResourceOrError(
    uri: string,
    notFoundMsg: string,
    deps: MessageRouterDeps,
    directFallback?: () => string | undefined
): Promise<string | null> {
    if (deps.mcpClientBridge) {
        try {
            const content = await deps.mcpClientBridge.readResource(uri);
            if (content) return content;
            deps.sendToWebview({
                type: 'ERROR',
                payload: { code: 'COMMAND_ERROR', message: notFoundMsg },
            });
            return null;
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            if (errMsg.includes('Resource not yet available')) {
                log.info(`[MissionControl] readMCPResourceOrError: resource pending (${uri})`);
                deps.sendToWebview({
                    type: 'PLAN_STATUS',
                    payload: { status: 'generating', message: 'Implementation plan is being generated…' },
                });
                return null;
            }
            handleError(err, deps);
            return null;
        }
    }

    if (!deps.mcpServer) {
        deps.sendToWebview({
            type: 'ERROR',
            payload: { code: 'COMMAND_ERROR', message: 'MCP server not available.' },
        });
        return null;
    }
    const content = directFallback?.();
    if (content) return content;
    deps.sendToWebview({
        type: 'ERROR',
        payload: { code: 'COMMAND_ERROR', message: notFoundMsg },
    });
    return null;
}

function handleRequestReport(deps: MessageRouterDeps): void {
    const masterTaskId = deriveMasterTaskId(deps);
    if (!masterTaskId) {
        deps.sendToWebview({
            type: 'ERROR',
            payload: { code: 'COMMAND_ERROR', message: 'No active session.' },
        });
        return;
    }

    readMCPResourceOrError(
        RESOURCE_URIS.taskReport(masterTaskId),
        'No consolidation report available for this session.',
        deps,
        () => deps.mcpServer?.getTaskState(masterTaskId)?.consolidationReport
    ).then(report => {
        if (report) {
            deps.sendToWebview({ type: 'CONSOLIDATION_REPORT', payload: { report } });
        }
    }).catch(err => handleError(err, deps));
}

function handleRequestPlan(deps: MessageRouterDeps): void {
    const masterTaskId = deriveMasterTaskId(deps);
    if (!masterTaskId) {
        deps.sendToWebview({
            type: 'ERROR',
            payload: { code: 'COMMAND_ERROR', message: 'No active session. Cannot load implementation plan.' },
        });
        return;
    }

    readMCPResourceOrError(
        RESOURCE_URIS.taskPlan(masterTaskId),
        'No implementation plan available for this session.',
        deps,
        () =>
            deps.mcpServer?.getTaskState(masterTaskId)?.executionPlan
            ?? deps.engine.getRunbook()?.execution_plan
    ).then(plan => {
        if (plan) {
            log.info(`[MissionControl] handleRequestPlan: plan loaded (${plan.length} chars)`);
            deps.sendToWebview({ type: 'EXECUTION_PLAN', payload: { plan } });
        }
    }).catch(err => handleError(err, deps));
}
