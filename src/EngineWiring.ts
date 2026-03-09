// ─────────────────────────────────────────────────────────────────────────────
// src/EngineWiring.ts — Engine ↔ ADK ↔ UI event subscriptions
// ─────────────────────────────────────────────────────────────────────────────
// R1 refactor: Extracted from extension.ts activate() (lines 487–666, 741–786).
// P3.2 refactor: executePhase() decomposed into ContextAssemblyAdapter,
//   WorkerLauncher, and WorkerResultProcessor collaborators.

import { randomUUID } from 'node:crypto';
import { asTimestamp, EngineState, EngineEvent, type Phase, type HostToWebviewMessage } from './types/index.js';
import { MissionControlPanel } from './webview/MissionControlPanel.js';
import log from './logger/log.js';
import type { ServiceContainer } from './ServiceContainer.js';
import { ContextAssemblyAdapter } from './engine/ContextAssemblyAdapter.js';
import { WorkerLauncher } from './engine/WorkerLauncher.js';
import { WorkerResultProcessor } from './engine/WorkerResultProcessor.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  wireEngine — connects Engine, ADK, MCP, and Consolidation events
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Wire all engine events, ADK worker lifecycle events, and consolidation flow.
 * Must be called after all services are initialised on the container.
 *
 * `sessionDirName` is read from `svc.currentSessionDirName` at event-fire time
 * (not captured at wire time) to support deferred session creation.
 *
 * @param svc             The shared service container.
 * @param workspaceRoot   Absolute path to the primary workspace folder.
 * @param workerTimeoutMs Worker timeout from the extension configuration.
 * @param workspaceRoots  All active workspace folder paths (defaults to [workspaceRoot]).
 */
