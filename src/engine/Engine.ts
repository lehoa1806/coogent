// ─────────────────────────────────────────────────────────────────────────────
// src/engine/Engine.ts — Deterministic state machine
// ─────────────────────────────────────────────────────────────────────────────

import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import log from '../logger/log.js';
import {
    EngineState,
    EngineEvent,
    STATE_TRANSITIONS,
    RUNBOOK_FILENAME,
    asPhaseId,
    asTimestamp,
} from '../types/index.js';
import type {
    Runbook,
    Phase,
    PhaseId,
    HostToWebviewMessage,
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
    'state:changed': (from: EngineState, to: EngineState, event: EngineEvent) => void;
    /** Fired when a message should be sent to the Webview. */
    'ui:message': (message: HostToWebviewMessage) => void;
    /** Fired when a phase is ready for execution (may fire multiple times for DAG). */
    'phase:execute': (phase: Phase) => void;
    /** Fired when execution is complete. */
    'run:completed': (runbook: Runbook) => void;
    /** Fired when all phases are done — triggers consolidation report generation. */
    'run:consolidate': (sessionDir: string) => void;
    /** Fired on any error. */
    'error': (error: Error) => void;
    /** Fired when a phase should be auto-retried (self-healing). */
    'phase:heal': (phase: Phase, augmentedPrompt: string) => void;
    /** Fired when a phase passes and should trigger a Git checkpoint. */
    'phase:checkpoint': (phaseId: number) => void;
    /** Fired when the user requests force-stopping a specific phase's worker. */
    'phase:stop': (phaseId: number) => void;
    /** Fired when the user requests a plan from a prompt. */
    'plan:request': (prompt: string, feedback?: string) => void;
    /** Fired when the user rejects a plan and wants re-generation. */
    'plan:rejected': (prompt: string, feedback: string) => void;
    /** Fired when the user wants to retry parsing cached timeout output. */
    'plan:retryParse': () => void;
    /** Fired when the user requests a diff review for a specific phase. */
    'phase:review-diff': (phaseId: number) => void;
}

// Typed EventEmitter helper
export declare interface Engine {
    on<K extends keyof EngineEvents>(event: K, listener: EngineEvents[K]): this;
    emit<K extends keyof EngineEvents>(event: K, ...args: Parameters<EngineEvents[K]>): boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Engine — the brain
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Deterministic finite state machine governing the Coogent execution lifecycle.
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
export class Engine extends EventEmitter {
    private state: EngineState = EngineState.IDLE;
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

    /** Tracked self-healing timer handles for cancellation on abort/reset. */
    private healingTimers: Set<ReturnType<typeof setTimeout>> = new Set();

    /** Lifecycle watchdog — detects stalled pipelines where all workers are dead. */
    private stallWatchdog: ReturnType<typeof setInterval> | null = null;
    private readonly STALL_CHECK_INTERVAL_MS = 30_000;

    /**
     * Serialization mutex for onWorkerExited.
     * Prevents two concurrent calls from both seeing activeWorkerCount === 0
     * and double-firing the FSM transition (B-1 fix).
     */
    private workerExitLock: Promise<void> = Promise.resolve();

    // ── Pillar 2+3 subsystems ────────────────────────────────────────────
    private readonly scheduler: Scheduler;
    private readonly healer: SelfHealingController;
    private evaluatorRegistry: EvaluatorRegistry | null = null;

