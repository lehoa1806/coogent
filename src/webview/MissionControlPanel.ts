// ─────────────────────────────────────────────────────────────────────────────
// src/webview/MissionControlPanel.ts — Webview panel lifecycle and UI rendering
// ─────────────────────────────────────────────────────────────────────────────

import * as vscode from 'vscode';
import type { HostToWebviewMessage, WebviewToHostMessage } from '../types/index.js';
import type { OrchestratorEngine } from '../engine/OrchestratorEngine.js';
import { isValidWebviewMessage } from './ipcValidator.js';

/**
 * Manages the Mission Control Webview panel.
 *
 * The Webview is a **pure projection** — it renders state received from
 * the Extension Host and sends user commands back via postMessage.
 */
export class MissionControlPanel {
    public static readonly viewType = 'isolatedAgent.missionControl';
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
        orchestratorEngine: OrchestratorEngine
    ): void {
        const column = vscode.window.activeTextEditor?.viewColumn;

        if (MissionControlPanel.currentPanel) {
            MissionControlPanel.currentPanel.panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            MissionControlPanel.viewType,
            'Isolated-Agent: Mission Control',
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
            orchestratorEngine
        );
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Instance
    // ═══════════════════════════════════════════════════════════════════════════

    private constructor(
        panel: vscode.WebviewPanel,
        private readonly extensionUri: vscode.Uri,
        private readonly orchestratorEngine: OrchestratorEngine
    ) {
        this.panel = panel;
        this.panel.webview.html = this.getHtmlForWebview();

        this.panel.webview.onDidReceiveMessage(
            (message: unknown) => this.handleMessage(message),
            null,
            this.disposables
        );

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
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
                this.orchestratorEngine.start().catch(console.error);
                break;
            case 'CMD_PAUSE':
                this.orchestratorEngine.pause();
                break;
            case 'CMD_ABORT':
                this.orchestratorEngine.abort().catch(console.error);
                break;
            case 'CMD_RETRY':
                this.orchestratorEngine.retry(message.payload.phaseId).catch(console.error);
                break;
            case 'CMD_SKIP_PHASE':
                this.orchestratorEngine.skipPhase(message.payload.phaseId).catch(console.error);
                break;
            case 'CMD_EDIT_PHASE':
                this.orchestratorEngine.editPhase(
                    message.payload.phaseId,
                    message.payload.patch
                ).catch(console.error);
                break;
            case 'CMD_LOAD_RUNBOOK':
                this.orchestratorEngine.loadRunbook(message.payload.filePath).catch(console.error);
                break;
            case 'CMD_REQUEST_STATE': {
                const runbook = this.orchestratorEngine.getRunbook();
                const draft = this.orchestratorEngine.getPlanDraft();
                const state = this.orchestratorEngine.getState();
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
                this.orchestratorEngine.planRequest(message.payload.prompt);
                break;
            case 'CMD_PLAN_APPROVE':
                this.orchestratorEngine.planApproved().catch(console.error);
                break;
            case 'CMD_PLAN_REJECT':
                this.orchestratorEngine.planRejected(message.payload.feedback);
                break;
            case 'CMD_PLAN_EDIT_DRAFT':
                this.orchestratorEngine.updatePlanDraft(message.payload.draft);
                break;
            case 'CMD_RESET':
                this.orchestratorEngine.reset().catch(console.error);
                break;
            default: {
                const _exhaustive: never = message;
                console.warn('[MissionControl] Unknown message:', _exhaustive);
            }
        }
    }

    private sendToWebview(message: HostToWebviewMessage): void {
        this.panel.webview.postMessage(message);
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
                 font-src ${webview.cspSource} https://fonts.gstatic.com;
                 script-src 'nonce-${nonce}';">
  <title>Mission Control</title>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap">
  <link rel="stylesheet" href="${styleUri}">
</head>
<body>
  <div class="app-shell">
    <header class="header" role="banner">
      <h1>⚙️ Mission Control</h1>
      <span id="state-badge" class="badge badge-idle" aria-live="polite">IDLE</span>
      <span class="badge badge-idle">v0.1.0</span>
      <div class="header-spacer"></div>
      <button id="btn-new-chat" class="btn-new-chat" title="Start a new chat / runbook" aria-label="Start new chat">➕ New Chat</button>
    </header>

    <main style="display:flex;flex-direction:column;flex:1;overflow:hidden;min-height:0;">
      <!-- Planning Panel — visible in IDLE / PLANNING / PLAN_REVIEW states -->
      <div id="planning-panel" class="planning-panel" role="region" aria-label="Task planning">
        <div id="plan-input-area" class="plan-input-area">
          <h2>🤖 Describe Your Task</h2>
          <textarea id="plan-prompt" class="plan-prompt" rows="4"
            placeholder="Describe what you want to build, e.g. 'Create a REST API for a todo app with Express and TypeScript'"
            aria-label="Task description"></textarea>
          <div class="plan-prompt-hint">⌘ Enter to submit</div>
          <button id="btn-plan" class="primary">🧠 Generate Plan</button>
        </div>

        <div id="plan-spinner" class="plan-spinner" style="display:none;" role="status" aria-live="polite">
          <div class="spinner" aria-hidden="true"></div>
          <span id="plan-spinner-text">AI agent is creating your plan...</span>
        </div>

        <div id="plan-review-area" class="plan-review-area" style="display:none;" role="region" aria-label="Plan review">
          <h2>📋 Review Generated Plan</h2>
          <div id="plan-review-phases"></div>
          <div class="plan-review-actions">
            <button id="btn-plan-approve" class="primary">✅ Approve &amp; Load</button>
            <div class="plan-replan">
              <input id="plan-feedback" type="text" placeholder="Feedback for re-generation..." class="plan-feedback-input" aria-label="Plan feedback">
              <button id="btn-plan-reject" class="danger">🔄 Re-plan</button>
            </div>
          </div>
        </div>
      </div>

      <nav class="controls" role="toolbar" aria-label="Execution controls">
        <button id="btn-load" class="primary" aria-label="Load runbook">📂 Load Runbook</button>
        <button id="btn-start" class="primary" disabled aria-label="Start execution">▶ Start</button>
        <button id="btn-pause" disabled aria-label="Pause execution">⏸ Pause</button>
        <button id="btn-abort" class="danger" disabled aria-label="Abort execution">⏹ Abort</button>
        <button id="btn-reset" class="primary" style="display:none;" aria-label="Reset">🔄 Reset</button>
      </nav>

      <div class="main-content">
        <div class="content-column">
          <!-- Phase Pipeline -->
          <section class="phase-pipeline" role="region" aria-label="Phase pipeline">
            <h2>Phases</h2>
            <div id="phases-container" class="phase-scroll">
              <div class="empty">
                <div class="empty-icon" aria-hidden="true">📋</div>
                <p>No runbook loaded</p>
                <code>.isolated_agent/ipc/&lt;id&gt;/.task-runbook.json</code>
              </div>
            </div>
          </section>

          <!-- Terminal Output -->
          <section class="terminal" role="log" aria-label="Worker output">
            <div class="terminal-header">
              <h2>Worker Output</h2>
            </div>
            <div id="token-bar" class="token-bar" style="display:none;" role="progressbar" aria-label="Token budget">
              <div class="token-bar-track"><div id="token-fill" class="token-bar-fill"></div></div>
              <div id="token-label" class="token-bar-label"></div>
            </div>
            <div id="output" class="terminal-output" aria-live="off">Waiting for execution...\n</div>
            <button id="btn-scroll-bottom" class="btn-scroll-bottom" title="Scroll to bottom" aria-label="Scroll to bottom">↓</button>
          </section>
        </div>

        <!-- Progress Sidebar -->
        <aside id="progress-sidebar" class="progress-sidebar" style="display:none;" role="complementary" aria-label="Execution progress">
          <div class="progress-ring-container">
            <svg class="progress-ring" viewBox="0 0 56 56">
              <circle class="progress-ring-bg" cx="28" cy="28" r="24" />
              <circle id="progress-ring-fill" class="progress-ring-fill" cx="28" cy="28" r="24"
                stroke-dasharray="150.8" stroke-dashoffset="150.8" />
            </svg>
            <div id="progress-label" class="progress-ring-label">0/0</div>
          </div>
          <div id="elapsed-time" class="elapsed-time">00:00</div>
          <div id="progress-meta" class="progress-meta"></div>
        </aside>
      </div>
    </main>
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
