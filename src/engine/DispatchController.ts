// ─────────────────────────────────────────────────────────────────────────────
// src/engine/DispatchController.ts — DAG dispatch scheduling & stall recovery
// ─────────────────────────────────────────────────────────────────────────────
// Sprint 1 Extract: Dispatch cluster from Engine.ts.
// Handles dispatchReadyPhases, advanceSchedule, stall watchdog, resumePending.

import log from '../logger/log.js';
import { EngineState, EngineEvent, asTimestamp } from '../types/index.js';
import type { Engine } from './Engine.js';

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

    constructor(private readonly engine: Engine) { }

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
}
