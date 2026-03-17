// ─────────────────────────────────────────────────────────────────────────────
// stores/failureConsole.ts — Failure Console reactive store & webview types
//
// Holds FailureConsoleRecord data pushed from the Extension Host via the
// FAILURE_CONSOLE_RECORD IPC message.  Types mirror src/types/failure-console.ts
// but are self-contained (the webview cannot import from the Extension Host).
// ─────────────────────────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════════
//  Webview-local Failure Console Types
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

/** A single event in the failure timeline, referencing the originating subsystem. */
export interface FailureEventRef {
    readonly eventId: string;
    readonly timestamp: number;
    readonly source: FailureSource;
    readonly summary: string;
    readonly isRootCandidate: boolean;
}

/** Diagnostic evidence collected at the time of failure. */
export interface FailureEvidence {
    readonly latestWorkerOutput?: string;
    readonly latestErrorText?: string;
    readonly contextBudget?: {
        readonly tokenLimit: number;
        readonly estimatedUsed: number;
        readonly remaining: number;
    };
    readonly toolActions?: ReadonlyArray<{
        readonly toolId: string;
        readonly outcome: 'success' | 'failure' | 'denied';
        readonly timestamp: number;
    }>;
    readonly successCriteria?: readonly string[];
    readonly contextManifestRef?: string;
    readonly repairPromptRef?: string;
}

/** A model-suggested recovery action with confidence level. */
export interface SuggestedRecoveryAction {
    readonly action: RecoveryActionType;
    readonly title: string;
    readonly rationale: string;
    readonly confidence: 'low' | 'medium' | 'high';
    readonly availability: 'enabled' | 'disabled';
    readonly disabledReason?: string;
}

/** The operator's chosen recovery decision from the failure console. */
export interface OperatorRecoveryDecision {
    readonly action: RecoveryActionType;
    readonly initiatedBy: 'user';
    readonly suggestedByModel: boolean;
    readonly selectedAt: number;
    readonly previousFailureRecordId: string;
    readonly reasonSummary?: string;
    readonly resultingState?: string;
}

/** A fully classified and assembled failure record for the console UI. */
export interface FailureConsoleRecord {
    readonly id: string;
    readonly runId: string;
    readonly sessionId: string;
    readonly phaseId?: string;
    readonly workerId?: string;
    readonly severity: FailureSeverity;
    readonly scope: FailureScope;
    readonly category: FailureCategory;
    readonly rootEventId?: string;
    readonly contributingEventIds: readonly string[];
    readonly message: string;
    readonly evidence: FailureEvidence;
    readonly suggestedActions: readonly SuggestedRecoveryAction[];
    readonly chosenAction?: OperatorRecoveryDecision;
    readonly createdAt: number;
    readonly updatedAt: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Reactive Store (Svelte 5 runes)
// ═══════════════════════════════════════════════════════════════════════════════

/** Internal reactive state — not exported directly to avoid state_invalid_export. */
const store = $state<{ records: FailureConsoleRecord[] }>({ records: [] });

/** All received failure records, ordered by arrival. */
export function getFailureRecords(): FailureConsoleRecord[] {
    return store.records;
}

/**
 * The most recent failure record by `createdAt` timestamp.
 * Returns `undefined` when there are no records.
 */
export function getLatestFailure(): FailureConsoleRecord | undefined {
    return store.records.length === 0
        ? undefined
        : store.records.reduce((latest, r) =>
              r.createdAt > latest.createdAt ? r : latest,
          );
}

/** Append a new failure record to the store. */
export function addFailureRecord(record: FailureConsoleRecord): void {
    store.records = [...store.records, record];
}

/** Clear all failure records from the store. */
export function clearFailureRecords(): void {
    store.records = [];
}

