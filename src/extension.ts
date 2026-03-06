// ─────────────────────────────────────────────────────────────────────────────
// src/extension.ts — Main entry point: service init + delegation
// ─────────────────────────────────────────────────────────────────────────────
// R1 refactor: Service instantiation only. All command registrations and event
// wiring are delegated to CommandRegistry, EngineWiring, and PlannerWiring.

import * as vscode from 'vscode';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { RUNBOOK_FILENAME, asPhaseId } from './types/index.js';
import { StateManager } from './state/StateManager.js';
import { Engine } from './engine/Engine.js';
import { ADKController } from './adk/ADKController.js';
import { AntigravityADKAdapter } from './adk/AntigravityADKAdapter.js';
import { OutputBufferRegistry } from './adk/OutputBufferRegistry.js';
import { ContextScoper, CharRatioEncoder } from './context/ContextScoper.js';
import { ASTFileResolver } from './context/FileResolver.js';
import { TelemetryLogger } from './logger/TelemetryLogger.js';
import log, { initLog, disposeLog } from './logger/log.js';
import { parseLogLevel } from './logger/LogStream.js';
import { GitManager } from './git/GitManager.js';
import { GitSandboxManager } from './git/GitSandboxManager.js';
import { PlannerAgent } from './planner/PlannerAgent.js';
import { SessionManager, formatSessionDirName, stripSessionDirPrefix } from './session/SessionManager.js';
import { HandoffExtractor } from './context/HandoffExtractor.js';
import { ConsolidationAgent } from './consolidation/ConsolidationAgent.js';
import { CoogentMCPServer } from './mcp/CoogentMCPServer.js';
import { MCPClientBridge } from './mcp/MCPClientBridge.js';
import { SidebarMenuProvider } from './webview/SidebarMenuProvider.js';
import { MissionControlPanel } from './webview/MissionControlPanel.js';

import { ServiceContainer } from './ServiceContainer.js';
import { registerAllCommands, preFlightGitCheck } from './CommandRegistry.js';
import { wireEngine } from './EngineWiring.js';
import { wirePlanner } from './PlannerWiring.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Shared Services
// ═══════════════════════════════════════════════════════════════════════════════

const svc = new ServiceContainer();

// Re-export preFlightGitCheck for backward compatibility
export { preFlightGitCheck };

// ═══════════════════════════════════════════════════════════════════════════════
//  Extension Lifecycle
// ═══════════════════════════════════════════════════════════════════════════════

