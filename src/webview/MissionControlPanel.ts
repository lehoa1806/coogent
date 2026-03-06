// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// src/webview/MissionControlPanel.ts — Webview panel lifecycle and UI rendering
// ─────────────────────────────────────────────────────────────────────────────

import * as vscode from 'vscode';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { HostToWebviewMessage, WebviewToHostMessage } from '../types/index.js';
import { asTimestamp } from '../types/index.js';
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

/** Timeout (ms) for MCP resource fetch calls from the webview. Prevents infinite loading spinners. */
const MCP_FETCH_TIMEOUT_MS = 15_000;

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

    // Broadcast initial suggestion data for @ mention and / workflow popups
    this.broadcastSuggestionData();
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

    // ── Legacy CMD_PAUSE guard — no-op with clear warning ───────────────────
    // The Webview sends `{type:"CMD_PAUSE"}` (bare, no phaseId) which is not
    // a valid message type. The correct type is CMD_PAUSE_PHASE with a phaseId.
    // Intercept before the generic IPC validator to avoid confusing log noise.
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
        // Git pre-flight: offer bypass instead of hard-blocking
        if (this.preFlightGitCheck) {
          const check = await this.preFlightGitCheck();
          if (check.blocked) {
            const choice = await vscode.window.showWarningMessage(
              `Coogent: ${check.message} `,
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
        // ERR-01: Store the prompt before the async pre-flight check so it
        // can be echoed back if the user cancels the Git warning (prompt is never lost).
        const pendingPrompt = message.payload.prompt;

        // Git pre-flight: offer bypass instead of hard-blocking
        if (this.preFlightGitCheck) {
          const check = await this.preFlightGitCheck();
          if (check.blocked) {
            const choice = await vscode.window.showWarningMessage(
              `Coogent: ${check.message} `,
              'Continue on Current Branch',
              'Cancel'
            );
            if (choice !== 'Continue on Current Branch') {
              // ERR-01: Restore the prompt to the webview chat input via
              // a LOG_ENTRY with the sentinel [LAST_PROMPT] prefix.
              // The Svelte messageHandler reads this and populates lastPrompt.
              this.sendToWebview({
                type: 'LOG_ENTRY',
                payload: {
                  timestamp: asTimestamp(),
                  level: 'warn',
                  message: `[LAST_PROMPT] ${pendingPrompt}`,
                },
              });
              return;
            }
            this._skipSandboxBranch = true;
          }
        }
        this.engine.planRequest(pendingPrompt);
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
          // ERR-04: Purge the old MCP task before switching so the in-memory store
          // doesn't grow unboundedly across session resets.
          const oldTaskId = this.engine.getSessionDirName();
          if (oldTaskId) {
            this.mcpServer?.purgeTask(oldTaskId);
          }
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
      case 'CMD_SET_CONVERSATION_MODE':
        this.handleSetConversationMode(message.payload.mode);
        break;
      case 'CMD_REQUEST_REPORT':
        this.handleRequestReport();
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
      case 'CMD_UPLOAD_FILE':
        this.handleUploadFile(false);
        break;
      case 'CMD_UPLOAD_IMAGE':
        this.handleUploadFile(true);
        break;

      // ── Session management (webview-initiated) ─────────────────────────────
      case 'CMD_LIST_SESSIONS': {
        if (!this.sessionManager) break;
        const sessions = await this.sessionManager.listSessions();
        this.sendToWebview({ type: 'SESSION_LIST', payload: { sessions } });
        break;
      }
      case 'CMD_SEARCH_SESSIONS': {
        if (!this.sessionManager) break;
        const results = await this.sessionManager.searchSessions(message.payload.query);
        this.sendToWebview({
          type: 'SESSION_SEARCH_RESULTS',
          payload: { query: message.payload.query, sessions: results },
        });
        break;
      }
      case 'CMD_LOAD_SESSION': {
        // Delegate to the registered command so extension.ts module-level state
        // (currentSessionDir, plannerAgent) is updated in a single place.
        await vscode.commands.executeCommand('coogent.loadSession', message.payload.sessionId);
        break;
      }
      case 'CMD_DELETE_SESSION': {
        // Delegate to the registered command so the sidebar TreeView auto-refreshes.
        await vscode.commands.executeCommand(
          'coogent.deleteSession',
          { session: { sessionId: message.payload.sessionId } }
        );
        break;
      }

      default: {
        const _exhaustive: never = message;
        log.warn('[MissionControl] Unknown message:', _exhaustive);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Session Management Handlers
  // ═══════════════════════════════════════════════════════════════════════════

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
   * TYPE-03: Wraps the async read with a 15-second timeout so `mcpStore.ts`
   * never hangs in `loading: true` forever. Also guards the response against
   * panel disposal that may occur while the promise is in-flight.
   */
  private handleMCPFetchResource(uri: string, requestId: string): void {
    log.info(`[MissionControl] MCP_FETCH_RESOURCE: uri = ${uri}, requestId = ${requestId} `);

    if (!this.mcpClientBridge) {
      this.sendToWebview({
        type: 'MCP_RESOURCE_DATA',
        payload: { requestId, data: '', error: 'MCP Client Bridge not available.' },
      });
      return;
    }

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`MCP_FETCH_RESOURCE timed out after ${MCP_FETCH_TIMEOUT_MS / 1_000} s`)), MCP_FETCH_TIMEOUT_MS)
    );

    Promise.race([this.mcpClientBridge.readResource(uri), timeoutPromise])
      .then(content => {
        if (!MissionControlPanel.currentPanel) return; // panel disposed while in-flight
        let data: string | object = content;
        try { data = JSON.parse(content); } catch { /* leave as string */ }
        this.sendToWebview({
          type: 'MCP_RESOURCE_DATA',
          payload: { requestId, data },
        });
      })
      .catch(err => {
        if (!MissionControlPanel.currentPanel) return; // panel disposed while in-flight
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

  /**
   * Handle file/image upload requests from the Webview.
   * Opens the VS Code file picker and sends selected paths back.
   */
  private async handleUploadFile(imageOnly: boolean): Promise<void> {
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

    this.sendToWebview({
      type: 'ATTACHMENT_SELECTED',
      payload: { paths },
    });
  }

  /**
   * Broadcast context-aware suggestion data for @ mention and / workflow popups.
   */
  private broadcastSuggestionData(): void {
    // Derive mention items from active runbook context
    const runbook = this.engine.getRunbook() ?? this.engine.getPlanDraft();
    const mentions: { label: string; description: string; insert: string }[] = [
      { label: '@file', description: 'Reference a file', insert: '@file ' },
      { label: '@context', description: 'Attach context', insert: '@context ' },
    ];

    // Add phase-specific mentions if runbook exists
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

    this.sendToWebview({
      type: 'SUGGESTION_DATA',
      payload: { mentions, workflows },
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  MCP Resource Helpers (ERR-03: extracted to avoid duplication)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Read a resource via MCPClientBridge, or fallback to direct state map access.
   * Returns `null` and sends an ERROR if no content is available.
   * Extracted to eliminate duplication between handleRequestReport and handleRequestPlan.
   *
   * @param uri             The `coogent://` resource URI.
   * @param notFoundMsg     Human - readable message when the resource exists but is empty.
   * @param directFallback  Optional fallback accessor for when the bridge is unavailable.
   */
  private async readMCPResourceOrError(
    uri: string,
    notFoundMsg: string,
    directFallback?: () => string | undefined
  ): Promise<string | null> {
    if (this.mcpClientBridge) {
      try {
        const content = await this.mcpClientBridge.readResource(uri);
        if (content) return content;
        this.sendToWebview({
          type: 'ERROR',
          payload: { code: 'COMMAND_ERROR', message: notFoundMsg },
        });
        return null;
      } catch (err) {
        // "Resource not yet available" means the agent hasn't submitted the artifact yet.
        // This is expected during EXECUTING_WORKER — convert to a pending signal, not an error.
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes('Resource not yet available')) {
          log.info(`[MissionControl] readMCPResourceOrError: resource pending (${uri})`);
          this.sendToWebview({
            type: 'PLAN_STATUS',
            payload: { status: 'generating', message: 'Implementation plan is being generated…' },
          });
          return null;
        }
        this.handleError(err);
        return null;
      }
    }

    // Fallback: direct state map access (bridge not yet connected)
    if (!this.mcpServer) {
      this.sendToWebview({
        type: 'ERROR',
        payload: { code: 'COMMAND_ERROR', message: 'MCP server not available.' },
      });
      return null;
    }
    const content = directFallback?.();
    if (content) return content;
    this.sendToWebview({
      type: 'ERROR',
      payload: { code: 'COMMAND_ERROR', message: notFoundMsg },
    });
    return null;
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

    this.readMCPResourceOrError(
      RESOURCE_URIS.taskReport(masterTaskId),
      'No consolidation report available for this session.',
      () => this.mcpServer?.getTaskState(masterTaskId)?.consolidationReport
    ).then(report => {
      if (report) {
        this.sendToWebview({ type: 'CONSOLIDATION_REPORT', payload: { report } });
      }
    }).catch(err => this.handleError(err));
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

    this.readMCPResourceOrError(
      RESOURCE_URIS.taskPlan(masterTaskId),
      'No implementation plan available for this session.',
      () =>
        // Primary: MCP in-memory store (present when engine is live)
        this.mcpServer?.getTaskState(masterTaskId)?.implementationPlan
        // Fallback: runbook.implementation_plan (survives extension restart)
        ?? this.engine.getRunbook()?.implementation_plan
    ).then(plan => {
      if (plan) {
        log.info(`[MissionControl] handleRequestPlan: plan loaded (${plan.length} chars)`);
        this.sendToWebview({ type: 'IMPLEMENTATION_PLAN', payload: { plan } });
      }
    }).catch(err => this.handleError(err));
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
