// ─────────────────────────────────────────────────────────────────────────────
// src/engine/DispatchController.ts — DAG dispatch scheduling & stall recovery
// ─────────────────────────────────────────────────────────────────────────────
// Sprint 1 Extract: Dispatch cluster from Engine.ts.
// Handles dispatchReadyPhases, advanceSchedule, stall watchdog, resumePending.

import log from '../logger/log.js';
import { EngineState, EngineEvent, asTimestamp, type Phase } from '../types/index.js';
import type { EngineInternals } from './EngineInternals.js';
import { SelectionPipeline, SubtaskSpecBuilder, type SubtaskDraft } from '../agent-selection/index.js';
import type { ArtifactDB } from '../mcp/ArtifactDB.js';
import type { TelemetryLogger } from '../logger/TelemetryLogger.js';
import type { ContextPackBuilder } from '../context/ContextPackBuilder.js';

/** Options for DispatchController construction. */
export interface DispatchControllerOptions {
    /** Enable capability-based agent selection pipeline. Default: false. */
    readonly useAgentSelection?: boolean;
    /** S3-4: Enable shadow mode — run selection pipeline, log results, but don't affect dispatch. */
    readonly enableShadowMode?: boolean;
    /** ArtifactDB instance for persisting selection audit records. */
    readonly artifactDb?: ArtifactDB;
    /** TelemetryLogger instance for telemetry events. */
    readonly logger?: TelemetryLogger;
    /** Session directory name for audit record persistence. */
    readonly sessionDirName?: string;
    /**
     * ContextPackBuilder for assembling context packs before worker spawn.
     * Accepts a getter function to support deferred initialization
     * (builder is created inside the async MCP init chain).
     */
    readonly contextPackBuilder?: ContextPackBuilder | (() => ContextPackBuilder | undefined);
    /** Promise that resolves once MCP server + ArtifactDB are ready. */
    readonly mcpReady?: Promise<void>;
    /** Token budget for context pack assembly. Default: 100_000. */
    readonly contextBudgetTokens?: number;
}

/**
 * Extracted dispatch and stall-recovery logic from Engine.
 *
 * Owns the stall watchdog timer and coordinates with the DAG-aware
 * Scheduler to dispatch phases whose dependencies are satisfied.
 */
export class DispatchController {
    /** Lifecycle watchdog — detects stalled pipelines where all workers are dead. */
    private stallWatchdog: ReturnType<typeof setInterval> | null = null;
    private readonly STALL_CHECK_INTERVAL_MS = 30_000;

    /** Feature flag: when true, run agent selection pipeline before dispatch. */
    private readonly useAgentSelection: boolean;
    /** Lazily-initialised pipeline instance (created on first use). */
    private selectionPipeline: SelectionPipeline | null = null;
    /** ArtifactDB for persisting audit records. */
    private readonly artifactDb: ArtifactDB | undefined;
    /** TelemetryLogger for structured event logging. */
    private readonly telemetryLogger: TelemetryLogger | undefined;
    /** Session directory name used as session_id in audit records. */
    private readonly sessionDirName: string;
    /** S3-4: Shadow mode — run pipeline for observability without affecting dispatch. */
    private readonly enableShadowMode: boolean;
    /** ContextPackBuilder getter — resolved lazily at dispatch time. */
    private readonly contextPackBuilderOrGetter: ContextPackBuilder | (() => ContextPackBuilder | undefined) | undefined;
    /** Promise that gates context pack build until MCP is ready. */
    private readonly mcpReady: Promise<void> | undefined;
    /** Token budget used for context pack assembly. */
    private readonly contextBudgetTokens: number;

    constructor(
        private readonly engine: EngineInternals,
        options?: DispatchControllerOptions,
    ) {
        this.useAgentSelection = options?.useAgentSelection ?? false;
        this.enableShadowMode = options?.enableShadowMode ?? false;
        this.artifactDb = options?.artifactDb;
        this.telemetryLogger = options?.logger;
        this.sessionDirName = options?.sessionDirName ?? '';
        this.contextPackBuilderOrGetter = options?.contextPackBuilder;
        this.mcpReady = options?.mcpReady;
        this.contextBudgetTokens = options?.contextBudgetTokens ?? 100_000;
    }

