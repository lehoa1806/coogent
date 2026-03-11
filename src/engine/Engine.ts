// ─────────────────────────────────────────────────────────────────────────────
// src/engine/Engine.ts — Deterministic state machine
// ─────────────────────────────────────────────────────────────────────────────
// Sprint 1: Slimmed to FSM core + delegation to extracted controllers.
// Controllers: PlanningController, PhaseController, EvaluationOrchestrator,
//              SessionController, DispatchController.

import * as path from 'node:path';
import log from '../logger/log.js';
import {
    EngineState,
    EngineEvent,
    STATE_TRANSITIONS,
    asTimestamp,
    type Runbook,
    type Phase,
    type HostToWebviewMessage,
    type EvaluationResult,
} from '../types/index.js';
import { StateManager } from '../state/StateManager.js';
import { Scheduler } from './Scheduler.js';
import { SelfHealingController } from './SelfHealing.js';
import { EvaluatorRegistryV2 } from '../evaluators/EvaluatorRegistry.js';
import { PlanningController } from './PlanningController.js';
import { PhaseController } from './PhaseController.js';
import { EvaluationOrchestrator } from './EvaluationOrchestrator.js';
import { SessionController } from './SessionController.js';
import { DispatchController, type DispatchControllerOptions } from './DispatchController.js';
import type { EngineInternals } from './EngineInternals.js';
import { TypedEventEmitter } from './TypedEventEmitter.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Engine Events — typed EventEmitter
// ═══════════════════════════════════════════════════════════════════════════════

export type EngineEvents = {
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
    /** Fired when the user approves the AI-generated plan (M1 audit fix). */
    'plan:approved': (approvedDraft: Runbook) => void;
    /** Fired when the user wants to retry parsing cached timeout output. */
    'plan:retryParse': () => void;
    /** Fired when the user requests a diff review for a specific phase. */
    'phase:review-diff': (phaseId: number) => void;
    /** Fired when a listener throws during emit — diagnostic only. */
    'engine:listener-error': (sourceEvent: string, error: unknown) => void;
}

// NOTE: Typed on()/emit()/once()/off() are provided by TypedEventEmitter<EngineEvents>.
// The `declare interface Engine` merge hack is no longer needed.

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
 * Delegates domain logic to:
 * - PlanningController: Conversational runbook generation flow.
 * - PhaseController: Per-phase user commands (edit, pause, stop, restart, skip).
 * - EvaluationOrchestrator: Worker exit result evaluation and self-healing retries.
 * - SessionController: Runbook loading, session reset, and session switching.
 * - DispatchController: DAG-aware dispatch, stall watchdog, and pipeline recovery.
 *
 * See ARCHITECTURE.md § State Machine for the transition diagram.
 */
export class Engine extends TypedEventEmitter<EngineEvents> implements EngineInternals {
    private state: EngineState = EngineState.IDLE;
    private runbook: Runbook | null = null;
    private pauseRequested = false;

    // NOTE: Listener error fencing is now handled by the TypedEventEmitter base class.

    /**
     * Number of concurrently active workers.
     * AB-1 fix: The FSM stays in EXECUTING_WORKER while activeWorkerCount > 0.
     * Transition to EVALUATING only fires when the *last* worker exits.
     */
    private activeWorkerCount = 0;

    /** Tracked self-healing timer handles for cancellation on abort/reset. */
    private healingTimers: Set<ReturnType<typeof setTimeout>> = new Set();

    /**
     * Serialization mutex for onWorkerExited / onWorkerFailed.
     * Prevents two concurrent calls from both seeing activeWorkerCount === 0
     * and double-firing the FSM transition (B-1 fix).
     */
    private workerExitLock: Promise<void> = Promise.resolve();

    // ── Subsystems ──────────────────────────────────────────────────────────
    private readonly scheduler: Scheduler;
    private readonly healer: SelfHealingController;
    private evaluatorRegistry: EvaluatorRegistryV2 | null = null;

    // ── Extracted controllers ───────────────────────────────────────────────
    private readonly planning: PlanningController;
    private readonly phases: PhaseController;
    private readonly evaluation: EvaluationOrchestrator;
    private readonly session: SessionController;
    private dispatch: DispatchController;