export function wireEngine(
    svc: ServiceContainer,
    workspaceRoot: string,
    workerTimeoutMs: number,
    workspaceRoots: string[] = [workspaceRoot],
    contextBudgetTokens = 100_000,
): void {
    const { engine, adkController, logger, gitSandbox, gitManager, mcpBridge, mcpServer,
        handoffExtractor, consolidationAgent, outputRegistry,
        workerOutputAccumulator, workerStderrAccumulator,
        sandboxBranchCreatedForSession } = svc;

    if (!engine || !adkController) return;

    // Deferred session alias: read at call time from the mutable container.
    // At event-fire time, initSession() will have run (triggered on plan:request).
    const getSessionDirName = () => svc.currentSessionDirName ?? '';

    // ── Wire DispatchController with agent-selection options ──────────
    // Pass ArtifactDB reference and TelemetryLogger so the pipeline can
    // persist audit records and log agent selection events.
    // `useAgentSelection` defaults to false — enable via configuration.
    if (svc.mcpServer && engine.configureDispatch) {
        const dispatchOpts: import('./engine/DispatchController.js').DispatchControllerOptions = {
            useAgentSelection: false,
            artifactDb: svc.mcpServer.getArtifactDB(),
            sessionDirName: getSessionDirName(),
            ...(logger ? { logger } : {}),
            // V2-A 1.1: Pass getter so builder is resolved at dispatch time (after MCP init)
            contextPackBuilder: () => svc.contextPackBuilder,
            ...(svc.mcpReady ? { mcpReady: svc.mcpReady } : {}),
            contextBudgetTokens,
        };
        engine.configureDispatch(dispatchOpts);
    }

    // F-5 audit fix: Track per-phase flush intervals for incremental worker output persistence.
    // Every 30s, accumulated output is flushed to DB so a crash mid-phase doesn't lose diagnostics.
    const INCREMENTAL_FLUSH_MS = 30_000;
    const flushIntervals = new Map<number, ReturnType<typeof setInterval>>();

    /** Clear and remove the incremental flush interval for a phase. */
    function clearFlushInterval(phaseId: number): void {
        const interval = flushIntervals.get(phaseId);
        if (interval !== undefined) {
            clearInterval(interval);
            flushIntervals.delete(phaseId);
        }
    }

    // ── Engine → Webview (ui:message) ──────────────────────────────────
    engine.on('ui:message', (message: HostToWebviewMessage) => {
        MissionControlPanel.broadcast(message);
    });

    // ── Engine → Webview (state:changed) ───────────────────────────────
    engine.on('state:changed', (from, to, event) => {
        logger?.logStateTransition(from, to, event).catch(log.onError);

        // NOTE: Previously purged task from ArtifactDB on IDLE transition (LF-5).
        // Removed because sql.js does not honour ON DELETE CASCADE, leaving
        // orphan phases/handoffs/worker_outputs that cause "Task not found" errors.
        // The realpath workspace boundary check is the true security gate.

        // Auto-create sandbox branch on first EXECUTING_WORKER per session
        if (to === 'EXECUTING_WORKER' && !sandboxBranchCreatedForSession.has(getSessionDirName()) && gitSandbox) {
            sandboxBranchCreatedForSession.add(getSessionDirName());
            if (MissionControlPanel.shouldSkipSandbox()) {
                log.info('[Coogent] Sandbox branch skipped — user chose to continue on current branch.');
            } else {
                const branchRb = engine.getRunbook() ?? null;
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

        // Broadcast STATE_SNAPSHOT on every state transition
        const rb = engine.getRunbook() ?? null;
        MissionControlPanel.broadcast({
            type: 'STATE_SNAPSHOT',
            payload: {
                runbook: rb ?? { project_id: '', status: 'idle', current_phase: 0, phases: [] },
                engineState: to,
                masterTaskId: getSessionDirName(),
            },
        });
    });

    // ── Engine → run:completed ──────────────────────────────────────────
    engine.on('run:completed', (runbook) => {
        // Persist task completion timestamp (BL-5 audit fix)
        if (mcpServer) {
            mcpServer.setTaskCompleted(getSessionDirName());
        }

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
    });

    // ── Engine → phase:execute ──────────────────────────────────────────
    engine.on('phase:execute', (phase: Phase) => {
        if (!phase.mcpPhaseId) {
            phase.mcpPhaseId = `phase-${String(phase.id).padStart(3, '0')}-${randomUUID()}`;
        }

        // Persist phase log entry at start
        if (mcpServer && phase.mcpPhaseId) {
            mcpServer.upsertPhaseLog(getSessionDirName(), phase.mcpPhaseId, {
                prompt: phase.prompt,
                startedAt: Date.now(),
            });
        }

        executePhase(svc, phase, workspaceRoot, workerTimeoutMs, getSessionDirName(), workspaceRoots).catch((err) => {
            log.error('[Coogent] Phase execution error:', err);

            // Recovery: unhandled errors in executePhase() leave the phase stuck
            // in "running" and the engine in EXECUTING_WORKER. Trigger the failure
            // path so the FSM can advance (retry, skip, or pause).
            MissionControlPanel.broadcast({
                type: 'LOG_ENTRY',
                payload: {
                    timestamp: asTimestamp(),
                    level: 'error',
                    message: `Phase ${phase.id} failed during setup: ${err instanceof Error ? err.message : String(err)}`,
                },
            });
            engine?.onWorkerFailed(phase.id, 'crash').catch(log.onError);
        });
    });

    // ── Engine → phase:heal (SelfHealing) ──────────────────────────────
    engine.on('phase:heal', (phase: Phase, augmentedPrompt: string) => {
        const healPhase = { ...phase, prompt: augmentedPrompt };
        executePhase(svc, healPhase, workspaceRoot, workerTimeoutMs, getSessionDirName(), workspaceRoots).catch((err) => {
            log.error('[Coogent] Self-healing phase execution error:', err);
            engine?.onWorkerFailed(phase.id, 'crash').catch(log.onError);
        });
    });

    // ── Engine → phase:checkpoint (Git) ────────────────────────────────
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

    // ── Build WorkerResultProcessor for worker lifecycle delegation ────
    const resultProcessor = new WorkerResultProcessor(
        engine as unknown as import('./engine/WorkerResultProcessor.js').ResultProcessorEngine,
        getSessionDirName,
        mcpServer as unknown as import('./engine/WorkerResultProcessor.js').ResultProcessorMCPServer | undefined,
        handoffExtractor as unknown as import('./engine/WorkerResultProcessor.js').ResultProcessorHandoffExtractor | undefined,
        mcpBridge as unknown as import('./engine/WorkerResultProcessor.js').ResultProcessorMCPBridge | undefined,
    );

    // ── ADK → Engine (worker lifecycle) ────────────────────────────────
    adkController.on('worker:exited', (phaseId, exitCode) => {
        // F-5 audit fix: Clear incremental flush interval before final flush
        clearFlushInterval(phaseId);

        outputRegistry?.flushAndRemove(phaseId);

        const accumulatedOutput = workerOutputAccumulator.get(phaseId) ?? '';
        const accumulatedStderr = workerStderrAccumulator.get(phaseId) ?? '';
        workerOutputAccumulator.delete(phaseId);
        workerStderrAccumulator.delete(phaseId);

        resultProcessor.processWorkerExit(
            phaseId,
            exitCode,
            accumulatedOutput,
            accumulatedStderr,
            svc.currentSessionDir,
        ).catch(log.onError);
    });

    adkController.on('worker:timeout', (phaseId) => {
        // F-5 audit fix: Clear incremental flush interval
        clearFlushInterval(phaseId);

        outputRegistry?.flushAndRemove(phaseId);

        const accOut = workerOutputAccumulator.get(phaseId) ?? '';
        const accErr = workerStderrAccumulator.get(phaseId) ?? '';
        workerOutputAccumulator.delete(phaseId);
        workerStderrAccumulator.delete(phaseId);

        resultProcessor.processWorkerFailure(phaseId, 'timeout', accOut, accErr)
            .catch(log.onError);
    });

    adkController.on('worker:crash', (phaseId) => {
        // F-5 audit fix: Clear incremental flush interval
        clearFlushInterval(phaseId);

        outputRegistry?.flushAndRemove(phaseId);

        const accOut = workerOutputAccumulator.get(phaseId) ?? '';
        const accErr = workerStderrAccumulator.get(phaseId) ?? '';
        workerOutputAccumulator.delete(phaseId);
        workerStderrAccumulator.delete(phaseId);

        resultProcessor.processWorkerFailure(phaseId, 'crash', accOut, accErr)
            .catch(log.onError);
    });

    // ── ADK → Webview (output streaming via OutputBufferRegistry) ────────
    adkController.on('worker:output', (phaseId, stream, chunk) => {
        // Output is batched through OutputBufferRegistry (100ms timer / 4KB flush).
        // The registry's flush callback broadcasts PHASE_OUTPUT to the webview.
        outputRegistry?.getOrCreate(phaseId, stream).append(chunk);
        logger?.logPhaseOutput(phaseId, stream, chunk).catch(log.onError);

        // Accumulate stdout for handoff extraction (capped at 2 MB)
        const MAX_ACCUMULATOR_SIZE = 2 * 1024 * 1024;
        if (stream === 'stdout') {
            const existing = workerOutputAccumulator.get(phaseId) ?? '';
            if (existing.length + chunk.length <= MAX_ACCUMULATOR_SIZE) {
                workerOutputAccumulator.set(phaseId, existing + chunk);
            } else if (existing.length < MAX_ACCUMULATOR_SIZE) {
                const remaining = MAX_ACCUMULATOR_SIZE - existing.length;
                workerOutputAccumulator.set(phaseId, existing + chunk.slice(0, remaining));
            }
        }

        // S3 audit fix: Accumulate stderr for persistence (capped at 2 MB)
        if (stream === 'stderr') {
            const existing = workerStderrAccumulator.get(phaseId) ?? '';
            if (existing.length + chunk.length <= MAX_ACCUMULATOR_SIZE) {
                workerStderrAccumulator.set(phaseId, existing + chunk);
            } else if (existing.length < MAX_ACCUMULATOR_SIZE) {
                const remaining = MAX_ACCUMULATOR_SIZE - existing.length;
                workerStderrAccumulator.set(phaseId, existing + chunk.slice(0, remaining));
            }
        }

        // F-5 audit fix: Start incremental flush interval if not already running
        if (!flushIntervals.has(phaseId) && mcpServer) {
            const interval = setInterval(() => {
                const accOut = workerOutputAccumulator.get(phaseId) ?? '';
                const accErr = workerStderrAccumulator.get(phaseId) ?? '';
                if (accOut || accErr) {
                    const rb = engine.getRunbook() ?? null;
                    const pObj = rb?.phases.find(p => p.id === phaseId);
                    if (pObj?.mcpPhaseId) {
                        mcpServer.upsertWorkerOutput(getSessionDirName(), pObj.mcpPhaseId, accOut, accErr);
                        log.debug(`[EngineWiring] F-5: Incremental flush for phase ${phaseId} (${accOut.length + accErr.length} bytes)`);
                    }
                }
            }, INCREMENTAL_FLUSH_MS);
            flushIntervals.set(phaseId, interval);
        }
    });

    // ── Engine → ConsolidationAgent ────────────────────────────────────
    engine.on('run:consolidate', (evtSessionDir: string) => {
        const runbook = engine.getRunbook() ?? null;
        const agent = consolidationAgent;
        if (!agent || !runbook) return;

        agent.generateReport(evtSessionDir, runbook, mcpBridge, getSessionDirName())
            .then(async report => {
                try {
                    await agent.saveReport(evtSessionDir, report, mcpBridge, getSessionDirName(), svc.storageBase);
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
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Phase Execution Pipeline
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Full phase execution pipeline: assemble context → spawn worker.
 * Extracted from the module-level `executePhase()` in extension.ts.
 *
 * P3.2 refactor: Steps are delegated to ContextAssemblyAdapter and WorkerLauncher.
 * The public signature is preserved for backward compatibility.
 *
 * @param workspaceRoots  All active workspace roots (defaults to [workspaceRoot]).
 */
async function executePhase(
    svc: ServiceContainer,
    phase: Phase,
    workspaceRoot: string,
    timeoutMs: number,
    masterTaskId: string,
    workspaceRoots: string[] = [workspaceRoot]
): Promise<void> {
    const { engine, contextScoper, adkController, logger } = svc;

    // Guard against stale healing timer fires after abort/reset.
    // Allow ERROR_PAUSED → RETRY transition for self-healing retries
    // (e.g. timeout/crash auto-retry fires after FSM reached ERROR_PAUSED).
    const engineState = engine?.getState();
    if (engineState === EngineState.ERROR_PAUSED) {
        const retryResult = engine?.transition(EngineEvent.RETRY);
        if (retryResult === null) {
            log.warn(`[Coogent] Skipping phase ${phase.id} execution — RETRY transition from ERROR_PAUSED rejected`);
            return;
        }
    } else if (engineState !== EngineState.EXECUTING_WORKER) {
        log.warn(`[Coogent] Skipping phase ${phase.id} execution — engine not in EXECUTING_WORKER (state: ${engineState})`);
        return;
    }

    if (!contextScoper || !adkController || !logger) {
        engine?.onWorkerFailed(phase.id, 'crash').catch(log.onError);
        return;
    }

    // ── Step 1: Assemble context (delegated to ContextAssemblyAdapter) ──
    const assembler = new ContextAssemblyAdapter(
        contextScoper as unknown as import('./engine/ContextAssemblyAdapter.js').ContextScoperLike,
        logger as unknown as import('./engine/ContextAssemblyAdapter.js').ContextAssemblyLogger,
    );
    const assemblyResult = await assembler.assembleContext(phase, workspaceRoot, workspaceRoots);
    if (!assemblyResult.ok) {
        engine?.onWorkerFailed(phase.id, 'crash').catch(log.onError);
        return;
    }

    // ── Step 2: Build prompt + launch worker (delegated to WorkerLauncher) ──
    const launcher = new WorkerLauncher(
        adkController as unknown as import('./engine/WorkerLauncher.js').WorkerLauncherADK,
        logger as unknown as import('./engine/WorkerLauncher.js').WorkerLauncherLogger,
    );
    await launcher.launch(phase, timeoutMs, masterTaskId, svc, workspaceRoots);
}
