// ─────────────────────────────────────────────────────────────────────────────
// src/agent-selection/types.ts — Type definitions for the Agent Selection System
// ─────────────────────────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════════
//  1. Reasoning Type — Cognitive strategies required by a subtask
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Cognitive reasoning strategies that a subtask may require.
 * Used to match subtasks with agents whose reasoning strengths align.
 */
export type ReasoningType =
    | 'local_code_reasoning'
    | 'interface_preservation'
    | 'control_flow_editing'
    | 'structural_reasoning'
    | 'workflow_planning'
    | 'symbol_level_editing'
    | 'constraint_preserving_changes'
    | 'consistency_checking'
    | 'risk_detection'
    | 'behavioral_case_generation'
    | 'test_oracle_design'
    | 'pattern_search'
    | 'comparative_analysis'
    | 'causal_analysis'
    | 'failure_tracing'
    | 'behavior_preservation';

// ═══════════════════════════════════════════════════════════════════════════════
//  2. Task Type — Fine-grained classification of subtask work
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fine-grained classification of what a subtask actually does.
 * Determines which agent types are eligible to handle the work.
 */
export type TaskType =
    | 'code_modification'
    | 'localized_bugfix'
    | 'small_integration'
    | 'verification'
    | 'regression_check'
    | 'constraint_audit'
    | 'test_creation'
    | 'test_update'
    | 'coverage_extension'
    | 'repo_pattern_discovery'
    | 'implementation_lookup'
    | 'reference_gathering'
    | 'bug_investigation'
    | 'root_cause_analysis'
    | 'failure_isolation'
    | 'task_decomposition'
    | 'dependency_mapping'
    | 'execution_planning';

// ═══════════════════════════════════════════════════════════════════════════════
//  3. Risk Level — Graduated risk classification
// ═══════════════════════════════════════════════════════════════════════════════

/** Graduated risk classification for subtasks and agent tolerances. */
export type RiskLevel = 'low' | 'medium' | 'high';

// ═══════════════════════════════════════════════════════════════════════════════
//  4. Ambiguity Tolerance — How much uncertainty an agent can handle
// ═══════════════════════════════════════════════════════════════════════════════

/** How much ambiguity an agent can tolerate in its inputs. */
export type AmbiguityTolerance = 'low' | 'medium' | 'high';

// ═══════════════════════════════════════════════════════════════════════════════
//  5. Agent Type — The distinct agent archetypes in the system
// ═══════════════════════════════════════════════════════════════════════════════

/** The distinct agent archetypes available for subtask assignment. */
export type AgentType = 'Planner' | 'CodeEditor' | 'Reviewer' | 'TestWriter' | 'Researcher' | 'Debugger';

// ═══════════════════════════════════════════════════════════════════════════════
//  6. Agent Mode — Operational modes that specialize agent behavior
// ═══════════════════════════════════════════════════════════════════════════════

/** Operational modes that further specialize an agent's behavior within its type. */
export type AgentMode =
    | 'conservative_patch'
    | 'standard_edit'
    | 'cross_file_edit'
    | 'api_review'
    | 'behavior_review'
    | 'constraint_audit'
    | 'pattern_lookup'
    | 'symbol_trace'
    | 'implementation_comparison';

// ═══════════════════════════════════════════════════════════════════════════════
//  7. Context Format — How context should be structured for an agent
// ═══════════════════════════════════════════════════════════════════════════════

/** Describes how input context should be structured and delivered to an agent. */
export type ContextFormat =
    | 'full_target_file'
    | 'file_slices'
    | 'dependency_handoff'
    | 'diff'
    | 'target_file'
    | 'diffs'
    | 'constraints'
    | 'patches'
    | 'changed_files'
    | 'test_results'
    | 'implementation_summary'
    | 'target_files'
    | 'existing_tests'
    | 'repo_index'
    | 'symbol_names'
    | 'feature_descriptions'
    | 'error_logs'
    | 'failing_tests'
    | 'relevant_files'
    | 'requirements'
    | 'available_tools';

// ═══════════════════════════════════════════════════════════════════════════════
//  8. Deliverable Type — What an agent produces as output
// ═══════════════════════════════════════════════════════════════════════════════

