// ─────────────────────────────────────────────────────────────────────────────
// src/types/failure-console.ts — Failure Console types and data model
// ─────────────────────────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════════
//  Failure Classification — Union types for categorizing failures
// ═══════════════════════════════════════════════════════════════════════════════

/** Severity level of a failure event. */
export type FailureSeverity = 'warning' | 'recoverable' | 'hard_failure';

/** Scope at which the failure occurred within the orchestration hierarchy. */
export type FailureScope = 'run' | 'phase' | 'worker' | 'tool' | 'context' | 'policy';

/** The subsystem that originated the failure. */
export type FailureSource =
    | 'planner'
    | 'scheduler'
    | 'worker'
    | 'tool'
    | 'context_scoper'
    | 'policy_gate'
    | 'evaluator'
    | 'mcp'
    | 'plugin'
    | 'unknown';

/** Deterministic category assigned by the FailureClassifier. */
export type FailureCategory =
    | 'worker_execution_error'
    | 'tool_denied'
    | 'tool_invocation_error'
    | 'context_budget_exceeded'
    | 'context_assembly_error'
    | 'success_criteria_mismatch'
    | 'evaluation_rejection'
    | 'dependency_failure'
    | 'scheduler_stall'
    | 'timeout'
    | 'planner_invalid_output'
    | 'mcp_contract_error'
    | 'plugin_failure'
    | 'unknown';

/** Type of recovery action an operator can take from the failure console. */
export type RecoveryActionType =
    | 'retry'
    | 'retry_with_more_context'
    | 'edit_success_criteria'
    | 'skip'
    | 'reroute_worker'
    | 'inspect_repair_prompt';

// ═══════════════════════════════════════════════════════════════════════════════
//  Failure Timeline — Events contributing to a failure
// ═══════════════════════════════════════════════════════════════════════════════

/** A single event in the failure timeline, referencing the originating subsystem. */
export interface FailureEventRef {
    /** Unique identifier for this event. */
    readonly eventId: string;
    /** Unix timestamp (ms) when the event occurred. */
    readonly timestamp: number;
    /** Subsystem that emitted the event. */
    readonly source: FailureSource;
    /** Human-readable summary of what happened. */
    readonly summary: string;
    /** Whether this event is a candidate root cause. */
    readonly isRootCandidate: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Failure Evidence — Runtime artefacts collected for diagnosis
// ═══════════════════════════════════════════════════════════════════════════════

/** Diagnostic evidence collected at the time of failure. */
export interface FailureEvidence {
    /** Latest output produced by the worker before failure. */
    readonly latestWorkerOutput?: string;
    /** Latest error text from the failing subsystem. */
    readonly latestErrorText?: string;
    /** Context token budget snapshot at the time of failure. */
    readonly contextBudget?: {
        readonly tokenLimit: number;
        readonly estimatedUsed: number;
        readonly remaining: number;
    };
    /** Tool invocation outcomes leading up to the failure. */
    readonly toolActions?: ReadonlyArray<{
        readonly toolId: string;
        readonly outcome: 'success' | 'failure' | 'denied';
        readonly timestamp: number;
    }>;
    /** Success criteria that were being evaluated. */
    readonly successCriteria?: readonly string[];
    /** Reference to the full context manifest for inspection. */
    readonly contextManifestRef?: string;
    /** Reference to the repair prompt used in the last healing attempt. */
    readonly repairPromptRef?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Recovery Actions — Suggested and operator-chosen recovery paths
// ═══════════════════════════════════════════════════════════════════════════════

/** A model-suggested recovery action with confidence level. */
export interface SuggestedRecoveryAction {
    /** The type of recovery action being suggested. */
    readonly action: RecoveryActionType;
    /** Short human-readable title for the action. */
    readonly title: string;
    /** Explanation of why this action might resolve the failure. */
    readonly rationale: string;
    /** Model's confidence that this action will succeed. */
    readonly confidence: 'low' | 'medium' | 'high';
}

/** The operator's chosen recovery decision from the failure console. */
export interface OperatorRecoveryDecision {
    /** The recovery action the operator selected. */
    readonly action: RecoveryActionType;
    /** Who initiated the recovery (always 'user' for human-in-the-loop). */
    readonly initiatedBy: 'user';
    /** Whether the chosen action was among the model's suggestions. */
    readonly suggestedByModel: boolean;
    /** Unix timestamp (ms) when the operator selected this action. */
    readonly selectedAt: number;
    /** ID of the FailureConsoleRecord this decision applies to. */
    readonly previousFailureRecordId: string;
    /** Optional free-text summary of the operator's reasoning. */
    readonly reasonSummary?: string;
    /** Optional description of the resulting engine state after recovery. */
    readonly resultingState?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Failure Console Record — The primary persisted failure entity
// ═══════════════════════════════════════════════════════════════════════════════

/** A fully classified and assembled failure record for the console UI. */
export interface FailureConsoleRecord {
    /** Unique identifier for this failure record. */
    readonly id: string;
    /** Run ID that this failure belongs to. */
    readonly runId: string;
    /** Session ID for the current orchestration session. */
    readonly sessionId: string;
    /** Phase ID where the failure occurred (if scoped to a phase). */
    readonly phaseId?: string;
    /** Worker ID that experienced the failure (if scoped to a worker). */
    readonly workerId?: string;
    /** Severity classification of the failure. */
    readonly severity: FailureSeverity;
    /** Scope at which the failure applies. */
    readonly scope: FailureScope;
    /** Deterministic category for this failure. */
    readonly category: FailureCategory;
    /** Event ID of the identified root cause (if determined). */
    readonly rootEventId?: string;
    /** Event IDs that contributed to this failure. */
    readonly contributingEventIds: readonly string[];
    /** Human-readable failure message. */
    readonly message: string;
    /** Diagnostic evidence collected at the time of failure. */
    readonly evidence: FailureEvidence;
    /** Model-suggested recovery actions. */
    readonly suggestedActions: readonly SuggestedRecoveryAction[];
    /** The operator's chosen recovery action (if any). */
    readonly chosenAction?: OperatorRecoveryDecision;
    /** Unix timestamp (ms) when the record was created. */
    readonly createdAt: number;
    /** Unix timestamp (ms) when the record was last updated. */
    readonly updatedAt: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Failure Packet — Runtime data bundle for the FailureAssembler
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * A transient data packet assembled from runtime events,
 * consumed by the FailureAssembler to produce a FailureConsoleRecord.
 */
export interface FailurePacket {
    /** Run ID for the current execution. */
    readonly runId: string;
    /** Session ID for the current orchestration session. */
    readonly sessionId: string;
    /** Phase ID where the failure occurred (if applicable). */
    readonly phaseId?: string;
    /** Worker ID that experienced the failure (if applicable). */
    readonly workerId?: string;
    /** Ordered timeline of events leading to the failure. */
    readonly timeline: readonly FailureEventRef[];
    /** Latest output from the worker before the failure. */
    readonly latestOutput?: string;
    /** Latest error text from the failing subsystem. */
    readonly latestError?: string;
    /** Context token budget snapshot. */
    readonly contextBudget?: {
        readonly tokenLimit: number;
        readonly used: number;
        readonly remaining: number;
    };
    /** Success criteria that were being evaluated. */
    readonly successCriteria?: readonly string[];
    /** Tool invocation outcomes leading up to the failure. */
    readonly toolActions?: ReadonlyArray<{
        readonly toolId: string;
        readonly outcome: 'success' | 'failure' | 'denied';
        readonly timestamp: number;
    }>;
}
