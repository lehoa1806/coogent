// ─────────────────────────────────────────────────────────────────────────────
// src/extension.ts — Main entry point: wires Engine ↔ ADK ↔ Context ↔ Panel
// ─────────────────────────────────────────────────────────────────────────────

import * as vscode from 'vscode';
import * as path from 'node:path';

import { randomUUID } from 'node:crypto';
import { RUNBOOK_FILENAME, asPhaseId, asTimestamp, EngineState } from './types/index.js';
import type { Phase, HostToWebviewMessage } from './types/index.js';
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
import { MissionControlPanel } from './webview/MissionControlPanel.js';
import { MissionControlViewProvider } from './webview/MissionControlViewProvider.js';
import { PlannerAgent } from './planner/PlannerAgent.js';
import { SessionManager, formatSessionDirName, stripSessionDirPrefix } from './session/SessionManager.js';
import { HandoffExtractor } from './context/HandoffExtractor.js';
import { ConsolidationAgent } from './consolidation/ConsolidationAgent.js';
import { CoogentMCPServer } from './mcp/CoogentMCPServer.js';
import { MCPClientBridge } from './mcp/MCPClientBridge.js';
import { buildImplementationPlanMarkdown } from './utils/planMarkdown.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Session ID — W-3: Uses spec-compliant crypto.randomUUID() (Node 19+)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Generate a standard UUID v4 for session identification.
 * Chronological ordering is provided by `formatSessionDirName()`'s timestamp prefix.
 */
