// ─────────────────────────────────────────────────────────────────────────────
// src/extension.ts — Main entry point: wires Engine ↔ ADK ↔ Context ↔ Panel
// ─────────────────────────────────────────────────────────────────────────────

import * as vscode from 'vscode';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { RUNBOOK_FILENAME, asPhaseId, asTimestamp } from './types/index.js';
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
import { GitSandboxManager } from './git/GitSandboxManager.js';
import { MissionControlPanel } from './webview/MissionControlPanel.js';
import { PlannerAgent } from './planner/PlannerAgent.js';
import { SessionManager } from './session/SessionManager.js';
import { HandoffExtractor } from './context/HandoffExtractor.js';
import { ConsolidationAgent } from './consolidation/ConsolidationAgent.js';

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
let gitSandbox: GitSandboxManager | undefined;
let outputRegistry: OutputBufferRegistry | undefined;
let plannerAgent: PlannerAgent | undefined;
let sessionManager: SessionManager | undefined;
let handoffExtractor: HandoffExtractor | undefined;
let consolidationAgent: ConsolidationAgent | undefined;
let currentSessionDir: string | undefined;
const workerOutputAccumulator = new Map<number, string>();

// ═══════════════════════════════════════════════════════════════════════════════
//  Pre-flight Git Check — reusable helper (exported for MissionControlPanel)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check whether the working tree is clean before starting execution.
 * Uses the native VS Code Git API via GitSandboxManager (no destructive stash).
 *
 * @param sandbox - The GitSandboxManager instance, or undefined if Git is not available.
 * @returns `{ blocked: true, message }` if dirty, `{ blocked: false }` if clean or unavailable.
 */