    constructor(
        private stateManager: StateManager,
        options?: {
            scheduler?: Scheduler;
            healer?: SelfHealingController;
            workspaceRoot?: string;
        }
    ) {
        super(); // TypedEventEmitter handles listener error fencing

        this.scheduler = options?.scheduler ?? new Scheduler();
        this.healer = options?.healer ?? new SelfHealingController();
        if (options?.workspaceRoot) {
            this.evaluatorRegistry = new EvaluatorRegistryV2(options.workspaceRoot);
        }

        // Compose controllers
        this.planning = new PlanningController(this);
        this.phases = new PhaseController(this);
        this.evaluation = new EvaluationOrchestrator(this, this.healer, this.evaluatorRegistry);
        this.session = new SessionController(this);
        this.dispatch = new DispatchController(this);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Internal Accessors — used by extracted controllers
    // ═══════════════════════════════════════════════════════════════════════════

    /** @internal Used by controllers to access the StateManager. */
    public getStateManager(): StateManager { return this.stateManager; }

    /** @internal Used by controllers to access the Scheduler. */
    public getScheduler(): Scheduler { return this.scheduler; }

    /** @internal Used by controllers to access the SelfHealingController. */
    public getHealer(): SelfHealingController { return this.healer; }
    public getEvaluation(): EvaluationOrchestrator { return this.evaluation; }

    /** @internal Used by PlanningController.planApproved() and SessionController. */
    public setRunbook(runbook: Runbook | null): void { this.runbook = runbook; }

    /** @internal Used by PhaseController.pausePhase() and SessionController. */
    public setPauseRequested(value: boolean): void { this.pauseRequested = value; }

    /** @internal Used by DispatchController.advanceSchedule(). */
    public isPauseRequested(): boolean { return this.pauseRequested; }

    /** @internal Used by controllers. */
    public addHealingTimer(timer: ReturnType<typeof setTimeout>): void { this.healingTimers.add(timer); }
    public removeHealingTimer(timer: ReturnType<typeof setTimeout>): void { this.healingTimers.delete(timer); }

    /** @internal Used by SessionController.reset(). */
    public cleanupTimers(): void {
        for (const timer of this.healingTimers) {
            clearTimeout(timer);
        }
        this.healingTimers.clear();
        this.stopStallWatchdog();
    }

    /** @internal Used by SessionController. */
    public replaceStateManager(sm: StateManager): void { this.stateManager = sm; }

    /** @internal Used by SessionController.reset(). */
    public resetControllers(): void { this.planning.reset(); }

    /** @internal Used by DispatchController and SessionController. */
    public setActiveWorkerCount(count: number): void { this.activeWorkerCount = count; }
    public getActiveWorkerCount(): number { return this.activeWorkerCount; }
    public incrementActiveWorkerCount(): void { this.activeWorkerCount++; }

    /**
     * Re-configure the DispatchController with agent selection options.
     * Called from EngineWiring after services are initialised.
     */
    public configureDispatch(options: DispatchControllerOptions): void {
        this.dispatch.stopStallWatchdog();
        this.dispatch = new DispatchController(this, options);
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
     */
    public getSessionDirName(): string | undefined {
        try {
            const dir = this.stateManager.getSessionDir();
            return dir ? path.basename(dir) : undefined;
        } catch {
            return undefined;
        }
    }

    /** Update the global max retries at runtime. */
    public setMaxRetries(maxRetries: number): void {
        this.healer.setMaxRetries(maxRetries);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  State Machine Core
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Attempt a state transition. Returns the new state, or null if invalid.
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
    //  Delegated Commands — Session / Runbook Lifecycle
    // ═══════════════════════════════════════════════════════════════════════════

    public async loadRunbook(_filePath?: string): Promise<void> { return this.session.loadRunbook(); }

    public async reset(newStateManager?: StateManager): Promise<void> { return this.session.reset(newStateManager); }

    public async switchSession(newStateManager: StateManager): Promise<void> { return this.session.switchSession(newStateManager); }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Lifecycle Commands — start / pause / abort / retry
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Begin (or resume) execution.
     */
    public async start(): Promise<void> {
        if (!this.runbook) {
            this.emit('error', new Error('Cannot start: no runbook loaded.'));
            return;
        }

        this.pauseRequested = false;

        const result = this.transition(EngineEvent.START);
        if (result === null) return;

        this.runbook.status = 'running';
        await this.persist();

        this.startStallWatchdog();
        this.dispatchReadyPhases();
    }

    /** Pause execution after the current phase completes. */
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

    /** Abort execution and transition to IDLE. */
    public async abort(): Promise<void> {
        const result = this.transition(EngineEvent.ABORT);
        if (result === null) return;

        this.cleanupTimers();

        if (this.runbook) {
            for (const phase of this.runbook.phases) {
                if (phase.status === 'running') {
                    phase.status = 'pending';
                    this.emit('phase:stop', phase.id);
                }
            }
            this.runbook.status = 'idle';
            await this.persist();
        }

        this.activeWorkerCount = 0;

        if (this.runbook) {
            const sessionId = this.getSessionDirName();
            this.emitUIMessage({
                type: 'STATE_SNAPSHOT',
                payload: {
                    runbook: this.runbook,
                    engineState: this.state,
                    ...(sessionId ? { masterTaskId: sessionId } : {}),
                },
            });
        }
    }

    /** Retry a failed phase. */
    public async retry(phaseId: number): Promise<void> {
        if (!this.runbook) return;

        const phase = this.runbook.phases.find(p => p.id === phaseId);
        if (!phase || (phase.status !== 'failed' && phase.status !== 'pending')) return;

        const result = this.transition(EngineEvent.RETRY);
        if (result === null) return;

        phase.status = 'pending';
        this.runbook.current_phase = phaseId;
        this.runbook.status = 'running';
        await this.persist();

        this.startStallWatchdog();
        this.dispatchReadyPhases();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Delegated Commands — Phase Control
    // ═══════════════════════════════════════════════════════════════════════════

    public async editPhase(
        phaseId: number,
        patch: Partial<Pick<Phase, 'prompt' | 'context_files' | 'success_criteria'>>
    ): Promise<void> { return this.phases.editPhase(phaseId, patch); }

    public pausePhase(phaseId: number): void { this.phases.pausePhase(phaseId); }

    public async stopPhase(phaseId: number): Promise<void> { return this.phases.stopPhase(phaseId); }

    public async restartPhase(phaseId: number): Promise<void> { return this.phases.restartPhase(phaseId); }

    public async reviewDiff(phaseId: number): Promise<void> { return this.phases.reviewDiff(phaseId); }

    public async skipPhase(phaseId: number): Promise<void> { return this.phases.skipPhase(phaseId); }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Delegated Commands — Planning
    // ═══════════════════════════════════════════════════════════════════════════

    public planRequest(prompt: string): void { this.planning.planRequest(prompt); }

    public planGenerated(draft: Runbook, fileTree: string[]): void { this.planning.planGenerated(draft, fileTree); }

    public async planApproved(): Promise<void> { return this.planning.planApproved(); }

    public planRejected(feedback: string): void { this.planning.planRejected(feedback); }

    public planRetryParse(): void { this.planning.planRetryParse(); }

    public updatePlanDraft(draft: Runbook): void { this.planning.updatePlanDraft(draft); }

    public getPlanDraft(): Runbook | null { return this.planning.getPlanDraft(); }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Worker Callbacks — called by ADKController
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Called when a worker exits. Serialized via workerExitLock (B-1 fix).
     */
    public async onWorkerExited(
        phaseId: number,
        exitCode: number,
        stdout = '',
        stderr = ''
    ): Promise<void> {
        this.workerExitLock = this.workerExitLock.then(async () => {
            if (!this.runbook) return;

            const phase = this.runbook.phases.find(p => p.id === phaseId);
            if (!phase || phase.status !== 'running') return;

            this.activeWorkerCount = Math.max(0, this.activeWorkerCount - 1);
            const isLastWorker = this.activeWorkerCount === 0;

            await this.evaluation.handleWorkerExited(phaseId, exitCode, stdout, stderr, isLastWorker);
        });
        return this.workerExitLock;
    }

    /** Evaluate a phase's success criteria (public for tests). */
    public async evaluatePhaseResult(
        phase: Phase,
        exitCode: number,
        stdout: string,
        stderr: string
    ): Promise<EvaluationResult> {
        return this.evaluation.evaluatePhaseResult(phase, exitCode, stdout, stderr);
    }

    /** Apply the evaluation verdict (public for tests). */
    public async applyVerdict(
        phase: Phase,
        result: EvaluationResult,
        exitCode: number,
        stderr: string
    ): Promise<void> {
        return this.evaluation.applyVerdict(phase, result, exitCode, stderr);
    }

    /**
     * Called when a worker times out or crashes.
     * B-1 fix: Serialized via workerExitLock.
     */
    public async onWorkerFailed(phaseId: number, reason: 'timeout' | 'crash'): Promise<void> {
        this.workerExitLock = this.workerExitLock.then(async () => {
            if (!this.runbook) return;

            const phase = this.runbook.phases.find(p => p.id === phaseId);
            if (!phase || phase.status !== 'running') return;

            this.activeWorkerCount = Math.max(0, this.activeWorkerCount - 1);
            const isLastWorker = this.activeWorkerCount === 0;

            await this.evaluation.handleWorkerFailed(phase, isLastWorker, reason);
        });
        return this.workerExitLock;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Delegated — Dispatch & Scheduling
    // ═══════════════════════════════════════════════════════════════════════════

    public async dispatchReadyPhases(): Promise<void> { return this.dispatch.dispatchReadyPhases(); }

    public advanceSchedule(): void { this.dispatch.advanceSchedule(); }

    public startStallWatchdog(): void { this.dispatch.startStallWatchdog(); }

    public stopStallWatchdog(): void { this.dispatch.stopStallWatchdog(); }

    public async resumePending(): Promise<void> { return this.dispatch.resumePending(); }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Persistence & UI Helpers
    // ═══════════════════════════════════════════════════════════════════════════

    /** Persist the current runbook state to disk. */
    public async persist(): Promise<void> {
        if (!this.runbook) return;
        await this.stateManager.saveRunbook(this.runbook, this.state);
    }

    /** Convenience: send a message to the UI. */
    public emitUIMessage(message: HostToWebviewMessage): void {
        this.emit('ui:message', message);
    }
}
