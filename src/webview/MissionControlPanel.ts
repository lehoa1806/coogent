// ─────────────────────────────────────────────────────────────────────────────
// src/webview/MissionControlPanel.ts — Webview panel lifecycle and UI rendering
// ─────────────────────────────────────────────────────────────────────────────

import * as vscode from 'vscode';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { HostToWebviewMessage, WebviewToHostMessage } from '../types/index.js';
import type { Engine } from '../engine/Engine.js';
import type { SessionManager } from '../session/SessionManager.js';
import type { ADKController } from '../adk/ADKController.js';
import { StateManager } from '../state/StateManager.js';
import { isValidWebviewMessage } from './ipcValidator.js';

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
    adkController?: ADKController
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
      adkController
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
    private readonly adkController?: ADKController
  ) {
    this.panel = panel;
    this.panel.webview.html = this.getHtmlForWebview();

    this.panel.webview.onDidReceiveMessage(
      (message: unknown) => this.handleMessage(message),
      null,
      this.disposables
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

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
  private handleMessage(raw: unknown): void {
    if (!isValidWebviewMessage(raw)) {
      console.warn('[MissionControl] Invalid or malformed message:', raw);
      return;
    }

    const message = raw as WebviewToHostMessage;
    console.log(`[MissionControl] Webview → Host: ${message.type}`);

    switch (message.type) {
      case 'CMD_START':
        this.engine.start().catch(console.error);
        break;
      case 'CMD_PAUSE':
        this.engine.pause();
        break;
      case 'CMD_ABORT':
        this.engine.abort().catch(console.error);
        break;
      case 'CMD_RETRY':
        this.engine.retry(message.payload.phaseId).catch(console.error);
        break;
      case 'CMD_SKIP_PHASE':
        this.engine.skipPhase(message.payload.phaseId).catch(console.error);
        break;
      case 'CMD_PAUSE_PHASE':
        this.engine.pausePhase(message.payload.phaseId);
        break;
      case 'CMD_STOP_PHASE':
        this.engine.stopPhase(message.payload.phaseId).catch(console.error);
        break;
      case 'CMD_RESTART_PHASE':
        this.engine.restartPhase(message.payload.phaseId).catch(console.error);
        break;
      case 'CMD_EDIT_PHASE':
        this.engine.editPhase(
          message.payload.phaseId,
          message.payload.patch
        ).catch(console.error);
        break;
      case 'CMD_LOAD_RUNBOOK':
        this.engine.loadRunbook(message.payload?.filePath).catch(console.error);
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
      case 'CMD_PLAN_REQUEST':
        this.engine.planRequest(message.payload.prompt);
        break;
      case 'CMD_PLAN_APPROVE':
        this.engine.planApproved().catch(console.error);
        break;
      case 'CMD_PLAN_REJECT':
        this.engine.planRejected(message.payload.feedback);
        break;
      case 'CMD_PLAN_EDIT_DRAFT':
        this.engine.updatePlanDraft(message.payload.draft);
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
          this.engine.reset(freshStateManager).catch(console.error);
          this.sessionManager?.setCurrentSessionId(newSessionId);
        } else {
          this.engine.reset().catch(console.error);
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
    this.engine.switchSession(newStateManager).catch(console.error);
  }

  private sendToWebview(message: HostToWebviewMessage): void {
    this.panel.webview.postMessage(message);
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
                 style-src ${webview.cspSource} 'nonce-${nonce}';
                 font-src ${webview.cspSource};
                 script-src 'nonce-${nonce}';">
  <title>Mission Control</title>
  <!-- Fonts: inherited from VS Code's configured --vscode-font-family / --vscode-editor-font-family -->
  <link rel="stylesheet" href="${styleUri}">
</head>
<body>
  <div class="app-shell">
    <!-- Zone 1: Global Controls -->
    <header class="header">
      <button class="btn-new-chat" id="btn-new-chat" data-tooltip="Start a fresh session" data-tooltip-pos="bottom">+ New Chat</button>
      <h1>Coogent Mission Control</h1>
      <div class="header-spacer"></div>
      <span class="badge" id="state-badge" data-tooltip="Current engine state" data-tooltip-pos="bottom">IDLE</span>
      <button class="btn-icon" id="btn-history" data-tooltip="Session history" data-tooltip-pos="bottom">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M13.5 8a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0zM8 3.5a.5.5 0 0 0-1 0V8a.5.5 0 0 0 .25.43l2.5 1.5a.5.5 0 0 0 .5-.86L8 7.71V3.5z"/><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zM2 8a6 6 0 1 1 12 0A6 6 0 0 1 2 8z"/></svg>
      </button>
      <button class="btn-icon btn-danger" id="btn-reset" data-tooltip="Reset engine" data-tooltip-pos="bottom">⟲</button>
    </header>

    <!-- Conversation Mode Toggle -->
    <div class="conversation-mode-bar" id="conversation-mode-bar">
      <span class="mode-label">Conversation:</span>
      <button class="mode-btn active" data-mode="isolated" data-tooltip="Each subtask in a new conversation" data-tooltip-pos="bottom">Isolated</button>
      <button class="mode-btn" data-mode="continuous" data-tooltip="All subtasks share one conversation" data-tooltip-pos="bottom">Continuous</button>
      <button class="mode-btn" data-mode="smart" data-tooltip="Auto-switch based on token usage" data-tooltip-pos="bottom">Smart</button>
    </div>

    <!-- Zone 2: Mission Overview -->
    <section class="mission-overview" id="mission-overview">
      <div class="mission-title" id="mission-title">No mission loaded</div>
      <div class="mission-progress" id="mission-progress"></div>
    </section>

    <!-- Zone 5: Plan Review Panel (shown during PLAN_REVIEW state) -->
    <section class="plan-review-panel" id="plan-review-panel" style="display:none;">
      <div class="plan-status" id="plan-status"></div>
      <div id="plan-review-area">
        <div class="plan-carousel" id="plan-carousel"></div>
      </div>
      <div class="plan-review-actions">
        <div class="plan-nav">
          <button id="plan-carousel-prev" data-tooltip="Previous phase">←</button>
          <span id="plan-carousel-label"></span>
          <button id="plan-carousel-next" data-tooltip="Next phase">→</button>
        </div>
        <div class="plan-decision">
          <button id="btn-plan-approve" class="primary" data-tooltip="Accept this plan and start execution">✓ Approve & Run</button>
          <div class="plan-replan-group">
            <input type="text" id="plan-feedback" class="plan-feedback-input" placeholder="What should change? (optional)" />
            <button id="btn-plan-reject" class="danger" data-tooltip="Send feedback and re-generate the plan">↻ Revise Plan</button>
          </div>
        </div>
      </div>
    </section>

    <!-- Main Body: Navigator + Details -->
    <div class="app-body">
      <!-- Zone 3: Phase Navigator -->
      <nav class="phase-navigator" id="phase-navigator">
        <div class="nav-header">Phases</div>
        <!-- Phase items rendered dynamically -->
      </nav>

      <main class="main-center">
        <!-- Plan Prompt Input (shown in IDLE state) -->
        <section class="plan-prompt-section" id="plan-prompt-section">
          <textarea id="plan-prompt" rows="3" placeholder="Describe your goal and Coogent will generate a plan..."></textarea>
          <button id="btn-plan" data-tooltip="Generate a multi-phase runbook">🚀 Generate Plan</button>
        </section>

        <div class="phase-details" id="phase-details">
          <p class="placeholder-text">Select a phase from the navigator.</p>
        </div>

        <!-- Zone 4: Execution Controls -->
        <div class="execution-controls controls" id="controls">
          <button id="btn-load" data-tooltip="Load Runbook JSON">📂 Load</button>
          <button id="btn-start" data-tooltip="Start execution">▶ Start</button>
          <button id="btn-pause" data-tooltip="Pause after current phase">⏸ Pause</button>
          <button id="btn-abort" data-tooltip="Abort execution">⏹ Abort</button>
          <div class="controls-spacer"></div>
          <span class="elapsed-time" id="elapsed-time" data-tooltip="Elapsed time">00:00</span>
        </div>
      </main>
    </div>

    <!-- Zone 6: Worker Output Terminal -->
    <div class="terminal-resizer" id="terminal-resizer"></div>
    <section class="terminal-panel">
      <div class="terminal-header">
        <span>Worker Output</span>
        <button class="btn-icon" id="btn-clear-output" data-tooltip="Clear output">🗑</button>
      </div>
      <pre class="terminal-output" id="output">Waiting for execution...\n</pre>
      <button class="btn-scroll-bottom" id="btn-scroll-bottom" data-tooltip="Scroll to bottom">↓</button>
    </section>

    <!-- Token Budget Bar -->
    <div class="token-bar" id="token-bar" style="display:none;">
      <div class="token-fill" id="token-fill"></div>
      <span class="token-label" id="token-label"></span>
    </div>



    <!-- History Drawer (slide-in from right) -->
    <aside class="chat-history-drawer" id="history-drawer" style="display:none;">
      <div class="drawer-header">
        <h2>Session History</h2>
        <button class="btn-close-drawer" id="btn-close-history" data-tooltip="Close history">✕</button>
      </div>
      <div class="drawer-search">
        <input type="text" id="history-search" class="session-search-input" placeholder="Search sessions..." />
      </div>
      <div class="session-list" id="history-list"></div>
    </aside>
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
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

/**
 * Runtime validation for Webview → Host IPC messages.
 * Ensures the `type` discriminator exists and payload shapes match.
 * See 02-review.md § P1-3.
 */
// Re-export for backward compatibility
export { isValidWebviewMessage } from './ipcValidator.js';
