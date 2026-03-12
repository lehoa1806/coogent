// ─────────────────────────────────────────────────────────────────────────────
// src/agent-selection/SubtaskSpecBuilder.ts — Factory for constructing SubtaskSpec objects
// ─────────────────────────────────────────────────────────────────────────────

import type {
    SubtaskSpec,
    TaskType,
    ReasoningType,
    RiskLevel,
    ContextRequirements,
    Deliverable,
    AssumptionPolicy,
    DeliverableType,
} from './types.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  1. Input interfaces
// ═══════════════════════════════════════════════════════════════════════════════

/** Raw subtask data as it arrives from the planner or decomposer. */
export interface SubtaskDraft {
    readonly id: string;
    readonly title: string;
    readonly goal: string;
    readonly contextFiles?: readonly string[];
    readonly dependsOn?: readonly string[];
    readonly requiredCapabilities?: readonly string[];
    readonly successCriteria?: string;
}

/** Additional normalized requirement context. */
export interface NormalizedRequirementContext {
    readonly constraints?: readonly string[];
    readonly riskFactors?: readonly string[];
    readonly knownInputs?: readonly string[];
}

// ═══════════════════════════════════════════════════════════════════════════════
//  2. Keyword → TaskType mapping table
// ═══════════════════════════════════════════════════════════════════════════════

/** Ordered keyword-to-TaskType rules. Scored by match count; highest wins. */
const TASK_TYPE_KEYWORDS: readonly { readonly keywords: readonly string[]; readonly type: TaskType }[] = [
    { keywords: ['test', 'spec', 'coverage', 'testing', 'tests', 'e2e', 'integration test', 'test suite', 'test case'], type: 'test_creation' },
    { keywords: ['review', 'verify', 'audit', 'check', 'validate', 'inspect', 'confirm', 'regression'], type: 'verification' },
    { keywords: ['refactor', 'restructure', 'reorganize'], type: 'refactor' as TaskType },
    { keywords: ['fix', 'bug', 'patch', 'resolve', 'broken', 'crash', 'error', 'issue', 'failing', 'defect'], type: 'localized_bugfix' },
    { keywords: ['debug', 'investigate bug', 'root cause', 'diagnose'], type: 'bug_investigation' },
    { keywords: ['investigate', 'research', 'discover', 'find', 'search', 'explore', 'analyze', 'scan', 'map', 'understand'], type: 'repo_pattern_discovery' },
    { keywords: ['plan', 'decompose', 'design', 'architect', 'structure', 'organize', 'break down'], type: 'task_decomposition' },
    { keywords: ['integrate', 'connect', 'wire up', 'hook up', 'link'], type: 'small_integration' },
    { keywords: ['dependency', 'dependencies', 'import graph', 'module graph'], type: 'dependency_mapping' },
];

// ═══════════════════════════════════════════════════════════════════════════════
//  3. TaskType → ReasoningType mapping table
// ═══════════════════════════════════════════════════════════════════════════════

const REASONING_BY_TASK_TYPE: ReadonlyMap<TaskType, readonly ReasoningType[]> = new Map<TaskType, readonly ReasoningType[]>([
    ['code_modification', ['local_code_reasoning', 'symbol_level_editing', 'interface_preservation']],
    ['localized_bugfix', ['local_code_reasoning', 'failure_tracing', 'causal_analysis']],
    ['small_integration', ['structural_reasoning', 'interface_preservation', 'control_flow_editing']],
    ['verification', ['consistency_checking', 'risk_detection', 'behavior_preservation']],
    ['regression_check', ['consistency_checking', 'behavior_preservation']],
    ['constraint_audit', ['constraint_preserving_changes', 'risk_detection']],
    ['test_creation', ['behavioral_case_generation', 'test_oracle_design']],
    ['test_update', ['behavioral_case_generation', 'behavior_preservation']],
    ['coverage_extension', ['behavioral_case_generation', 'pattern_search']],
    ['repo_pattern_discovery', ['pattern_search', 'comparative_analysis']],
    ['implementation_lookup', ['pattern_search', 'comparative_analysis']],
    ['reference_gathering', ['pattern_search']],
    ['bug_investigation', ['failure_tracing', 'causal_analysis']],
    ['root_cause_analysis', ['causal_analysis', 'failure_tracing']],
    ['failure_isolation', ['failure_tracing', 'causal_analysis', 'risk_detection']],
    ['task_decomposition', ['workflow_planning', 'structural_reasoning']],
    ['dependency_mapping', ['structural_reasoning', 'workflow_planning']],
    ['execution_planning', ['workflow_planning', 'structural_reasoning']],
]);

// ═══════════════════════════════════════════════════════════════════════════════
//  4. TaskType → DeliverableType mapping table
// ═══════════════════════════════════════════════════════════════════════════════