    constructor(
        private stateManager: StateManager,
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
    public getState(): EngineState {
        return this.state;
    }

    /** Get the loaded runbook (or null). */
    public getRunbook(): Runbook | null {
        return this.runbook;
    }

    /**
     * B-4: Public accessor for the active session directory basename.
     * Removes the need for unsafe cast-through-unknown in MissionControlPanel.
     */
    public getSessionDirName(): string | undefined {
        try {
            const dir = this.stateManager.getSessionDir();
            return dir ? path.basename(dir) : undefined;
        } catch {
            return undefined;
        }
    }

    /** Update the global max retries at runtime (delegates to SelfHealingController). */
    public setMaxRetries(maxRetries: number): void {
        this.healer.setMaxRetries(maxRetries);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  State Machine Core
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Attempt a state transition. Returns the new state, or null if invalid.
     * Invalid transitions are silently rejected with a log.
     */
    public transition(event: EngineEvent): EngineState | null {
        const allowed = STATE_TRANSITIONS[this.state];
        const nextState = allowed[event];

        if (nextState === undefined) {
            log.warn(
                `[Engine] Invalid transition: ${this.state} + ${event} → rejected`
            );
            this.emitUIMessage({
                type: 'LOG_ENTRY',
                payload: {
                    timestamp: asTimestamp(),
                    level: 'warn',
                    message: `Invalid command "${event}" in state "${this.state}".`,
                },
            });
            return null;
        }

        const prev = this.state;
        this.state = nextState;

        log.info(`[Engine] ${prev} → ${nextState} (${event})`);
        this.emit('state:changed', prev, nextState, event);

        return nextState;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  User Commands
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Load and validate a runbook from disk.
     */
    public async loadRunbook(_filePath?: string): Promise<void> {
        const transResult = this.transition(EngineEvent.LOAD_RUNBOOK);
        if (transResult === null) return; // B-5: Guard against invalid state

        try {
            // Use StateManager to load + validate
            const runbook = await this.stateManager.loadRunbook();

            if (!runbook) {
                this.transition(EngineEvent.PARSE_FAILURE);
                this.emitUIMessage({
                    type: 'ERROR',
                    payload: {
                        code: 'RUNBOOK_NOT_FOUND',
                        message: `No ${RUNBOOK_FILENAME} found in the session directory (.coogent/ipc/).`,
                    },
                });
                return;
            }

            // Detect cycles in DAG before accepting the runbook (#31)
            const cycleMembers = this.scheduler.detectCycles(runbook.phases);
            if (cycleMembers.length > 0) {
                this.transition(EngineEvent.PARSE_FAILURE);
                this.emitUIMessage({
                    type: 'ERROR',
                    payload: {
                        code: 'CYCLE_DETECTED',
                        message: `Cyclic dependency detected in phases: [${cycleMembers.join(', ')}]. ` +
                            `Fix the depends_on fields in your runbook.`,
                    },
                });
                return;
            }

            this.runbook = runbook;
            this.transition(EngineEvent.PARSE_SUCCESS);

            // Send full state to the UI
            this.emitUIMessage({
                type: 'STATE_SNAPSHOT',
                payload: {
                    runbook: this.runbook,
                    engineState: this.state,
                },
            });
        } catch (err: unknown) {
            this.transition(EngineEvent.PARSE_FAILURE);
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
     * Begin (or resume) execution.
     * Uses DAG-aware dispatch when phases have `depends_on`, otherwise V1 sequential.
     */
    public async start(): Promise<void> {
        if (!this.runbook) {
            this.emit('error', new Error('Cannot start: no runbook loaded.'));
            return;
        }

        this.pauseRequested = false;

        const result = this.transition(EngineEvent.START);
        if (result === null) return;

        // Update runbook global status
        this.runbook.status = 'running';
        await this.persist();

        // Start the stall watchdog
        this.startStallWatchdog();

        // Dispatch ready phases (DAG-aware; falls back to sequential internally)
        this.dispatchReadyPhases();
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
                timestamp: asTimestamp(),
                level: 'info',
                message: 'Pause requested — will halt after current phase completes.',
            },
        });
    }

    /**
     * Abort execution and transition to IDLE.
     * Cleans up all active workers, cancels healing timers, and resets running phases.
     */
    public async abort(): Promise<void> {
        const result = this.transition(EngineEvent.ABORT);
        if (result === null) return;

        // Cancel any pending self-healing timers
        for (const timer of this.healingTimers) {
            clearTimeout(timer);
        }
        this.healingTimers.clear();
        this.stopStallWatchdog();

        if (this.runbook) {
            // Mark all running phases as pending so they can be re-run later
            for (const phase of this.runbook.phases) {
                if (phase.status === 'running') {
                    phase.status = 'pending';
                    this.emit('phase:stop', phase.id);
                }
            }
            this.runbook.status = 'idle';
            await this.persist();
        }

        // Reset worker count — all workers should be terminated by phase:stop listeners
        this.activeWorkerCount = 0;

        // W-10: Guard against null runbook when aborting before any runbook is loaded
        if (this.runbook) {
            this.emitUIMessage({
                type: 'STATE_SNAPSHOT',
                payload: {
                    runbook: this.runbook,
                    engineState: this.state,
                },
            });
        }
    }

    /**
     * Reset from COMPLETED → IDLE (start a new chat).
     * Clears all in-memory state so the UI returns to the initial prompt view.
     * If a new StateManager is provided, the engine switches to that session
     * directory so the next loadRunbook() won't reload the old session.
     */
    public async reset(newStateManager?: StateManager): Promise<void> {
        const result = this.transition(EngineEvent.RESET);
        if (result === null) return;

        // Cancel any pending self-healing timers
        for (const timer of this.healingTimers) {
            clearTimeout(timer);
        }
        this.healingTimers.clear();
        this.stopStallWatchdog();

        // Clear ALL internal state for a fresh start
        this.runbook = null;
        this.planDraft = null;
        this.planPrompt = '';
        this.activeWorkerCount = 0;
        this.pauseRequested = false;
        this.healer.reset();

        // Switch to a fresh session directory so loadRunbook() starts clean
        if (newStateManager) {
            this.stateManager = newStateManager;
        }

        this.emitUIMessage({
            type: 'LOG_ENTRY',
            payload: {
                timestamp: asTimestamp(),
                level: 'info',
                message: 'Session reset. Ready for a new chat.',
            },
        });

        // Emit a clean STATE_SNAPSHOT so the webview re-renders to IDLE
        this.emitUIMessage({
            type: 'STATE_SNAPSHOT',
            payload: {
                runbook: { project_id: '', status: 'idle', current_phase: 0, phases: [] },
                engineState: this.state,
            },
        });
    }

    /**
     * Switch to a different session by replacing the StateManager.
     * Only allowed when the engine is in IDLE state to prevent data loss.
     * After switching, automatically loads the runbook from the new session.
     */
    public async switchSession(newStateManager: StateManager): Promise<void> {
        // Allow switching from any non-executing state
        const safeToSwitch = new Set([
            EngineState.IDLE,
            EngineState.READY,
            EngineState.COMPLETED,
            EngineState.ERROR_PAUSED,
            EngineState.PLAN_REVIEW,
        ]);

        if (!safeToSwitch.has(this.state)) {
            this.emitUIMessage({
                type: 'LOG_ENTRY',
                payload: {
                    timestamp: asTimestamp(),
                    level: 'warn',
                    message: 'Cannot switch session: engine is currently executing. Abort first.',
                },
            });
            return;
        }

        // Auto-reset to IDLE if not already there — use proper FSM transition
        // to ensure state:changed events are emitted and listeners stay in sync.
        if (this.state !== EngineState.IDLE) {
            this.transition(EngineEvent.RESET);
        }

        this.stateManager = newStateManager;
        this.runbook = null;
        this.planDraft = null;
        this.planPrompt = '';
        this.activeWorkerCount = 0;

        // Load the runbook from the new session
        await this.loadRunbook();
    }

    /**
     * Retry a failed phase.
     */
    public async retry(phaseId: number): Promise<void> {
        if (!this.runbook) return;

        const phase = this.runbook.phases.find(p => p.id === phaseId);
        if (!phase || phase.status !== 'failed') return;

        // Transition FIRST — avoid stale mutations if the transition is invalid
        const result = this.transition(EngineEvent.RETRY);
        if (result === null) return;

        // Only mutate after confirming the transition succeeded
        phase.status = 'pending';
        this.runbook.current_phase = phaseId;
        this.runbook.status = 'running';
        await this.persist();

        // Restart stall watchdog
        this.startStallWatchdog();

        // Use DAG-aware dispatch (handles both sequential and parallel modes)
        this.dispatchReadyPhases();
    }

    /**
     * Skip a failed phase and move to the next one.
     * Advances the schedule so dependent phases can be unblocked.
     */
    public async skipPhase(phaseId: number): Promise<void> {
        if (!this.runbook) return;

        const phase = this.runbook.phases.find(p => p.id === phaseId);
        if (!phase) return;

        // Transition FIRST — avoid stale mutations if the transition is invalid
        const result = this.transition(EngineEvent.SKIP_PHASE);
        if (result === null) return;

        phase.status = 'completed'; // Mark as skipped (completed)
        this.runbook.current_phase = phaseId + 1;
        await this.persist();

        this.emitUIMessage({
            type: 'PHASE_STATUS',
            payload: { phaseId: phaseId as PhaseId, status: 'completed' },
        });

        // Advance schedule to unblock dependent phases
        // SKIP_PHASE transitions to READY — need START to dispatch workers
        const allDone = this.scheduler.isAllDone(this.runbook.phases);
        if (allDone) {
            const hasFailed = this.runbook.phases.some(p => p.status === 'failed');
            if (hasFailed) {
                this.runbook.status = 'paused_error';
                await this.persist();
            } else {
                this.runbook.status = 'completed';
                this.transition(EngineEvent.START); // READY → EXECUTING_WORKER
                this.transition(EngineEvent.WORKER_EXITED); // → EVALUATING
                this.transition(EngineEvent.ALL_PHASES_PASS); // → COMPLETED
                await this.persist();
                this.emit('run:completed', this.runbook);
                this.emit('run:consolidate', this.stateManager.getSessionDir());
            }
            this.emitUIMessage({
                type: 'STATE_SNAPSHOT',
                payload: { runbook: this.runbook, engineState: this.state },
            });
            return;
        }

        // More phases to do — transition to EXECUTING_WORKER and dispatch
        const startResult = this.transition(EngineEvent.START);
        if (startResult !== null) {
            this.runbook.status = 'running';
            await this.persist();
            this.startStallWatchdog();
            this.dispatchReadyPhases();
        }
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

    /**
     * Pause a specific phase — prevents its next dispatch after current worker completes.
     * Emits a LOG_ENTRY so the user sees immediate feedback.
     */
    public pausePhase(phaseId: number): void {
        this.pauseRequested = true;
        this.emitUIMessage({
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
     * Marks the phase as failed and emits a worker failure event.
     */
    public async stopPhase(phaseId: number): Promise<void> {
        if (!this.runbook) return;

        const phase = this.runbook.phases.find(p => p.id === phaseId);
        if (!phase || phase.status !== 'running') return;

        // Emit an event that ADKController will listen to for force-termination
        this.emit('phase:stop', phaseId);

        this.emitUIMessage({
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
        if (!this.runbook) return;

        const phase = this.runbook.phases.find(p => p.id === phaseId);
        if (!phase) return;

        // Only restart if not currently running
        if (phase.status === 'running') return;

        // Ensure the FSM is in a state that allows dispatching workers.
        // ERROR_PAUSED → use RETRY. READY/COMPLETED → use START.
        // Other states are not safe to restart from.
        if (this.state === EngineState.ERROR_PAUSED) {
            const result = this.transition(EngineEvent.RETRY);
            if (result === null) return;
        } else if (this.state === EngineState.READY || this.state === EngineState.COMPLETED) {
            const result = this.transition(EngineEvent.START);
            if (result === null) return;
        } else if (this.state !== EngineState.EXECUTING_WORKER) {
            // Cannot restart from PLANNING, PARSING, PLAN_REVIEW, EVALUATING, or IDLE
            this.emitUIMessage({
                type: 'LOG_ENTRY',
                payload: {
                    timestamp: asTimestamp(),
                    level: 'warn',
                    message: `Cannot restart phase #${phaseId}: engine is in state "${this.state}".`,
                },
            });
            return;
        }

        phase.status = 'pending';
        this.runbook.current_phase = phaseId;
        this.healer.clearAttempts(phaseId);
        this.runbook.status = 'running';
        await this.persist();

        this.emitUIMessage({
            type: 'LOG_ENTRY',
            payload: {
                timestamp: asTimestamp(),
                level: 'info',
                message: `Restarting phase #${phaseId} from scratch.`,
            },
        });

        this.dispatchCurrentPhase();
    }

    /**
     * Request a diff review for a specific phase.
     * Emits 'phase:review-diff' for the extension host to open a diff view.
     */
    public async reviewDiff(phaseId: number): Promise<void> {
        if (!this.runbook) return;

        const phase = this.runbook.phases.find(p => p.id === phaseId);
        if (!phase) return;

        this.emit('phase:review-diff', phaseId);

        this.emitUIMessage({
            type: 'LOG_ENTRY',
            payload: {
                timestamp: asTimestamp(),
                level: 'info',
                message: `Diff review requested for phase #${phaseId}.`,
            },
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

        const result = this.transition(EngineEvent.PLAN_REQUEST);
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

        const result = this.transition(EngineEvent.PLAN_GENERATED);
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
        const result = this.transition(EngineEvent.PLAN_APPROVED);
        if (result === null) return;

        // Load and validate the saved runbook (reuses existing loadRunbook logic)
        try {
            const runbook = await this.stateManager.loadRunbook();
            if (!runbook) {
                this.transition(EngineEvent.PARSE_FAILURE);
                return;
            }
            this.runbook = runbook;
            this.transition(EngineEvent.PARSE_SUCCESS);

            this.emitUIMessage({
                type: 'STATE_SNAPSHOT',
                payload: { runbook: this.runbook, engineState: this.state },
            });
        } catch (err) {
            this.transition(EngineEvent.PARSE_FAILURE);
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
        const result = this.transition(EngineEvent.PLAN_REJECTED);
        if (result === null) return;

        this.emitUIMessage({
            type: 'PLAN_STATUS',
            payload: { status: 'generating', message: 'Re-planning with feedback...' },
        });

        this.emit('plan:rejected', this.planPrompt, feedback);
    }

    /**
     * User wants to retry parsing cached timeout output.
     * Only valid while in PLANNING state (engine stays in PLANNING after timeout).
     * Emits 'plan:retryParse' — extension.ts listens and calls plannerAgent.retryParse().
     */
    public planRetryParse(): void {
        if (this.state !== EngineState.PLANNING && this.state !== EngineState.IDLE) {
            log.warn(`[Engine] planRetryParse() rejected: engine is in state "${this.state}"`);
            return;
        }

        this.emit('plan:retryParse');
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
     * Called when a worker exits. Drives evaluation → verdict → advance.
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
        // B-1: Serialize through workerExitLock to prevent race condition
        // where two concurrent calls both decrement activeWorkerCount to 0
        // and both fire the FSM transition.
        this.workerExitLock = this.workerExitLock.then(async () => {
            if (!this.runbook) return;

            // Guard: skip if phase is no longer running (e.g., already handled by
            // onWorkerFailed due to a timeout/crash race)
            const phase = this.runbook.phases.find(p => p.id === phaseId);
            if (!phase || phase.status !== 'running') return;

            this.activeWorkerCount = Math.max(0, this.activeWorkerCount - 1);
            const isLastWorker = this.activeWorkerCount === 0;

            const passed = await this.evaluatePhaseResult(phase, exitCode, stdout, stderr);

            if (isLastWorker) {
                // Last worker exited — do full FSM transition
                this.transition(EngineEvent.WORKER_EXITED);
                await this.applyVerdict(phase, passed, exitCode, stderr);
            } else {
                // Other workers still running — evaluate in-place without FSM transition
                await this.applyVerdictInPlace(phase, passed, exitCode, stderr);
            }
        });
        return this.workerExitLock;
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
                    this.transition(EngineEvent.PHASE_FAIL);
                    await this.persist();
                    this.emitUIMessage({
                        type: 'STATE_SNAPSHOT',
                        payload: { runbook: this.runbook, engineState: this.state },
                    });
                    return;
                }
                this.runbook.status = 'completed';
                this.transition(EngineEvent.ALL_PHASES_PASS);
                await this.persist();
                this.emit('run:completed', this.runbook);
                this.emit('run:consolidate', this.stateManager.getSessionDir());
                this.emitUIMessage({
                    type: 'STATE_SNAPSHOT',
                    payload: { runbook: this.runbook, engineState: this.state },
                });
                return;
            }

            // Advance: use DAG scheduler to find next ready phases
            this.transition(EngineEvent.PHASE_PASS);
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
                        timestamp: asTimestamp(),
                        level: 'warn',
                        message: `Phase ${phase.id} failed — auto-retrying (attempt ${attempt}, delay ${delay}ms)…`,
                    },
                });

                this.transition(EngineEvent.PHASE_FAIL);
                phase.status = 'pending';
                await this.persist();

                const timer = setTimeout(() => {
                    this.healingTimers.delete(timer);
                    this.emit('phase:heal', phase, augmentedPrompt);
                }, delay);
                this.healingTimers.add(timer);
                return;
            }

            // Max retries exhausted — surface to user
            phase.status = 'failed';
            this.runbook.status = 'paused_error';
            this.transition(EngineEvent.PHASE_FAIL);
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
                const inPlaceTimer = setTimeout(() => {
                    this.healingTimers.delete(inPlaceTimer);
                    this.emit('phase:heal', phase, augmentedPrompt);
                }, delay);
                this.healingTimers.add(inPlaceTimer);
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
            this.persist().catch(log.onError);
            this.emitUIMessage({
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
     * Called when a worker times out or crashes.
     * AB-1: In parallel mode, mark the phase as failed but only transition
     * the FSM to ERROR_PAUSED when no other workers are still running.
     *
     * B-1 fix: Serialize through workerExitLock to prevent race condition
     * where concurrent onWorkerFailed + onWorkerExited calls both see
     * activeWorkerCount === 0 and double-fire the FSM transition.
     */
    public async onWorkerFailed(phaseId: number, reason: 'timeout' | 'crash'): Promise<void> {
        this.workerExitLock = this.workerExitLock.then(async () => {
            if (!this.runbook) return;

            const phase = this.runbook.phases.find(p => p.id === phaseId);
            // Guard: skip if phase is no longer running (race with onWorkerExited)
            if (!phase || phase.status !== 'running') return;

            this.activeWorkerCount = Math.max(0, this.activeWorkerCount - 1);
            phase.status = 'failed';

            // Emit PHASE_STATUS so UI reflects the failure immediately
            this.emitUIMessage({
                type: 'PHASE_STATUS',
                payload: { phaseId: asPhaseId(phaseId), status: 'failed' },
            });

            if (this.activeWorkerCount === 0) {
                // Last worker — transition FSM
                const event = reason === 'timeout'
                    ? EngineEvent.WORKER_TIMEOUT
                    : EngineEvent.WORKER_CRASH;
                this.transition(event);
                this.runbook.status = 'paused_error';
                this.stopStallWatchdog();
                await this.persist();
            } else {
                // Other workers still running — record failure but don't transition FSM yet
                await this.persist();

                // Dispatch any phases that are ready and don't depend on the failed phase
                this.dispatchReadyPhases();
            }

            this.emitUIMessage({
                type: 'ERROR',
                payload: {
                    code: reason === 'timeout' ? 'WORKER_TIMEOUT' : 'WORKER_CRASH',
                    message: `Worker for phase ${phaseId} ${reason === 'timeout' ? 'timed out' : 'crashed'}.`,
                    phaseId: asPhaseId(phaseId),
                },
            });
        });
        return this.workerExitLock;
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
            log.warn(`[Engine] Phase ${this.runbook.current_phase} not found.`);
            return;
        }

        // Mark as running and track
        phase.status = 'running';
        this.activeWorkerCount++;
        this.emitUIMessage({
            type: 'PHASE_STATUS',
            payload: { phaseId: phase.id, status: 'running' },
        });

        // Persist the running status so crash recovery knows the phase was in-flight
        this.persist().catch(log.onError);

        // Delegate execution to ADKController
        this.emit('phase:execute', phase);
    }

    /**
 * Dispatch all ready phases (DAG-aware).
 * Replaces sequential `current_phase++` with frontier-set dispatch.
 * W-6 fix: Await persist() so disk-write failures surface as errors.
 */
    private async dispatchReadyPhases(): Promise<void> {
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

        // W-6: Await persist so disk-write failures are observed
        try {
            await this.persist();
        } catch (err) {
            log.error('[Engine] dispatchReadyPhases persist failed:', err);
        }

        // Emit a STATE_SNAPSHOT *after* phases are set to 'running' so the
        // webview gets a full snapshot with the updated statuses.
        this.emitUIMessage({
            type: 'STATE_SNAPSHOT',
            payload: {
                runbook: this.runbook,
                engineState: this.state,
            },
        });
    }

    /**
 * Evaluate success criteria against a worker's exit code.
 * V1: Simple exit code matching.
 * W-4 fix: Log a warning when criteria format is unrecognized.
 */
    private evaluateSuccess(criteria: string, exitCode: number): boolean {
        if (criteria.startsWith('exit_code:')) {
            const expected = parseInt(criteria.split(':')[1], 10);
            return exitCode === expected;
        }
        // W-4: Warn on unrecognized criteria format
        if (criteria !== '' && !criteria.startsWith('exit_code:')) {
            log.warn(`[Engine] Unrecognized success_criteria "${criteria}" — falling back to exit_code:0`);
        }
        // Default: exit 0
        return exitCode === 0;
    }

    /**
     * Persist the current runbook state to disk.
     * StateManager.saveRunbook() uses WAL internally: writes WAL → temp file → atomic
     * rename → clears WAL. A crash between in-memory mutation and this call would
     * lose the mutation, but recovery via WAL replay ensures at-least-once delivery
     * of the *previous* persisted state.
     */
    private async persist(): Promise<void> {
        if (!this.runbook) return;
        await this.stateManager.saveRunbook(this.runbook, this.state);
    }

    /** Convenience: send a message to the UI. */
    private emitUIMessage(message: HostToWebviewMessage): void {
        this.emit('ui:message', message);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Lifecycle Watchdog — detects and recovers stalled pipelines
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Start the stall watchdog timer.
     * Checks periodically for a stall condition: engine is in EXECUTING_WORKER
     * but no workers are actually running (activeWorkerCount === 0 and no
     * phases have status 'running'). This can happen if a worker exit event
     * is lost or activeWorkerCount drifts.
     */
    private startStallWatchdog(): void {
        this.stopStallWatchdog();
        this.stallWatchdog = setInterval(() => {
            if (this.state !== EngineState.EXECUTING_WORKER) return;
            if (!this.runbook) return;

            const runningPhases = this.runbook.phases.filter(p => p.status === 'running');
            if (runningPhases.length > 0) return; // Workers are live, no stall

            // Stall detected: no running phases but FSM thinks workers are active
            log.warn(
                `[Engine] Stall watchdog: FSM in EXECUTING_WORKER but no running phases. ` +
                `activeWorkerCount=${this.activeWorkerCount}. Attempting recovery.`
            );

            // Fix the counter
            this.activeWorkerCount = 0;

            // Try to dispatch ready phases
            const readyPhases = this.scheduler.getReadyPhases(this.runbook.phases);
            if (readyPhases.length > 0) {
                this.emitUIMessage({
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

            // No ready phases — check if all done
            const allDone = this.scheduler.isAllDone(this.runbook.phases);
            if (allDone) {
                const hasFailed = this.runbook.phases.some(p => p.status === 'failed');
                if (hasFailed) {
                    this.transition(EngineEvent.WORKER_EXITED);
                    this.transition(EngineEvent.PHASE_FAIL);
                    this.runbook.status = 'paused_error';
                } else {
                    this.transition(EngineEvent.WORKER_EXITED);
                    this.transition(EngineEvent.ALL_PHASES_PASS);
                    this.runbook.status = 'completed';
                    this.emit('run:completed', this.runbook);
                    this.emit('run:consolidate', this.stateManager.getSessionDir());
                }
                this.persist().catch(log.onError);
                this.emitUIMessage({
                    type: 'STATE_SNAPSHOT',
                    payload: { runbook: this.runbook, engineState: this.state },
                });
                this.stopStallWatchdog();
                return;
            }

            // Stuck: pending phases exist but can't be dispatched (deps not met)
            this.emitUIMessage({
                type: 'LOG_ENTRY',
                payload: {
                    timestamp: asTimestamp(),
                    level: 'error',
                    message: 'Pipeline stalled: pending phases exist but dependencies are unmet. ' +
                        'Use "Resume Pending" to attempt recovery or retry/skip failed phases.',
                },
            });
            // Transition to ERROR_PAUSED so user can interact
            this.transition(EngineEvent.WORKER_EXITED);
            this.transition(EngineEvent.PHASE_FAIL);
            this.runbook.status = 'paused_error';
            this.persist().catch(log.onError);
            this.emitUIMessage({
                type: 'STATE_SNAPSHOT',
                payload: { runbook: this.runbook, engineState: this.state },
            });
            this.stopStallWatchdog();
        }, this.STALL_CHECK_INTERVAL_MS);
    }

    /** Stop the stall watchdog timer. */
    private stopStallWatchdog(): void {
        if (this.stallWatchdog) {
            clearInterval(this.stallWatchdog);
            this.stallWatchdog = null;
        }
    }

    /**
     * Resume all pending phases whose dependencies are satisfied.
     * Use this to recover a stalled pipeline — e.g., when a worker exit event
     * was lost or the pipeline was interrupted mid-flight.
     *
     * Valid from EXECUTING_WORKER (counter drift) or ERROR_PAUSED (manual recovery).
     */
    public async resumePending(): Promise<void> {
        if (!this.runbook) return;

        // Allow from ERROR_PAUSED (user recovery) or EXECUTING_WORKER (counter drift)
        if (this.state === EngineState.ERROR_PAUSED) {
            const result = this.transition(EngineEvent.RETRY);
            if (result === null) return;
        } else if (this.state !== EngineState.EXECUTING_WORKER) {
            this.emitUIMessage({
                type: 'LOG_ENTRY',
                payload: {
                    timestamp: asTimestamp(),
                    level: 'warn',
                    message: `Cannot resume pending: engine is in state "${this.state}".`,
                },
            });
            return;
        }

        this.runbook.status = 'running';

        // Fix activeWorkerCount to match reality
        const actualRunning = this.runbook.phases.filter(p => p.status === 'running').length;
        this.activeWorkerCount = actualRunning;

        const readyPhases = this.scheduler.getReadyPhases(this.runbook.phases);
        if (readyPhases.length === 0) {
            this.emitUIMessage({
                type: 'LOG_ENTRY',
                payload: {
                    timestamp: asTimestamp(),
                    level: 'info',
                    message: 'No pending phases with satisfied dependencies found.',
                },
            });
            return;
        }

        this.emitUIMessage({
            type: 'LOG_ENTRY',
            payload: {
                timestamp: asTimestamp(),
                level: 'info',
                message: `Resuming ${readyPhases.length} pending phase(s): ${readyPhases.map(p => `#${p.id}`).join(', ')}.`,
            },
        });

        await this.persist();
        this.startStallWatchdog();
        this.dispatchReadyPhases();
    }
}
