// ─────────────────────────────────────────────────────────────────────────────
// src/types/index.ts — Core type definitions for the Isolated-Agent extension
// ─────────────────────────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════════
//  1. Runbook Data Model — .task-runbook.json schema
// ═══════════════════════════════════════════════════════════════════════════════

/** Status of an individual phase within the runbook. */
export type PhaseStatus = 'pending' | 'running' | 'completed' | 'failed';

/** A single micro-task within the runbook execution plan. */
export interface Phase {
    /** Sequential identifier (or DAG node ID in V2). */
    readonly id: number;
    /** Current execution status. */
    status: PhaseStatus;
    /** The explicit instruction to inject into the ephemeral worker agent. */
    prompt: string;
    /** Exact file paths (relative to workspace root) to read and inject. */
    context_files: readonly string[];
    /**
     * The condition required to mark this phase as successful.
     * V1: `"exit_code:0"` — checks process exit code.
     * V2: Regex match, compiler output, test suite result.
     */
    success_criteria: string;

    // ── Pillar 2+3 Extensions (optional, backward-compatible) ────────────

    /**
     * Phase IDs that must complete before this phase can begin.
     * Enables DAG-based parallel execution.
     * When absent, sequential ordering via `current_phase` is used.
     */
    depends_on?: readonly number[];
    /**
     * Which evaluator to use for `success_criteria`.
     * V1 default: `"exit_code"`.
     * V2+: `"regex"`, `"toolchain"`, `"test_suite"`.
     */
    evaluator?: EvaluatorType;
    /**
     * Maximum number of self-healing retries for this phase.
     * Overrides the global `maxRetries` setting.
     */
    max_retries?: number;
}

/** Global status of the runbook execution. */
export type RunbookStatus = 'idle' | 'running' | 'paused_error' | 'completed';

/** The persistent state file: .task-runbook.json */
export interface Runbook {
    /** Unique identifier for this execution run. */
    readonly project_id: string;
    /** Global execution status. */
    status: RunbookStatus;
    /** Index of the currently executing (or next-to-execute) phase. */
    current_phase: number;
    /** Ordered collection of micro-tasks. */
    phases: Phase[];
}

// ═══════════════════════════════════════════════════════════════════════════════
//  2. Finite State Machine — OrchestratorEngine states and events
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The 9 deterministic states of the orchestration engine.
 * See ARCHITECTURE.md § State Machine for the transition diagram.
 */