    /**
     * Dispatch all ready phases (DAG-aware).
     * Queries the Scheduler for phases with satisfied dependencies,
     * marks them running, increments active worker count, and emits phase:execute.
     */
    public async dispatchReadyPhases(): Promise<void> {
        const runbook = this.engine.getRunbook();
        if (!runbook) return;

        const readyPhases = this.engine.getScheduler().getReadyPhases(runbook.phases);

        if (readyPhases.length === 0) {
            return;
        }

        for (const phase of readyPhases) {
            // Agent selection pipeline (when enabled)
            if (this.useAgentSelection) {
                const selectionOk = await this.runAgentSelection(phase);
                if (!selectionOk) {
                    // Validation failed — transition to ERROR_PAUSED
                    this.engine.transition(EngineEvent.PHASE_FAIL);
                    this.engine.emitUIMessage({
                        type: 'LOG_ENTRY',
                        payload: {
                            timestamp: asTimestamp(),
                            level: 'error',
                            message: `Phase ${phase.id}: agent selection pipeline validation failed. Pausing execution.`,
                        },
                    });
                    continue;
                }
            } else if (this.enableShadowMode) {
                // S3-4: Shadow mode — run pipeline for observability only
                try {
                    await this.runAgentSelection(phase, true /* shadowMode */);
                } catch (err) {
                    log.warn(`[DispatchController] Shadow mode selection failed for phase ${phase.id}:`, err);
                }
            }

            // Build context pack before dispatch (best-effort, non-blocking on failure)
            // V2-A 1.1: Resolve builder lazily to avoid async race with MCP init
            const resolvedBuilder = typeof this.contextPackBuilderOrGetter === 'function'
                ? this.contextPackBuilderOrGetter()
                : this.contextPackBuilderOrGetter;
            if (resolvedBuilder) {
                try {
                    // V2-A 1.1: await MCP readiness before accessing ArtifactDB
                    if (this.mcpReady) {
                        await this.mcpReady;
                    }

                    // Resolve upstream mcpPhaseIds from dependency numeric IDs
                    const upstreamPhaseIds: string[] = [];
                    if (phase.depends_on && runbook) {
                        const phaseMap = new Map(runbook.phases.map(p => [p.id, p]));
                        for (const depId of phase.depends_on) {
                            const depPhase = phaseMap.get(depId);
                            if (depPhase?.mcpPhaseId && depPhase.status === 'completed') {
                                upstreamPhaseIds.push(depPhase.mcpPhaseId);
                            }
                        }
                    }

                    const packResult = await resolvedBuilder.build({
                        sessionId: this.sessionDirName,
                        taskId: runbook.project_id,
                        phaseId: String(phase.id),
                        prompt: phase.prompt,
                        contextFiles: phase.context_files ?? [],
                        upstreamPhaseIds,
                        maxTokens: this.contextBudgetTokens,
                        ...(phase.requiresFullFileContext !== undefined
                            ? { requiresFullFileContext: phase.requiresFullFileContext }
                            : {}),
                    });
                    log.info(
                        `[DispatchController] Context pack built for phase ${phase.id}: ` +
                        `${packResult.manifest.totals.totalTokens} tokens`,
                    );
                } catch (err) {
                    log.warn(`[DispatchController] Context pack build failed for phase ${phase.id}:`, err);
                }
            }

            phase.status = 'running';
            this.engine.incrementActiveWorkerCount();
            this.engine.emitUIMessage({
                type: 'PHASE_STATUS',
                payload: { phaseId: phase.id, status: 'running' },
            });
            this.engine.emit('phase:execute', phase);
        }

        try {
            await this.engine.persist();
        } catch (err) {
            log.error('[DispatchController] dispatchReadyPhases persist failed:', err);
        }

        this.engine.emitUIMessage({
            type: 'STATE_SNAPSHOT',
            payload: {
                runbook,
                engineState: this.engine.getState(),
            },
        });
    }