function generateSessionId(): string {
  return randomUUID();
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Singletons — initialized in activate()
// ═══════════════════════════════════════════════════════════════════════════════

let stateManager: StateManager | undefined;
let engine: Engine | undefined;
let adkController: ADKController | undefined;
let contextScoper: ContextScoper | undefined;
let logger: TelemetryLogger | undefined;
// LogStream is managed via the singleton in log.ts (initLog / disposeLog)
let gitManager: GitManager | undefined;
let gitSandbox: GitSandboxManager | undefined;
let outputRegistry: OutputBufferRegistry | undefined;
let plannerAgent: PlannerAgent | undefined;
let sessionManager: SessionManager | undefined;
let handoffExtractor: HandoffExtractor | undefined;
let consolidationAgent: ConsolidationAgent | undefined;
let currentSessionDir: string | undefined;
let mcpServer: CoogentMCPServer | undefined;
let mcpBridge: MCPClientBridge | undefined;
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
    log.warn('[Coogent] Git pre-flight check failed (non-blocking):', err);
    return { blocked: false };
  }
}

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

  // Extension lifecycle starts
  log.info('[Coogent] Extension activating...');

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
        () => preFlightGitCheck(gitSandbox),
        // onReset callback: update module-level state when webview triggers a new session
        (newDir, newDirName) => {
          currentSessionDir = newDir;
          plannerAgent?.setMasterTaskId(newDirName);
          // Persist the new session
          sessionManager?.setCurrentSessionId(newDirName.replace(/^\d{8}-\d{6}-/, ''), newDirName);
          sessionManager?.saveCurrentSession().catch(log.onError);
        },
        mcpServer,
        mcpBridge
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
          const newId = generateSessionId();
          const newDirName = formatSessionDirName(newId);
          const newDir = path.join(workspaceRoot, '.coogent', 'ipc', newDirName);
          // B-4: Purge old session from MCP store before switching
          if (currentSessionDir && mcpServer) {
            mcpServer.purgeTask(path.basename(currentSessionDir));
          }
          currentSessionDir = newDir;
          const newSM = new StateManager(newDir);
          await engine.reset(newSM);
          sessionManager = new SessionManager(workspaceRoot, newId, newDirName);
          sessionManager.saveCurrentSession().catch(log.onError);
          plannerAgent?.setMasterTaskId(newDirName);
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
      log.warn('[Coogent] No workspace folder open — engine not initialized.');
      return;
    }
    log.info('[Coogent] Workspace root:', workspaceRoot);


    // Read extension configuration
    const config = vscode.workspace.getConfiguration('coogent');
    const tokenLimit = config.get<number>('tokenLimit', 100_000);
    const workerTimeoutMs = config.get<number>('workerTimeoutMs', 900_000);


    // ─── Initialize services ───────────────────────────────────────────
    // Try restoring the last active session before creating a new one
    let sessionDirName: string;
    let sessionId: string;
    const lastSessionDirName = SessionManager.loadLastSessionSync(workspaceRoot);
    if (lastSessionDirName) {
      sessionDirName = lastSessionDirName;
      sessionId = stripSessionDirPrefix(lastSessionDirName);
      log.info(`[Coogent] Restoring previous session: ${sessionDirName}`);
    } else {
      sessionId = generateSessionId();
      sessionDirName = formatSessionDirName(sessionId);
      log.info(`[Coogent] Creating fresh session: ${sessionDirName}`);
    }
    const sessionDir = path.join(workspaceRoot, '.coogent', 'ipc', sessionDirName);
    currentSessionDir = sessionDir;
    log.info('[Coogent] Session dir:', sessionDir);

    stateManager = new StateManager(sessionDir);
    log.info('[Coogent] StateManager initialized');


    engine = new Engine(stateManager, { workspaceRoot });
    log.info('[Coogent] Engine initialized');


    gitManager = new GitManager(workspaceRoot);

    gitSandbox = new GitSandboxManager(workspaceRoot);


    sessionManager = new SessionManager(workspaceRoot, sessionId, sessionDirName);
    // Persist the current session so it survives extension restarts
    sessionManager.saveCurrentSession().catch(log.onError);


    const adkAdapter = new AntigravityADKAdapter(workspaceRoot);
    adkController = new ADKController(adkAdapter, workspaceRoot);
    log.info('[Coogent] ADKController initialized');


    contextScoper = new ContextScoper({
      encoder: new CharRatioEncoder(),
      tokenLimit,
      resolver: new ASTFileResolver(),
    });


    logger = new TelemetryLogger(workspaceRoot, '.coogent/logs');
    log.info('[Coogent] TelemetryLogger initialized');


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
    plannerAgent.setMasterTaskId(sessionDirName);
    log.info('[Coogent] PlannerAgent initialized');

    // ─── Initialize HandoffExtractor & ConsolidationAgent ────────────
    handoffExtractor = new HandoffExtractor();
    consolidationAgent = new ConsolidationAgent();

    // ─── Initialize MCP Server & Client Bridge ──────────────────────
    mcpServer = new CoogentMCPServer(workspaceRoot);
    mcpBridge = new MCPClientBridge(mcpServer, workspaceRoot);
    mcpBridge.connect()
      .then(() => log.info('[Coogent] MCP Client Bridge connected.'))
      .catch(err => log.error('[Coogent] MCP Client Bridge connection failed:', err));

    // ─── Wire MCP Server → Engine (phaseCompleted logging bridge) ───
    // P2-1 / M-1: The MCP Server emits phaseCompleted when a worker submits
    // a handoff via the submit_phase_handoff tool.
    //
    // ARCHITECTURE NOTE: Today, DAG advancement is driven by the ADK
    // worker:exited event → Engine.onWorkerExited(). The MCP phaseCompleted
    // event is currently logging-only. To migrate to MCP-first orchestration
    // (where agents use tools instead of process exits), wire this listener
    // to Engine.onWorkerExited() or a dedicated Engine.onPhaseHandoffReceived()
    // method, and guard against double-advancing (exit code + MCP handoff).
    mcpServer.onPhaseCompleted((handoff) => {
      log.info(
        `[Coogent] MCP phaseCompleted: masterTaskId=${handoff.masterTaskId}, ` +
        `phaseId=${handoff.phaseId}`
      );
    });


    // ─── Register Activity Bar sidebar provider ────────────────────────
    const sidebarProvider = new MissionControlViewProvider(
      context.extensionUri, engine, sessionManager, adkController,
      () => preFlightGitCheck(gitSandbox),
      (newDir, newDirName) => {
        currentSessionDir = newDir;
        plannerAgent?.setMasterTaskId(newDirName);
        sessionManager?.setCurrentSessionId(newDirName.replace(/^\d{8}-\d{6}-/, ''), newDirName);
        sessionManager?.saveCurrentSession().catch(log.onError);
      },
      mcpServer, mcpBridge
    );
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        MissionControlViewProvider.viewType,
        sidebarProvider,
        { webviewOptions: { retainContextWhenHidden: true } }
      )
    );
    log.info('[Coogent] Activity Bar sidebar provider registered.');


    // ─── Wire Engine → Webview ─────────────────────────────────────────
    engine.on('ui:message', (message: HostToWebviewMessage) => {
      MissionControlPanel.broadcast(message);
      MissionControlViewProvider.broadcast(message);
    });

    // ─── Wire Engine → Webview (state:changed) ────────────────────────────
    let branchCreated = false; // Bug 4: ensure branch creation runs once per session
    engine.on('state:changed', (from, to, event) => {
      logger?.logStateTransition(from, to, event).catch(log.onError);

      // Bug 4: Auto-create sandbox branch on first EXECUTING_WORKER transition
      if (to === 'EXECUTING_WORKER' && !branchCreated && gitSandbox) {
        branchCreated = true;

        // Skip branch creation if the user chose "Continue on Current Branch"
        if (MissionControlPanel.shouldSkipSandbox()) {
          log.info('[Coogent] Sandbox branch skipped — user chose to continue on current branch.');
        } else {
          const branchRb = engine?.getRunbook() ?? null;
          const slug = branchRb?.project_id || 'coogent-task';
          gitSandbox.createSandboxBranch({ taskSlug: slug })
            .then(result => {
              if (result.success) {
                MissionControlPanel.broadcast({
                  type: 'LOG_ENTRY',
                  payload: { timestamp: asTimestamp(), level: 'info', message: `🔀 ${result.message}` },
                });
              } else {
                log.warn('[Coogent] Branch creation skipped:', result.message);
              }
            })
            .catch(err => log.error('[Coogent] Auto-branch creation error:', err));
        }
      }

      // Broadcast STATE_SNAPSHOT to webview on every state transition (Req §3)
      const rb = engine?.getRunbook() ?? null;
      MissionControlPanel.broadcast({
        type: 'STATE_SNAPSHOT',
        payload: {
          runbook: rb ?? { project_id: '', status: 'idle', current_phase: 0, phases: [] },
          engineState: to,
          masterTaskId: sessionDirName,
        },
      });
      MissionControlViewProvider.broadcast({
        type: 'STATE_SNAPSHOT',
        payload: {
          runbook: rb ?? { project_id: '', status: 'idle', current_phase: 0, phases: [] },
          engineState: to,
          masterTaskId: sessionDirName,
        },
      });
    });

    // ─── Wire Engine → run:completed (log completion) ──────────────────
    engine.on('run:completed', (runbook) => {
      const phaseCount = runbook.phases.length;
      const completedCount = runbook.phases.filter(p => p.status === 'completed').length;
      log.info(
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
      MissionControlViewProvider.broadcast({
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
      // P1-1 fix: Generate a deterministic mcpPhaseId and assign it to the
      // Phase object in-place. This mutation flows through STATE_SNAPSHOT to
      // the frontend, enabling MCP resource lookups by real phase ID.
      if (!phase.mcpPhaseId) {
        phase.mcpPhaseId = `phase-${String(phase.id).padStart(3, '0')}-${generateSessionId()}`;
      }
      executePhase(phase, workspaceRoot, workerTimeoutMs, sessionDirName).catch((err) => {
        log.error('[Coogent] Phase execution error:', err);
      });
    });

    // ─── Wire Engine → SelfHealing (Pillar 3) ──────────────────────────
    engine.on('phase:heal', (phase: Phase, augmentedPrompt: string) => {
      // Clone the phase and override prompt — carry over mcpPhaseId so the
      // healed worker's handoff submission uses the same ID.
      const healPhase = { ...phase, prompt: augmentedPrompt };
      executePhase(healPhase, workspaceRoot, workerTimeoutMs, sessionDirName).catch((err) => {
        log.error('[Coogent] Self-healing phase execution error:', err);
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
      }).catch(log.onError);
    });

    // ─── Wire ADK → Engine (worker lifecycle) ──────────────────────────
    adkController.on('worker:exited', (phaseId, exitCode) => {
      outputRegistry?.flushAndRemove(phaseId);

      // Extract and save handoff report on successful exit
      if (exitCode === 0 && handoffExtractor && currentSessionDir) {
        const accumulatedOutput = workerOutputAccumulator.get(phaseId) ?? '';
        workerOutputAccumulator.delete(phaseId);
        handoffExtractor.extractHandoff(phaseId, accumulatedOutput, workspaceRoot)
          .then(report => {
            // Store the handoff in MCP state (canonical source)
            // P1-1 fix: Use the real mcpPhaseId assigned during phase:execute
            // instead of a synthetic zero-UUID that never matches MCP state keys.
            if (mcpBridge && report) {
              const runbook = engine?.getRunbook() ?? null;
              const phaseObj = runbook?.phases.find(p => p.id === phaseId);
              const phaseIdStr = phaseObj?.mcpPhaseId;
              // B-3 fix: Skip handoff submission if mcpPhaseId is missing.
              // Generating a random UUID would create an orphaned MCP key
              // that no client can ever read.
              if (!phaseIdStr) {
                log.warn(`[Coogent] mcpPhaseId missing for phase ${phaseId} — skipping handoff submission.`);
              } else {
                mcpBridge.submitPhaseHandoff(
                  sessionDirName,
                  phaseIdStr,
                  report.decisions ?? [],
                  report.modified_files ?? [],
                  report.unresolved_issues ?? []
                ).catch(err => log.error('[Coogent] Failed to store handoff in MCP:', err));
              }
            }
          })
          .catch(err => log.error('[Coogent] Handoff extraction error:', err));
      } else {
        workerOutputAccumulator.delete(phaseId);
      }

      engine?.onWorkerExited(phaseId, exitCode).catch(log.onError);
    });

    adkController.on('worker:timeout', (phaseId) => {
      outputRegistry?.flushAndRemove(phaseId);
      engine?.onWorkerFailed(phaseId, 'timeout').catch(log.onError);
    });

    adkController.on('worker:crash', (phaseId) => {
      outputRegistry?.flushAndRemove(phaseId);
      engine?.onWorkerFailed(phaseId, 'crash').catch(log.onError);
    });

    // ─── Wire ADK → Webview (output streaming) ────────────────────────
    adkController.on('worker:output', (phaseId, stream, chunk) => {
      outputRegistry?.getOrCreate(phaseId, stream).append(chunk);
      logger?.logPhaseOutput(phaseId, stream, chunk).catch(log.onError);

      // Route output to per-phase detail views
      MissionControlPanel.broadcast({
        type: 'PHASE_OUTPUT',
        payload: { phaseId: asPhaseId(phaseId), stream, chunk },
      });

      // Accumulate stdout for handoff extraction (B-3: capped at 2MB)
      // W-2 fix: Check combined size to prevent a single large chunk from bypassing the cap
      if (stream === 'stdout') {
        const existing = workerOutputAccumulator.get(phaseId) ?? '';
        const MAX_ACCUMULATOR_SIZE = 2 * 1024 * 1024; // 2MB cap
        if (existing.length + chunk.length <= MAX_ACCUMULATOR_SIZE) {
          workerOutputAccumulator.set(phaseId, existing + chunk);
        } else if (existing.length < MAX_ACCUMULATOR_SIZE) {
          // Partial append to exactly fill the budget
          const remaining = MAX_ACCUMULATOR_SIZE - existing.length;
          workerOutputAccumulator.set(phaseId, existing + chunk.slice(0, remaining));
        }
      }
    });

    // ─── Wire Engine → PlannerAgent ─────────────────────────────────
    engine.on('plan:request', (prompt: string) => {
      plannerAgent?.plan(prompt).catch(log.onError);
    });

    engine.on('plan:rejected', (prompt: string, feedback: string) => {
      plannerAgent?.plan(prompt, feedback).catch(log.onError);
    });

    engine.on('plan:retryParse', () => {
      plannerAgent?.retryParse().catch(log.onError);
    });

    // ─── Wire PlannerAgent → Engine ─────────────────────────────────
    plannerAgent.on('plan:generated', (draft, fileTree) => {
      engine?.planGenerated(draft, fileTree);

      // Broadcast planning summary to webview for the Master Task hero section
      MissionControlPanel.broadcast({
        type: 'PLAN_SUMMARY',
        payload: {
          summary: draft.summary || draft.project_id,
        },
      });

      // Store the plan in the MCP state (canonical source)
      if (mcpBridge) {
        const implPlanContent = buildImplementationPlanMarkdown(draft);
        mcpBridge.submitImplementationPlan(sessionDirName, implPlanContent)
          .then(() => log.info('[Coogent] Implementation plan stored in MCP state.'))
          .catch(err => log.error('[Coogent] Failed to store implementation plan in MCP:', err));
      }
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
      engine?.abort().catch(log.onError);
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
        engine?.abort().catch(log.onError);
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
      const runbook = engine?.getRunbook() ?? null;
      // W-12: Capture references before async chain to prevent use-after-nullify
      const agent = consolidationAgent;
      if (!agent || !runbook) return;

      agent.generateReport(evtSessionDir, runbook, mcpBridge, sessionDirName)
        .then(async report => {
          // W-10 fix: Await saveReport() so errors are observed instead of silently swallowed
          try {
            await agent.saveReport(evtSessionDir, report, mcpBridge, sessionDirName);
          } catch (err) {
            log.error('[Coogent] saveReport failed:', err);
          }
          return report;
        })
        .then(report => {
          MissionControlPanel.broadcast({
            type: 'LOG_ENTRY',
            payload: {
              timestamp: asTimestamp(),
              level: 'info',
              message: 'Consolidation report stored in MCP state.',
            },
          });

          // Auto-broadcast the report to the webview (#BUG-5)
          const markdown = agent.formatAsMarkdown(report);
          MissionControlPanel.broadcast({
            type: 'CONSOLIDATION_REPORT',
            payload: { report: markdown },
          });
        })
        .catch(err => {
          log.error('[Coogent] Consolidation error:', err);
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
        // B-2 fix: Guard against undefined gitSandbox (no .git in workspace)
        if (!gitSandbox) {
          vscode.window.showWarningMessage('Coogent: Git not available in this workspace.');
          return;
        }
        try {
          const result = await gitSandbox.preFlightCheck();
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
        // B-2 fix: Guard against undefined gitSandbox
        if (!gitSandbox) {
          vscode.window.showWarningMessage('Coogent: Git not available in this workspace.');
          return;
        }
        const slug = await vscode.window.showInputBox({ prompt: 'Enter a task slug (e.g., feat-auth-flow)' });
        if (!slug) return;
        try {
          const result = await gitSandbox.createSandboxBranch({ taskSlug: slug });
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
        // B-2 fix: Guard against undefined gitSandbox
        if (!gitSandbox) {
          vscode.window.showWarningMessage('Coogent: Git not available in this workspace.');
          return;
        }
        try {
          const result = await gitSandbox.openDiffReview();
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
        const newWorkerTimeoutMs = updated.get<number>('workerTimeoutMs', 900_000);
        const newMaxRetries = updated.get<number>('maxRetries', 3);

        // Propagate to ContextScoper
        if (contextScoper) {
          contextScoper.setTokenLimit(newTokenLimit);
        }

        // Propagate to Engine
        if (engine) {
          engine.setMaxRetries(newMaxRetries);
        }

        // Propagate log level to LogStream
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

    // ─── File system watcher — auto-reload on external runbook edit ───
    const watcher = vscode.workspace.createFileSystemWatcher(
      `**/.coogent/ipc/**/${RUNBOOK_FILENAME}`,
      true,   // ignoreCreateEvents
      false,  // ignoreChangeEvents
      true    // ignoreDeleteEvents
    );
    watcher.onDidChange(() => {
      log.info(`[Coogent] ${RUNBOOK_FILENAME} changed externally`);
      // Only reload if the engine is in a state that accepts LOAD_RUNBOOK
      if (engine?.getState() === 'IDLE') {
        engine.loadRunbook().catch(log.onError);
      }
    });
    context.subscriptions.push(watcher);

    // ─── Orphan cleanup & crash recovery ───────────────────────────────
    log.info('[Coogent] All event handlers wired — running cleanup & crash recovery...');
    adkController.cleanupOrphanedWorkers().catch(log.onError);

    stateManager.recoverFromCrash().then(async (recovered) => {
      if (recovered) {
        // P0-3 fix: Hydrate the engine with the recovered runbook so FSM
        // state matches disk. Without this, the engine stays in IDLE.
        try {
          await engine?.loadRunbook();
        } catch (err) {
          log.error('[Coogent] Failed to load recovered runbook:', err);
        }
        vscode.window.showWarningMessage(
          'Coogent: Recovered from an interrupted session. Review state before continuing.'
        );
      } else if (lastSessionDirName) {
        // Restored a previous session — hydrate engine with its runbook
        try {
          await engine?.loadRunbook();
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

export async function deactivate(): Promise<void> {
  log.info('[Coogent] Extension deactivating (closing log stream)...');

  // Graceful shutdown: abort engine + kill all workers in parallel (Req §6)
  await Promise.allSettled([
    engine?.abort().catch(log.onError),
    adkController?.killAllWorkers().catch(log.onError),
    plannerAgent?.abort().catch(log.onError),
    mcpBridge?.disconnect().catch(log.onError),
  ]);

  // Flush any remaining output buffers
  outputRegistry?.dispose();

  // Release all references for GC
  stateManager = undefined;
  engine = undefined;
  adkController = undefined;
  contextScoper = undefined;
  logger = undefined;

  // N-1: Release all remaining references BEFORE disposing the log stream
  gitManager = undefined;
  gitSandbox = undefined;
  outputRegistry = undefined;
  plannerAgent = undefined;
  sessionManager = undefined;
  handoffExtractor = undefined;
  consolidationAgent = undefined;
  currentSessionDir = undefined;
  mcpServer = undefined;
  mcpBridge = undefined;
  workerOutputAccumulator.clear();

  // Dispose log stream LAST so all shutdown/teardown messages are captured
  disposeLog();
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
  // W-4: Guard against stale healing timer fires after abort/reset
  if (engine?.getState() !== EngineState.EXECUTING_WORKER) {
    log.warn(`[Coogent] Skipping phase ${phase.id} execution — engine not in EXECUTING_WORKER (state: ${engine?.getState()})`);
    return;
  }

  if (!contextScoper || !adkController || !logger) {
    engine?.onWorkerFailed(phase.id, 'crash').catch(log.onError);
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
    engine?.onWorkerFailed(phase.id, 'crash').catch(log.onError);
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
  const runbook = engine?.getRunbook() ?? null;
  if (runbook && phase.id === 0) {
    await logger.initRun(runbook.project_id);
  }

  // Step 5.5: Build handoff context from dependent phases
  let handoffContext = '';
  if (handoffExtractor && currentSessionDir) {
    try {
      handoffContext = await handoffExtractor.buildNextContext(phase, currentSessionDir, workspaceRoot);
    } catch (err) {
      log.error('[Coogent] Failed to build handoff context:', err);
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
