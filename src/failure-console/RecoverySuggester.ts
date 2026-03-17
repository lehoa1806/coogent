// ─────────────────────────────────────────────────────────────────────────────
// src/failure-console/RecoverySuggester.ts — Model-assisted recovery suggestion generator
// ─────────────────────────────────────────────────────────────────────────────

import type {
    FailureCategory,
    FailureSeverity,
    FailureScope,
    FailureEvidence,
    SuggestedRecoveryAction,
    RecoveryActionType,
} from '../types/failure-console.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Public Interfaces
// ═══════════════════════════════════════════════════════════════════════════════

/** Context required to generate recovery suggestions for a classified failure. */
export interface SuggestionContext {
    /** Deterministic category from the FailureClassifier. */
    category: FailureCategory;
    /** Severity level of the failure event. */
    severity: FailureSeverity;
    /** Scope at which the failure occurred. */
    scope: FailureScope;
    /** Human-readable failure message. */
    message: string;
    /** Diagnostic evidence collected at the time of failure. */
    evidence: FailureEvidence;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Internal Types
// ═══════════════════════════════════════════════════════════════════════════════

/** A rule entry mapping a category to its primary suggestions. */
interface SuggestionRule {
    action: RecoveryActionType;
    confidence: 'low' | 'medium' | 'high';
    title: string;
    rationale: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Suggestion Rule Table
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Deterministic heuristic rules keyed by FailureCategory.
 * Each category maps to an ordered list of suggestions (highest confidence first).
 */
const SUGGESTION_RULES: ReadonlyMap<FailureCategory, readonly SuggestionRule[]> = new Map<
    FailureCategory,
    readonly SuggestionRule[]
>([
    [
        'worker_execution_error',
        [
            {
                action: 'retry',
                confidence: 'high',
                title: 'Retry the phase',
                rationale: 'Worker execution errors are often transient and may resolve on retry.',
            },
            {
                action: 'reroute_worker',
                confidence: 'medium',
                title: 'Reroute to a different worker',
                rationale:
                    'The current worker may have a persistent issue; routing to an alternative worker could succeed.',
            },
        ],
    ],
    [
        'tool_denied',
        [
            {
                action: 'edit_success_criteria',
                confidence: 'medium',
                title: 'Edit success criteria',
                rationale:
                    'The required tool is denied by policy. Adjusting success criteria may allow completion without this tool.',
            },
            {
                action: 'skip',
                confidence: 'low',
                title: 'Skip this phase',
                rationale:
                    'If the denied tool is non-essential, skipping the phase avoids blocking the run.',
            },
        ],
    ],
    [
        'tool_invocation_error',
        [
            {
                action: 'retry',
                confidence: 'high',
                title: 'Retry the phase',
                rationale:
                    'Tool invocation errors may be caused by transient issues such as network timeouts or rate limits.',
            },
            {
                action: 'inspect_repair_prompt',
                confidence: 'medium',
                title: 'Inspect the repair prompt',
                rationale:
                    'The tool invocation arguments may be malformed. Inspecting the prompt can reveal fixable issues.',
            },
        ],
    ],
    [
        'context_budget_exceeded',
        [
            {
                action: 'retry_with_more_context',
                confidence: 'high',
                title: 'Retry with expanded context budget',
                rationale:
                    'The context budget was exhausted. Retrying with a larger budget may allow completion.',
            },
            {
                action: 'edit_success_criteria',
                confidence: 'medium',
                title: 'Simplify success criteria',
                rationale:
                    'Reducing the scope of success criteria can lower context requirements and fit within budget.',
            },
        ],
    ],
    [
        'context_assembly_error',
        [
            {
                action: 'retry',
                confidence: 'medium',
                title: 'Retry the phase',
                rationale:
                    'Context assembly errors may be caused by transient file or reference issues that resolve on retry.',
            },
            {
                action: 'inspect_repair_prompt',
                confidence: 'medium',
                title: 'Inspect the repair prompt',
                rationale:
                    'The context manifest may reference invalid or missing data. Inspecting the prompt can identify the issue.',
            },
        ],
    ],
    [
        'evaluation_rejection',
        [
            {
                action: 'edit_success_criteria',
                confidence: 'high',
                title: 'Edit success criteria',
                rationale:
                    'The evaluator rejected the output. Adjusting the success criteria may align expectations with what was produced.',
            },
            {
                action: 'retry',
                confidence: 'medium',
                title: 'Retry the phase',
                rationale:
                    'A retry may produce output that better matches the current evaluation criteria.',
            },
        ],
    ],
    [
        'timeout',
        [
            {
                action: 'retry',
                confidence: 'medium',
                title: 'Retry the phase',
                rationale:
                    'Timeouts can be caused by transient load or slowness. A retry may complete within the time limit.',
            },
            {
                action: 'reroute_worker',
                confidence: 'medium',
                title: 'Reroute to a different worker',
                rationale:
                    'The current worker may be experiencing persistent slowness. An alternative worker may be faster.',
            },
        ],
    ],
    [
        'dependency_failure',
        [
            {
                action: 'skip',
                confidence: 'low',
                title: 'Skip this phase',
                rationale:
                    'A dependency has failed. If this phase is non-critical, skipping it allows the run to continue.',
            },
            {
                action: 'inspect_repair_prompt',
                confidence: 'low',
                title: 'Inspect the repair prompt',
                rationale:
                    'Inspecting the prompt may reveal which dependency failed and whether a workaround exists.',
            },
        ],
    ],
    [
        'mcp_contract_error',
        [
            {
                action: 'retry',
                confidence: 'medium',
                title: 'Retry the phase',
                rationale:
                    'MCP contract errors may be caused by temporary server-side issues that resolve on retry.',
            },
            {
                action: 'inspect_repair_prompt',
                confidence: 'high',
                title: 'Inspect the repair prompt',
                rationale:
                    'The MCP contract may have changed or the request may be malformed. Inspecting the prompt can reveal the mismatch.',
            },
        ],
    ],
    [
        'plugin_failure',
        [
            {
                action: 'retry',
                confidence: 'low',
                title: 'Retry the phase',
                rationale:
                    'Plugin failures are often deterministic, but a retry may succeed if the failure was caused by a transient issue.',
            },
            {
                action: 'inspect_repair_prompt',
                confidence: 'medium',
                title: 'Inspect the repair prompt',
                rationale:
                    'The plugin may require different input parameters. Inspecting the prompt can identify configuration issues.',
            },
        ],
    ],
    [
        'unknown',
        [
            {
                action: 'inspect_repair_prompt',
                confidence: 'medium',
                title: 'Inspect the repair prompt',
                rationale:
                    'The failure category could not be determined. Inspecting the prompt may reveal the root cause.',
            },
            {
                action: 'retry',
                confidence: 'low',
                title: 'Retry the phase',
                rationale:
                    'When the failure cause is unknown, a retry is a low-confidence fallback that may succeed.',
            },
        ],
    ],
]);

// ═══════════════════════════════════════════════════════════════════════════════
//  RecoverySuggester
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Generates ranked recovery suggestions for a classified failure context.
 *
 * Stage 4 implementation: uses deterministic rule-based heuristics keyed by
 * {@link FailureCategory}. A future iteration can swap in a real model call.
 */
export class RecoverySuggester {
    /**
     * Generate ranked recovery suggestions for the given failure context.
     * Returns suggestions ordered by confidence (high first).
     *
     * The `inspect_repair_prompt` action is always included as a fallback
     * if it is not already present in the category-specific rules.
     */
    suggest(ctx: SuggestionContext): SuggestedRecoveryAction[] {
        const rules = SUGGESTION_RULES.get(ctx.category) ?? [];

        const suggestions: SuggestedRecoveryAction[] = rules.map((rule) => ({
            action: rule.action,
            title: rule.title,
            rationale: rule.rationale,
            confidence: rule.confidence,
        }));

        // Ensure inspect_repair_prompt is always present as a fallback
        const hasInspect = suggestions.some((s) => s.action === 'inspect_repair_prompt');
        if (!hasInspect) {
            suggestions.push({
                action: 'inspect_repair_prompt',
                title: 'Inspect the repair prompt',
                rationale:
                    'Review the repair prompt for potential issues that may have contributed to the failure.',
                confidence: 'low',
            });
        }

        // Sort by confidence: high > medium > low
        return suggestions.sort((a, b) => confidenceRank(b.confidence) - confidenceRank(a.confidence));
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════════════════════════════════

/** Numeric rank for sorting by confidence (higher = better). */
function confidenceRank(confidence: 'low' | 'medium' | 'high'): number {
    switch (confidence) {
        case 'high':
            return 3;
        case 'medium':
            return 2;
        case 'low':
            return 1;
        default:
            return 0;
    }
}