    /**
     * Advance the schedule after a successful phase.
     * Respects pause requests — halts dispatch if pause was requested.
     */
    public advanceSchedule(): void {
        const runbook = this.engine.getRunbook();
        if (!runbook) return;

        if (this.engine.isPauseRequested()) {
            this.engine.setPauseRequested(false);
            runbook.status = 'idle';
            this.engine.persist().catch(log.onError);
            this.engine.emitUIMessage({
                type: 'LOG_ENTRY',
                payload: {
                    timestamp: asTimestamp(),
                    level: 'info',
                    message: 'Execution paused after phase completion.',
                },
            });
            return;
        }
        this.dispatchReadyPhases();
    }

    /**
     * Start the stall watchdog timer.
     * Periodically checks for stalled pipelines where the FSM is in
     * EXECUTING_WORKER but no phases are actually running.
     */
    public startStallWatchdog(): void {
        this.stopStallWatchdog();
        this.stallWatchdog = setInterval(() => {
            if (this.engine.getState() !== EngineState.EXECUTING_WORKER) return;
            const runbook = this.engine.getRunbook();
            if (!runbook) return;

            const runningPhases = runbook.phases.filter(p => p.status === 'running');
            if (runningPhases.length > 0) return;

            log.warn(
                `[DispatchController] Stall watchdog: FSM in EXECUTING_WORKER but no running phases. ` +
                `activeWorkerCount=${this.engine.getActiveWorkerCount()}. Attempting recovery.`
            );

            this.engine.setActiveWorkerCount(0);

            const readyPhases = this.engine.getScheduler().getReadyPhases(runbook.phases);
            if (readyPhases.length > 0) {
                this.engine.emitUIMessage({
                    type: 'LOG_ENTRY',
                    payload: {
                        timestamp: asTimestamp(),
                        level: 'warn',
                        message: `Stall detected — auto-dispatching ${readyPhases.length} ready phase(s).`,
                    },
                });
                this.dispatchReadyPhases();
                return;
            }

            const allDone = this.engine.getScheduler().isAllDone(runbook.phases);
            if (allDone) {
                const hasFailed = runbook.phases.some(p => p.status === 'failed');
                if (hasFailed) {
                    this.engine.transition(EngineEvent.WORKER_EXITED);
                    this.engine.transition(EngineEvent.PHASE_FAIL);
                    runbook.status = 'paused_error';
                } else {
                    this.engine.transition(EngineEvent.WORKER_EXITED);
                    this.engine.transition(EngineEvent.ALL_PHASES_PASS);
                    runbook.status = 'completed';
                    this.engine.emit('run:completed', runbook);
                    this.engine.emit('run:consolidate', this.engine.getStateManager().getSessionDir());
                }
                this.engine.persist().catch(log.onError);
                this.engine.emitUIMessage({
                    type: 'STATE_SNAPSHOT',
                    payload: { runbook, engineState: this.engine.getState() },
                });
                this.stopStallWatchdog();
                return;
            }

            this.engine.emitUIMessage({
                type: 'LOG_ENTRY',
                payload: {
                    timestamp: asTimestamp(),
                    level: 'error',
                    message: 'Pipeline stalled: pending phases exist but dependencies are unmet. ' +
                        'Use "Resume Pending" to attempt recovery or retry/skip failed phases.',
                },
            });
            this.engine.transition(EngineEvent.WORKER_EXITED);
            this.engine.transition(EngineEvent.PHASE_FAIL);
            runbook.status = 'paused_error';
            this.engine.persist().catch(log.onError);
            this.engine.emitUIMessage({
                type: 'STATE_SNAPSHOT',
                payload: { runbook, engineState: this.engine.getState() },
            });
            this.stopStallWatchdog();
        }, this.STALL_CHECK_INTERVAL_MS);
    }

    /** Stop the stall watchdog timer. */
    public stopStallWatchdog(): void {
        if (this.stallWatchdog) {
            clearInterval(this.stallWatchdog);
            this.stallWatchdog = null;
        }
    }

