// ─────────────────────────────────────────────────────────────────────────────
// src/engine/OrchestratorEngine.ts — Deterministic state machine
// ─────────────────────────────────────────────────────────────────────────────

import { EventEmitter } from 'node:events';
import {
    OrchestratorState,
    OrchestratorEvent,
    STATE_TRANSITIONS,
} from '../types/index.js';
import type {
    Runbook,
    Phase,
    PhaseStatus,
    HostToWebviewMessage,
    SuccessEvaluator,
} from '../types/index.js';
import { StateManager } from '../state/StateManager.js';
import { Scheduler } from './Scheduler.js';
import { SelfHealingController } from './SelfHealing.js';
import { EvaluatorRegistry } from '../evaluators/CompilerEvaluator.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Engine Events — typed EventEmitter
// ═══════════════════════════════════════════════════════════════════════════════

export interface EngineEvents {
    /** Fired on every state transition. */
    'state:changed': (from: OrchestratorState, to: OrchestratorState, event: OrchestratorEvent) => void;
    /** Fired when a message should be sent to the Webview. */
    'ui:message': (message: HostToWebviewMessage) => void;
    /** Fired when a phase is ready for execution (may fire multiple times for DAG). */
    'phase:execute': (phase: Phase) => void;
    /** Fired when execution is complete. */
    'run:completed': (runbook: Runbook) => void;
    /** Fired on any error. */
    'error': (error: Error) => void;
    /** Fired when a phase should be auto-retried (self-healing). */
    'phase:heal': (phase: Phase, augmentedPrompt: string) => void;
    /** Fired when a phase passes and should trigger a Git checkpoint. */
    'phase:checkpoint': (phaseId: number) => void;
    /** Fired when the user requests a plan from a prompt. */
    'plan:request': (prompt: string, feedback?: string) => void;
    /** Fired when the user rejects a plan and wants re-generation. */
    'plan:rejected': (prompt: string, feedback: string) => void;
}

// Typed EventEmitter helper
export declare interface OrchestratorEngine {
    on<K extends keyof EngineEvents>(event: K, listener: EngineEvents[K]): this;
    emit<K extends keyof EngineEvents>(event: K, ...args: Parameters<EngineEvents[K]>): boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  OrchestratorEngine — the brain
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Deterministic finite state machine governing the Isolated-Agent execution lifecycle.
 *
 * Responsibilities:
 * - Owns and enforces the 9-state lifecycle (including PLANNING + PLAN_REVIEW).
 * - Validates all transitions against the STATE_TRANSITIONS table.
 * - Emits typed events for state changes, UI updates, and phase dispatch.
 * - Persists state via StateManager after every mutation.
 * - Does NOT spawn agents — delegates to ADKController via events.
 *
 * See ARCHITECTURE.md § State Machine for the transition diagram.
 */
export class OrchestratorEngine extends EventEmitter {
    private state: OrchestratorState = OrchestratorState.IDLE;
    private runbook: Runbook | null = null;
    private pauseRequested = false;
    private planDraft: Runbook | null = null;
    private planPrompt = '';

    /**
     * Number of concurrently active workers.
     * AB-1 fix: The FSM stays in EXECUTING_WORKER while activeWorkerCount > 0.
     * Transition to EVALUATING only fires when the *last* worker exits.
     */
    private activeWorkerCount = 0;

    // ── Pillar 2+3 subsystems ────────────────────────────────────────────
    private readonly scheduler: Scheduler;
    private readonly healer: SelfHealingController;
    private evaluatorRegistry: EvaluatorRegistry | null = null;

