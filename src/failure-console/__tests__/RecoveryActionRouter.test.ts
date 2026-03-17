// ─────────────────────────────────────────────────────────────────────────────
// src/failure-console/__tests__/RecoveryActionRouter.test.ts
// ─────────────────────────────────────────────────────────────────────────────

import { RecoveryActionRouter, type ActionLegalityContext, type ActionLegalityResult } from '../RecoveryActionRouter.js';
import type { RecoveryActionType, SuggestedRecoveryAction } from '../../types/failure-console.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Factory for a valid baseline context where all actions are expected to be
 * enabled. Override individual fields to test specific disabling conditions.
 */
function makeContext(overrides: Partial<ActionLegalityContext> = {}): ActionLegalityContext {
    return {
        engineState: 'ERROR_PAUSED',
        phaseStatus: 'failed',
        phaseId: 1,
        hasDownstreamDependents: false,
        isCriticalPhase: false,
        availableWorkerCount: 3,
        failureCategory: 'worker_execution_error',
        failureSeverity: 'recoverable',
        currentRetryCount: 0,
        maxRetries: 3,
        ...overrides,
    };
}

function makeSuggestion(overrides: Partial<SuggestedRecoveryAction> = {}): SuggestedRecoveryAction {
    return {
        action: 'retry',
        title: 'Retry the phase',
        rationale: 'Transient error may resolve on retry',
        confidence: 'medium',
        ...overrides,
    };
}

