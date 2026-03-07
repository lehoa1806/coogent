// ─────────────────────────────────────────────────────────────────────────────
// src/engine/SessionController.ts — Session/runbook lifecycle management
// ─────────────────────────────────────────────────────────────────────────────
// Sprint 1 Extract: Session cluster from Engine.ts.
// Handles loadRunbook, reset, switchSession.

import {
    EngineState,
    EngineEvent,
    RUNBOOK_FILENAME,
    asTimestamp,
} from '../types/index.js';
import type { Engine } from './Engine.js';
import type { StateManager } from '../state/StateManager.js';

/**
 * Extracted session lifecycle logic from Engine.
 *
 * Manages runbook loading/validation, session reset, and session switching.
 * All FSM transitions are delegated back to the owning Engine.
 */
export class SessionController {
    constructor(private readonly engine: Engine) { }

    /**
     * Load and validate a runbook from disk.
     * Transitions IDLE → READY on success, or back to IDLE on failure.
     */
    public async loadRunbook(): Promise<void> {
        const transResult = this.engine.transition(EngineEvent.LOAD_RUNBOOK);
        if (transResult === null) return;

        try {
            const runbook = await this.engine.getStateManager().loadRunbook();

            if (!runbook) {
                this.engine.transition(EngineEvent.PARSE_FAILURE);
                this.engine.emitUIMessage({
                    type: 'ERROR',
                    payload: {
                        code: 'RUNBOOK_NOT_FOUND',
                        message: `No ${RUNBOOK_FILENAME} found in the session directory (.coogent/ipc/).`,
                    },
                });
                return;
            }

            const cycleMembers = this.engine.getScheduler().detectCycles(runbook.phases);
            if (cycleMembers.length > 0) {
                this.engine.transition(EngineEvent.PARSE_FAILURE);
                this.engine.emitUIMessage({
                    type: 'ERROR',
                    payload: {
                        code: 'CYCLE_DETECTED',
                        message: `Cyclic dependency detected in phases: [${cycleMembers.join(', ')}]. ` +
                            `Fix the depends_on fields in your runbook.`,
                    },
                });
                return;
            }

            // MF-1 FIX: Validate depends_on reference integrity.
            // A dangling reference (typo like depends_on: [99]) would silently
            // block the phase forever. Catch it early with a clear error.
            const phaseIds = new Set(runbook.phases.map(p => p.id));
            for (const phase of runbook.phases) {
                for (const depId of (phase.depends_on ?? [])) {
                    if (!phaseIds.has(depId)) {
                        this.engine.transition(EngineEvent.PARSE_FAILURE);
                        this.engine.emitUIMessage({
                            type: 'ERROR',
                            payload: {
                                code: 'VALIDATION_ERROR',
                                message: `Phase ${phase.id} references non-existent dependency: ${depId}. ` +
                                    `Check the depends_on field in your runbook.`,
                            },
                        });
                        return;
                    }
                }
            }

            this.engine.setRunbook(runbook);
            this.engine.transition(EngineEvent.PARSE_SUCCESS);

            this.engine.emitUIMessage({
                type: 'STATE_SNAPSHOT',
                payload: {
                    runbook,
                    engineState: this.engine.getState(),
                },
            });
        } catch (err: unknown) {
            this.engine.transition(EngineEvent.PARSE_FAILURE);
            this.engine.emitUIMessage({
                type: 'ERROR',
                payload: {
                    code: 'PARSE_ERROR',
                    message: err instanceof Error ? err.message : String(err),
                },
            });
        }
    }

    /**
     * Reset from COMPLETED → IDLE (start a new chat).
     * Cleans up timers, runbook state, and optionally swaps the StateManager.
     */
    public async reset(newStateManager?: StateManager): Promise<void> {
        const result = this.engine.transition(EngineEvent.RESET);
        if (result === null) return;

        this.engine.cleanupTimers();
        this.engine.setRunbook(null);
        this.engine.resetControllers();
        this.engine.setActiveWorkerCount(0);
        this.engine.setPauseRequested(false);
        this.engine.getHealer().reset();

        if (newStateManager) {
            this.engine.replaceStateManager(newStateManager);
        }

        this.engine.emitUIMessage({
            type: 'LOG_ENTRY',
            payload: {
                timestamp: asTimestamp(),
                level: 'info',
                message: 'Session reset. Ready for a new chat.',
            },
        });

        this.engine.emitUIMessage({
            type: 'STATE_SNAPSHOT',
            payload: {
                runbook: { project_id: '', status: 'idle', current_phase: 0, phases: [] },
                engineState: this.engine.getState(),
            },
        });
    }

    /**
     * Switch to a different session by replacing the StateManager.
     * Only allowed from safe states (IDLE, READY, COMPLETED, ERROR_PAUSED, PLAN_REVIEW).
     */
    public async switchSession(newStateManager: StateManager): Promise<void> {
        const safeToSwitch = new Set([
            EngineState.IDLE,
            EngineState.READY,
            EngineState.COMPLETED,
            EngineState.ERROR_PAUSED,
            EngineState.PLAN_REVIEW,
        ]);

        if (!safeToSwitch.has(this.engine.getState())) {
            this.engine.emitUIMessage({
                type: 'LOG_ENTRY',
                payload: {
                    timestamp: asTimestamp(),
                    level: 'warn',
                    message: 'Cannot switch session: engine is currently executing. Abort first.',
                },
            });
            return;
        }

        if (this.engine.getState() !== EngineState.IDLE) {
            this.engine.transition(EngineEvent.RESET);
        }

        this.engine.replaceStateManager(newStateManager);
        this.engine.setRunbook(null);
        this.engine.resetControllers();
        this.engine.setActiveWorkerCount(0);

        await this.loadRunbook();
    }
}
