// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// src/webview/MissionControlPanel.ts — Webview panel lifecycle and UI rendering
// ─────────────────────────────────────────────────────────────────────────────

import * as vscode from 'vscode';
import type { HostToWebviewMessage } from '../types/index.js';
import type { Engine } from '../engine/Engine.js';
import type { SessionManager } from '../session/SessionManager.js';
import type { ADKController } from '../adk/ADKController.js';
import { StateManager } from '../state/StateManager.js';
import { getWebviewHtml } from './webviewHtml.js';
import type { CoogentMCPServer } from '../mcp/CoogentMCPServer.js';
import type { MCPClientBridge } from '../mcp/MCPClientBridge.js';
import type { AgentRegistry } from '../agent-selection/AgentRegistry.js';
import { routeWebviewMessage, deriveMasterTaskId, broadcastSuggestionData, type MessageRouterDeps } from './messageRouter.js';

/** Signature for the injected pre-flight Git check function. */
type PreFlightGitCheckFn = () => Promise<{ blocked: true; message: string } | { blocked: false }>;

/** Callback invoked when CMD_RESET creates a new session. */
type OnResetFn = (newSessionDir: string, newSessionDirName: string, newStateManager?: StateManager) => void;

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
    mcpClientBridge?: MCPClientBridge,
    agentRegistry?: AgentRegistry,
    coogentDir?: string
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
      mcpClientBridge,
      agentRegistry,
      coogentDir
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Instance
  // ═══════════════════════════════════════════════════════════════════════════

  /** Cached dependency bag for the message router. */
  private readonly routerDeps: MessageRouterDeps;

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly engine: Engine,
    private readonly sessionManager?: SessionManager,
    private readonly adkController?: ADKController,
    private readonly preFlightGitCheck?: PreFlightGitCheckFn,
    private readonly onReset?: OnResetFn,
    private readonly mcpServer?: CoogentMCPServer,
    private readonly mcpClientBridge?: MCPClientBridge,
    private readonly agentRegistry?: AgentRegistry,
    private readonly coogentDir?: string
  ) {
    this.panel = panel;
    this.routerDeps = this.buildDeps();
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
          const _masterTaskId = deriveMasterTaskId(this.routerDeps);
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
    broadcastSuggestionData(this.routerDeps);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Message Handling — delegates to messageRouter.ts
  // ═══════════════════════════════════════════════════════════════════════════

  private async handleMessage(raw: unknown): Promise<void> {
    await routeWebviewMessage(raw, this.routerDeps);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Dependency Construction
  // ═══════════════════════════════════════════════════════════════════════════

  private buildDeps(): MessageRouterDeps {
    return {
      engine: this.engine,
      sendToWebview: (msg) => this.sendToWebview(msg),
      isPanelAlive: () => MissionControlPanel.currentPanel !== undefined,
      getSkipSandboxBranch: () => this._skipSandboxBranch,
      setSkipSandboxBranch: (v) => { this._skipSandboxBranch = v; },
      sessionManager: this.sessionManager,
      adkController: this.adkController,
      preFlightGitCheck: this.preFlightGitCheck,
      onReset: this.onReset,
      mcpServer: this.mcpServer,
      mcpClientBridge: this.mcpClientBridge,
      agentRegistry: this.agentRegistry,
      coogentDir: this.coogentDir,
    };
  }

  private sendToWebview(message: HostToWebviewMessage): void {
    this.panel.webview.postMessage(message);
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
