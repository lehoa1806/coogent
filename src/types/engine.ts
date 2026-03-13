// ─────────────────────────────────────────────────────────────────────────────
// src/types/engine.ts — Finite State Machine states, events, and transitions
// ─────────────────────────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════════
//  Finite State Machine — Engine states and events
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The 9 deterministic states of the execution engine.
 * See architecture.md § State Machine for the transition diagram.
 */
export enum EngineState {
    /** No runbook loaded. Waiting for user action. */
    IDLE = 'IDLE',
    /** Planner agent is generating a runbook from user prompt. */
    PLANNING = 'PLANNING',
    /** AI-generated plan awaiting user review/approval. */
    PLAN_REVIEW = 'PLAN_REVIEW',
    /** Validating .task-runbook.json schema and file existence. */
    PARSING = 'PARSING',
    /** Runbook parsed successfully. Awaiting START command. */
    READY = 'READY',
    /** A worker agent is alive and processing the current phase. */
    EXECUTING_WORKER = 'EXECUTING_WORKER',
    /** Worker exited. Checking success_criteria. */
    EVALUATING = 'EVALUATING',
    /** Phase failed or worker crashed. Halted for user decision. */
    ERROR_PAUSED = 'ERROR_PAUSED',
    /** All phases passed. Terminal state for the run. */
    COMPLETED = 'COMPLETED',
}

/** Events that trigger state transitions. */
export enum EngineEvent {
    PLAN_REQUEST = 'PLAN_REQUEST',
    PLAN_GENERATED = 'PLAN_GENERATED',
    PLAN_APPROVED = 'PLAN_APPROVED',
    PLAN_REJECTED = 'PLAN_REJECTED',
    LOAD_RUNBOOK = 'LOAD_RUNBOOK',
    PARSE_SUCCESS = 'PARSE_SUCCESS',
    PARSE_FAILURE = 'PARSE_FAILURE',
    START = 'START',
    RESUME = 'RESUME',
    WORKER_EXITED = 'WORKER_EXITED',
    PHASE_PASS = 'PHASE_PASS',
    PHASE_FAIL = 'PHASE_FAIL',
    ALL_PHASES_PASS = 'ALL_PHASES_PASS',
    WORKER_TIMEOUT = 'WORKER_TIMEOUT',
    WORKER_CRASH = 'WORKER_CRASH',
    RETRY = 'RETRY',
    SKIP_PHASE = 'SKIP_PHASE',
    ABORT = 'ABORT',
    RESET = 'RESET',
    PAUSE = 'PAUSE',
}

/**
 * The deterministic transition table.
 * Key: current state → Key: event → Value: next state.
 * Missing entries are invalid transitions (silently rejected).
 *
 * S4-8: `satisfies` provides compile-time exhaustiveness — every EngineState
 * must have an entry, and every transition must target a valid EngineState.
 */
export const STATE_TRANSITIONS: Record<
    EngineState,
    Partial<Record<EngineEvent, EngineState>>
> = {
    [EngineState.IDLE]: {
        [EngineEvent.PLAN_REQUEST]: EngineState.PLANNING,
        [EngineEvent.LOAD_RUNBOOK]: EngineState.PARSING,
        [EngineEvent.RESET]: EngineState.IDLE,
        // Post-abort recovery: allow retry/skip/start from IDLE when a runbook is loaded
        [EngineEvent.RETRY]: EngineState.EXECUTING_WORKER,
        [EngineEvent.SKIP_PHASE]: EngineState.READY,
        [EngineEvent.START]: EngineState.EXECUTING_WORKER,
    },
    [EngineState.PLANNING]: {
        [EngineEvent.PLAN_GENERATED]: EngineState.PLAN_REVIEW,
        [EngineEvent.PLAN_REJECTED]: EngineState.PLANNING, // Self-loop for re-plan
        [EngineEvent.ABORT]: EngineState.IDLE,
        [EngineEvent.RESET]: EngineState.IDLE,
    },
    [EngineState.PLAN_REVIEW]: {
        [EngineEvent.PLAN_APPROVED]: EngineState.PARSING,
        [EngineEvent.PLAN_REJECTED]: EngineState.PLANNING,
        [EngineEvent.ABORT]: EngineState.IDLE,
        [EngineEvent.RESET]: EngineState.IDLE,
    },
    [EngineState.PARSING]: {
        [EngineEvent.PARSE_SUCCESS]: EngineState.READY,
        [EngineEvent.PARSE_FAILURE]: EngineState.IDLE,
        [EngineEvent.ABORT]: EngineState.IDLE,
        [EngineEvent.RESET]: EngineState.IDLE,
    },
    [EngineState.READY]: {
        [EngineEvent.START]: EngineState.EXECUTING_WORKER,
        [EngineEvent.RESUME]: EngineState.EXECUTING_WORKER,
        [EngineEvent.ABORT]: EngineState.IDLE,
        [EngineEvent.RESET]: EngineState.IDLE,
    },
    [EngineState.EXECUTING_WORKER]: {
        [EngineEvent.WORKER_EXITED]: EngineState.EVALUATING,
        [EngineEvent.WORKER_TIMEOUT]: EngineState.ERROR_PAUSED,
        [EngineEvent.WORKER_CRASH]: EngineState.ERROR_PAUSED,
        [EngineEvent.ABORT]: EngineState.IDLE,
        [EngineEvent.RESET]: EngineState.IDLE,
    },
    [EngineState.EVALUATING]: {
        [EngineEvent.PHASE_PASS]: EngineState.EXECUTING_WORKER,
        [EngineEvent.ALL_PHASES_PASS]: EngineState.COMPLETED,
        [EngineEvent.PHASE_FAIL]: EngineState.ERROR_PAUSED,
        [EngineEvent.ABORT]: EngineState.IDLE,
        [EngineEvent.RESET]: EngineState.IDLE,
        [EngineEvent.RETRY]: EngineState.EXECUTING_WORKER, // Self-healing retry from evaluating
    },
    [EngineState.ERROR_PAUSED]: {
        [EngineEvent.RETRY]: EngineState.EXECUTING_WORKER,
        [EngineEvent.SKIP_PHASE]: EngineState.READY,
        [EngineEvent.ABORT]: EngineState.IDLE,
        [EngineEvent.RESET]: EngineState.IDLE,
    },
    [EngineState.COMPLETED]: {
        [EngineEvent.RESET]: EngineState.IDLE,
    },
} satisfies Record<EngineState, Partial<Record<EngineEvent, EngineState>>>;