export enum OrchestratorState {
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
export enum OrchestratorEvent {
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
}

/**
 * The deterministic transition table.
 * Key: current state → Key: event → Value: next state.
 * Missing entries are invalid transitions (silently rejected).
 */
export const STATE_TRANSITIONS: Record<
    OrchestratorState,
    Partial<Record<OrchestratorEvent, OrchestratorState>>
> = {
    [OrchestratorState.IDLE]: {
        [OrchestratorEvent.PLAN_REQUEST]: OrchestratorState.PLANNING,
        [OrchestratorEvent.LOAD_RUNBOOK]: OrchestratorState.PARSING,
    },
    [OrchestratorState.PLANNING]: {
        [OrchestratorEvent.PLAN_GENERATED]: OrchestratorState.PLAN_REVIEW,
        [OrchestratorEvent.ABORT]: OrchestratorState.IDLE,
    },
    [OrchestratorState.PLAN_REVIEW]: {
        [OrchestratorEvent.PLAN_APPROVED]: OrchestratorState.PARSING,
        [OrchestratorEvent.PLAN_REJECTED]: OrchestratorState.PLANNING,
        [OrchestratorEvent.ABORT]: OrchestratorState.IDLE,
    },
    [OrchestratorState.PARSING]: {
        [OrchestratorEvent.PARSE_SUCCESS]: OrchestratorState.READY,
        [OrchestratorEvent.PARSE_FAILURE]: OrchestratorState.IDLE,
    },
    [OrchestratorState.READY]: {
        [OrchestratorEvent.START]: OrchestratorState.EXECUTING_WORKER,
        [OrchestratorEvent.RESUME]: OrchestratorState.EXECUTING_WORKER,
        [OrchestratorEvent.RESET]: OrchestratorState.IDLE,
    },
    [OrchestratorState.EXECUTING_WORKER]: {
        [OrchestratorEvent.WORKER_EXITED]: OrchestratorState.EVALUATING,
        [OrchestratorEvent.WORKER_TIMEOUT]: OrchestratorState.ERROR_PAUSED,
        [OrchestratorEvent.WORKER_CRASH]: OrchestratorState.ERROR_PAUSED,
    },
    [OrchestratorState.EVALUATING]: {
        [OrchestratorEvent.PHASE_PASS]: OrchestratorState.EXECUTING_WORKER,
        [OrchestratorEvent.ALL_PHASES_PASS]: OrchestratorState.COMPLETED,
        [OrchestratorEvent.PHASE_FAIL]: OrchestratorState.ERROR_PAUSED,
    },
    [OrchestratorState.ERROR_PAUSED]: {
        [OrchestratorEvent.RETRY]: OrchestratorState.EXECUTING_WORKER,
        [OrchestratorEvent.SKIP_PHASE]: OrchestratorState.READY,
        [OrchestratorEvent.ABORT]: OrchestratorState.IDLE,
        [OrchestratorEvent.RESET]: OrchestratorState.IDLE,
    },
    [OrchestratorState.COMPLETED]: {
        [OrchestratorEvent.RESET]: OrchestratorState.IDLE,
    },
};

// ═══════════════════════════════════════════════════════════════════════════════
//  3. IPC Message Contracts — Webview ↔ Extension Host
// ═══════════════════════════════════════════════════════════════════════════════

/** Token count breakdown per file. */
export interface FileTokenEntry {
    path: string;
    tokens: number;
}

// ── Host → Webview (state projections) ──────────────────────────────────────

export interface StateSnapshotMessage {
    readonly type: 'STATE_SNAPSHOT';
    readonly payload: {
        runbook: Runbook;
        engineState: OrchestratorState;
    };
}

export interface PhaseStatusMessage {
    readonly type: 'PHASE_STATUS';
    readonly payload: {
        phaseId: number;
        status: PhaseStatus;
        durationMs?: number;
    };
}

export interface WorkerOutputMessage {
    readonly type: 'WORKER_OUTPUT';
    readonly payload: {
        phaseId: number;
        stream: 'stdout' | 'stderr';
        chunk: string;
    };
}

export interface TokenBudgetMessage {
    readonly type: 'TOKEN_BUDGET';
    readonly payload: {
        phaseId: number;
        breakdown: readonly FileTokenEntry[];
        totalTokens: number;
        limit: number;
    };
}

export interface ErrorMessage {
    readonly type: 'ERROR';
    readonly payload: {
        code: string;
        message: string;
        phaseId?: number;
    };
}

export interface LogEntryMessage {
    readonly type: 'LOG_ENTRY';
    readonly payload: {
        timestamp: number;
        level: 'info' | 'warn' | 'error';
        message: string;
    };
}

/** Planning draft message — planner agent produced a runbook draft. */
export interface PlanDraftMessage {
    readonly type: 'PLAN_DRAFT';
    readonly payload: {
        draft: Runbook;
        fileTree: readonly string[];
    };
}

/** Planning status message — spinner updates during planning. */
export interface PlanStatusMessage {
    readonly type: 'PLAN_STATUS';
    readonly payload: {
        status: 'generating' | 'parsing' | 'ready' | 'error';
        message?: string;
    };
}

/** Discriminated union of all messages the Extension Host sends to the Webview. */
export type HostToWebviewMessage =
    | StateSnapshotMessage
    | PhaseStatusMessage
    | WorkerOutputMessage
    | TokenBudgetMessage
    | ErrorMessage
    | LogEntryMessage
    | PlanDraftMessage
    | PlanStatusMessage;

// ── Webview → Host (user commands) ──────────────────────────────────────────

export interface CmdStartMessage {
    readonly type: 'CMD_START';
}

export interface CmdPauseMessage {
    readonly type: 'CMD_PAUSE';
}

export interface CmdAbortMessage {
    readonly type: 'CMD_ABORT';
}

export interface CmdRetryMessage {
    readonly type: 'CMD_RETRY';
    readonly payload: { phaseId: number };
}

export interface CmdSkipPhaseMessage {
    readonly type: 'CMD_SKIP_PHASE';
    readonly payload: { phaseId: number };
}

export interface CmdEditPhaseMessage {
    readonly type: 'CMD_EDIT_PHASE';
    readonly payload: {
        phaseId: number;
        patch: Partial<Pick<Phase, 'prompt' | 'context_files' | 'success_criteria'>>;
    };
}

export interface CmdLoadRunbookMessage {
    readonly type: 'CMD_LOAD_RUNBOOK';
    readonly payload: { filePath: string };
}

export interface CmdRequestStateMessage {
    readonly type: 'CMD_REQUEST_STATE';
}

/** User submits a prompt for the Planner Agent to generate a runbook. */
export interface CmdPlanRequestMessage {
    readonly type: 'CMD_PLAN_REQUEST';
    readonly payload: {
        prompt: string;
        feedback?: string;
    };
}

/** User approves the AI-generated plan. */
export interface CmdPlanApproveMessage {
    readonly type: 'CMD_PLAN_APPROVE';
}

/** User rejects the plan and provides feedback for re-generation. */
export interface CmdPlanRejectMessage {
    readonly type: 'CMD_PLAN_REJECT';
    readonly payload: {
        feedback: string;
    };
}

/** User edits the draft runbook directly in the review panel. */
export interface CmdPlanEditDraftMessage {
    readonly type: 'CMD_PLAN_EDIT_DRAFT';
    readonly payload: {
        draft: Runbook;
    };
}

/** User requests a full reset (start new chat) from COMPLETED state. */
export interface CmdResetMessage {
    readonly type: 'CMD_RESET';
}

/** Discriminated union of all messages the Webview sends to the Extension Host. */
export type WebviewToHostMessage =
    | CmdStartMessage
    | CmdPauseMessage
    | CmdAbortMessage
    | CmdRetryMessage
    | CmdSkipPhaseMessage
    | CmdEditPhaseMessage
    | CmdLoadRunbookMessage
    | CmdResetMessage
    | CmdRequestStateMessage
    | CmdPlanRequestMessage
    | CmdPlanApproveMessage
    | CmdPlanRejectMessage
    | CmdPlanEditDraftMessage;

// ═══════════════════════════════════════════════════════════════════════════════
//  4. ADK Integration Contracts
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The payload sent to the ADK when spawning an ephemeral worker agent.
 * Enforces zero-context mode and explicit file injection.
 */
export interface ADKInjectionPayload {
    /**
     * MUST be `true`. Workers are always ephemeral — no conversation history,
     * no prior file access, no accumulated state.
     */
    readonly ephemeral: true;
    /** The micro-task prompt to inject into the worker. */
    readonly prompt: string;
    /**
     * Pre-assembled, delimited file content payload.
     * Format: `<<<FILE: path>>>..content..<<<END FILE>>>` per file.
     */
    readonly contextPayload: string;
    /** Workspace root for the worker agent. */
    readonly workingDirectory: string;
    /** Maximum execution time before force-termination (ms). */
    readonly timeoutMs: number;
}

/**
 * Handle returned by the ADK after spawning a worker.
 * Used for monitoring and termination.
 */
export interface ADKWorkerHandle {
    /** Unique session identifier from the ADK. */
    readonly sessionId: string;
    /** OS process ID of the worker (for orphan cleanup). */
    readonly pid: number;
    /** Register a callback for stdout/stderr output chunks. */
    onOutput(callback: (stream: 'stdout' | 'stderr', chunk: string) => void): void;
    /** Register a callback for process exit. */
    onExit(callback: (exitCode: number) => void): void;
    /** Force-terminate the worker process. */
    terminate(): Promise<void>;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  5. Context Scoper Result Types
// ═══════════════════════════════════════════════════════════════════════════════

/** Successful context assembly result. */
export interface ContextResultOk {
    readonly ok: true;
    readonly payload: string;
    readonly totalTokens: number;
    readonly limit: number;
    readonly breakdown: readonly FileTokenEntry[];
}

/** Failed context assembly — token budget exceeded. */
export interface ContextResultOverBudget {
    readonly ok: false;
    readonly totalTokens: number;
    readonly limit: number;
    readonly breakdown: readonly FileTokenEntry[];
}

/** Result of the Context Scoper's assembly operation. */
export type ContextResult = ContextResultOk | ContextResultOverBudget;

// ═══════════════════════════════════════════════════════════════════════════════
//  6. WAL (Write-Ahead Log) Entry
// ═══════════════════════════════════════════════════════════════════════════════

/** A WAL entry written before mutating the runbook file. */
export interface WALEntry {
    readonly timestamp: number;
    readonly engineState: OrchestratorState;
    readonly currentPhase: number;
    readonly snapshot: Runbook;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  7. Pillar 2 — Intelligent Context Management Types
// ═══════════════════════════════════════════════════════════════════════════════

/** Pluggable interface for resolving context file paths. */
export interface FileResolver {
    /**
     * Resolve the full set of files to inject for a phase.
     * V1: Returns `phase.context_files` verbatim (explicit).
     * V2: Walks the AST to discover transitive imports.
     */
    resolve(phase: Phase, workspaceRoot: string): Promise<string[]>;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  8. Pillar 3 — Autonomous Resilience Types
// ═══════════════════════════════════════════════════════════════════════════════

/** Evaluator type discriminant. */
export type EvaluatorType = 'exit_code' | 'regex' | 'toolchain' | 'test_suite';

/**
 * Pluggable interface for evaluating phase success.
 * Implementations can verify exit codes, regex on stdout, compiler output, etc.
 */
export interface SuccessEvaluator {
    /** Unique type identifier (matches `phase.evaluator`). */
    readonly type: EvaluatorType;
    /**
     * Evaluate whether a phase succeeded.
     * @returns `true` if the phase should be marked as passed.
     */
    evaluate(criteria: string, exitCode: number, stdout: string, stderr: string): Promise<boolean>;
}

/** Result of a self-healing attempt. */
export interface HealingAttempt {
    readonly attemptNumber: number;
    readonly phaseId: number;
    readonly exitCode: number;
    readonly stderr: string;
    readonly timestamp: number;
}

/** Git operation result. */
export interface GitOperationResult {
    readonly success: boolean;
    readonly commitHash?: string;
    readonly message: string;
}
