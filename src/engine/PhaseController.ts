// ─────────────────────────────────────────────────────────────────────────────
// src/engine/PhaseController.ts — Per-phase user commands
// ─────────────────────────────────────────────────────────────────────────────
// Sprint 1 Extract: Phase Control cluster from Engine.ts.
// Handles editPhase, pausePhase, stopPhase, restartPhase, reviewDiff, skipPhase.

import { EngineState, EngineEvent, asTimestamp, type Phase, type PhaseId } from '../types/index.js';
import type { EngineInternals } from './EngineInternals.js';
import log from '../logger/log.js';

/**
 * Extracted phase-control logic from Engine.
 *
 * Each method receives a phaseId and operates on the runbook through
 * the EngineInternals contract. FSM transitions and events are delegated.
 */
export class PhaseController {
    constructor(private readonly engine: EngineInternals) { }

    /**
     * Edit a phase's prompt, files, or criteria before execution.
     */
    public async editPhase(
        phaseId: number,
        patch: Partial<Pick<Phase, 'prompt' | 'context_files' | 'success_criteria'>>
    ): Promise<void> {
        const runbook = this.engine.getRunbook();
        if (!runbook) return;

        const phase = runbook.phases.find(p => p.id === phaseId);
        if (!phase) return;

        if (patch.prompt !== undefined) phase.prompt = patch.prompt;
        if (patch.context_files !== undefined) phase.context_files = patch.context_files;
        if (patch.success_criteria !== undefined) phase.success_criteria = patch.success_criteria;

        await this.engine.persist();

        this.engine.emitUIMessage({
            type: 'STATE_SNAPSHOT',
            payload: { runbook, engineState: this.engine.getState() },
        });
    }

    /**
     * Pause a specific phase — prevents its next dispatch.
     */
    public pausePhase(phaseId: number): void {
        this.engine.setPauseRequested(true);
        this.engine.emitUIMessage({
            type: 'LOG_ENTRY',
            payload: {
                timestamp: asTimestamp(),
                level: 'info',
                message: `Pause requested for phase #${phaseId} — will halt after current worker completes.`,
            },
        });
    }

    /**
     * Stop (force-terminate) the worker for a specific phase.
     */
    public async stopPhase(phaseId: number): Promise<void> {
        const runbook = this.engine.getRunbook();
        if (!runbook) return;

        const phase = runbook.phases.find(p => p.id === phaseId);
        if (!phase || phase.status !== 'running') return;

        this.engine.emit('phase:stop', phaseId);

        this.engine.emitUIMessage({
            type: 'LOG_ENTRY',
            payload: {
                timestamp: asTimestamp(),
                level: 'warn',
                message: `Stop requested for phase #${phaseId} — terminating worker.`,
            },
        });
    }

    /**
     * Restart a phase — reset its status and re-dispatch.
     * Works for failed, completed, or pending phases.
     */
    public async restartPhase(phaseId: number): Promise<void> {
        const runbook = this.engine.getRunbook();
        if (!runbook) return;

        const phase = runbook.phases.find(p => p.id === phaseId);
        if (!phase) return;

        // Only restart if not currently running
        if (phase.status === 'running') return;

        // Ensure the FSM is in a state that allows dispatching workers.
        const state = this.engine.getState();
        if (state === EngineState.ERROR_PAUSED) {
            const result = this.engine.transition(EngineEvent.RETRY);
            if (result === null) return;
        } else if (state === EngineState.IDLE) {
            const result = this.engine.transition(EngineEvent.START);
            if (result === null) return;
        } else if (state === EngineState.READY || state === EngineState.COMPLETED) {
            const result = this.engine.transition(EngineEvent.START);
            if (result === null) return;
        } else if (state !== EngineState.EXECUTING_WORKER) {
            this.engine.emitUIMessage({
                type: 'LOG_ENTRY',
                payload: {
                    timestamp: asTimestamp(),
                    level: 'warn',
                    message: `Cannot restart phase #${phaseId}: engine is in state "${state}".`,
                },
            });
            return;
        }

        phase.status = 'pending';
        runbook.current_phase = phaseId;
        this.engine.getHealer().clearAttempts(phaseId);
        runbook.status = 'running';
        await this.engine.persist();

        this.engine.emitUIMessage({
            type: 'LOG_ENTRY',
            payload: {
                timestamp: asTimestamp(),
                level: 'info',
                message: `Restarting phase #${phaseId} from scratch.`,
            },
        });

        this.engine.dispatchReadyPhases().catch(err => {
            log.error('[PhaseController] restartPhase dispatch failed:', err);
        });
    }

    /**
     * Request a diff review for a specific phase.
     */
    public async reviewDiff(phaseId: number): Promise<void> {
        const runbook = this.engine.getRunbook();
        if (!runbook) return;

        const phase = runbook.phases.find(p => p.id === phaseId);
        if (!phase) return;

        this.engine.emit('phase:review-diff', phaseId);

        this.engine.emitUIMessage({
            type: 'LOG_ENTRY',
            payload: {
                timestamp: asTimestamp(),
                level: 'info',
                message: `Diff review requested for phase #${phaseId}.`,
            },
        });
    }

    /**
     * Skip a failed phase and move to the next one.
     */
    public async skipPhase(phaseId: number): Promise<void> {
        const runbook = this.engine.getRunbook();
        if (!runbook) return;

        const phase = runbook.phases.find(p => p.id === phaseId);
        if (!phase) return;

        const result = this.engine.transition(EngineEvent.SKIP_PHASE);
        if (result === null) return;

        phase.status = 'completed';
        // P-1 fix: Don't assume sequential IDs — let DAG scheduler determine next phase.
        const nextReady = this.engine.getScheduler().getReadyPhases(runbook.phases);
        runbook.current_phase = nextReady.length > 0 ? nextReady[0].id : phaseId;
        await this.engine.persist();

        this.engine.emitUIMessage({
            type: 'PHASE_STATUS',
            payload: { phaseId: phaseId as PhaseId, status: 'completed' },
        });

        // Advance schedule to unblock dependent phases
        const allDone = this.engine.getScheduler().isAllDone(runbook.phases);
        if (allDone) {
            const hasFailed = runbook.phases.some(p => p.status === 'failed');
            if (hasFailed) {
                runbook.status = 'paused_error';
                await this.engine.persist();
            } else {
                runbook.status = 'completed';
                // P-2 fix: Guard composite transitions — stop if any transition fails.
                const r1 = this.engine.transition(EngineEvent.START);
                if (r1 !== null) {
                    const r2 = this.engine.transition(EngineEvent.WORKER_EXITED);
                    if (r2 !== null) {
                        this.engine.transition(EngineEvent.ALL_PHASES_PASS);
                    }
                }
                await this.engine.persist();
                this.engine.emit('run:completed', runbook);
                this.engine.emit('run:consolidate', this.engine.getStateManager().getSessionDir());
            }
            this.engine.emitUIMessage({
                type: 'STATE_SNAPSHOT',
                payload: { runbook, engineState: this.engine.getState() },
            });
            return;
        }

        // More phases to do — transition to EXECUTING_WORKER and dispatch
        const startResult = this.engine.transition(EngineEvent.START);
        if (startResult !== null) {
            runbook.status = 'running';
            await this.engine.persist();
            this.engine.startStallWatchdog();
            this.engine.dispatchReadyPhases().catch(err => {
                log.error('[PhaseController] skipPhase dispatch failed:', err);
            });
        }
    }
}
