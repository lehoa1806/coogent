// ─────────────────────────────────────────────────────────────────────────────
// src/failure-console/__tests__/RecoverySuggester.test.ts
// ─────────────────────────────────────────────────────────────────────────────

import { RecoverySuggester, type SuggestionContext } from '../RecoverySuggester.js';
import type {
    FailureCategory,
    SuggestedRecoveryAction,
    RecoveryActionType,
} from '../../types/failure-console.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════════════════════════════════

/** Factory for a baseline SuggestionContext. Override individual fields as needed. */
function makeContext(overrides: Partial<SuggestionContext> = {}): SuggestionContext {
    return {
        category: 'worker_execution_error',
        severity: 'recoverable',
        scope: 'worker',
        message: 'Worker crashed during execution',
        evidence: {},
        ...overrides,
    };
}

/** Helper to find a suggestion by action type. */
function findSuggestion(
    suggestions: SuggestedRecoveryAction[],
    action: RecoveryActionType,
): SuggestedRecoveryAction | undefined {
    return suggestions.find((s) => s.action === action);
}

/** Helper to assert that suggestions are sorted by confidence (high > medium > low). */
function assertSortedByConfidence(suggestions: SuggestedRecoveryAction[]): void {
    const rankMap: Record<string, number> = { high: 3, medium: 2, low: 1 };
    for (let i = 1; i < suggestions.length; i++) {
        const prev = rankMap[suggestions[i - 1]!.confidence]!;
        const curr = rankMap[suggestions[i]!.confidence]!;
        expect(prev).toBeGreaterThanOrEqual(curr);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Structure & Ordering
// ═══════════════════════════════════════════════════════════════════════════════

describe('RecoverySuggester — structure', () => {
    const suggester = new RecoverySuggester();

    it('returns a non-empty array of suggestions', () => {
        const suggestions = suggester.suggest(makeContext());
        expect(suggestions.length).toBeGreaterThan(0);
    });

    it('every suggestion has required fields', () => {
        const suggestions = suggester.suggest(makeContext());
        for (const s of suggestions) {
            expect(s.action).toBeDefined();
            expect(typeof s.title).toBe('string');
            expect(s.title.length).toBeGreaterThan(0);
            expect(typeof s.rationale).toBe('string');
            expect(s.rationale.length).toBeGreaterThan(0);
            expect(['low', 'medium', 'high']).toContain(s.confidence);
        }
    });

    it('suggestions are sorted by confidence descending (high first)', () => {
        const suggestions = suggester.suggest(makeContext());
        assertSortedByConfidence(suggestions);
    });

    it('sorts by confidence across all categories', () => {
        const categories: FailureCategory[] = [
            'worker_execution_error',
            'tool_denied',
            'tool_invocation_error',
            'context_budget_exceeded',
            'context_assembly_error',
            'evaluation_rejection',
            'timeout',
            'dependency_failure',
            'mcp_contract_error',
            'plugin_failure',
            'unknown',
        ];
        for (const category of categories) {
            const suggestions = suggester.suggest(makeContext({ category }));
            assertSortedByConfidence(suggestions);
        }
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  inspect_repair_prompt fallback
// ═══════════════════════════════════════════════════════════════════════════════

describe('RecoverySuggester — inspect_repair_prompt fallback', () => {
    const suggester = new RecoverySuggester();

    it('always includes inspect_repair_prompt for every category', () => {
        const categories: FailureCategory[] = [
            'worker_execution_error',
            'tool_denied',
            'tool_invocation_error',
            'context_budget_exceeded',
            'context_assembly_error',
            'evaluation_rejection',
            'timeout',
            'dependency_failure',
            'mcp_contract_error',
            'plugin_failure',
            'unknown',
        ];
        for (const category of categories) {
            const suggestions = suggester.suggest(makeContext({ category }));
            const inspect = findSuggestion(suggestions, 'inspect_repair_prompt');
            expect(inspect).toBeDefined();
        }
    });

    it('does not duplicate inspect_repair_prompt when already in rules', () => {
        // tool_invocation_error, mcp_contract_error, plugin_failure, unknown etc.
        // all include inspect_repair_prompt in their rules
        const suggestions = suggester.suggest(makeContext({ category: 'tool_invocation_error' }));
        const inspectCount = suggestions.filter(
            (s) => s.action === 'inspect_repair_prompt',
        ).length;
        expect(inspectCount).toBe(1);
    });

    it('adds inspect_repair_prompt as fallback when not in rules', () => {
        // worker_execution_error rules are: retry (high), reroute_worker (medium)
        const suggestions = suggester.suggest(makeContext({ category: 'worker_execution_error' }));
        const inspect = findSuggestion(suggestions, 'inspect_repair_prompt');
        expect(inspect).toBeDefined();
        expect(inspect!.confidence).toBe('low');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Category: worker_execution_error
// ═══════════════════════════════════════════════════════════════════════════════

describe('RecoverySuggester — worker_execution_error', () => {
    const suggester = new RecoverySuggester();

    it('suggests retry with high confidence', () => {
        const suggestions = suggester.suggest(makeContext({ category: 'worker_execution_error' }));
        const retry = findSuggestion(suggestions, 'retry');
        expect(retry).toBeDefined();
        expect(retry!.confidence).toBe('high');
    });

    it('suggests reroute_worker with medium confidence', () => {
        const suggestions = suggester.suggest(makeContext({ category: 'worker_execution_error' }));
        const reroute = findSuggestion(suggestions, 'reroute_worker');
        expect(reroute).toBeDefined();
        expect(reroute!.confidence).toBe('medium');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Category: tool_denied
// ═══════════════════════════════════════════════════════════════════════════════

describe('RecoverySuggester — tool_denied', () => {
    const suggester = new RecoverySuggester();

    it('suggests edit_success_criteria with medium confidence', () => {
        const suggestions = suggester.suggest(makeContext({ category: 'tool_denied' }));
        const edit = findSuggestion(suggestions, 'edit_success_criteria');
        expect(edit).toBeDefined();
        expect(edit!.confidence).toBe('medium');
    });

    it('suggests skip with low confidence', () => {
        const suggestions = suggester.suggest(makeContext({ category: 'tool_denied' }));
        const skip = findSuggestion(suggestions, 'skip');
        expect(skip).toBeDefined();
        expect(skip!.confidence).toBe('low');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Category: tool_invocation_error
// ═══════════════════════════════════════════════════════════════════════════════

describe('RecoverySuggester — tool_invocation_error', () => {
    const suggester = new RecoverySuggester();

    it('suggests retry with high confidence', () => {
        const suggestions = suggester.suggest(makeContext({ category: 'tool_invocation_error' }));
        const retry = findSuggestion(suggestions, 'retry');
        expect(retry).toBeDefined();
        expect(retry!.confidence).toBe('high');
    });

    it('suggests inspect_repair_prompt with medium confidence', () => {
        const suggestions = suggester.suggest(makeContext({ category: 'tool_invocation_error' }));
        const inspect = findSuggestion(suggestions, 'inspect_repair_prompt');
        expect(inspect).toBeDefined();
        expect(inspect!.confidence).toBe('medium');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Category: context_budget_exceeded
// ═══════════════════════════════════════════════════════════════════════════════

describe('RecoverySuggester — context_budget_exceeded', () => {
    const suggester = new RecoverySuggester();

    it('suggests retry_with_more_context with high confidence', () => {
        const suggestions = suggester.suggest(
            makeContext({ category: 'context_budget_exceeded' }),
        );
        const retryCtx = findSuggestion(suggestions, 'retry_with_more_context');
        expect(retryCtx).toBeDefined();
        expect(retryCtx!.confidence).toBe('high');
    });

    it('suggests edit_success_criteria with medium confidence', () => {
        const suggestions = suggester.suggest(
            makeContext({ category: 'context_budget_exceeded' }),
        );
        const edit = findSuggestion(suggestions, 'edit_success_criteria');
        expect(edit).toBeDefined();
        expect(edit!.confidence).toBe('medium');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Category: context_assembly_error
// ═══════════════════════════════════════════════════════════════════════════════

describe('RecoverySuggester — context_assembly_error', () => {
    const suggester = new RecoverySuggester();

    it('suggests retry with medium confidence', () => {
        const suggestions = suggester.suggest(makeContext({ category: 'context_assembly_error' }));
        const retry = findSuggestion(suggestions, 'retry');
        expect(retry).toBeDefined();
        expect(retry!.confidence).toBe('medium');
    });

    it('suggests inspect_repair_prompt with medium confidence', () => {
        const suggestions = suggester.suggest(makeContext({ category: 'context_assembly_error' }));
        const inspect = findSuggestion(suggestions, 'inspect_repair_prompt');
        expect(inspect).toBeDefined();
        expect(inspect!.confidence).toBe('medium');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Category: evaluation_rejection
// ═══════════════════════════════════════════════════════════════════════════════

describe('RecoverySuggester — evaluation_rejection', () => {
    const suggester = new RecoverySuggester();

    it('suggests edit_success_criteria with high confidence', () => {
        const suggestions = suggester.suggest(makeContext({ category: 'evaluation_rejection' }));
        const edit = findSuggestion(suggestions, 'edit_success_criteria');
        expect(edit).toBeDefined();
        expect(edit!.confidence).toBe('high');
    });

    it('suggests retry with medium confidence', () => {
        const suggestions = suggester.suggest(makeContext({ category: 'evaluation_rejection' }));
        const retry = findSuggestion(suggestions, 'retry');
        expect(retry).toBeDefined();
        expect(retry!.confidence).toBe('medium');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Category: timeout
// ═══════════════════════════════════════════════════════════════════════════════

describe('RecoverySuggester — timeout', () => {
    const suggester = new RecoverySuggester();

    it('suggests retry with medium confidence', () => {
        const suggestions = suggester.suggest(makeContext({ category: 'timeout' }));
        const retry = findSuggestion(suggestions, 'retry');
        expect(retry).toBeDefined();
        expect(retry!.confidence).toBe('medium');
    });

    it('suggests reroute_worker with medium confidence', () => {
        const suggestions = suggester.suggest(makeContext({ category: 'timeout' }));
        const reroute = findSuggestion(suggestions, 'reroute_worker');
        expect(reroute).toBeDefined();
        expect(reroute!.confidence).toBe('medium');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Category: dependency_failure
// ═══════════════════════════════════════════════════════════════════════════════

describe('RecoverySuggester — dependency_failure', () => {
    const suggester = new RecoverySuggester();

    it('suggests skip with low confidence', () => {
        const suggestions = suggester.suggest(makeContext({ category: 'dependency_failure' }));
        const skip = findSuggestion(suggestions, 'skip');
        expect(skip).toBeDefined();
        expect(skip!.confidence).toBe('low');
    });

    it('suggests inspect_repair_prompt with low confidence', () => {
        const suggestions = suggester.suggest(makeContext({ category: 'dependency_failure' }));
        const inspect = findSuggestion(suggestions, 'inspect_repair_prompt');
        expect(inspect).toBeDefined();
        expect(inspect!.confidence).toBe('low');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Category: mcp_contract_error
// ═══════════════════════════════════════════════════════════════════════════════

describe('RecoverySuggester — mcp_contract_error', () => {
    const suggester = new RecoverySuggester();

    it('suggests retry with medium confidence', () => {
        const suggestions = suggester.suggest(makeContext({ category: 'mcp_contract_error' }));
        const retry = findSuggestion(suggestions, 'retry');
        expect(retry).toBeDefined();
        expect(retry!.confidence).toBe('medium');
    });

    it('suggests inspect_repair_prompt with high confidence', () => {
        const suggestions = suggester.suggest(makeContext({ category: 'mcp_contract_error' }));
        const inspect = findSuggestion(suggestions, 'inspect_repair_prompt');
        expect(inspect).toBeDefined();
        expect(inspect!.confidence).toBe('high');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Category: plugin_failure
// ═══════════════════════════════════════════════════════════════════════════════

describe('RecoverySuggester — plugin_failure', () => {
    const suggester = new RecoverySuggester();

    it('suggests retry with low confidence', () => {
        const suggestions = suggester.suggest(makeContext({ category: 'plugin_failure' }));
        const retry = findSuggestion(suggestions, 'retry');
        expect(retry).toBeDefined();
        expect(retry!.confidence).toBe('low');
    });

    it('suggests inspect_repair_prompt with medium confidence', () => {
        const suggestions = suggester.suggest(makeContext({ category: 'plugin_failure' }));
        const inspect = findSuggestion(suggestions, 'inspect_repair_prompt');
        expect(inspect).toBeDefined();
        expect(inspect!.confidence).toBe('medium');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Category: unknown
// ═══════════════════════════════════════════════════════════════════════════════

describe('RecoverySuggester — unknown', () => {
    const suggester = new RecoverySuggester();

    it('suggests inspect_repair_prompt with medium confidence', () => {
        const suggestions = suggester.suggest(makeContext({ category: 'unknown' }));
        const inspect = findSuggestion(suggestions, 'inspect_repair_prompt');
        expect(inspect).toBeDefined();
        expect(inspect!.confidence).toBe('medium');
    });

    it('suggests retry with low confidence', () => {
        const suggestions = suggester.suggest(makeContext({ category: 'unknown' }));
        const retry = findSuggestion(suggestions, 'retry');
        expect(retry).toBeDefined();
        expect(retry!.confidence).toBe('low');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Categories not in rule table (success_criteria_mismatch, scheduler_stall, planner_invalid_output)
// ═══════════════════════════════════════════════════════════════════════════════

describe('RecoverySuggester — categories without explicit rules', () => {
    const suggester = new RecoverySuggester();

    it('returns at least inspect_repair_prompt for success_criteria_mismatch', () => {
        const suggestions = suggester.suggest(
            makeContext({ category: 'success_criteria_mismatch' }),
        );
        expect(suggestions.length).toBeGreaterThan(0);
        const inspect = findSuggestion(suggestions, 'inspect_repair_prompt');
        expect(inspect).toBeDefined();
    });

    it('returns at least inspect_repair_prompt for scheduler_stall', () => {
        const suggestions = suggester.suggest(makeContext({ category: 'scheduler_stall' }));
        expect(suggestions.length).toBeGreaterThan(0);
        const inspect = findSuggestion(suggestions, 'inspect_repair_prompt');
        expect(inspect).toBeDefined();
    });

    it('returns at least inspect_repair_prompt for planner_invalid_output', () => {
        const suggestions = suggester.suggest(
            makeContext({ category: 'planner_invalid_output' }),
        );
        expect(suggestions.length).toBeGreaterThan(0);
        const inspect = findSuggestion(suggestions, 'inspect_repair_prompt');
        expect(inspect).toBeDefined();
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Edge cases
// ═══════════════════════════════════════════════════════════════════════════════

describe('RecoverySuggester — edge cases', () => {
    const suggester = new RecoverySuggester();

    it('produces unique action types (no duplicates) per suggestion set', () => {
        const categories: FailureCategory[] = [
            'worker_execution_error',
            'tool_denied',
            'tool_invocation_error',
            'context_budget_exceeded',
            'context_assembly_error',
            'evaluation_rejection',
            'timeout',
            'dependency_failure',
            'mcp_contract_error',
            'plugin_failure',
            'unknown',
            'success_criteria_mismatch',
            'scheduler_stall',
            'planner_invalid_output',
        ];
        for (const category of categories) {
            const suggestions = suggester.suggest(makeContext({ category }));
            const actions = suggestions.map((s) => s.action);
            const uniqueActions = new Set(actions);
            expect(uniqueActions.size).toBe(actions.length);
        }
    });

    it('handles empty evidence gracefully', () => {
        const suggestions = suggester.suggest(makeContext({ evidence: {} }));
        expect(suggestions.length).toBeGreaterThan(0);
    });

    it('handles full evidence gracefully', () => {
        const suggestions = suggester.suggest(
            makeContext({
                evidence: {
                    latestWorkerOutput: 'some output',
                    latestErrorText: 'Error: something went wrong',
                    contextBudget: { tokenLimit: 1000, estimatedUsed: 900, remaining: 100 },
                    toolActions: [
                        { toolId: 'tool-1', outcome: 'failure', timestamp: Date.now() },
                    ],
                    successCriteria: ['Must pass all tests'],
                    contextManifestRef: 'manifest-123',
                    repairPromptRef: 'prompt-456',
                },
            }),
        );
        expect(suggestions.length).toBeGreaterThan(0);
    });

    it('returns same suggestions for same context (deterministic)', () => {
        const ctx = makeContext({ category: 'timeout' });
        const first = suggester.suggest(ctx);
        const second = suggester.suggest(ctx);
        expect(first).toEqual(second);
    });

    it('all returned actions are valid RecoveryActionType values', () => {
        const validActions: RecoveryActionType[] = [
            'retry',
            'retry_with_more_context',
            'edit_success_criteria',
            'skip',
            'reroute_worker',
            'inspect_repair_prompt',
        ];
        const categories: FailureCategory[] = [
            'worker_execution_error',
            'tool_denied',
            'tool_invocation_error',
            'context_budget_exceeded',
            'context_assembly_error',
            'evaluation_rejection',
            'timeout',
            'dependency_failure',
            'mcp_contract_error',
            'plugin_failure',
            'unknown',
        ];
        for (const category of categories) {
            const suggestions = suggester.suggest(makeContext({ category }));
            for (const s of suggestions) {
                expect(validActions).toContain(s.action);
            }
        }
    });
});