    /**
     * Resume all pending phases whose dependencies are satisfied.
     * Used for ERROR_PAUSED recovery and manual pipeline unblocking.
     */
    public async resumePending(): Promise<void> {
        const runbook = this.engine.getRunbook();
        if (!runbook) return;

        if (this.engine.getState() === EngineState.ERROR_PAUSED) {
            const result = this.engine.transition(EngineEvent.RETRY);
            if (result === null) return;
        } else if (this.engine.getState() !== EngineState.EXECUTING_WORKER) {
            this.engine.emitUIMessage({
                type: 'LOG_ENTRY',
                payload: {
                    timestamp: asTimestamp(),
                    level: 'warn',
                    message: `Cannot resume pending: engine is in state "${this.engine.getState()}".`,
                },
            });
            return;
        }

        runbook.status = 'running';

        const actualRunning = runbook.phases.filter(p => p.status === 'running').length;
        this.engine.setActiveWorkerCount(actualRunning);

        const readyPhases = this.engine.getScheduler().getReadyPhases(runbook.phases);
        if (readyPhases.length === 0) {
            this.engine.emitUIMessage({
                type: 'LOG_ENTRY',
                payload: {
                    timestamp: asTimestamp(),
                    level: 'info',
                    message: 'No pending phases with satisfied dependencies found.',
                },
            });
            return;
        }

        this.engine.emitUIMessage({
            type: 'LOG_ENTRY',
            payload: {
                timestamp: asTimestamp(),
                level: 'info',
                message: `Resuming ${readyPhases.length} pending phase(s): ${readyPhases.map(p => `#${p.id}`).join(', ')}.`,
            },
        });

        await this.engine.persist();
        this.startStallWatchdog();
        this.dispatchReadyPhases();
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Agent Selection Pipeline helpers
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Convert a Phase into a SubtaskDraft suitable for the selection pipeline.
     */
    private buildSubtaskDraft(phase: Phase): SubtaskDraft {
        return {
            id: phase.mcpPhaseId ?? `phase-${phase.id}`,
            title: `Phase ${phase.id}`,
            goal: phase.prompt.slice(0, 500),
            contextFiles: phase.context_files ?? [],
            dependsOn: phase.depends_on?.map(String) ?? [],
            requiredSkills: phase.required_skills ?? [],
            successCriteria: phase.success_criteria ?? undefined,
        };
    }

    /**
     * Run the agent selection pipeline for a phase.
     *
     * On success: replaces `phase.prompt` with the compiled prompt,
     *             persists the audit record, and logs telemetry.
     * On failure: logs the validation errors and returns `false`.
     *
     * @returns `true` if the pipeline succeeded, `false` if validation failed.
     */
    private async runAgentSelection(phase: Phase, shadowMode = false): Promise<boolean> {
        try {
            if (!this.selectionPipeline) {
                this.selectionPipeline = new SelectionPipeline();
            }

            // 1. Build SubtaskSpec from Phase
            const draft = this.buildSubtaskDraft(phase);
            const spec = SubtaskSpecBuilder.build(draft);

            // 2. Run the pipeline (select → compile → validate)
            const result = this.selectionPipeline.run(spec);

            // 3. Replace phase prompt with compiled prompt body (skip in shadow mode)
            if (!shadowMode) {
                phase.prompt = result.prompt.text;
            }

            // 4. Log telemetry
            if (this.telemetryLogger) {
                await this.telemetryLogger.logAgentSelected(
                    spec.subtask_id,
                    result.selection.selected_agent,
                    result.selection.candidate_agents[0]?.score ?? 0,
                    [...result.selection.selection_rationale],
                );
                await this.telemetryLogger.logPromptCompiled(
                    spec.subtask_id,
                    result.prompt.prompt_id,
                    result.selection.selected_agent,
                );
            }

            // 5. Persist audit record
            if (this.artifactDb) {
                const auditWithSession = {
                    ...result.audit,
                    session_id: this.sessionDirName,
                };
                this.artifactDb.audits.insertSelectionAudit(auditWithSession);
            }

            log.info(
                `[DispatchController] Phase ${phase.id}: agent selection${shadowMode ? ' (shadow)' : ''} → ` +
                `${result.selection.selected_agent} (prompt ${result.prompt.prompt_id})`,
            );

            return true;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            log.error(`[DispatchController] Agent selection failed for phase ${phase.id}: ${message}`);

            // Log validation failure telemetry
            if (this.telemetryLogger) {
                const subtaskId = phase.mcpPhaseId ?? `phase-${phase.id}`;
                await this.telemetryLogger.logPromptValidationFailed(
                    subtaskId,
                    'n/a',
                    [message],
                );
            }

            return false;
        }
    }
}