const DELIVERABLE_BY_TASK_TYPE: ReadonlyMap<TaskType, DeliverableType> = new Map<TaskType, DeliverableType>([
    ['code_modification', 'patch_with_summary'],
    ['localized_bugfix', 'patch_with_notes'],
    ['small_integration', 'patch_with_summary'],
    ['verification', 'review_report'],
    ['regression_check', 'review_report'],
    ['constraint_audit', 'review_report'],
    ['test_creation', 'test_patch'],
    ['test_update', 'test_patch'],
    ['coverage_extension', 'test_patch'],
    ['repo_pattern_discovery', 'research_summary'],
    ['implementation_lookup', 'research_summary'],
    ['reference_gathering', 'research_summary'],
    ['bug_investigation', 'debug_report'],
    ['root_cause_analysis', 'debug_report'],
    ['failure_isolation', 'debug_report'],
    ['task_decomposition', 'task_graph'],
    ['dependency_mapping', 'task_graph'],
    ['execution_planning', 'task_graph'],
]);

// ═══════════════════════════════════════════════════════════════════════════════
//  5. TaskType → Default deliverable must_include sections
// ═══════════════════════════════════════════════════════════════════════════════

const DELIVERABLE_SECTIONS: ReadonlyMap<DeliverableType, readonly string[]> = new Map<DeliverableType, readonly string[]>([
    ['patch_with_summary', ['code_changes', 'change_summary', 'files_modified']],
    ['patch_with_notes', ['code_changes', 'root_cause', 'fix_explanation']],
    ['review_report', ['findings', 'severity_assessment', 'recommendations']],
    ['test_patch', ['test_code', 'coverage_notes', 'test_rationale']],
    ['research_summary', ['findings', 'patterns_identified', 'references']],
    ['debug_report', ['root_cause', 'evidence', 'reproduction_steps']],
    ['task_graph', ['subtask_list', 'dependency_graph', 'execution_order']],
]);

// ═══════════════════════════════════════════════════════════════════════════════
//  6. TaskType → Default verification steps
// ═══════════════════════════════════════════════════════════════════════════════

const VERIFICATION_BY_TASK_TYPE: ReadonlyMap<TaskType, readonly string[]> = new Map<TaskType, readonly string[]>([
    ['code_modification', ['lint_check', 'type_check', 'unit_tests']],
    ['localized_bugfix', ['regression_test', 'type_check', 'manual_verify']],
    ['small_integration', ['integration_test', 'type_check']],
    ['verification', ['cross_reference_check']],
    ['regression_check', ['run_full_test_suite']],
    ['constraint_audit', ['constraint_validation']],
    ['test_creation', ['run_new_tests', 'coverage_check']],
    ['test_update', ['run_updated_tests']],
    ['coverage_extension', ['coverage_report']],
    ['repo_pattern_discovery', ['verify_findings']],
    ['implementation_lookup', ['verify_references']],
    ['reference_gathering', ['verify_sources']],
    ['bug_investigation', ['reproduce_bug']],
    ['root_cause_analysis', ['validate_hypothesis']],
    ['failure_isolation', ['reproduce_failure']],
    ['task_decomposition', ['validate_completeness']],
    ['dependency_mapping', ['validate_dependencies']],
    ['execution_planning', ['validate_plan']],
]);

// ═══════════════════════════════════════════════════════════════════════════════
//  7. SubtaskSpecBuilder
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Factory that constructs fully-populated SubtaskSpec objects from
 * loosely-structured subtask draft data.
 *
 * All methods are static and pure — no side effects, no shared state.
 */
export class SubtaskSpecBuilder {
    /**
     * Build a complete SubtaskSpec from a draft and optional context.
     *
     * The builder infers:
     * - task_type from the goal/title keywords
     * - reasoning_type from the task_type
     * - risk_level from context (defaults to 'medium')
     * - context_requirements from contextFiles
     * - assumption_policy with sensible defaults
     * - deliverable from task_type
     * - verification_needed from risk and task type
     */
    static build(
        draft: SubtaskDraft,
        context?: NormalizedRequirementContext,
        dependencyInputs?: readonly string[],
    ): SubtaskSpec {
        const taskType = SubtaskSpecBuilder.inferTaskType(draft.title, draft.goal);
        const reasoningTypes = SubtaskSpecBuilder.inferReasoningTypes(taskType);
        const riskLevel = SubtaskSpecBuilder.inferRiskLevel(context);
        const assumptionPolicy = SubtaskSpecBuilder.buildDefaultAssumptionPolicy(context?.constraints);
        const deliverable = SubtaskSpecBuilder.buildDefaultDeliverable(taskType);
        const contextRequirements = SubtaskSpecBuilder.buildContextRequirements(draft.contextFiles);
        const verification = SubtaskSpecBuilder.buildVerificationSteps(taskType, riskLevel);

        return {
            subtask_id: draft.id,
            title: draft.title,
            goal: draft.goal,
            task_type: taskType,
            reasoning_type: reasoningTypes,
            required_capabilities: draft.requiredCapabilities ?? [],
            required_inputs: context?.knownInputs ?? [],
            context_requirements: contextRequirements,
            dependency_inputs: dependencyInputs ?? [],
            assumptions_allowed: assumptionPolicy.allowed,
            assumptions_forbidden: assumptionPolicy.forbidden,
            required_confirmations: assumptionPolicy.must_confirm,
            risk_level: riskLevel,
            failure_cost: riskLevel,
            deliverable,
            verification_needed: verification,
            fallback_strategy: SubtaskSpecBuilder.buildFallbackStrategy(taskType),
        };
    }