    constructor(
        private readonly stateManager: StateManager,
        options?: {
            scheduler?: Scheduler;
            healer?: SelfHealingController;
            workspaceRoot?: string;
        }
    ) {
        super();
        this.scheduler = options?.scheduler ?? new Scheduler();
        this.healer = options?.healer ?? new SelfHealingController();
        if (options?.workspaceRoot) {
            this.evaluatorRegistry = new EvaluatorRegistry(options.workspaceRoot);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  State Access
    // ═══════════════════════════════════════════════════════════════════════════

    /** Get the current engine state. */
    public getState(): OrchestratorState {
        return this.state;
    }

    /** Get the loaded runbook (or null). */
    public getRunbook(): Runbook | null {
        return this.runbook;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  State Machine Core
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Attempt a state transition. Returns the new state, or null if invalid.
     * Invalid transitions are silently rejected with a log.
     */
    public transition(event: OrchestratorEvent): OrchestratorState | null {
        const allowed = STATE_TRANSITIONS[this.state];
        const nextState = allowed[event];

        if (nextState === undefined) {
            console.warn(
                `[Engine] Invalid transition: ${this.state} + ${event} → rejected`
            );
            this.emitUIMessage({
                type: 'LOG_ENTRY',
                payload: {
                    timestamp: Date.now(),
                    level: 'warn',
                    message: `Invalid command "${event}" in state "${this.state}".`,
                },
            });
            return null;
        }

        const prev = this.state;
        this.state = nextState;

        console.log(`[Engine] ${prev} → ${nextState} (${event})`);
        this.emit('state:changed', prev, nextState, event);

        return nextState;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  User Commands
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Load and validate a runbook from disk.
     */
    public async loadRunbook(filePath?: string): Promise<void> {
        this.transition(OrchestratorEvent.LOAD_RUNBOOK);

        try {
            // Use StateManager to load + validate
            const runbook = await this.stateManager.loadRunbook();

            if (!runbook) {
                this.transition(OrchestratorEvent.PARSE_FAILURE);
                this.emitUIMessage({
                    type: 'ERROR',
                    payload: {
                        code: 'RUNBOOK_NOT_FOUND',
                        message: 'No .task-runbook.json found in the session directory (.isolated_agent/ipc/).',
                    },
                });
                return;
            }

            this.runbook = runbook;
            this.transition(OrchestratorEvent.PARSE_SUCCESS);

            // Send full state to the UI
            this.emitUIMessage({
                type: 'STATE_SNAPSHOT',
                payload: {
                    runbook: this.runbook,
                    engineState: this.state,
                },
            });
        } catch (err: unknown) {
            this.transition(OrchestratorEvent.PARSE_FAILURE);
            this.emitUIMessage({
                type: 'ERROR',
                payload: {
                    code: 'PARSE_ERROR',
                    message: err instanceof Error ? err.message : String(err),
                },
            });
        }
    }

    /**
     * Begin (or resume) sequential execution from `current_phase`.
     */
    public async start(): Promise<void> {
        if (!this.runbook) {
            this.emit('error', new Error('Cannot start: no runbook loaded.'));
            return;
        }

        this.pauseRequested = false;

        const result = this.transition(OrchestratorEvent.START);
        if (result === null) return;

        // Update runbook global status
        this.runbook.status = 'running';
        await this.persist();

        // Dispatch the current phase
        this.dispatchCurrentPhase();
    }

    /**
     * Pause execution after the current phase completes.
     * Does NOT interrupt a running worker — just prevents the next phase from starting.
     */
    public pause(): void {
        this.pauseRequested = true;
        this.emitUIMessage({
            type: 'LOG_ENTRY',
            payload: {
                timestamp: Date.now(),
                level: 'info',
                message: 'Pause requested — will halt after current phase completes.',
            },
        });
    }

    /**
     * Abort execution and transition to IDLE.
     */
    public async abort(): Promise<void> {
        const result = this.transition(OrchestratorEvent.ABORT);
        if (result === null) return;

        if (this.runbook) {
            this.runbook.status = 'idle';
            await this.persist();
        }

        this.emitUIMessage({
            type: 'STATE_SNAPSHOT',
            payload: {
                runbook: this.runbook!,
                engineState: this.state,
            },
        });
    }

    /**
     * Reset from COMPLETED → IDLE (start a new chat).
     * Clears the in-memory runbook so the UI returns to the initial prompt view.
     */
    public async reset(): Promise<void> {
        const result = this.transition(OrchestratorEvent.RESET);
        if (result === null) return;

        // Clear internal state for a fresh start (in-memory only, no file writes)
        this.runbook = null;

        this.emitUIMessage({
            type: 'LOG_ENTRY',
            payload: {
                timestamp: Date.now(),
                level: 'info',
                message: 'Session reset. Ready for a new chat.',
            },
        });
    }

    /**
     * Retry a failed phase.
     */
    public async retry(phaseId: number): Promise<void> {
        if (!this.runbook) return;

        const phase = this.runbook.phases.find(p => p.id === phaseId);
        if (!phase || phase.status !== 'failed') return;

        // Reset the phase
        phase.status = 'pending';
        this.runbook.current_phase = phaseId;

        const result = this.transition(OrchestratorEvent.RETRY);
        if (result === null) return;

        this.runbook.status = 'running';
        await this.persist();

        this.dispatchCurrentPhase();
    }

    /**
     * Skip a failed phase and move to the next one.
     */
    public async skipPhase(phaseId: number): Promise<void> {
        if (!this.runbook) return;

        const phase = this.runbook.phases.find(p => p.id === phaseId);
        if (!phase) return;

        phase.status = 'completed'; // Mark as skipped (completed)
        this.runbook.current_phase = phaseId + 1;

        this.transition(OrchestratorEvent.SKIP_PHASE);
        await this.persist();

        this.emitUIMessage({
            type: 'PHASE_STATUS',
            payload: { phaseId, status: 'completed' },
        });
    }

    /**
     * Edit a phase's prompt, files, or criteria before execution.
     */
    public async editPhase(
        phaseId: number,
        patch: Partial<Pick<Phase, 'prompt' | 'context_files' | 'success_criteria'>>
    ): Promise<void> {
        if (!this.runbook) return;

        const phase = this.runbook.phases.find(p => p.id === phaseId);
        if (!phase) return;

        if (patch.prompt !== undefined) phase.prompt = patch.prompt;
        if (patch.context_files !== undefined) phase.context_files = patch.context_files;
        if (patch.success_criteria !== undefined) phase.success_criteria = patch.success_criteria;

        await this.persist();

        this.emitUIMessage({
            type: 'STATE_SNAPSHOT',
            payload: { runbook: this.runbook, engineState: this.state },
        });
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Planning Commands — Conversational Runbook Generation
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * User submitted a prompt — start the planning flow.
     * Transitions IDLE → PLANNING and emits 'plan:request'.
     */
    public planRequest(prompt: string): void {
        this.planPrompt = prompt;
        this.planDraft = null;

        const result = this.transition(OrchestratorEvent.PLAN_REQUEST);
        if (result === null) return;

        this.emitUIMessage({
            type: 'PLAN_STATUS',
            payload: { status: 'generating', message: 'Planning started...' },
        });
        this.emitUIMessage({
            type: 'STATE_SNAPSHOT',
            payload: {
                runbook: this.runbook ?? { project_id: '', status: 'idle', current_phase: 0, phases: [] },
                engineState: this.state,
            },
        });

        this.emit('plan:request', prompt);
    }

    /**
     * Planner agent produced a draft runbook.
     * Transitions PLANNING → PLAN_REVIEW.
     */
    public planGenerated(draft: Runbook, fileTree: string[]): void {
        this.planDraft = draft;

        const result = this.transition(OrchestratorEvent.PLAN_GENERATED);
        if (result === null) return;

        this.emitUIMessage({
            type: 'PLAN_DRAFT',
            payload: { draft, fileTree },
        });
        this.emitUIMessage({
            type: 'STATE_SNAPSHOT',
            payload: {
                runbook: draft,
                engineState: this.state,
            },
        });
    }

    /**
     * User approved the AI-generated plan.
     * Saves draft to disk and transitions PLAN_REVIEW → PARSING.
     */
    public async planApproved(): Promise<void> {
        if (!this.planDraft) {
            this.emit('error', new Error('Cannot approve: no draft available.'));
            return;
        }

        // Save the draft as the active runbook
        await this.stateManager.saveRunbook(this.planDraft, this.state);

        // Transition to PARSING and load the saved runbook
        const result = this.transition(OrchestratorEvent.PLAN_APPROVED);
        if (result === null) return;

        // Load and validate the saved runbook (reuses existing loadRunbook logic)
        try {
            const runbook = await this.stateManager.loadRunbook();
            if (!runbook) {
                this.transition(OrchestratorEvent.PARSE_FAILURE);
                return;
            }
            this.runbook = runbook;
            this.transition(OrchestratorEvent.PARSE_SUCCESS);

            this.emitUIMessage({
                type: 'STATE_SNAPSHOT',
                payload: { runbook: this.runbook, engineState: this.state },
            });
        } catch (err) {
            this.transition(OrchestratorEvent.PARSE_FAILURE);
            this.emitUIMessage({
                type: 'ERROR',
                payload: {
                    code: 'PARSE_ERROR',
                    message: err instanceof Error ? err.message : String(err),
                },
            });
        }
    }

    /**
     * User rejected the plan — re-plan with feedback.
     * Transitions PLAN_REVIEW → PLANNING and emits 'plan:rejected'.
     */
    public planRejected(feedback: string): void {
        const result = this.transition(OrchestratorEvent.PLAN_REJECTED);
        if (result === null) return;

        this.emitUIMessage({
            type: 'PLAN_STATUS',
            payload: { status: 'generating', message: 'Re-planning with feedback...' },
        });

        this.emit('plan:rejected', this.planPrompt, feedback);
    }

    /**
     * User edited the draft directly in the review panel.
     */
    public updatePlanDraft(draft: Runbook): void {
        this.planDraft = draft;
    }

    /** Get the current plan draft (for review). */
    public getPlanDraft(): Runbook | null {
        return this.planDraft;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Worker Callbacks — called by ADKController
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Called when a worker exits. Orchestrates evaluation → verdict → advance.
     * See 02-review.md § R9 and AB-1.
     *
     * AB-1: In parallel mode, multiple workers run concurrently. The FSM
     * transition to EVALUATING only fires when the *last* active worker exits.
     * Intermediate exits evaluate and update the phase in-place without
     * disrupting the FSM for sibling workers.
     */
    public async onWorkerExited(
        phaseId: number,
        exitCode: number,
        stdout = '',
        stderr = ''
    ): Promise<void> {
        if (!this.runbook) return;

        this.activeWorkerCount = Math.max(0, this.activeWorkerCount - 1);

        const phase = this.runbook.phases.find(p => p.id === phaseId);
        if (!phase) return;

        const passed = await this.evaluatePhaseResult(phase, exitCode, stdout, stderr);

        if (this.activeWorkerCount === 0) {
            // Last worker exited — do full FSM transition
            this.transition(OrchestratorEvent.WORKER_EXITED);
            await this.applyVerdict(phase, passed, exitCode, stderr);
        } else {
            // Other workers still running — evaluate in-place without FSM transition
            await this.applyVerdictInPlace(phase, passed, exitCode, stderr);
        }
    }

    /**
     * Evaluate a phase's success criteria against the worker's output.
     * Uses the pluggable EvaluatorRegistry (Pillar 3) when available,
     * falling back to simple exit code matching.
     */
    public async evaluatePhaseResult(
        phase: Phase,
        exitCode: number,
        stdout: string,
        stderr: string
    ): Promise<boolean> {
        if (this.evaluatorRegistry) {
            const evaluator = this.evaluatorRegistry.get(phase.evaluator);
            return evaluator.evaluate(phase.success_criteria, exitCode, stdout, stderr);
        }
        return this.evaluateSuccess(phase.success_criteria, exitCode);
    }

    /**
     * Apply the evaluation verdict: update phase/runbook state, handle
     * self-healing retries, and advance the schedule on success.
     */
    public async applyVerdict(
        phase: Phase,
        passed: boolean,
        exitCode: number,
        stderr: string
    ): Promise<void> {
        if (!this.runbook) return;

        if (passed) {
            phase.status = 'completed';
            this.healer.clearAttempts(phase.id);
            this.emitUIMessage({
                type: 'PHASE_STATUS',
                payload: { phaseId: phase.id, status: 'completed' },
            });

            // Emit checkpoint event for GitManager
            this.emit('phase:checkpoint', phase.id);

            // Check if all phases are done (DAG-aware)
            const allDone = this.scheduler.isAllDone(this.runbook.phases);

            if (allDone) {
                const hasFailed = this.runbook.phases.some(p => p.status === 'failed');
                if (hasFailed) {
                    // Some parallel sibling failed — transition to ERROR_PAUSED
                    this.runbook.status = 'paused_error';
                    this.transition(OrchestratorEvent.PHASE_FAIL);
                    await this.persist();
                    this.emitUIMessage({
                        type: 'STATE_SNAPSHOT',
                        payload: { runbook: this.runbook, engineState: this.state },
                    });
                    return;
                }
                this.runbook.status = 'completed';
                this.transition(OrchestratorEvent.ALL_PHASES_PASS);
                await this.persist();
                this.emit('run:completed', this.runbook);
                this.emitUIMessage({
                    type: 'STATE_SNAPSHOT',
                    payload: { runbook: this.runbook, engineState: this.state },
                });
                return;
            }

            // Advance: use DAG scheduler to find next ready phases
            this.transition(OrchestratorEvent.PHASE_PASS);
            await this.persist();

            this.advanceSchedule();
        } else {
            // ── Self-healing check (Pillar 3) ────────────────────────────────
            this.healer.recordFailure(phase.id, exitCode, stderr);

            if (this.healer.canRetryWithPhase(phase)) {
                const augmentedPrompt = this.healer.buildHealingPrompt(phase);
                const delay = this.healer.getRetryDelay(phase.id);
                const attempt = this.healer.getAttemptCount(phase.id);

                this.emitUIMessage({
                    type: 'LOG_ENTRY',
                    payload: {
                        timestamp: Date.now(),
                        level: 'warn',
                        message: `Phase ${phase.id} failed — auto-retrying (attempt ${attempt}, delay ${delay}ms)…`,
                    },
                });

                this.transition(OrchestratorEvent.PHASE_FAIL);
                phase.status = 'pending';
                await this.persist();

                setTimeout(() => {
                    this.emit('phase:heal', phase, augmentedPrompt);
                }, delay);
                return;
            }

            // Max retries exhausted — surface to user
            phase.status = 'failed';
            this.runbook.status = 'paused_error';
            this.transition(OrchestratorEvent.PHASE_FAIL);
            await this.persist();

            this.emitUIMessage({
                type: 'PHASE_STATUS',
                payload: { phaseId: phase.id, status: 'failed' },
            });
            this.emitUIMessage({
                type: 'ERROR',
                payload: {
                    code: 'PHASE_FAILED',
                    message: `Phase ${phase.id} failed after ${this.healer.getAttemptCount(phase.id)} attempts (exit code ${exitCode}).`,
                    phaseId: phase.id,
                },
            });
        }
    }

    /**
     * Apply a verdict while other workers are still running (AB-1 parallel mode).
     * Updates phase status and dispatches newly-ready phases without FSM transitions.
     * The FSM remains in EXECUTING_WORKER until the last worker exits.
     */
    private async applyVerdictInPlace(
        phase: Phase,
        passed: boolean,
        exitCode: number,
        stderr: string
    ): Promise<void> {
        if (!this.runbook) return;

        if (passed) {
            phase.status = 'completed';
            this.healer.clearAttempts(phase.id);
            this.emitUIMessage({
                type: 'PHASE_STATUS',
                payload: { phaseId: phase.id, status: 'completed' },
            });
            this.emit('phase:checkpoint', phase.id);
            await this.persist();

            // Dispatch any newly-unblocked phases from this completion
            this.dispatchReadyPhases();
        } else {
            this.healer.recordFailure(phase.id, exitCode, stderr);

            if (this.healer.canRetryWithPhase(phase)) {
                const augmentedPrompt = this.healer.buildHealingPrompt(phase);
                const delay = this.healer.getRetryDelay(phase.id);
                phase.status = 'pending';
                await this.persist();
                setTimeout(() => {
                    this.emit('phase:heal', phase, augmentedPrompt);
                }, delay);
                return;
            }

            phase.status = 'failed';
            await this.persist();
            this.emitUIMessage({
                type: 'PHASE_STATUS',
                payload: { phaseId: phase.id, status: 'failed' },
            });
            this.emitUIMessage({
                type: 'ERROR',
                payload: {
                    code: 'PHASE_FAILED',
                    message: `Phase ${phase.id} failed (exit code ${exitCode}). Other workers still running.`,
                    phaseId: phase.id,
                },
            });
        }
    }

    /**
     * Advance the schedule after a successful phase.
     * Checks for pause requests and dispatches next ready phases (DAG-aware).
     */
    public advanceSchedule(): void {
        if (!this.runbook) return;

        if (this.pauseRequested) {
            this.pauseRequested = false;
            this.runbook.status = 'idle';
            this.persist().catch(console.error);
            this.emitUIMessage({
                type: 'LOG_ENTRY',
                payload: {
                    timestamp: Date.now(),
                    level: 'info',
                    message: 'Execution paused after phase completion.',
                },
            });
            return;
        }

        this.dispatchReadyPhases();
    }

    /**
     * Called when a worker times out or crashes.
     * AB-1: In parallel mode, mark the phase as failed but only transition
     * the FSM to ERROR_PAUSED when no other workers are still running.
     */
    public async onWorkerFailed(phaseId: number, reason: 'timeout' | 'crash'): Promise<void> {
        if (!this.runbook) return;

        this.activeWorkerCount = Math.max(0, this.activeWorkerCount - 1);

        const phase = this.runbook.phases.find(p => p.id === phaseId);
        if (phase) phase.status = 'failed';

        if (this.activeWorkerCount === 0) {
            // Last worker — transition FSM
            const event = reason === 'timeout'
                ? OrchestratorEvent.WORKER_TIMEOUT
                : OrchestratorEvent.WORKER_CRASH;
            this.transition(event);
            this.runbook.status = 'paused_error';
            await this.persist();
        } else {
            // Other workers still running — record failure but don't transition FSM yet
            await this.persist();
        }

        this.emitUIMessage({
            type: 'ERROR',
            payload: {
                code: reason === 'timeout' ? 'WORKER_TIMEOUT' : 'WORKER_CRASH',
                message: `Worker for phase ${phaseId} ${reason === 'timeout' ? 'timed out' : 'crashed'}.`,
                phaseId,
            },
        });
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Private Helpers
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Dispatch the current phase for execution (V1 sequential fallback).
     * Emits 'phase:execute' which the ADKController listens to.
     */
    private dispatchCurrentPhase(): void {
        if (!this.runbook) return;

        const phase = this.runbook.phases.find(
            p => p.id === this.runbook!.current_phase
        );

        if (!phase) {
            console.warn(`[Engine] Phase ${this.runbook.current_phase} not found.`);
            return;
        }

        // Mark as running and track
        phase.status = 'running';
        this.activeWorkerCount++;
        this.emitUIMessage({
            type: 'PHASE_STATUS',
            payload: { phaseId: phase.id, status: 'running' },
        });

        // Delegate execution to ADKController
        this.emit('phase:execute', phase);
    }

    /**
     * Dispatch all ready phases (DAG-aware).
     * Replaces sequential `current_phase++` with frontier-set dispatch.
     */
    private dispatchReadyPhases(): void {
        if (!this.runbook) return;

        const readyPhases = this.scheduler.getReadyPhases(this.runbook.phases);

        if (readyPhases.length === 0) {
            // No phases ready but not all done — might be waiting on running phases
            return;
        }

        for (const phase of readyPhases) {
            phase.status = 'running';
            this.activeWorkerCount++;
            this.emitUIMessage({
                type: 'PHASE_STATUS',
                payload: { phaseId: phase.id, status: 'running' },
            });
            this.emit('phase:execute', phase);
        }
    }

    /**
     * Evaluate success criteria against a worker's exit code.
     * V1: Simple exit code matching.
     */
    private evaluateSuccess(criteria: string, exitCode: number): boolean {
        if (criteria.startsWith('exit_code:')) {
            const expected = parseInt(criteria.split(':')[1], 10);
            return exitCode === expected;
        }
        // Default: exit 0
        return exitCode === 0;
    }

    /** Persist the current runbook state to disk. */
    private async persist(): Promise<void> {
        if (!this.runbook) return;
        await this.stateManager.saveRunbook(this.runbook, this.state);
    }

    /** Convenience: send a message to the UI. */
    private emitUIMessage(message: HostToWebviewMessage): void {
        this.emit('ui:message', message);
    }
}
