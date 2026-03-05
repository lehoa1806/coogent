// ─────────────────────────────────────────────────────────────────────────────
// src/types/index.ts — Core type definitions for the Coogent extension
// ─────────────────────────────────────────────────────────────────────────────

import type { SessionSummary } from '../session/SessionManager.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  0. Conversation Mode — Controls how subtask conversations are managed
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Controls how the AI chat conversation is managed across subtask phases.
 * - `isolated`: Each subtask opens a new conversation (zero-context, default).
 * - `continuous`: All subtasks share the same conversation (context carries over).
 * - `smart`: Automatically starts a new conversation when estimated token usage
 *   crosses a configurable threshold.
 */
export type ConversationMode = 'isolated' | 'continuous' | 'smart';

/** Configuration for conversation management across subtasks. */
export interface ConversationSettings {
    /** Active conversation mode. */
    mode: ConversationMode;
    /** Token threshold for smart-switch mode (default: 80_000). */
    smartSwitchTokenThreshold: number;
}

/** Default conversation settings. */
export const DEFAULT_CONVERSATION_SETTINGS: ConversationSettings = {
    mode: 'isolated',
    smartSwitchTokenThreshold: 80_000,
};

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
//  2. Finite State Machine — Engine states and events
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The 9 deterministic states of the execution engine.
 * See ARCHITECTURE.md § State Machine for the transition diagram.
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
}

/**
 * The deterministic transition table.
 * Key: current state → Key: event → Value: next state.
 * Missing entries are invalid transitions (silently rejected).
 */
export const STATE_TRANSITIONS: Record<
    EngineState,
    Partial<Record<EngineEvent, EngineState>>
> = {
    [EngineState.IDLE]: {
        [EngineEvent.PLAN_REQUEST]: EngineState.PLANNING,
        [EngineEvent.LOAD_RUNBOOK]: EngineState.PARSING,
        [EngineEvent.RESET]: EngineState.IDLE,
    },
    [EngineState.PLANNING]: {
        [EngineEvent.PLAN_GENERATED]: EngineState.PLAN_REVIEW,
        [EngineEvent.ABORT]: EngineState.IDLE,
    },
    [EngineState.PLAN_REVIEW]: {
        [EngineEvent.PLAN_APPROVED]: EngineState.PARSING,
        [EngineEvent.PLAN_REJECTED]: EngineState.PLANNING,
        [EngineEvent.ABORT]: EngineState.IDLE,
    },
    [EngineState.PARSING]: {
        [EngineEvent.PARSE_SUCCESS]: EngineState.READY,
        [EngineEvent.PARSE_FAILURE]: EngineState.IDLE,
    },
    [EngineState.READY]: {
        [EngineEvent.START]: EngineState.EXECUTING_WORKER,
        [EngineEvent.RESUME]: EngineState.EXECUTING_WORKER,
        [EngineEvent.RESET]: EngineState.IDLE,
    },
    [EngineState.EXECUTING_WORKER]: {
        [EngineEvent.WORKER_EXITED]: EngineState.EVALUATING,
        [EngineEvent.WORKER_TIMEOUT]: EngineState.ERROR_PAUSED,
        [EngineEvent.WORKER_CRASH]: EngineState.ERROR_PAUSED,
        [EngineEvent.ABORT]: EngineState.IDLE,
    },
    [EngineState.EVALUATING]: {
        [EngineEvent.PHASE_PASS]: EngineState.EXECUTING_WORKER,
        [EngineEvent.ALL_PHASES_PASS]: EngineState.COMPLETED,
        [EngineEvent.PHASE_FAIL]: EngineState.ERROR_PAUSED,
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
        engineState: EngineState;
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

/** Session list message — recent sessions for the history drawer. */
export interface SessionListMessage {
    readonly type: 'SESSION_LIST';
    readonly payload: {
        sessions: readonly SessionSummary[];
    };
}

/** Session search results message — filtered sessions from a search query. */
export interface SessionSearchResultsMessage {
    readonly type: 'SESSION_SEARCH_RESULTS';
    readonly payload: {
        query: string;
        sessions: readonly SessionSummary[];
    };
}

/** Conversation mode sync message — tells the Webview which mode is active. */
export interface ConversationModeMessage {
    readonly type: 'CONVERSATION_MODE';
    readonly payload: {
        mode: ConversationMode;
        smartSwitchTokenThreshold: number;
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
    | PlanStatusMessage
    | SessionListMessage
    | SessionSearchResultsMessage
    | ConversationModeMessage;

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

export interface CmdPausePhaseMessage {
    readonly type: 'CMD_PAUSE_PHASE';
    readonly payload: { phaseId: number };
}

export interface CmdStopPhaseMessage {
    readonly type: 'CMD_STOP_PHASE';
    readonly payload: { phaseId: number };
}

export interface CmdRestartPhaseMessage {
    readonly type: 'CMD_RESTART_PHASE';
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
    readonly payload?: { filePath: string };
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

/** User requests the list of recent/past sessions. */
export interface CmdListSessionsMessage {
    readonly type: 'CMD_LIST_SESSIONS';
}

/** User searches past sessions by query string. */
export interface CmdSearchSessionsMessage {
    readonly type: 'CMD_SEARCH_SESSIONS';
    readonly payload: {
        query: string;
    };
}

/** User loads a specific past session by ID. */
export interface CmdLoadSessionMessage {
    readonly type: 'CMD_LOAD_SESSION';
    readonly payload: {
        sessionId: string;
    };
}

/** User sets the conversation mode via the toggle. */
export interface CmdSetConversationModeMessage {
    readonly type: 'CMD_SET_CONVERSATION_MODE';
    readonly payload: {
        mode: ConversationMode;
    };
}

/** Discriminated union of all messages the Webview sends to the Extension Host. */
export type WebviewToHostMessage =
    | CmdStartMessage
    | CmdPauseMessage
    | CmdAbortMessage
    | CmdRetryMessage
    | CmdSkipPhaseMessage
    | CmdPausePhaseMessage
    | CmdStopPhaseMessage
    | CmdRestartPhaseMessage
    | CmdEditPhaseMessage
    | CmdLoadRunbookMessage
    | CmdResetMessage
    | CmdRequestStateMessage
    | CmdPlanRequestMessage
    | CmdPlanApproveMessage
    | CmdPlanRejectMessage
    | CmdPlanEditDraftMessage
    | CmdListSessionsMessage
    | CmdSearchSessionsMessage
    | CmdLoadSessionMessage
    | CmdSetConversationModeMessage;

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
    readonly engineState: EngineState;
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
