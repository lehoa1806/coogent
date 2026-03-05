// ─────────────────────────────────────────────────────────────────────────────
// src/extension.ts — Main entry point: wires Engine ↔ ADK ↔ Context ↔ Panel
// ─────────────────────────────────────────────────────────────────────────────

import * as vscode from 'vscode';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Phase, HostToWebviewMessage } from './types/index.js';
import { StateManager } from './state/StateManager.js';
import { Engine } from './engine/Engine.js';
import { ADKController } from './adk/ADKController.js';
import { AntigravityADKAdapter } from './adk/AntigravityADKAdapter.js';
import { OutputBufferRegistry } from './adk/OutputBufferRegistry.js';
import { ContextScoper, CharRatioEncoder } from './context/ContextScoper.js';
import { ASTFileResolver } from './context/FileResolver.js';
import { TelemetryLogger } from './logger/TelemetryLogger.js';
import { GitManager } from './git/GitManager.js';
import { MissionControlPanel } from './webview/MissionControlPanel.js';
import { PlannerAgent } from './planner/PlannerAgent.js';
import { SessionManager } from './session/SessionManager.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  UUIDv7 — time-ordered session ID
// ═══════════════════════════════════════════════════════════════════════════════

function uuidv7(): string {
  const now = Date.now();
  const timeHex = now.toString(16).padStart(12, '0');
  const rand = randomBytes(10).toString('hex');
  return [
    timeHex.slice(0, 8),
    timeHex.slice(8, 12),
    '7' + rand.slice(0, 3),
    ((parseInt(rand.slice(3, 4), 16) & 0x3) | 0x8).toString(16) + rand.slice(4, 7),
    rand.slice(7, 19),
  ].join('-');
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Singletons — initialized in activate()
// ═══════════════════════════════════════════════════════════════════════════════

let stateManager: StateManager | undefined;
let engine: Engine | undefined;
let adkController: ADKController | undefined;
let contextScoper: ContextScoper | undefined;
let logger: TelemetryLogger | undefined;
let gitManager: GitManager | undefined;
let outputRegistry: OutputBufferRegistry | undefined;
let plannerAgent: PlannerAgent | undefined;
let sessionManager: SessionManager | undefined;

// ═══════════════════════════════════════════════════════════════════════════════
//  Extension Lifecycle
// ═══════════════════════════════════════════════════════════════════════════════

export function activate(context: vscode.ExtensionContext): void {
  vscode.window.showInformationMessage('[Coogent DEBUG] activate() called!');
  console.log('[Coogent] Extension activating...');

  // ─── Register commands FIRST — must always be available ──────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('coogent.openMissionControl', () => {
      console.log('[Coogent DEBUG] openMissionControl command invoked!');
      if (!engine) {
        vscode.window.showWarningMessage(
          'Coogent: Open a workspace folder first to use Mission Control.'
        );
        return;
      }
      MissionControlPanel.createOrShow(context.extensionUri, engine, sessionManager, adkController);
    })
  );
  console.log('[Coogent DEBUG] ✅ Command registered (before workspace check)');

  try {

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      console.warn('[Coogent] No workspace folder open — engine not initialized.');
      return;
    }
    console.log('[Coogent DEBUG] Step 1/10 — workspaceRoot:', workspaceRoot);

    // Read extension configuration
    const config = vscode.workspace.getConfiguration('coogent');
    const tokenLimit = config.get<number>('tokenLimit', 100_000);
    const workerTimeoutMs = config.get<number>('workerTimeoutMs', 300_000);
    console.log('[Coogent DEBUG] Step 2/10 — config loaded (tokenLimit=%d, timeout=%d)', tokenLimit, workerTimeoutMs);

    // ─── Initialize services ───────────────────────────────────────────
    const sessionId = uuidv7();
    const sessionDir = path.join(workspaceRoot, '.coogent', 'ipc', sessionId);
    console.log('[Coogent DEBUG] Session ID:', sessionId);

    stateManager = new StateManager(sessionDir);
    console.log('[Coogent DEBUG] Step 3/10 — StateManager created (sessionDir: %s)', sessionDir);

    engine = new Engine(stateManager, { workspaceRoot });
    console.log('[Coogent DEBUG] Step 4/10 — Engine created');

    gitManager = new GitManager(workspaceRoot);
    console.log('[Coogent DEBUG] Step 5/10 — GitManager created');

    sessionManager = new SessionManager(workspaceRoot, sessionId);
    console.log('[Coogent DEBUG] Step 5.1/10 — SessionManager created');

    const adkAdapter = new AntigravityADKAdapter(workspaceRoot);
    adkController = new ADKController(adkAdapter, workspaceRoot);
    console.log('[Coogent DEBUG] Step 6/10 — ADKController created');

    contextScoper = new ContextScoper({
      encoder: new CharRatioEncoder(),
      tokenLimit,
      resolver: new ASTFileResolver(),
    });
    console.log('[Coogent DEBUG] Step 7/10 — ContextScoper created');

    logger = new TelemetryLogger(workspaceRoot, '.coogent/logs');
    console.log('[Coogent DEBUG] Step 8/10 — TelemetryLogger created');

    // Output buffer registry — replaces module-level Map (02-review.md § R11)
    outputRegistry = new OutputBufferRegistry((phaseId, stream, chunk) => {
      MissionControlPanel.broadcast({
        type: 'WORKER_OUTPUT',
        payload: { phaseId, stream, chunk },
      });
    });
    console.log('[Coogent DEBUG] Step 9/10 — OutputBufferRegistry created');

    // ─── Initialize Planner Agent ────────────────────────────────────
    plannerAgent = new PlannerAgent(adkAdapter, {
      workspaceRoot,
      maxTreeDepth: 4,
      maxTreeChars: 8000,
    });
    console.log('[Coogent DEBUG] Step 9.1/10 — PlannerAgent created');

    // ─── Wire Engine → Webview ─────────────────────────────────────────
    engine.on('ui:message', (message: HostToWebviewMessage) => {
      MissionControlPanel.broadcast(message);
    });

    // ─── Wire Engine → Logger ──────────────────────────────────────────
    engine.on('state:changed', (from, to, event) => {
      logger?.logStateTransition(from, to, event).catch(console.error);
    });

    // ─── Wire Engine → ADK (phase execution) ───────────────────────────
    engine.on('phase:execute', (phase: Phase) => {
      executePhase(phase, workspaceRoot, workerTimeoutMs, sessionId).catch((err) => {
        console.error('[Coogent] Phase execution error:', err);
      });
    });

    // ─── Wire Engine → SelfHealing (Pillar 3) ──────────────────────────
    engine.on('phase:heal', (phase: Phase, augmentedPrompt: string) => {
      // Clone the phase and override prompt for the newly spawned worker
      const healPhase = { ...phase, prompt: augmentedPrompt };
      executePhase(healPhase, workspaceRoot, workerTimeoutMs, sessionId).catch((err) => {
        console.error('[Coogent] Self-healing phase execution error:', err);
      });
    });

    // ─── Wire Engine → GitManager (Pillar 3) ───────────────────────────
    engine.on('phase:checkpoint', (phaseId: number) => {
      gitManager?.snapshotCommit(phaseId).then(res => {
        if (res.success) {
          MissionControlPanel.broadcast({
            type: 'LOG_ENTRY',
            payload: { timestamp: Date.now(), level: 'info', message: res.message }
          });
        }
      }).catch(console.error);
    });

    // ─── Wire ADK → Engine (worker lifecycle) ──────────────────────────
    adkController.on('worker:exited', (phaseId, exitCode) => {
      outputRegistry?.flushAndRemove(phaseId);
      engine?.onWorkerExited(phaseId, exitCode).catch(console.error);
    });

    adkController.on('worker:timeout', (phaseId) => {
      outputRegistry?.flushAndRemove(phaseId);
      engine?.onWorkerFailed(phaseId, 'timeout').catch(console.error);
    });

    adkController.on('worker:crash', (phaseId) => {
      outputRegistry?.flushAndRemove(phaseId);
      engine?.onWorkerFailed(phaseId, 'crash').catch(console.error);
    });

    // ─── Wire ADK → Webview (output streaming) ────────────────────────
    adkController.on('worker:output', (phaseId, stream, chunk) => {
      outputRegistry?.getOrCreate(phaseId, stream).append(chunk);
      logger?.logPhaseOutput(phaseId, stream, chunk).catch(console.error);
    });

    // ─── Wire Engine → PlannerAgent ─────────────────────────────────
    engine.on('plan:request', (prompt: string) => {
      plannerAgent?.plan(prompt).catch(console.error);
    });

    engine.on('plan:rejected', (prompt: string, feedback: string) => {
      plannerAgent?.plan(prompt, feedback).catch(console.error);
    });

    // ─── Wire PlannerAgent → Engine ─────────────────────────────────
    plannerAgent.on('plan:generated', (draft, fileTree) => {
      engine?.planGenerated(draft, fileTree);
    });

    plannerAgent.on('plan:error', (error) => {
      MissionControlPanel.broadcast({
        type: 'PLAN_STATUS',
        payload: { status: 'error', message: error.message },
      });
      MissionControlPanel.broadcast({
        type: 'ERROR',
        payload: { code: 'PLAN_ERROR', message: error.message },
      });
      // Abort back to IDLE on planning failure
      engine?.abort().catch(console.error);
    });

    plannerAgent.on('plan:status', (status, message) => {
      MissionControlPanel.broadcast({
        type: 'PLAN_STATUS',
        payload: { status, message },
      });
    });

    console.log('[Coogent DEBUG] Step 9.5/10 — All event wiring complete');

    console.log('[Coogent DEBUG] Step 10/10 — All services initialized');

    // ─── List all registered commands for debugging ────────────────────
    vscode.commands.getCommands(true).then((cmds) => {
      const coogentCmds = cmds.filter(c => c.startsWith('coogent'));
      console.log('[Coogent DEBUG] Registered coogent commands:', JSON.stringify(coogentCmds));
    });

    // ─── File system watcher — auto-reload on external runbook edit ───
    const watcher = vscode.workspace.createFileSystemWatcher(
      '**/.coogent/ipc/**/.task-runbook.json',
      true,   // ignoreCreateEvents
      false,  // ignoreChangeEvents
      true    // ignoreDeleteEvents
    );
    watcher.onDidChange(() => {
      console.log('[Coogent] .task-runbook.json changed externally');
      // Only reload if the engine is in a state that accepts LOAD_RUNBOOK
      if (engine?.getState() === 'IDLE') {
        engine.loadRunbook().catch(console.error);
      }
    });
    context.subscriptions.push(watcher);

    // ─── Orphan cleanup & crash recovery ───────────────────────────────
    adkController.cleanupOrphanedWorkers().catch(console.error);

    stateManager.recoverFromCrash().then(async (recovered) => {
      if (recovered) {
        // P0-3 fix: Hydrate the engine with the recovered runbook so FSM
        // state matches disk. Without this, the engine stays in IDLE.
        try {
          await engine?.loadRunbook();
        } catch (err) {
          console.error('[Coogent] Failed to load recovered runbook:', err);
        }
        vscode.window.showWarningMessage(
          'Coogent: Recovered from an interrupted session. Review state before continuing.'
        );
      }
    }).catch(console.error);

    vscode.window.showInformationMessage('[Coogent DEBUG] Extension activated successfully — command should be available now');
    console.log('[Coogent] Extension activated.');

  } catch (err: any) {
    const msg = err?.message || String(err);
    vscode.window.showErrorMessage(`[Coogent DEBUG] activate() FAILED: ${msg}`);
    console.error('[Coogent] Activation error:', err);
  }
}