    /**
     * Infer TaskType from title and goal text.
     * Uses scoring-based keyword matching against a priority-ordered rule set.
     * Counts keyword hits per rule; highest score wins. Ties broken by
     * declaration order. Defaults to 'code_modification'.
     */
    static inferTaskType(title: string, goal: string): TaskType {
        const combined = `${title} ${goal}`.toLowerCase();
        let bestType: TaskType = 'code_modification';
        let bestScore = 0;
        for (const rule of TASK_TYPE_KEYWORDS) {
            const score = rule.keywords.reduce((count, kw) => count + (combined.includes(kw) ? 1 : 0), 0);
            if (score > bestScore) {
                bestScore = score;
                bestType = rule.type;
            }
        }
        return bestType;
    }

    /**
     * Infer ReasoningType(s) from TaskType.
     * Returns the reasoning strategies most relevant to the given task type.
     */
    static inferReasoningTypes(taskType: TaskType): readonly ReasoningType[] {
        return REASONING_BY_TASK_TYPE.get(taskType) ?? ['local_code_reasoning'];
    }

    /**
     * Build default assumption policy.
     * Constraints become forbidden assumptions; sensible defaults are applied
     * for the allowed, must_confirm, and escalate_if_missing lists.
     */
    static buildDefaultAssumptionPolicy(
        constraints?: readonly string[],
    ): AssumptionPolicy {
        return {
            allowed: [
                'Project follows standard TypeScript conventions',
                'Existing tests should continue to pass',
                'Import paths use .js extensions',
            ],
            forbidden: constraints ? [...constraints] : [],
            must_confirm: [
                'Breaking changes to public APIs',
                'Deletion of existing files',
                'Changes to shared configuration',
            ],
            escalate_if_missing: [
                'Required dependency types',
                'Target file existence',
            ],
        };
    }

    /**
     * Build default deliverable from task type.
     * Maps the task type to the appropriate deliverable type and required sections.
     */
    static buildDefaultDeliverable(taskType: TaskType): Deliverable {
        const deliverableType: DeliverableType = DELIVERABLE_BY_TASK_TYPE.get(taskType) ?? 'patch_with_summary';
        const mustInclude: readonly string[] = DELIVERABLE_SECTIONS.get(deliverableType) ?? ['output_summary'];
        return {
            type: deliverableType,
            must_include: mustInclude,
        };
    }

    // ───────────────────────────────────────────────────────────────────────
    //  Private helpers
    // ───────────────────────────────────────────────────────────────────────

    /** Infer risk level from context factors. Defaults to 'medium'. */
    private static inferRiskLevel(context?: NormalizedRequirementContext): RiskLevel {
        if (!context?.riskFactors || context.riskFactors.length === 0) {
            return 'medium';
        }
        const highRiskKeywords = ['breaking', 'production', 'security', 'data-loss', 'migration'];
        const hasHighRisk = context.riskFactors.some((f) =>
            highRiskKeywords.some((kw) => f.toLowerCase().includes(kw)),
        );
        if (hasHighRisk) {
            return 'high';
        }
        const lowRiskKeywords = ['documentation', 'comment', 'formatting', 'style'];
        const allLowRisk = context.riskFactors.every((f) =>
            lowRiskKeywords.some((kw) => f.toLowerCase().includes(kw)),
        );
        if (allLowRisk) {
            return 'low';
        }
        return 'medium';
    }

    /** Build context requirements from draft context files. */
    private static buildContextRequirements(
        contextFiles?: readonly string[],
    ): ContextRequirements {
        const mustInclude = contextFiles ? [...contextFiles] : [];
        return {
            preferred_format: ['full_target_file', 'file_slices'],
            must_include: mustInclude,
            optional: [],
        };
    }

    /** Build verification steps from task type and risk level. */
    private static buildVerificationSteps(
        taskType: TaskType,
        riskLevel: RiskLevel,
    ): readonly string[] {
        const base = VERIFICATION_BY_TASK_TYPE.get(taskType) ?? ['basic_review'];
        if (riskLevel === 'high') {
            return [...base, 'peer_review', 'extended_test_suite'];
        }
        return base;
    }

    /** Build a fallback strategy string from task type. */
    private static buildFallbackStrategy(taskType: TaskType): string {
        switch (taskType) {
            case 'localized_bugfix':
            case 'bug_investigation':
            case 'root_cause_analysis':
            case 'failure_isolation':
                return 'escalate_to_debugger_agent';
            case 'verification':
            case 'regression_check':
            case 'constraint_audit':
                return 'escalate_to_reviewer_agent';
            case 'task_decomposition':
            case 'dependency_mapping':
            case 'execution_planning':
                return 'escalate_to_planner_agent';
            default:
                return 'retry_with_enriched_context';
        }
    }
}
