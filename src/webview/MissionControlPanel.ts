// ─────────────────────────────────────────────────────────────────────────────
// src/webview/MissionControlPanel.ts — Webview panel lifecycle and UI rendering
// ─────────────────────────────────────────────────────────────────────────────

import * as vscode from 'vscode';
import * as path from 'node:path';
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

/** Signature for the injected pre-flight Git check function. */
type PreFlightGitCheckFn = () => Promise<{ blocked: true; message: string } | { blocked: false }>;

/** Callback invoked when CMD_RESET creates a new session. */
type OnResetFn = (newSessionDir: string, newSessionDirName: string) => void;

/**
 * Manages the Mission Control Webview panel.
 *
 * The Webview is a **pure projection** — it renders state received from
 * the Extension Host and sends user commands back via postMessage.
 */
export class MissionControlPanel {
  public static readonly viewType = 'coogent.missionControl';
  private static currentPanel: MissionControlPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  /**
   * When the user chooses "Continue on Current Branch" on a dirty tree,
   * this flag is set so the auto-branch-creation logic in extension.ts
   * skips creating a sandbox branch.
   */
  private _skipSandboxBranch = false;

  /** Whether the user opted to skip sandbox branch creation for this session. */
  public static shouldSkipSandbox(): boolean {
    return MissionControlPanel.currentPanel?._skipSandboxBranch ?? false;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Static API
  // ═══════════════════════════════════════════════════════════════════════════

  /** Broadcast a message to the active panel (no-op if none open). */
  public static broadcast(message: HostToWebviewMessage): void {
    MissionControlPanel.currentPanel?.sendToWebview(message);
  }

  /** Create or reveal the Mission Control panel. */
  public static createOrShow(
    extensionUri: vscode.Uri,
    engine: Engine,
    sessionManager?: SessionManager,
    adkController?: ADKController,
    preFlightGitCheck?: PreFlightGitCheckFn,
    onReset?: OnResetFn,
    mcpServer?: CoogentMCPServer,
    mcpClientBridge?: MCPClientBridge
  ): void {
    const column = vscode.window.activeTextEditor?.viewColumn;

    if (MissionControlPanel.currentPanel) {
      MissionControlPanel.currentPanel.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      MissionControlPanel.viewType,
      'Coogent: Mission Control',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'webview-ui', 'dist')],
      }
    );

    MissionControlPanel.currentPanel = new MissionControlPanel(
      panel,
      extensionUri,
      engine,
      sessionManager,
      adkController,
      preFlightGitCheck,
      onReset,
      mcpServer,
      mcpClientBridge
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Instance
  // ═══════════════════════════════════════════════════════════════════════════

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly engine: Engine,
    private readonly sessionManager?: SessionManager,
    private readonly adkController?: ADKController,
    private readonly preFlightGitCheck?: PreFlightGitCheckFn,
    private readonly onReset?: OnResetFn,
    private readonly mcpServer?: CoogentMCPServer,
    private readonly mcpClientBridge?: MCPClientBridge
  ) {
    this.panel = panel;
    this.panel.webview.html = this.getHtmlForWebview();

    this.panel.webview.onDidReceiveMessage(
      (message: unknown) => this.handleMessage(message),
      null,
      this.disposables
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    // #54: Re-send state snapshot when panel becomes visible again
    this.panel.onDidChangeViewState(
      (e) => {
        if (e.webviewPanel.visible) {
          const runbook = this.engine.getRunbook();
          const draft = this.engine.getPlanDraft();
          const state = this.engine.getState();
          const _masterTaskId = this.deriveMasterTaskId();
          this.sendToWebview({
            type: 'STATE_SNAPSHOT',
            payload: {
              runbook: runbook ?? draft ?? { project_id: '', status: 'idle', current_phase: 0, phases: [] },
              engineState: state,
              ...(_masterTaskId ? { masterTaskId: _masterTaskId } : {}),
            },
          });
        }
      },
      null,
      this.disposables
    );

    // Broadcast initial conversation mode
    if (this.adkController) {
      const settings = this.adkController.conversationSettings;
      this.sendToWebview({
        type: 'CONVERSATION_MODE',
        payload: {
          mode: settings.mode,
          smartSwitchTokenThreshold: settings.smartSwitchTokenThreshold,
        },
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Message Handling
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Validate and handle incoming messages from the Webview.
   * Runtime validation prevents malformed payloads from crashing the host.
   * See 02-review.md § P1-3.
   */
  private async handleMessage(raw: unknown): Promise<void> {
    // ── Host-side pass-through: PLAN_SUMMARY → forward to webview ──
    if (
      typeof raw === 'object' && raw !== null &&
      (raw as Record<string, unknown>).type === 'PLAN_SUMMARY'
    ) {
      const msg = raw as { type: 'PLAN_SUMMARY'; payload?: { summary?: unknown } };
      // W-5 fix: Validate payload before forwarding to prevent null dereference in Svelte
      if (typeof msg.payload?.summary !== 'string') {
        log.warn('[MissionControl] PLAN_SUMMARY: invalid payload (missing or non-string summary).');
        return;
      }
      log.info('[MissionControl] Host → Webview (pass-through): PLAN_SUMMARY');
      this.sendToWebview({
        type: 'PLAN_SUMMARY',
        payload: { summary: msg.payload.summary },
      });
      return;
    }

    if (!isValidWebviewMessage(raw)) {
      log.warn('[MissionControl] Invalid or malformed message:', raw);
      return;
    }

    const message = raw as WebviewToHostMessage;
    log.info(`[MissionControl] Webview → Host: ${message.type}`);

    switch (message.type) {
      case 'CMD_START': {
        // Git pre-flight: offer bypass instead of hard-blocking
        if (this.preFlightGitCheck) {
          const check = await this.preFlightGitCheck();
          if (check.blocked) {
            const choice = await vscode.window.showWarningMessage(
              `Coogent: ${check.message}`,
              'Continue on Current Branch',
              'Cancel'
            );
            if (choice !== 'Continue on Current Branch') return;
            this._skipSandboxBranch = true;
          }
        }
        this.engine.start().catch(err => this.handleError(err));
        break;
      }
      case 'CMD_PAUSE':
        this.engine.pause();
        break;
      case 'CMD_ABORT':
        this.engine.abort().catch(err => this.handleError(err));
        break;
      case 'CMD_RETRY':
        this.engine.retry(message.payload.phaseId).catch(err => this.handleError(err));
        break;
      case 'CMD_SKIP_PHASE':
        this.engine.skipPhase(message.payload.phaseId).catch(err => this.handleError(err));
        break;
      case 'CMD_PAUSE_PHASE':
        this.engine.pausePhase(message.payload.phaseId);
        break;
      case 'CMD_STOP_PHASE':
        this.engine.stopPhase(message.payload.phaseId).catch(err => this.handleError(err));
        break;
      case 'CMD_RESTART_PHASE':
        this.engine.restartPhase(message.payload.phaseId).catch(err => this.handleError(err));
        break;
      case 'CMD_EDIT_PHASE':
        this.engine.editPhase(
          message.payload.phaseId,
          message.payload.patch
        ).catch(err => this.handleError(err));
        break;
      case 'CMD_LOAD_RUNBOOK':
        this.engine.loadRunbook(message.payload?.filePath).catch(err => this.handleError(err));
        break;
      case 'CMD_REQUEST_STATE': {
        const runbook = this.engine.getRunbook();
        const draft = this.engine.getPlanDraft();
        const state = this.engine.getState();
        const _masterTaskId = this.deriveMasterTaskId();
        this.sendToWebview({
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
        // Git pre-flight: offer bypass instead of hard-blocking
        if (this.preFlightGitCheck) {
          const check = await this.preFlightGitCheck();
          if (check.blocked) {
            const choice = await vscode.window.showWarningMessage(
              `Coogent: ${check.message}`,
              'Continue on Current Branch',
              'Cancel'
            );
            if (choice !== 'Continue on Current Branch') return;
            this._skipSandboxBranch = true;
          }
        }
        this.engine.planRequest(message.payload.prompt);
        break;
      }
      case 'CMD_PLAN_APPROVE':
        this.engine.planApproved().catch(err => this.handleError(err));
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
        // Reset the skip flag for the new session
        this._skipSandboxBranch = false;
        // Create a fresh session so loadRunbook() won't reload the old data
        const newSessionId = randomUUID();
        const newSessionDirName = formatSessionDirName(newSessionId);
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (workspaceRoot) {
          const newSessionDir = path.join(
            workspaceRoot, '.coogent', 'ipc', newSessionDirName
          );
          const freshStateManager = new StateManager(newSessionDir);
          this.engine.reset(freshStateManager).catch(err => this.handleError(err));
          this.sessionManager?.setCurrentSessionId(newSessionId);
          // Notify extension.ts to update currentSessionDir and plannerAgent
          this.onReset?.(newSessionDir, newSessionDirName);
        } else {
          this.engine.reset().catch(err => this.handleError(err));
        }
        break;
      }
      case 'CMD_LIST_SESSIONS':
        this.handleListSessions();
        break;
      case 'CMD_SEARCH_SESSIONS':
        this.handleSearchSessions(message.payload.query);
        break;
      case 'CMD_LOAD_SESSION':
        this.handleLoadSession(message.payload.sessionId);
        break;
      case 'CMD_SET_CONVERSATION_MODE':
        this.handleSetConversationMode(message.payload.mode);
        break;
      case 'CMD_REQUEST_REPORT':
        this.handleRequestReport();
        break;
      case 'CMD_DELETE_SESSION':
        this.handleDeleteSession(message.payload.sessionId);
        break;
      case 'CMD_REQUEST_PLAN':
        this.handleRequestPlan();
        break;
      case 'CMD_REVIEW_DIFF':
        this.engine.reviewDiff(message.payload.phaseId).catch(err => this.handleError(err));
        break;
      case 'CMD_RESUME_PENDING':
        this.engine.resumePending().catch(err => this.handleError(err));
        break;
      case 'MCP_FETCH_RESOURCE':
        this.handleMCPFetchResource(message.payload.uri, message.payload.requestId);
        break;
      default: {
        const _exhaustive: never = message;
        log.warn('[MissionControl] Unknown message:', _exhaustive);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Session Management Handlers
  // ═══════════════════════════════════════════════════════════════════════════

  private handleListSessions(): void {
    if (!this.sessionManager) return;
    this.sessionManager.listSessions().then(sessions => {
      this.sendToWebview({
        type: 'SESSION_LIST',
        payload: { sessions },
      });
    }).catch(log.onError);
  }

  private handleSearchSessions(query: string): void {
    if (!this.sessionManager) return;
    this.sessionManager.searchSessions(query).then(sessions => {
      this.sendToWebview({
        type: 'SESSION_SEARCH_RESULTS',
        payload: { query, sessions },
      });
    }).catch(log.onError);
  }

  private handleLoadSession(sessionId: string): void {
    if (!this.sessionManager) return;
    const sessionDir = this.sessionManager.getSessionDir(sessionId);
    const newStateManager = new StateManager(sessionDir);
    this.engine.switchSession(newStateManager).catch(err => this.handleError(err));
  }

  private sendToWebview(message: HostToWebviewMessage): void {
    this.panel.webview.postMessage(message);
  }

  /**
   * Derive the masterTaskId from the Engine's active session directory.
   * Returns `undefined` if no session is active (e.g., IDLE state).
   */
  private deriveMasterTaskId(): string | undefined {
    return this.engine.getSessionDirName();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  MCP Resource Proxy
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Handle `MCP_FETCH_RESOURCE` requests from the Webview.
   *
   * P3-4: Prefers routing through `MCPClientBridge.readResource()` so that
   * MCP protocol middleware, validation, and logging are exercised. Falls back
   * to direct in-memory state map access when the bridge is not available.
   */
  private handleMCPFetchResource(uri: string, requestId: string): void {
    log.info(`[MissionControl] MCP_FETCH_RESOURCE: uri=${uri}, requestId=${requestId}`);

    if (!this.mcpClientBridge) {
      // mcpClientBridge should always be injected via createOrShow().
      // If somehow absent, return an explicit error rather than silently failing.
      this.sendToWebview({
        type: 'MCP_RESOURCE_DATA',
        payload: { requestId, data: '', error: 'MCP Client Bridge not available.' },
      });
      return;
    }

    this.mcpClientBridge.readResource(uri)
      .then(content => {
        // Attempt JSON parse for object-type resources (handoffs)
        let data: string | object = content;
        try { data = JSON.parse(content); } catch { /* leave as string */ }
        this.sendToWebview({
          type: 'MCP_RESOURCE_DATA',
          payload: { requestId, data },
        });
      })
      .catch(err => {
        const message = err instanceof Error ? err.message : String(err);
        log.error('[MissionControl] MCP_FETCH_RESOURCE error:', message);
        this.sendToWebview({
          type: 'MCP_RESOURCE_DATA',
          payload: { requestId, data: '', error: message },
        });
      });
  }

  /**
   * #55: Forward async errors to the webview as ERROR messages
   * instead of silently swallowing them with console.error.
   */
  private handleError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    log.error('[MissionControl] Error:', message);
    this.sendToWebview({
      type: 'ERROR',
      payload: {
        code: 'COMMAND_ERROR',
        message,
      },
    });
  }

  private handleSetConversationMode(mode: 'isolated' | 'continuous' | 'smart'): void {
    if (!this.adkController) return;
    this.adkController.setConversationSettings({ mode });
    const settings = this.adkController.conversationSettings;
    this.sendToWebview({
      type: 'CONVERSATION_MODE',
      payload: {
        mode: settings.mode,
        smartSwitchTokenThreshold: settings.smartSwitchTokenThreshold,
      },
    });
  }

  private handleRequestReport(): void {
    const masterTaskId = this.deriveMasterTaskId();
    if (!masterTaskId) {
      this.sendToWebview({
        type: 'ERROR',
        payload: { code: 'COMMAND_ERROR', message: 'No active session.' },
      });
      return;
    }

    if (this.mcpClientBridge) {
      this.mcpClientBridge.readResource(RESOURCE_URIS.taskReport(masterTaskId))
        .then(content => {
          if (content) {
            this.sendToWebview({ type: 'CONSOLIDATION_REPORT', payload: { report: content } });
          } else {
            this.sendToWebview({
              type: 'ERROR',
              payload: { code: 'COMMAND_ERROR', message: 'No consolidation report available for this session.' },
            });
          }
        })
        .catch(err => this.handleError(err));
      return;
    }

    // Fallback: direct state map access
    if (!this.mcpServer) {
      this.sendToWebview({
        type: 'ERROR',
        payload: { code: 'COMMAND_ERROR', message: 'MCP server not available.' },
      });
      return;
    }
    const task = this.mcpServer.getTaskState(masterTaskId);
    const report = task?.consolidationReport;
    if (report) {
      this.sendToWebview({ type: 'CONSOLIDATION_REPORT', payload: { report } });
    } else {
      this.sendToWebview({
        type: 'ERROR',
        payload: { code: 'COMMAND_ERROR', message: 'No consolidation report available for this session.' },
      });
    }
  }

  private handleDeleteSession(sessionId: string): void {
    if (!this.sessionManager) return;
    this.sessionManager.deleteSession(sessionId)
      .then(() => this.handleListSessions())
      .catch(err => this.handleError(err));
  }

  private handleRequestPlan(): void {
    const masterTaskId = this.deriveMasterTaskId();
    if (!masterTaskId) {
      this.sendToWebview({
        type: 'ERROR',
        payload: { code: 'COMMAND_ERROR', message: 'No active session. Cannot load implementation plan.' },
      });
      return;
    }

    if (this.mcpClientBridge) {
      this.mcpClientBridge.readResource(RESOURCE_URIS.taskPlan(masterTaskId))
        .then(content => {
          if (content) {
            log.info(`[MissionControl] handleRequestPlan: plan loaded via MCP bridge (${content.length} chars)`);
            this.sendToWebview({ type: 'IMPLEMENTATION_PLAN', payload: { plan: content } });
          } else {
            log.warn('[MissionControl] handleRequestPlan: no plan found in MCP state.');
            this.sendToWebview({
              type: 'ERROR',
              payload: { code: 'COMMAND_ERROR', message: 'No implementation plan available for this session.' },
            });
          }
        })
        .catch(err => this.handleError(err));
      return;
    }

    // Fallback: direct state map access
    if (!this.mcpServer) {
      this.sendToWebview({
        type: 'ERROR',
        payload: { code: 'COMMAND_ERROR', message: 'MCP server not available.' },
      });
      return;
    }
    const task = this.mcpServer.getTaskState(masterTaskId);
    const plan = task?.implementationPlan;
    if (plan) {
      log.info(`[MissionControl] handleRequestPlan: plan loaded from MCP state (${plan.length} chars)`);
      this.sendToWebview({ type: 'IMPLEMENTATION_PLAN', payload: { plan } });
    } else {
      log.warn('[MissionControl] handleRequestPlan: no plan found in MCP state.');
      this.sendToWebview({
        type: 'ERROR',
        payload: { code: 'COMMAND_ERROR', message: 'No implementation plan available for this session.' },
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  HTML Generation
  // ═══════════════════════════════════════════════════════════════════════════

  private getHtmlForWebview(): string {
    return getWebviewHtml(this.panel.webview, this.extensionUri);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Disposal
  // ═══════════════════════════════════════════════════════════════════════════

  private dispose(): void {
    MissionControlPanel.currentPanel = undefined;
    this.panel.dispose();
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}

/**
 * Runtime validation for Webview → Host IPC messages.
 * Ensures the `type` discriminator exists and payload shapes match.
 * See 02-review.md § P1-3.
 */
// Re-export for backward compatibility
export { isValidWebviewMessage } from './ipcValidator.js';
