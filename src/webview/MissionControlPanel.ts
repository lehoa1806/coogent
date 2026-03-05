// ─────────────────────────────────────────────────────────────────────────────
// src/webview/MissionControlPanel.ts — Webview panel lifecycle and UI rendering
// ─────────────────────────────────────────────────────────────────────────────

import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { HostToWebviewMessage, WebviewToHostMessage } from '../types/index.js';
import type { Engine } from '../engine/Engine.js';
import type { SessionManager } from '../session/SessionManager.js';
import type { ADKController } from '../adk/ADKController.js';
import { StateManager } from '../state/StateManager.js';
import { isValidWebviewMessage } from './ipcValidator.js';

/** Signature for the injected pre-flight Git check function. */
type PreFlightGitCheckFn = () => Promise<{ blocked: true; message: string } | { blocked: false }>;

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
    preFlightGitCheck?: PreFlightGitCheckFn
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
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'webview-ui')],
      }
    );

    MissionControlPanel.currentPanel = new MissionControlPanel(
      panel,
      extensionUri,
      engine,
      sessionManager,
      adkController,
      preFlightGitCheck
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
    private readonly preFlightGitCheck?: PreFlightGitCheckFn
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
          this.sendToWebview({
            type: 'STATE_SNAPSHOT',
            payload: {
              runbook: runbook ?? draft ?? { project_id: '', status: 'idle', current_phase: 0, phases: [] },
              engineState: state,
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
      const msg = raw as { type: 'PLAN_SUMMARY'; payload: { summary: string; implementationPlan: string } };
      console.log('[MissionControl] Host → Webview (pass-through): PLAN_SUMMARY');
      this.sendToWebview({
        type: 'PLAN_SUMMARY',
        payload: msg.payload,
      });
      return;
    }

    if (!isValidWebviewMessage(raw)) {
      console.warn('[MissionControl] Invalid or malformed message:', raw);
      return;
    }

    const message = raw as WebviewToHostMessage;
    console.log(`[MissionControl] Webview → Host: ${message.type}`);

    switch (message.type) {
      case 'CMD_START': {
        // Git pre-flight: check for dirty working tree before starting
        if (this.preFlightGitCheck) {
          const check = await this.preFlightGitCheck();
          if (check.blocked) {
            this.sendToWebview({ type: 'ERROR', payload: { code: 'GIT_DIRTY', message: check.message } });
            return;
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
        this.sendToWebview({
          type: 'STATE_SNAPSHOT',
          payload: {
            runbook: runbook ?? draft ?? { project_id: '', status: 'idle', current_phase: 0, phases: [] },
            engineState: state,
          },
        });
        break;
      }
      case 'CMD_PLAN_REQUEST': {
        // Git pre-flight: check for dirty working tree before planning
        if (this.preFlightGitCheck) {
          const check = await this.preFlightGitCheck();
          if (check.blocked) {
            this.sendToWebview({ type: 'ERROR', payload: { code: 'GIT_DIRTY', message: check.message } });
            return;
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
        // Create a fresh session so loadRunbook() won't reload the old data
        const newSessionId = randomUUID();
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (workspaceRoot) {
          const newSessionDir = path.join(
            workspaceRoot, '.coogent', 'ipc', newSessionId
          );
          const freshStateManager = new StateManager(newSessionDir);
          this.engine.reset(freshStateManager).catch(err => this.handleError(err));
          this.sessionManager?.setCurrentSessionId(newSessionId);
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
      case 'CMD_REVIEW_DIFF':
        this.engine.reviewDiff(message.payload.phaseId).catch(err => this.handleError(err));
        break;
      case 'CMD_RESUME_PENDING':
        this.engine.resumePending().catch(err => this.handleError(err));
        break;
      default: {
        const _exhaustive: never = message;
        console.warn('[MissionControl] Unknown message:', _exhaustive);
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
    }).catch(console.error);
  }

  private handleSearchSessions(query: string): void {
    if (!this.sessionManager) return;
    this.sessionManager.searchSessions(query).then(sessions => {
      this.sendToWebview({
        type: 'SESSION_SEARCH_RESULTS',
        payload: { query, sessions },
      });
    }).catch(console.error);
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
   * #55: Forward async errors to the webview as ERROR messages
   * instead of silently swallowing them with console.error.
   */
  private handleError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[MissionControl] Error:', message);
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
    const stateManager = (this.engine as unknown as { stateManager: { getSessionDir?: () => string } }).stateManager;
    const sessionDir = stateManager?.getSessionDir?.();
    if (!sessionDir) return;

    const reportPath = path.join(sessionDir, 'consolidation-report.md');
    fs.readFile(reportPath, 'utf-8')
      .then(report => {
        this.sendToWebview({
          type: 'CONSOLIDATION_REPORT',
          payload: { report },
        });
      })
      .catch(() => {
        this.sendToWebview({
          type: 'ERROR',
          payload: {
            code: 'COMMAND_ERROR',
            message: 'No consolidation report available for this session.',
          },
        });
      });
  }

  private handleDeleteSession(sessionId: string): void {
    if (!this.sessionManager) return;
    this.sessionManager.deleteSession(sessionId)
      .then(() => this.handleListSessions())
      .catch(err => this.handleError(err));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  HTML Generation
  // ═══════════════════════════════════════════════════════════════════════════

  private getHtmlForWebview(): string {
    const webview = this.panel.webview;
    const nonce = getNonce();

    // Resolve URIs for the bundled webview assets
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'webview-ui', 'dist', 'main.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'webview-ui', 'styles.css')
    );

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none';
                 style-src ${webview.cspSource} 'unsafe-inline';
                 font-src ${webview.cspSource} data:;
                 img-src ${webview.cspSource} data:;
                 script-src 'nonce-${nonce}';">
  <title>Mission Control</title>
  <!-- Fonts: inherited from VS Code's configured --vscode-font-family / --vscode-editor-font-family -->
  <link rel="stylesheet" href="${styleUri}">
</head>
<body>
  <div class="app-shell">
    <!-- Zone 1: Global Controls -->
    <header class="header" aria-label="Coogent controls">
      <button class="btn-new-chat" id="btn-new-chat" data-tooltip="Start a fresh session" data-tooltip-pos="bottom" aria-label="Start a fresh session">+ New Chat</button>
      <h1>Coogent Mission Control</h1>
      <div class="header-spacer"></div>
      <span class="badge" id="state-badge" data-tooltip="Current engine state" data-tooltip-pos="bottom" aria-live="polite" aria-label="Current engine state">IDLE</span>
      <button class="btn-icon" id="btn-history" data-tooltip="Session history" data-tooltip-pos="bottom" aria-label="Session history">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0zM8 3.5a.5.5 0 0 0-1 0V8a.5.5 0 0 0 .25.43l2.5 1.5a.5.5 0 0 0 .5-.86L8 7.71V3.5z"/><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zM2 8a6 6 0 1 1 12 0A6 6 0 0 1 2 8z"/></svg>
      </button>
      <button class="btn-icon btn-danger" id="btn-reset" data-tooltip="Reset engine" data-tooltip-pos="bottom" aria-label="Reset engine">⟲</button>
    </header>

    <!-- Conversation Mode Toggle -->
    <div class="conversation-mode-bar" id="conversation-mode-bar" role="radiogroup" aria-label="Conversation mode">
      <span class="mode-label">Conversation:</span>
      <button class="mode-btn active" data-mode="isolated" data-tooltip="Each subtask in a new conversation" data-tooltip-pos="bottom" aria-label="Each subtask in a new conversation">Isolated</button>
      <button class="mode-btn" data-mode="continuous" data-tooltip="All subtasks share one conversation" data-tooltip-pos="bottom" aria-label="All subtasks share one conversation">Continuous</button>
      <button class="mode-btn" data-mode="smart" data-tooltip="Auto-switch based on token usage" data-tooltip-pos="bottom" aria-label="Auto-switch based on token usage">Smart</button>
    </div>

    <!-- Zone 2: Mission Overview + Global Execution Controls -->
    <section class="mission-overview" id="mission-overview">
      <div class="mission-overview-info">
        <div class="mission-title" id="mission-title">No mission loaded</div>
        <div class="mission-progress" id="mission-progress"></div>
      </div>
      <div class="execution-controls controls" id="controls">
        <button id="btn-load" data-tooltip="Load Runbook JSON" aria-label="Load Runbook JSON">📂 Load</button>
        <button id="btn-start" data-tooltip="Start execution" aria-label="Start execution">▶ Start</button>
        <button id="btn-pause" data-tooltip="Pause after current phase" aria-label="Pause after current phase">⏸ Pause</button>
        <button id="btn-abort" data-tooltip="Abort execution" aria-label="Abort execution">⏹ Abort</button>
        <div class="controls-spacer"></div>
        <button id="btn-view-report" class="btn-icon" data-tooltip="View consolidation report" aria-label="View consolidation report" style="display:none;">📊</button>
        <span class="elapsed-time" id="elapsed-time" data-tooltip="Elapsed time" aria-label="Elapsed time">00:00</span>
      </div>
    </section>

    <!-- Master Task Summary (shown when planner summary is available) -->
    <section class="master-task-section" id="master-task-section" style="display:none;">
      <div class="master-task-summary" id="master-task-summary"></div>
      <button id="btn-toggle-plan" class="btn-icon" data-tooltip="Toggle implementation plan" aria-label="Toggle implementation plan">📋</button>
      <div class="master-task-plan" id="master-task-plan" style="display:none;"></div>
    </section>

    <!-- Zone 5: Plan Review Panel (shown during PLAN_REVIEW state) -->
    <section class="plan-review-panel" id="plan-review-panel" style="display:none;">
      <div class="plan-status" id="plan-status"></div>
      <div id="plan-review-area">
        <div class="plan-carousel" id="plan-carousel"></div>
      </div>
      <div class="plan-review-actions">
        <div class="plan-nav">
          <button id="plan-carousel-prev" data-tooltip="Previous phase" aria-label="Previous phase">←</button>
          <span id="plan-carousel-label"></span>
          <button id="plan-carousel-next" data-tooltip="Next phase" aria-label="Next phase">→</button>
        </div>
        <div class="plan-decision">
          <button id="btn-plan-approve" class="primary" data-tooltip="Accept this plan and start execution" aria-label="Accept this plan and start execution">✓ Approve & Run</button>
          <div class="plan-replan-group">
            <input type="text" id="plan-feedback" class="plan-feedback-input" placeholder="What should change? (optional)" aria-label="Plan revision feedback" />
            <button id="btn-plan-reject" class="danger" data-tooltip="Send feedback and re-generate the plan" aria-label="Send feedback and re-generate the plan">↻ Revise Plan</button>
          </div>
        </div>
      </div>
    </section>

    <!-- Main Body: Navigator + Details -->
    <div class="app-body">
      <!-- Zone 3: Phase Navigator -->
      <nav class="phase-navigator" id="phase-navigator" aria-label="Phase list" role="list">
        <div class="nav-header">Phases</div>
        <!-- Phase items rendered dynamically -->
      </nav>

      <main class="main-center" aria-label="Phase details">
        <!-- Plan Prompt Input (shown in IDLE state) -->
        <section class="plan-prompt-section" id="plan-prompt-section">
          <textarea id="plan-prompt" rows="3" placeholder="Describe your goal and Coogent will generate a plan..." aria-label="Plan prompt"></textarea>
          <button id="btn-plan" data-tooltip="Generate a multi-phase runbook" aria-label="Generate a multi-phase runbook">🚀 Generate Plan</button>
        </section>

        <div id="git-error-banner" style="display:none;"></div>

        <div class="phase-details" id="phase-details">
          <p class="placeholder-text">Select a phase from the navigator.</p>
        </div>
      </main>
    </div>

    <!-- Zone 6: Worker Output Terminal -->
    <div class="terminal-resizer" id="terminal-resizer"></div>
    <section class="terminal-panel" role="log" aria-label="Worker output">
      <div class="terminal-header">
        <span>Worker Output</span>
        <button class="btn-icon" id="btn-clear-output" data-tooltip="Clear output" aria-label="Clear output">🗑</button>
      </div>
      <pre class="terminal-output" id="output">Waiting for execution...\n</pre>
      <button class="btn-scroll-bottom" id="btn-scroll-bottom" data-tooltip="Scroll to bottom" aria-label="Scroll to bottom">↓</button>
    </section>



    <!-- History Drawer (slide-in from right) -->
    <aside class="chat-history-drawer" id="history-drawer" style="display:none;" role="dialog" aria-modal="true" aria-label="Session history">
      <div class="drawer-header">
        <h2>Session History</h2>
        <button class="btn-close-drawer" id="btn-close-history" data-tooltip="Close history" aria-label="Close history">✕</button>
      </div>
      <div class="drawer-search">
        <input type="text" id="history-search" class="session-search-input" placeholder="Search sessions..." aria-label="Search sessions" />
      </div>
      <div class="session-list" id="history-list"></div>
    </aside>

    <!-- Report Modal Overlay -->
    <div class="report-overlay" id="report-overlay" role="dialog" aria-modal="true" aria-label="Consolidation Report">
      <div class="report-modal">
        <div class="report-header">
          <h2>Consolidation Report</h2>
          <button class="btn-close-drawer" id="btn-close-report" aria-label="Close report">✕</button>
        </div>
        <div class="report-content" id="report-content"></div>
      </div>
    </div>
  </div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
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

// ═══════════════════════════════════════════════════════════════════════════════
//  Utilities
// ═══════════════════════════════════════════════════════════════════════════════

function getNonce(): string {
  // #53: Use crypto.randomUUID() for cryptographically strong nonces
  return randomUUID().replace(/-/g, '');
}

/**
 * Runtime validation for Webview → Host IPC messages.
 * Ensures the `type` discriminator exists and payload shapes match.
 * See 02-review.md § P1-3.
 */
// Re-export for backward compatibility
export { isValidWebviewMessage } from './ipcValidator.js';