export function deactivate(): void {
  console.log('[Coogent] Extension deactivating...');
  plannerAgent?.abort().catch(console.error);
  adkController?.terminateAll('IDE_SHUTDOWN').catch(console.error);
  outputRegistry?.dispose();
  // StateManager singleton removed (02-review.md § R10) — GC'd via reference clear
  stateManager = undefined;
  engine = undefined;
  adkController = undefined;
  contextScoper = undefined;
  logger = undefined;
  gitManager = undefined;
  outputRegistry = undefined;
  plannerAgent = undefined;
  sessionManager = undefined;
  console.log('[Coogent] Extension deactivated.');
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Phase Execution Pipeline
// ═══════════════════════════════════════════════════════════════════════════════

async function executePhase(
  phase: Phase,
  workspaceRoot: string,
  timeoutMs: number,
  masterTaskId: string
): Promise<void> {
  if (!contextScoper || !adkController || !logger) return;

  // Step 1: Assemble context
  const result = await contextScoper.assemble(phase, workspaceRoot);

  if (!result.ok) {
    MissionControlPanel.broadcast({
      type: 'TOKEN_BUDGET',
      payload: {
        phaseId: phase.id,
        breakdown: result.breakdown,
        totalTokens: result.totalTokens,
        limit: result.limit,
      },
    });
    MissionControlPanel.broadcast({
      type: 'ERROR',
      payload: {
        code: 'TOKEN_OVER_BUDGET',
        message: `Phase ${phase.id} context exceeds token limit (${result.totalTokens}/${result.limit}).`,
        phaseId: phase.id,
      },
    });
    engine?.onWorkerFailed(phase.id, 'crash').catch(console.error);
    return;
  }

  // Step 2: Log context assembly
  await logger.logContextAssembly(
    phase.id, result.totalTokens, result.limit, result.breakdown.length
  );

  // Step 3: Send token budget to UI
  MissionControlPanel.broadcast({
    type: 'TOKEN_BUDGET',
    payload: {
      phaseId: phase.id,
      breakdown: result.breakdown,
      totalTokens: result.totalTokens,
      limit: result.limit,
    },
  });

  // Step 4: Log the injected prompt
  await logger.logPhasePrompt(phase.id, phase.prompt);

  // Step 5: Initialize telemetry run (on first phase)
  const runbook = engine?.getRunbook();
  if (runbook && phase.id === 0) {
    await logger.initRun(runbook.project_id);
  }

  // Step 6: Spawn the worker
  await adkController.spawnWorker(phase, result.payload, timeoutMs, masterTaskId);
}
