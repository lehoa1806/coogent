// ─────────────────────────────────────────────────────────────────────────────
// src/engine/EngineInternals.ts — S4-3: Formalized controller contract
// ─────────────────────────────────────────────────────────────────────────────
// This interface formalizes the @internal methods that extracted controllers
// use to interact with the Engine. Controllers should depend on this interface
// rather than the full Engine class, reducing coupling.

import type { StateManager } from '../state/StateManager.js';
import type { Scheduler } from './Scheduler.js';
import type { SelfHealingController } from './SelfHealing.js';
import type { EvaluationOrchestrator } from './EvaluationOrchestrator.js';
import type {
    EngineState,
    EngineEvent,
    Runbook,
    HostToWebviewMessage,
} from '../types/index.js';

/**
 * S4-3 (BP-5): Formalized interface for the internal methods that
 * extracted controllers (PlanningController, PhaseController,
 * EvaluationOrchestrator, SessionController, DispatchController)
 * use to interact with the Engine.
 *
 * Controllers receive an `EngineInternals` reference via their constructor
 * instead of the full `Engine` class. This narrows the dependency surface
 * and makes the controller contract explicit and testable.
 */
export interface EngineInternals {
    // ── State Machine ────────────────────────────────────────────────────────
    /** Attempt a state transition. Returns the new state, or null if invalid. */
    transition(event: EngineEvent): EngineState | null;
    /** Get the current engine state. */
    getState(): EngineState;
    /** Get the loaded runbook (or null). */
    getRunbook(): Runbook | null;

    // ── Subsystem Accessors ──────────────────────────────────────────────────
    /** Access the StateManager for persistence operations. */
    getStateManager(): StateManager;
    /** Access the DAG-aware Scheduler. */
    getScheduler(): Scheduler;
    /** Access the SelfHealingController for retry logic. */
    getHealer(): SelfHealingController;
    /** Access the EvaluationOrchestrator. */
    getEvaluation(): EvaluationOrchestrator;

    // ── Runbook / State Mutators ─────────────────────────────────────────────
    /** Set (or clear) the active runbook. */
    setRunbook(runbook: Runbook | null): void;
    /** Replace the StateManager (used during session switching). */
    replaceStateManager(sm: StateManager): void;
    /** Persist the current runbook state to disk. */
    persist(): Promise<void>;

    // ── Pause / Resume ───────────────────────────────────────────────────────
    /** Request a pause after the current phase completes. */
    setPauseRequested(value: boolean): void;
    /** Check whether a pause has been requested. */
    isPauseRequested(): boolean;

    // ── Worker Tracking ──────────────────────────────────────────────────────
    /** Set the active worker count directly (e.g., to 0 on abort). */
    setActiveWorkerCount(count: number): void;
    /** Get the number of concurrently active workers. */
    getActiveWorkerCount(): number;
    /** Increment the active worker count by 1. */
    incrementActiveWorkerCount(): void;

    // ── Timer Management ─────────────────────────────────────────────────────
    /** Track a self-healing retry timer for cleanup on abort/reset. */
    addHealingTimer(timer: ReturnType<typeof setTimeout>): void;
    /** Remove a tracked self-healing timer. */
    removeHealingTimer(timer: ReturnType<typeof setTimeout>): void;
    /** Clear all tracked timers (healing + stall watchdog). */
    cleanupTimers(): void;

    // ── Controller Lifecycle ─────────────────────────────────────────────────
    /** Reset internal controller state (e.g., planning draft). */
    resetControllers(): void;

    // ── Session Identity ──────────────────────────────────────────────────────
    /** Get the active session directory basename (YYYYMMDD-HHMMSS-<uuid>). */
    getSessionDirName(): string | undefined;

    // ── UI / Events ──────────────────────────────────────────────────────────
    /** Send a message to the webview UI. */
    emitUIMessage(message: HostToWebviewMessage): void;

    // ── Dispatch Delegation ──────────────────────────────────────────────────
    /** Dispatch all ready phases in the DAG. */
    dispatchReadyPhases(): Promise<void>;
    /** Advance the scheduler after a phase completes. */
    advanceSchedule(): void;
    /** Start the stall detection watchdog. */
    startStallWatchdog(): void;
    /** Stop the stall detection watchdog. */
    stopStallWatchdog(): void;

    // ── EventEmitter Surface ─────────────────────────────────────────────────
    /** Emit a typed event. Controllers need this to fire `phase:execute`, etc. */
    emit(event: string, ...args: unknown[]): boolean;
}