export async function preFlightGitCheck(
  sandbox: GitSandboxManager | undefined
): Promise<{ blocked: true; message: string } | { blocked: false }> {
  if (!sandbox) {
    return { blocked: false };
  }
  try {
    const result = await sandbox.preFlightCheck();
    if (result.clean === false) {
      return { blocked: true, message: result.message };
    }
    return { blocked: false };
  } catch (err) {
    console.warn('[Coogent] Git pre-flight check failed (non-blocking):', err);
    return { blocked: false };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Extension Lifecycle
// ═══════════════════════════════════════════════════════════════════════════════

export function activate(context: vscode.ExtensionContext): void {
  // Extension lifecycle starts
  console.log('[Coogent] Extension activating...');

  // ─── Register commands FIRST — must always be available ──────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('coogent.openMissionControl', () => {
      if (!engine) {
        vscode.window.showWarningMessage(
          'Coogent: Open a workspace folder first to use Mission Control.'
        );
        return;
      }
      MissionControlPanel.createOrShow(
        context.extensionUri, engine, sessionManager, adkController,
        () => preFlightGitCheck(gitSandbox)
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('coogent.loadRunbook', async () => {
      if (!engine) {
        vscode.window.showWarningMessage('Coogent: No workspace — cannot load runbook.');
        return;
      }
      try {
        await engine.loadRunbook();
      } catch (err: any) {
        vscode.window.showErrorMessage(`Coogent: Failed to load runbook — ${err?.message ?? err}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('coogent.start', async () => {
      if (!engine) {
        vscode.window.showWarningMessage('Coogent: No workspace — cannot start.');
        return;
      }
      // Git pre-flight: check for dirty working tree (Req §7)
      const check = await preFlightGitCheck(gitSandbox);
      if (check.blocked) {
        const proceed = await vscode.window.showWarningMessage(
          `Coogent: ${check.message}`,
          'Continue Anyway',
          'Cancel'
        );
        if (proceed !== 'Continue Anyway') return;
      }
      try {
        await engine.start();
      } catch (err: any) {
        vscode.window.showErrorMessage(`Coogent: Start failed — ${err?.message ?? err}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('coogent.pause', () => {
      if (!engine) {
        vscode.window.showWarningMessage('Coogent: No workspace — cannot pause.');
        return;
      }
      engine.pause();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('coogent.reset', async () => {
      if (!engine) {
        vscode.window.showWarningMessage('Coogent: No workspace — cannot reset.');
        return;
      }
      try {
        // Create a fresh session for the reset
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (workspaceRoot) {
          const newId = uuidv7();
          const newDir = path.join(workspaceRoot, '.coogent', 'ipc', newId);
          currentSessionDir = newDir;
          const newSM = new StateManager(newDir);
          await engine.reset(newSM);
          sessionManager = new SessionManager(workspaceRoot, newId);
        } else {
          await engine.reset();
        }
      } catch (err: any) {
        vscode.window.showErrorMessage(`Coogent: Reset failed — ${err?.message ?? err}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('coogent.resumePending', async () => {
      if (!engine) {
        vscode.window.showWarningMessage('Coogent: No workspace — cannot resume.');
        return;
      }
      try {
        await engine.resumePending();
      } catch (err: any) {
        vscode.window.showErrorMessage(`Coogent: Resume failed — ${err?.message ?? err}`);
      }
    })
  );

  try {

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      console.warn('[Coogent] No workspace folder open — engine not initialized.');
      return;
    }


    // Read extension configuration
    const config = vscode.workspace.getConfiguration('coogent');
    const tokenLimit = config.get<number>('tokenLimit', 100_000);
    const workerTimeoutMs = config.get<number>('workerTimeoutMs', 300_000);


    // ─── Initialize services ───────────────────────────────────────────
    const sessionId = uuidv7();
    const sessionDir = path.join(workspaceRoot, '.coogent', 'ipc', sessionId);
    currentSessionDir = sessionDir;


    stateManager = new StateManager(sessionDir);


    engine = new Engine(stateManager, { workspaceRoot });


    gitManager = new GitManager(workspaceRoot);

    gitSandbox = new GitSandboxManager(workspaceRoot);


    sessionManager = new SessionManager(workspaceRoot, sessionId);


    const adkAdapter = new AntigravityADKAdapter(workspaceRoot);
    adkController = new ADKController(adkAdapter, workspaceRoot);


    contextScoper = new ContextScoper({
      encoder: new CharRatioEncoder(),
      tokenLimit,
      resolver: new ASTFileResolver(),
    });


    logger = new TelemetryLogger(workspaceRoot, '.coogent/logs');


    // Output buffer registry — replaces module-level Map (02-review.md § R11)
    outputRegistry = new OutputBufferRegistry((phaseId, stream, chunk) => {
      MissionControlPanel.broadcast({
        type: 'WORKER_OUTPUT',
        payload: { phaseId: asPhaseId(phaseId), stream, chunk },
      });
    });


    // ─── Initialize Planner Agent ────────────────────────────────────
    plannerAgent = new PlannerAgent(adkAdapter, {
      workspaceRoot,
      maxTreeDepth: 4,
      maxTreeChars: 8000,
    });

    // ─── Initialize HandoffExtractor & ConsolidationAgent ────────────
    handoffExtractor = new HandoffExtractor();
    consolidationAgent = new ConsolidationAgent();


    // ─── Wire Engine → Webview ─────────────────────────────────────────
    engine.on('ui:message', (message: HostToWebviewMessage) => {
      MissionControlPanel.broadcast(message);
    });

    // ─── Wire Engine → Logger + Webview (state:changed) ────────────────
    engine.on('state:changed', (from, to, event) => {
      logger?.logStateTransition(from, to, event).catch(console.error);

      // Broadcast STATE_SNAPSHOT to webview on every state transition (Req §3)
      const rb = engine?.getRunbook();
      MissionControlPanel.broadcast({
        type: 'STATE_SNAPSHOT',
        payload: {
          runbook: rb ?? { project_id: '', status: 'idle', current_phase: 0, phases: [] },
          engineState: to,
        },
      });
    });

    // ─── Wire Engine → run:completed (log completion) ──────────────────
    engine.on('run:completed', (runbook) => {
      const phaseCount = runbook.phases.length;
      const completedCount = runbook.phases.filter(p => p.status === 'completed').length;
      console.log(
        `[Coogent] Run completed: ${completedCount}/${phaseCount} phases completed ` +
        `for project "${runbook.project_id}".`
      );
      MissionControlPanel.broadcast({
        type: 'LOG_ENTRY',
        payload: {
          timestamp: asTimestamp(),
          level: 'info',
          message: `✅ Run completed: ${completedCount}/${phaseCount} phases for "${runbook.project_id}".`,
        },
      });
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
            payload: { timestamp: asTimestamp(), level: 'info', message: res.message }
          });
        }
      }).catch(console.error);
    });

    // ─── Wire ADK → Engine (worker lifecycle) ──────────────────────────
    adkController.on('worker:exited', (phaseId, exitCode) => {
      outputRegistry?.flushAndRemove(phaseId);

      // Extract and save handoff report on successful exit
      if (exitCode === 0 && handoffExtractor && currentSessionDir) {
        const accumulatedOutput = workerOutputAccumulator.get(phaseId) ?? '';
        workerOutputAccumulator.delete(phaseId);
        handoffExtractor.extractHandoff(phaseId, accumulatedOutput, workspaceRoot)
          .then(report => handoffExtractor!.saveHandoff(phaseId, report, currentSessionDir!))
          .catch(err => console.error('[Coogent] Handoff extraction error:', err));
      } else {
        workerOutputAccumulator.delete(phaseId);
      }

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

      // Route output to per-phase detail views
      MissionControlPanel.broadcast({
        type: 'PHASE_OUTPUT',
        payload: { phaseId: asPhaseId(phaseId), stream, chunk },
      });

      // Accumulate stdout for handoff extraction
      if (stream === 'stdout') {
        const existing = workerOutputAccumulator.get(phaseId) ?? '';
        workerOutputAccumulator.set(phaseId, existing + chunk);
      }
    });

    // ─── Wire Engine → PlannerAgent ─────────────────────────────────
    engine.on('plan:request', (prompt: string) => {
      plannerAgent?.plan(prompt).catch(console.error);
    });

    engine.on('plan:rejected', (prompt: string, feedback: string) => {
      plannerAgent?.plan(prompt, feedback).catch(console.error);
    });

    engine.on('plan:retryParse', () => {
      plannerAgent?.retryParse().catch(console.error);
    });

    // ─── Wire PlannerAgent → Engine ─────────────────────────────────
    plannerAgent.on('plan:generated', (draft, fileTree) => {
      engine?.planGenerated(draft, fileTree);

      // Broadcast planning summary to webview for the Master Task hero section
      MissionControlPanel.broadcast({
        type: 'PLAN_SUMMARY',
        payload: {
          summary: draft.summary || draft.project_id,
          implementationPlan: draft.implementation_plan || '',
        },
      });
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

    plannerAgent.on('plan:timeout', (hasOutput) => {
      // Check if retry is possible: either cached streaming output OR file-IPC session dir
      const canRetry = hasOutput || plannerAgent?.hasTimeoutOutput();

      MissionControlPanel.broadcast({
        type: 'PLAN_STATUS',
        payload: {
          status: 'timeout',
          message: canRetry
            ? 'Planner timed out — click "Retry Parse" to check for the response file on disk.'
            : 'Planner timed out with no output. Please regenerate the plan.',
        },
      });
      // Only abort to IDLE if there's truly nothing to retry from
      if (!canRetry) {
        engine?.abort().catch(console.error);
      }
      // Otherwise engine stays in PLANNING — user can send CMD_PLAN_RETRY_PARSE
    });

    plannerAgent.on('plan:status', (status, message) => {
      MissionControlPanel.broadcast({
        type: 'PLAN_STATUS',
        payload: { status, ...(message !== undefined && { message }) },
      });
    });

    // ─── Wire Engine → ConsolidationAgent ──────────────────────────────
    engine.on('run:consolidate', (evtSessionDir: string) => {
      const runbook = engine?.getRunbook();
      if (!consolidationAgent || !runbook) return;

      consolidationAgent.generateReport(evtSessionDir, runbook)
        .then(report => {
          return consolidationAgent!.saveReport(evtSessionDir, report)
            .then(reportPath => ({ reportPath, report }));
        })
        .then(({ reportPath, report }) => {
          MissionControlPanel.broadcast({
            type: 'LOG_ENTRY',
            payload: {
              timestamp: asTimestamp(),
              level: 'info',
              message: `Consolidation report saved: ${reportPath}`,
            },
          });

          // Auto-broadcast the report to the webview (#BUG-5)
          const markdown = consolidationAgent!.formatAsMarkdown(report);
          MissionControlPanel.broadcast({
            type: 'CONSOLIDATION_REPORT',
            payload: { report: markdown },
          });
        })
        .catch(err => {
          console.error('[Coogent] Consolidation error:', err);
          MissionControlPanel.broadcast({
            type: 'LOG_ENTRY',
            payload: {
              timestamp: asTimestamp(),
              level: 'error',
              message: `Consolidation report generation failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          });
        });
    });

    // ─── Git Sandbox commands ──────────────────────────────────────────
    context.subscriptions.push(
      vscode.commands.registerCommand('coogent.preFlightCheck', async () => {
        try {
          const result = await gitSandbox!.preFlightCheck();
          if (result.clean) {
            vscode.window.showInformationMessage(`Coogent: ${result.message}`);
          } else {
            vscode.window.showWarningMessage(`Coogent: ${result.message}`);
          }
        } catch (err: any) {
          vscode.window.showErrorMessage(`Coogent: Pre-flight check failed — ${err?.message ?? err}`);
        }
      })
    );

    context.subscriptions.push(
      vscode.commands.registerCommand('coogent.createSandbox', async () => {
        const slug = await vscode.window.showInputBox({ prompt: 'Enter a task slug (e.g., feat-auth-flow)' });
        if (!slug) return;
        try {
          const result = await gitSandbox!.createSandboxBranch({ taskSlug: slug });
          if (result.success) {
            vscode.window.showInformationMessage(`Coogent: ${result.message}`);
          } else {
            vscode.window.showErrorMessage(`Coogent: ${result.message}`);
          }
        } catch (err: any) {
          vscode.window.showErrorMessage(`Coogent: Failed to create sandbox — ${err?.message ?? err}`);
        }
      })
    );

    context.subscriptions.push(
      vscode.commands.registerCommand('coogent.openDiffReview', async () => {
        try {
          const result = await gitSandbox!.openDiffReview();
          if (result.success) {
            vscode.window.showInformationMessage(`Coogent: ${result.message}`);
          } else {
            vscode.window.showErrorMessage(`Coogent: ${result.message}`);
          }
        } catch (err: any) {
          vscode.window.showErrorMessage(`Coogent: Failed to open diff review — ${err?.message ?? err}`);
        }
      })
    );



    // ─── Reactive configuration — propagate setting changes (#97) ────
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration('coogent')) return;

        const updated = vscode.workspace.getConfiguration('coogent');
        const newTokenLimit = updated.get<number>('tokenLimit', 100_000);
        const newWorkerTimeoutMs = updated.get<number>('workerTimeoutMs', 300_000);
        const newMaxRetries = updated.get<number>('maxRetries', 3);

        // Propagate to ContextScoper
        if (contextScoper) {
          contextScoper.setTokenLimit(newTokenLimit);
        }

        // Propagate to Engine
        if (engine) {
          engine.setMaxRetries(newMaxRetries);
        }

        console.log(
          `[Coogent] Configuration updated: tokenLimit=${newTokenLimit}, ` +
          `workerTimeoutMs=${newWorkerTimeoutMs}, maxRetries=${newMaxRetries}`
        );
      })
    );

    // ─── File system watcher — auto-reload on external runbook edit ───
    const watcher = vscode.workspace.createFileSystemWatcher(
      `**/.coogent/ipc/**/${RUNBOOK_FILENAME}`,
      true,   // ignoreCreateEvents
      false,  // ignoreChangeEvents
      true    // ignoreDeleteEvents
    );
    watcher.onDidChange(() => {
      console.log(`[Coogent] ${RUNBOOK_FILENAME} changed externally`);
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


    console.log('[Coogent] Extension activated.');

  } catch (err: any) {
    const msg = err?.message || String(err);
    vscode.window.showErrorMessage(`[Coogent] Activation failed: ${msg}`);
    console.error('[Coogent] Activation error:', err);
  }
}

export async function deactivate(): Promise<void> {
  console.log('[Coogent] Extension deactivating...');

  // Graceful shutdown: abort engine + kill all workers in parallel (Req §6)
  await Promise.allSettled([
    engine?.abort().catch(console.error),
    adkController?.killAllWorkers().catch(console.error),
    plannerAgent?.abort().catch(console.error),
  ]);

  // Flush any remaining output buffers
  outputRegistry?.dispose();

  // Release all references for GC
  stateManager = undefined;
  engine = undefined;
  adkController = undefined;
  contextScoper = undefined;
  logger = undefined;
  gitManager = undefined;
  gitSandbox = undefined;
  outputRegistry = undefined;
  plannerAgent = undefined;
  sessionManager = undefined;
  handoffExtractor = undefined;
  consolidationAgent = undefined;
  currentSessionDir = undefined;
  workerOutputAccumulator.clear();
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
  if (!contextScoper || !adkController || !logger) {
    engine?.onWorkerFailed(phase.id, 'crash').catch(console.error);
    return;
  }

  // Step 0: Log phase start (Req §5)
  await logger.logPhaseStart(phase.id);

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

  // Step 5.5: Build handoff context from dependent phases
  let handoffContext = '';
  if (handoffExtractor && currentSessionDir) {
    try {
      handoffContext = await handoffExtractor.buildNextContext(phase, currentSessionDir, workspaceRoot);
    } catch (err) {
      console.error('[Coogent] Failed to build handoff context:', err);
    }
  }

  // Step 6: Spawn the worker
  // Build the full effective prompt:
  //   1. Handoff context from dependency phases (if any)
  //   2. The original phase prompt
  //   3. Distillation instructions (tells worker to produce JSON handoff block)
  const distillationPrompt = handoffExtractor?.generateDistillationPrompt(phase.id as number) ?? '';
  let effectivePrompt = phase.prompt;
  if (handoffContext) {
    effectivePrompt = `# Context from Previous Phases\n\n${handoffContext}\n---\n\n${effectivePrompt}`;
  }
  if (distillationPrompt) {
    effectivePrompt = `${effectivePrompt}\n\n---\n\n${distillationPrompt}`;
  }
  const effectivePhase = { ...phase, prompt: effectivePrompt };
  await adkController.spawnWorker(effectivePhase, result.payload, timeoutMs, masterTaskId);
}