/** The kind of artifact an agent produces upon completing its work. */
export type DeliverableType =
    | 'patch_with_summary'
    | 'patch_with_notes'
    | 'review_report'
    | 'test_patch'
    | 'research_summary'
    | 'debug_report'
    | 'task_graph';

// ═══════════════════════════════════════════════════════════════════════════════
//  9. Fit Assessment — How well an agent matches its assigned subtask
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Post-execution assessment of how well an agent matched its assigned subtask.
 * Reported by the worker agent to inform future selection decisions.
 */
export interface FitAssessment {
    /** How well the agent's capabilities matched the task requirements. */
    readonly task_fit: 'good' | 'partial' | 'poor';
    /** Whether the provided context was sufficient for the work. */
    readonly context_sufficiency: 'adequate' | 'partial' | 'insufficient';
    /** Whether the agent type was fundamentally mismatched for this work. */
    readonly agent_mismatch: boolean;
    /** If mismatched, which agent type would be more appropriate. */
    readonly recommended_reassignment: AgentType | null;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  10. Assumption Policy — Controls what assumptions an agent can make
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Governs the assumptions an agent is permitted to make during execution.
 * Injected into compiled worker prompts to constrain autonomous behavior.
 */
export interface AssumptionPolicy {
    /** Assumptions the agent is explicitly allowed to make. */
    readonly allowed: readonly string[];
    /** Assumptions the agent must never make. */
    readonly forbidden: readonly string[];
    /** Assumptions that require explicit confirmation before proceeding. */
    readonly must_confirm: readonly string[];
    /** Context items that trigger escalation if missing. */
    readonly escalate_if_missing: readonly string[];
}

// ═══════════════════════════════════════════════════════════════════════════════
//  11. Context Requirements — What context a subtask needs
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Specifies what context a subtask requires and how it should be formatted.
 * Used by the context scoper to prepare the agent's working set.
 */
export interface ContextRequirements {
    /** Preferred context delivery formats, in priority order. */
    readonly preferred_format: readonly ContextFormat[];
    /** Context items that must be present for the agent to proceed. */
    readonly must_include: readonly string[];
    /** Context items that are helpful but not required. */
    readonly optional: readonly string[];
}

// ═══════════════════════════════════════════════════════════════════════════════
//  12. Deliverable — What the agent must produce
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Describes the expected output artifact from a subtask execution.
 * Forms part of the output contract between the orchestrator and the agent.
 */
export interface Deliverable {
    /** The kind of artifact to produce. */
    readonly type: DeliverableType;
    /** Required sections or components in the deliverable. */
    readonly must_include: readonly string[];
}

// ═══════════════════════════════════════════════════════════════════════════════
//  13. Subtask Spec — Full specification for a unit of work
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Complete specification for a single subtask in the execution plan.
 * Consumed by the agent selector to find the best-fit agent,
 * and by the prompt compiler to generate the worker prompt.
 */
export interface SubtaskSpec {
    /** Unique identifier for this subtask. */
    readonly subtask_id: string;
    /** Human-readable title summarizing the work. */
    readonly title: string;
    /** Clear statement of what must be accomplished. */
    readonly goal: string;
    /** Fine-grained classification of the work. */
    readonly task_type: TaskType;
    /** Cognitive reasoning strategies required. */
    readonly reasoning_type: readonly ReasoningType[];
    /** Domain capabilities needed (e.g., 'typescript', 'sql', 'testing'). */
    readonly required_capabilities: readonly string[];
    /** Input artifacts or data required before execution. */
    readonly required_inputs: readonly string[];
    /** Context requirements specifying format and content needs. */
    readonly context_requirements: ContextRequirements;
    /** Inputs that must be provided by upstream subtask outputs. */
    readonly dependency_inputs: readonly string[];
    /** Assumptions the agent is explicitly allowed to make. */
    readonly assumptions_allowed: readonly string[];
    /** Assumptions the agent must never make. */
    readonly assumptions_forbidden: readonly string[];
    /** Items the agent must confirm before proceeding. */
    readonly required_confirmations: readonly string[];
    /** Risk level associated with this subtask. */
    readonly risk_level: RiskLevel;
    /** Cost of failure for this subtask. */
    readonly failure_cost: RiskLevel;
    /** Expected output artifact specification. */
    readonly deliverable: Deliverable;
    /** Verification steps to run after the subtask completes. */
    readonly verification_needed: readonly string[];
    /** Strategy to follow if the subtask fails or is blocked. */
    readonly fallback_strategy: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  14. Agent Profile — Capability manifest for an agent type
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Capability manifest describing what an agent type can do.
 * Used by the agent selector to score candidates against subtask requirements.
 */
export interface AgentProfile {
    /** Unique identifier for routing and cascading config (e.g. 'code_editor'). */
    readonly id: string;
    /** Display name for the UI. */
    readonly name: string;
    /** The agent archetype. */
    readonly agent_type: AgentType;
    /** Hyper-specific LLM system prompt with guardrails. */
    readonly system_prompt: string;
    /** Skill tags for Jaccard-similarity routing (e.g. ['typescript', 'react']). */
    readonly tags: readonly string[];
    /** Optional operational mode that specializes behavior. */
    readonly mode?: AgentMode;
    /** Task types this agent can handle. */
    readonly handles: readonly TaskType[];
    /** Cognitive reasoning strategies this agent excels at. */
    readonly reasoning_strengths: readonly ReasoningType[];
    /** Domain skills this agent possesses. */
    readonly skills: readonly string[];
    /** Preferred context delivery formats. */
    readonly preferred_context: readonly ContextFormat[];
    /** Hard requirements that must be met before assignment. */
    readonly requires: readonly string[];
    /** How much ambiguity this agent can tolerate. */
    readonly tolerates_ambiguity: AmbiguityTolerance;
    /** Maximum risk level this agent should be assigned. */
    readonly risk_tolerance: RiskLevel;
    /** Descriptive tags for scenarios where this agent excels. */
    readonly best_for: readonly string[];
    /** Descriptive tags for scenarios where this agent should not be used. */
    readonly avoid_when: readonly string[];
    /** The default deliverable type this agent produces. */
    readonly default_output: DeliverableType;
    /** Self-checking capabilities the agent can perform post-execution. */
    readonly self_check_capabilities: readonly string[];
    /**
     * @deprecated Use `allowed_tools_policy` instead. Retained for backward compatibility.
     * (Future scope) Restrict MCP tool access per agent.
     */
    readonly allowed_tools?: readonly string[];
    /** Per-worker tool access policy. When absent, inherits workspace default. */
    readonly allowed_tools_policy?: import('../tool-policy/types.js').AllowedToolsPolicy | undefined;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  15. Agent Score — Scored candidate from the selection process
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * A scored candidate from the agent selection process.
 * Rejected agents are scored but excluded from final selection.
 */
export interface AgentScore {
    /** The agent archetype that was scored. */
    readonly agent_type: AgentType;
    /** Composite fitness score (higher is better, 0–1 range). */
    readonly score: number;
    /** Whether this agent was rejected during scoring. */
    readonly rejected: boolean;
    /** Reason for rejection, if applicable. */
    readonly rejection_reason?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  16. Selection Result — Output of the agent selection process
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The result of running the agent selector against a subtask specification.
 * Contains the winning agent, all scored candidates, and audit metadata.
 */
export interface SelectionResult {
    /** The subtask this selection was performed for. */
    readonly subtask_id: string;
    /** All scored candidates, including rejected ones. */
    readonly candidate_agents: readonly AgentScore[];
    /** The agent type selected for this subtask. */
    readonly selected_agent: AgentType;
    /** Optional operational mode for the selected agent. */
    readonly selected_mode?: AgentMode;
    /** Human-readable rationale explaining why this agent was chosen. */
    readonly selection_rationale: readonly string[];
    /** Fallback agent type if the primary agent fails or is blocked. */
    readonly fallback_agent: AgentType | null;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  17. Compiled Worker Prompt — Final prompt ready for a worker agent
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The fully compiled prompt ready for injection into a worker agent.
 * Bundles the prompt text with its assumption policy and output contract
 * for full traceability and enforcement.
 */
export interface CompiledWorkerPrompt {
    /** Unique identifier for this compiled prompt. */
    readonly prompt_id: string;
    /** The subtask this prompt was compiled for. */
    readonly subtask_id: string;
    /** The agent type this prompt targets. */
    readonly agent_type: AgentType;
    /** Optional operational mode for the target agent. */
    readonly mode?: AgentMode;
    /** The fully assembled prompt string. */
    readonly text: string;
    /** Assumption policy governing the agent's autonomy. */
    readonly assumption_policy: AssumptionPolicy;
    /** Output contract specifying what the agent must deliver. */
    readonly output_contract: Deliverable;
    /** Version string for prompt template lineage. */
    readonly version: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  18. Validation Error — Individual validation issue
// ═══════════════════════════════════════════════════════════════════════════════

/** An individual validation issue found during prompt validation. */
export interface ValidationError {
    /** The field or section where the error was found. */
    readonly field: string;
    /** Human-readable description of the issue. */
    readonly message: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  19. Validation Result — Result of validating a compiled prompt
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Result of validating a compiled worker prompt.
 * Includes both hard errors (must fix) and soft warnings (should fix).
 */
export interface ValidationResult {
    /** The prompt that was validated. */
    readonly prompt_id: string;
    /** Whether the prompt passed all validation checks. */
    readonly valid: boolean;
    /** Hard validation errors that must be resolved. */
    readonly errors: readonly ValidationError[];
    /** Soft warnings that should be addressed but are not blocking. */
    readonly warnings: readonly ValidationError[];
}

// ═══════════════════════════════════════════════════════════════════════════════
//  20. Worker Run Result — Execution outcome from a worker agent
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The execution outcome reported by a worker agent after completing (or failing)
 * a subtask. Contains self-assessment, output artifacts, and audit metadata.
 */
export interface WorkerRunResult {
    /** Unique identifier for the worker instance. */
    readonly worker_id: string;
    /** The subtask that was executed. */
    readonly subtask_id: string;
    /** Terminal status of the execution. */
    readonly status: 'completed' | 'blocked' | 'failed';
    /** Self-reported confidence in the output quality (0–1 range). */
    readonly confidence: number;
    /** Post-execution fit assessment. */
    readonly fit_assessment: FitAssessment;
    /** Context items the agent needed but did not receive. */
    readonly missing_context: readonly string[];
    /** Non-blocking issues encountered during execution. */
    readonly warnings: readonly string[];
    /** Assumptions the agent made during execution. */
    readonly assumptions_made: readonly string[];
    /** Verification notes from the agent's self-check. */
    readonly verification_notes: readonly string[];
    /** The output artifact, or null if execution failed before producing output. */
    readonly output: { readonly type: DeliverableType; readonly patch?: string; readonly summary?: string } | null;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  21. Recovery Action — Post-failure recovery strategies
// ═══════════════════════════════════════════════════════════════════════════════

/** Actions the orchestrator can take in response to a failed or blocked worker. */
export type RecoveryAction =
    | 'accept'
    | 'enrich_context'
    | 'reassign'
    | 'escalate_to_planner'
    | 'escalate_to_reviewer';

// ═══════════════════════════════════════════════════════════════════════════════
//  22. Selection Audit Record — Full audit trail for a selection decision
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Complete audit record for an agent selection decision.
 * Enables post-hoc analysis, debugging, and continuous improvement
 * of the selection algorithm.
 */
export interface SelectionAuditRecord {
    /** The subtask this record pertains to. */
    readonly subtask_id: string;
    /** The full subtask specification used for selection. */
    readonly subtask_spec: SubtaskSpec;
    /** All scored candidates from the selection process. */
    readonly candidate_agents: readonly AgentScore[];
    /** The agent type that was ultimately selected. */
    readonly selected_agent: AgentType;
    /** Human-readable rationale for the selection. */
    readonly selection_rationale: readonly string[];
    /** The ID of the compiled prompt generated for this selection. */
    readonly compiled_prompt_id: string;
    /** Fallback agent type, if one was designated. */
    readonly fallback_agent: AgentType | null;
    /** Execution result, populated after the worker completes. */
    readonly worker_run_result?: WorkerRunResult;
    /** Unix timestamp (ms) when this record was created. */
    readonly timestamp: number;
}