/** Helper to find a specific action in the results. */
function findResult(results: ActionLegalityResult[], action: RecoveryActionType): ActionLegalityResult {
    const found = results.find((r) => r.action === action);
    if (!found) {
        throw new Error(`Action ${action} not found in results`);
    }
    return found;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  validateAll — Structure & completeness
// ═══════════════════════════════════════════════════════════════════════════════

describe('RecoveryActionRouter — validateAll', () => {
    const router = new RecoveryActionRouter();

    it('returns results for all six standard action types', () => {
        const results = router.validateAll(makeContext());
        const actions = results.map((r) => r.action);

        expect(actions).toContain('retry');
        expect(actions).toContain('retry_with_more_context');
        expect(actions).toContain('edit_success_criteria');
        expect(actions).toContain('skip');
        expect(actions).toContain('reroute_worker');
        expect(actions).toContain('inspect_repair_prompt');
        expect(results).toHaveLength(6);
    });

    it('enables all actions in the baseline context', () => {
        const results = router.validateAll(makeContext());
        for (const result of results) {
            expect(result.availability).toBe('enabled');
            expect(result.disabledReason).toBeUndefined();
        }
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  retry — Legality rules
// ═══════════════════════════════════════════════════════════════════════════════

describe('RecoveryActionRouter — retry', () => {
    const router = new RecoveryActionRouter();

    it('enabled when retries remain and engine is ERROR_PAUSED', () => {
        const result = router.validate('retry', makeContext());
        expect(result.availability).toBe('enabled');
    });

    it('disabled when currentRetryCount >= maxRetries', () => {
        const result = router.validate('retry', makeContext({ currentRetryCount: 3, maxRetries: 3 }));
        expect(result.availability).toBe('disabled');
        expect(result.disabledReason).toContain('Retry limit reached');
    });

    it('disabled when currentRetryCount exceeds maxRetries', () => {
        const result = router.validate('retry', makeContext({ currentRetryCount: 5, maxRetries: 3 }));
        expect(result.availability).toBe('disabled');
        expect(result.disabledReason).toContain('Retry limit reached');
    });

    it('disabled when engine is not ERROR_PAUSED', () => {
        const result = router.validate('retry', makeContext({ engineState: 'RUNNING' }));
        expect(result.availability).toBe('disabled');
        expect(result.disabledReason).toContain('not in ERROR_PAUSED');
    });

    it('checks retry limit before engine state', () => {
        const result = router.validate('retry', makeContext({
            currentRetryCount: 3,
            maxRetries: 3,
            engineState: 'RUNNING',
        }));
        // Retry limit is checked first
        expect(result.disabledReason).toContain('Retry limit reached');
    });

    it('disabled when maxRetries is 0', () => {
        const result = router.validate('retry', makeContext({ currentRetryCount: 0, maxRetries: 0 }));
        expect(result.availability).toBe('disabled');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  retry_with_more_context — Legality rules
// ═══════════════════════════════════════════════════════════════════════════════

describe('RecoveryActionRouter — retry_with_more_context', () => {
    const router = new RecoveryActionRouter();

    it('enabled for standard failure categories', () => {
        const result = router.validate('retry_with_more_context', makeContext());
        expect(result.availability).toBe('enabled');
    });

    it('disabled when failure category is tool_denied', () => {
        const result = router.validate('retry_with_more_context', makeContext({
            failureCategory: 'tool_denied',
        }));
        expect(result.availability).toBe('disabled');
        expect(result.disabledReason).toContain('tool_denied');
        expect(result.disabledReason).toContain('irrelevant');
    });

    it('disabled when failure category is plugin_failure', () => {
        const result = router.validate('retry_with_more_context', makeContext({
            failureCategory: 'plugin_failure',
        }));
        expect(result.availability).toBe('disabled');
        expect(result.disabledReason).toContain('plugin_failure');
    });

    it('disabled when retry limit reached', () => {
        const result = router.validate('retry_with_more_context', makeContext({
            currentRetryCount: 3,
            maxRetries: 3,
        }));
        expect(result.availability).toBe('disabled');
        expect(result.disabledReason).toContain('Retry limit reached');
    });

    it('checks failure category before retry limit', () => {
        const result = router.validate('retry_with_more_context', makeContext({
            failureCategory: 'tool_denied',
            currentRetryCount: 5,
            maxRetries: 3,
        }));
        // Category check is first
        expect(result.disabledReason).toContain('irrelevant');
    });

    it('enabled for context_budget_exceeded category', () => {
        const result = router.validate('retry_with_more_context', makeContext({
            failureCategory: 'context_budget_exceeded',
        }));
        expect(result.availability).toBe('enabled');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  edit_success_criteria — Legality rules
// ═══════════════════════════════════════════════════════════════════════════════

describe('RecoveryActionRouter — edit_success_criteria', () => {
    const router = new RecoveryActionRouter();

    it('enabled when phase status is failed', () => {
        const result = router.validate('edit_success_criteria', makeContext({ phaseStatus: 'failed' }));
        expect(result.availability).toBe('enabled');
    });

    it('disabled when phase status is not failed', () => {
        const result = router.validate('edit_success_criteria', makeContext({ phaseStatus: 'running' }));
        expect(result.availability).toBe('disabled');
        expect(result.disabledReason).toContain('not in failed state');
    });

    it('disabled when phase status is pending', () => {
        const result = router.validate('edit_success_criteria', makeContext({ phaseStatus: 'pending' }));
        expect(result.availability).toBe('disabled');
    });

    it('disabled when phase status is completed', () => {
        const result = router.validate('edit_success_criteria', makeContext({ phaseStatus: 'completed' }));
        expect(result.availability).toBe('disabled');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  skip — Legality rules
// ═══════════════════════════════════════════════════════════════════════════════

describe('RecoveryActionRouter — skip', () => {
    const router = new RecoveryActionRouter();

    it('enabled when phase has no downstream dependents', () => {
        const result = router.validate('skip', makeContext({ hasDownstreamDependents: false }));
        expect(result.availability).toBe('enabled');
    });

    it('enabled when phase is not critical', () => {
        const result = router.validate('skip', makeContext({
            hasDownstreamDependents: true,
            isCriticalPhase: false,
        }));
        expect(result.availability).toBe('enabled');
    });

    it('disabled when phase has downstream dependents AND is critical', () => {
        const result = router.validate('skip', makeContext({
            hasDownstreamDependents: true,
            isCriticalPhase: true,
        }));
        expect(result.availability).toBe('disabled');
        expect(result.disabledReason).toContain('critical phase');
        expect(result.disabledReason).toContain('downstream');
    });

    it('enabled when phase is critical but has NO downstream dependents', () => {
        const result = router.validate('skip', makeContext({
            hasDownstreamDependents: false,
            isCriticalPhase: true,
        }));
        expect(result.availability).toBe('enabled');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  reroute_worker — Legality rules
// ═══════════════════════════════════════════════════════════════════════════════

describe('RecoveryActionRouter — reroute_worker', () => {
    const router = new RecoveryActionRouter();

    it('enabled when multiple workers are available', () => {
        const result = router.validate('reroute_worker', makeContext({ availableWorkerCount: 2 }));
        expect(result.availability).toBe('enabled');
    });

    it('disabled when only one worker is available', () => {
        const result = router.validate('reroute_worker', makeContext({ availableWorkerCount: 1 }));
        expect(result.availability).toBe('disabled');
        expect(result.disabledReason).toContain('No alternative workers');
    });

    it('disabled when zero workers are available', () => {
        const result = router.validate('reroute_worker', makeContext({ availableWorkerCount: 0 }));
        expect(result.availability).toBe('disabled');
    });

    it('enabled when many workers are available', () => {
        const result = router.validate('reroute_worker', makeContext({ availableWorkerCount: 10 }));
        expect(result.availability).toBe('enabled');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  inspect_repair_prompt — Always enabled
// ═══════════════════════════════════════════════════════════════════════════════

describe('RecoveryActionRouter — inspect_repair_prompt', () => {
    const router = new RecoveryActionRouter();

    it('always enabled regardless of context', () => {
        const result = router.validate('inspect_repair_prompt', makeContext());
        expect(result.availability).toBe('enabled');
    });

    it('enabled even when engine is not ERROR_PAUSED', () => {
        const result = router.validate('inspect_repair_prompt', makeContext({ engineState: 'RUNNING' }));
        expect(result.availability).toBe('enabled');
    });

    it('enabled even when retries exhausted', () => {
        const result = router.validate('inspect_repair_prompt', makeContext({
            currentRetryCount: 10,
            maxRetries: 3,
        }));
        expect(result.availability).toBe('enabled');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  filterSuggestions — Integration with validate
// ═══════════════════════════════════════════════════════════════════════════════

describe('RecoveryActionRouter — filterSuggestions', () => {
    const router = new RecoveryActionRouter();

    it('returns suggestions unchanged when all are legal', () => {
        const suggestions = [
            makeSuggestion({ action: 'retry' }),
            makeSuggestion({ action: 'skip' }),
        ];
        const filtered = router.filterSuggestions(suggestions, makeContext());
        expect(filtered).toHaveLength(2);
        expect(filtered[0]!.rationale).not.toContain('[Disabled');
        expect(filtered[1]!.rationale).not.toContain('[Disabled');
    });

    it('annotates disabled suggestions with reason in rationale', () => {
        const suggestions = [
            makeSuggestion({ action: 'retry', rationale: 'Try again' }),
        ];
        const ctx = makeContext({ currentRetryCount: 3, maxRetries: 3 });
        const filtered = router.filterSuggestions(suggestions, ctx);

        expect(filtered).toHaveLength(1);
        expect(filtered[0]!.rationale).toContain('[Disabled');
        expect(filtered[0]!.rationale).toContain('Retry limit reached');
        expect(filtered[0]!.rationale).toContain('Try again');
    });

    it('handles mixed enabled/disabled suggestions', () => {
        const suggestions = [
            makeSuggestion({ action: 'retry' }),
            makeSuggestion({ action: 'inspect_repair_prompt' }),
            makeSuggestion({ action: 'reroute_worker' }),
        ];
        const ctx = makeContext({
            currentRetryCount: 5,
            maxRetries: 3,
            availableWorkerCount: 1,
        });
        const filtered = router.filterSuggestions(suggestions, ctx);

        // retry should be disabled
        expect(filtered[0]!.rationale).toContain('[Disabled');
        // inspect_repair_prompt always enabled
        expect(filtered[1]!.rationale).not.toContain('[Disabled');
        // reroute_worker disabled (only 1 worker)
        expect(filtered[2]!.rationale).toContain('[Disabled');
    });

    it('preserves suggestion properties for enabled actions', () => {
        const original = makeSuggestion({
            action: 'skip',
            title: 'Skip this phase',
            rationale: 'Non-essential work',
            confidence: 'high',
        });
        const filtered = router.filterSuggestions([original], makeContext());

        expect(filtered[0]).toEqual(original);
    });

    it('returns empty array for empty suggestions', () => {
        const filtered = router.filterSuggestions([], makeContext());
        expect(filtered).toEqual([]);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Edge cases & combined conditions
// ═══════════════════════════════════════════════════════════════════════════════

describe('RecoveryActionRouter — edge cases', () => {
    const router = new RecoveryActionRouter();

    it('multiple actions disabled simultaneously', () => {
        const ctx = makeContext({
            engineState: 'RUNNING',
            phaseStatus: 'running',
            currentRetryCount: 5,
            maxRetries: 3,
            hasDownstreamDependents: true,
            isCriticalPhase: true,
            availableWorkerCount: 0,
            failureCategory: 'tool_denied',
        });
        const results = router.validateAll(ctx);

        expect(findResult(results, 'retry').availability).toBe('disabled');
        expect(findResult(results, 'retry_with_more_context').availability).toBe('disabled');
        expect(findResult(results, 'edit_success_criteria').availability).toBe('disabled');
        expect(findResult(results, 'skip').availability).toBe('disabled');
        expect(findResult(results, 'reroute_worker').availability).toBe('disabled');
        // inspect_repair_prompt is always enabled
        expect(findResult(results, 'inspect_repair_prompt').availability).toBe('enabled');
    });

    it('disabled results include a disabledReason string', () => {
        const ctx = makeContext({ currentRetryCount: 3, maxRetries: 3 });
        const result = router.validate('retry', ctx);
        expect(result.disabledReason).toBeDefined();
        expect(typeof result.disabledReason).toBe('string');
        expect(result.disabledReason!.length).toBeGreaterThan(0);
    });

    it('enabled results do not include disabledReason', () => {
        const result = router.validate('retry', makeContext());
        expect(result.disabledReason).toBeUndefined();
    });

    it('boundary: currentRetryCount exactly equals maxRetries', () => {
        const result = router.validate('retry', makeContext({
            currentRetryCount: 3,
            maxRetries: 3,
        }));
        expect(result.availability).toBe('disabled');
    });

    it('boundary: currentRetryCount one less than maxRetries', () => {
        const result = router.validate('retry', makeContext({
            currentRetryCount: 2,
            maxRetries: 3,
        }));
        expect(result.availability).toBe('enabled');
    });

    it('boundary: availableWorkerCount exactly 2 enables reroute', () => {
        const result = router.validate('reroute_worker', makeContext({
            availableWorkerCount: 2,
        }));
        expect(result.availability).toBe('enabled');
    });

    it('boundary: availableWorkerCount exactly 1 disables reroute', () => {
        const result = router.validate('reroute_worker', makeContext({
            availableWorkerCount: 1,
        }));
        expect(result.availability).toBe('disabled');
    });
});