export function activate(context: vscode.ExtensionContext): void {
  // Start log stream FIRST — captures everything from this point on
  const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (wsRoot) {
    const logConfig = vscode.workspace.getConfiguration('coogent');
    const logLevel = parseLogLevel(logConfig.get<string>('logLevel', 'info'));
    const logMaxSizeMB = logConfig.get<number>('logMaxSizeMB', 5);
    const logMaxBackups = logConfig.get<number>('logMaxBackups', 2);
    initLog(wsRoot, {
      level: logLevel,
      maxLogBytes: logMaxSizeMB * 1024 * 1024,
      maxBackups: logMaxBackups,
    });
  }

  log.info('[Coogent] Extension activating...');

  // ── Register commands FIRST — must always be available ──────────────
  registerAllCommands(context, svc);

  try {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      log.warn('[Coogent] No workspace folder open — engine not initialized.');
      return;
    }
    log.info('[Coogent] Workspace root:', workspaceRoot);

    // Read extension configuration
    const config = vscode.workspace.getConfiguration('coogent');
    const tokenLimit = config.get<number>('tokenLimit', 100_000);
    const workerTimeoutMs = config.get<number>('workerTimeoutMs', 900_000);

    // ── Resolve session ────────────────────────────────────────────────
    let sessionDirName: string;
    let sessionId: string;
    const lastSessionDirName = SessionManager.loadLastSessionSync(workspaceRoot);
    if (lastSessionDirName) {
      sessionDirName = lastSessionDirName;
      sessionId = stripSessionDirPrefix(lastSessionDirName);
      log.info(`[Coogent] Restoring previous session: ${sessionDirName}`);
    } else {
      sessionId = randomUUID();
      sessionDirName = formatSessionDirName(sessionId);
      log.info(`[Coogent] Creating fresh session: ${sessionDirName}`);
    }
    const sessionDir = path.join(workspaceRoot, '.coogent', 'ipc', sessionDirName);
    svc.currentSessionDir = sessionDir;
    log.info('[Coogent] Session dir:', sessionDir);

    // ── Initialize services ────────────────────────────────────────────
    svc.stateManager = new StateManager(sessionDir);
    log.info('[Coogent] StateManager initialized');

    svc.engine = new Engine(svc.stateManager, { workspaceRoot });
    log.info('[Coogent] Engine initialized');

    svc.gitManager = new GitManager(workspaceRoot);
    svc.gitSandbox = new GitSandboxManager(workspaceRoot);

    svc.sessionManager = new SessionManager(workspaceRoot, sessionId, sessionDirName);
    svc.sessionManager.saveCurrentSession().catch(log.onError);

    const adkAdapter = new AntigravityADKAdapter(workspaceRoot);
    svc.adkController = new ADKController(adkAdapter, workspaceRoot);
    log.info('[Coogent] ADKController initialized');

    svc.contextScoper = new ContextScoper({
      encoder: new CharRatioEncoder(),
      tokenLimit,
      resolver: new ASTFileResolver(),
    });

    svc.logger = new TelemetryLogger(workspaceRoot, '.coogent/logs');
    log.info('[Coogent] TelemetryLogger initialized');

    svc.outputRegistry = new OutputBufferRegistry((phaseId, stream, chunk) => {
      MissionControlPanel.broadcast({
        type: 'PHASE_OUTPUT',
        payload: { phaseId: asPhaseId(phaseId), stream, chunk },
      });
    });

    svc.plannerAgent = new PlannerAgent(adkAdapter, {
      workspaceRoot,
      maxTreeDepth: 4,
      maxTreeChars: 8000,
    });
    svc.plannerAgent.setMasterTaskId(sessionDirName);
    log.info('[Coogent] PlannerAgent initialized');

    svc.handoffExtractor = new HandoffExtractor();
    svc.consolidationAgent = new ConsolidationAgent();

    // ── Initialize MCP Server & Client Bridge ──────────────────────────
    svc.mcpServer = new CoogentMCPServer(workspaceRoot);
    svc.mcpBridge = new MCPClientBridge(svc.mcpServer, workspaceRoot);
    svc.mcpServer.init(path.join(workspaceRoot, '.coogent'))
      .then(() => {
        log.info('[Coogent] ArtifactDB initialised.');
        return svc.mcpBridge!.connect();
      })
      .then(() => log.info('[Coogent] MCP Client Bridge connected.'))
      .catch(err => log.error('[Coogent] MCP Server/Bridge init failed:', err));

    // MCP phaseCompleted logging bridge
    svc.mcpServer.onPhaseCompleted((handoff) => {
      log.info(
        `[Coogent] MCP phaseCompleted: masterTaskId=${handoff.masterTaskId}, ` +
        `phaseId=${handoff.phaseId}`
      );
    });

    // ── Register sidebar ───────────────────────────────────────────────
    svc.sidebarMenu = new SidebarMenuProvider(svc.sessionManager);
    context.subscriptions.push(
      vscode.window.registerTreeDataProvider('coogent.sidebarMenu', svc.sidebarMenu)
    );
    svc.sidebarMenu.refresh();
    log.info('[Coogent] Activity Bar sidebar menu registered.');

    // ── Wire events (delegated) ────────────────────────────────────────
    wireEngine(svc, sessionDirName, workspaceRoot, workerTimeoutMs);
    wirePlanner(svc, sessionDirName);

    // ── Reactive configuration ─────────────────────────────────────────
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration('coogent')) return;
        const updated = vscode.workspace.getConfiguration('coogent');
        const newTokenLimit = updated.get<number>('tokenLimit', 100_000);
        const newWorkerTimeoutMs = updated.get<number>('workerTimeoutMs', 900_000);
        const newMaxRetries = updated.get<number>('maxRetries', 3);
        svc.contextScoper?.setTokenLimit(newTokenLimit);
        svc.engine?.setMaxRetries(newMaxRetries);
        if (e.affectsConfiguration('coogent.logLevel')) {
          const newLogLevel = parseLogLevel(updated.get<string>('logLevel', 'info'));
          log.setLevel(newLogLevel);
        }
        log.info(
          `[Coogent] Configuration updated: tokenLimit=${newTokenLimit}, ` +
          `workerTimeoutMs=${newWorkerTimeoutMs}, maxRetries=${newMaxRetries}`
        );
      })
    );

    // ── File system watcher — auto-reload on external runbook edit ─────
    const watcher = vscode.workspace.createFileSystemWatcher(
      `**/.coogent/ipc/**/${RUNBOOK_FILENAME}`,
      true, false, true
    );
    watcher.onDidChange(() => {
      log.info(`[Coogent] ${RUNBOOK_FILENAME} changed externally`);
      if (svc.engine?.getState() === 'IDLE') {
        svc.engine.loadRunbook().catch(log.onError);
      }
    });
    context.subscriptions.push(watcher);

    // ── Orphan cleanup & crash recovery ────────────────────────────────
    log.info('[Coogent] All event handlers wired — running cleanup & crash recovery...');
    svc.adkController.cleanupOrphanedWorkers().catch(log.onError);

    svc.stateManager.recoverFromCrash().then(async (recovered) => {
      if (recovered) {
        try {
          await svc.engine?.loadRunbook();
        } catch (err) {
          log.error('[Coogent] Failed to load recovered runbook:', err);
        }
        vscode.window.showWarningMessage(
          'Coogent: Recovered from an interrupted session. Review state before continuing.'
        );
      } else if (lastSessionDirName) {
        try {
          await svc.engine?.loadRunbook();
          log.info('[Coogent] Loaded runbook from restored session.');
        } catch (err) {
          log.info('[Coogent] No runbook in restored session (may be idle).');
        }
      }
    }).catch(log.onError);

    log.info('[Coogent] Extension activated.');

  } catch (err: any) {
    const msg = err?.message || String(err);
    vscode.window.showErrorMessage(`[Coogent] Activation failed: ${msg}`);
    log.error('[Coogent] Activation error:', err);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Extension Deactivation
// ═══════════════════════════════════════════════════════════════════════════════

export async function deactivate(): Promise<void> {
  log.info('[Coogent] Extension deactivating...');

  await Promise.allSettled([
    svc.engine?.abort().catch(log.onError),
    svc.adkController?.killAllWorkers().catch(log.onError),
    svc.plannerAgent?.abort().catch(log.onError),
    svc.mcpBridge?.disconnect().catch((err) =>
      log.warn('[Coogent] deactivate: mcpBridge.disconnect() threw:', err)
    ),
  ]);

  svc.outputRegistry?.dispose();

  try {
    svc.mcpServer?.dispose();
  } catch (err) {
    log.warn('[Coogent] deactivate: mcpServer.dispose() threw:', err);
  }

  svc.releaseAll();
  disposeLog();
}
