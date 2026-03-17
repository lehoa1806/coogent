// ─────────────────────────────────────────────────────────────────────────────
// src/failure-console/RecoveryActionRouter.ts — Recovery action legality validator
// ─────────────────────────────────────────────────────────────────────────────

import type {
    RecoveryActionType,
    SuggestedRecoveryAction,
} from '../types/failure-console.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Public Interfaces
// ═══════════════════════════════════════════════════════════════════════════════

/** Runtime context required to evaluate whether a recovery action is legal. */
export interface ActionLegalityContext {
    /** Current engine state (e.g. 'ERROR_PAUSED', 'RUNNING', 'IDLE'). */
    engineState: string;
    /** Current phase status (e.g. 'failed', 'pending', 'running'). */
    phaseStatus: string;
    /** Numeric phase identifier. */
    phaseId: number;
    /** Whether this phase has downstream dependents in the DAG. */
    hasDownstreamDependents: boolean;
    /** Whether this phase is marked as critical in the DAG. */
    isCriticalPhase: boolean;
    /** Number of workers currently available for assignment. */
    availableWorkerCount: number;
    /** Deterministic failure category from FailureClassifier. */
    failureCategory: string;
    /** Failure severity level. */
    failureSeverity: string;
    /** Number of retries already attempted for this phase. */
    currentRetryCount: number;
    /** Maximum retries allowed by policy. */
    maxRetries: number;
}

/** Result of evaluating a single recovery action's legality. */
export interface ActionLegalityResult {
    /** The recovery action that was evaluated. */
    action: RecoveryActionType;
    /** Whether the action is currently available. */
    availability: 'enabled' | 'disabled';
    /** Human-readable reason the action is disabled (only set when disabled). */
    disabledReason?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  All standard recovery action types
// ═══════════════════════════════════════════════════════════════════════════════

const ALL_ACTIONS: readonly RecoveryActionType[] = [
    'retry',
    'retry_with_more_context',
    'edit_success_criteria',
    'skip',
    'reroute_worker',
    'inspect_repair_prompt',
] as const;

// ═══════════════════════════════════════════════════════════════════════════════
//  RecoveryActionRouter
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Pure-logic module that validates whether a given recovery action is legal
 * in the current runtime state. No side-effects, no dependencies on model
 * or UI — designed for deterministic unit testing.
 */
export class RecoveryActionRouter {
    /**
     * Validate all standard recovery actions against the current runtime context.
     * Returns an {@link ActionLegalityResult} for each action type.
     */
    validateAll(ctx: ActionLegalityContext): ActionLegalityResult[] {
        return ALL_ACTIONS.map((action) => this.validate(action, ctx));
    }

    /**
     * Validate a single recovery action against the current runtime context.
     */
    validate(action: RecoveryActionType, ctx: ActionLegalityContext): ActionLegalityResult {
        const disabledReason = this.evaluateRule(action, ctx);
        if (disabledReason) {
            return { action, availability: 'disabled', disabledReason };
        }
        return { action, availability: 'enabled' };
    }

    /**
     * Filter a list of model-suggested recovery actions, annotating each with
     * availability and an optional disabledReason. Suggestions whose action
     * type is disabled will have `availability: 'disabled'` but are **not**
     * removed — the UI may still display them in a greyed-out state.
     */
    filterSuggestions(
        suggestions: SuggestedRecoveryAction[],
        ctx: ActionLegalityContext,
    ): SuggestedRecoveryAction[] {
        return suggestions.map((suggestion) => {
            const result = this.validate(suggestion.action, ctx);
            if (result.availability === 'disabled') {
                return {
                    ...suggestion,
                    // Spread the disabled reason into the suggestion so the UI
                    // can show why the suggestion is unavailable.
                    rationale: `[Disabled: ${result.disabledReason}] ${suggestion.rationale}`,
                } as SuggestedRecoveryAction;
            }
            return suggestion;
        });
    }

    // ─── Private rule evaluation ─────────────────────────────────────────

    /**
     * Evaluate a single action's legality rule. Returns a disabled reason
     * string if the action is illegal, or `undefined` if it is legal.
     */
    private evaluateRule(action: RecoveryActionType, ctx: ActionLegalityContext): string | undefined {
        switch (action) {
            case 'retry':
                return this.evaluateRetry(ctx);
            case 'retry_with_more_context':
                return this.evaluateRetryWithMoreContext(ctx);
            case 'edit_success_criteria':
                return this.evaluateEditSuccessCriteria(ctx);
            case 'skip':
                return this.evaluateSkip(ctx);
            case 'reroute_worker':
                return this.evaluateRerouteWorker(ctx);
            case 'inspect_repair_prompt':
                return undefined; // Always enabled
            default:
                return undefined;
        }
    }

    /**
     * retry: disabled if currentRetryCount >= maxRetries, or if engine
     * is not in ERROR_PAUSED state.
     */
    private evaluateRetry(ctx: ActionLegalityContext): string | undefined {
        if (ctx.currentRetryCount >= ctx.maxRetries) {
            return `Retry limit reached (${ctx.currentRetryCount}/${ctx.maxRetries})`;
        }
        if (ctx.engineState !== 'ERROR_PAUSED') {
            return `Engine is not in ERROR_PAUSED state (current: ${ctx.engineState})`;
        }
        return undefined;
    }

    /**
     * retry_with_more_context: disabled if failure category is tool_denied
     * or plugin_failure (context is irrelevant), or same retry limit check.
     */
    private evaluateRetryWithMoreContext(ctx: ActionLegalityContext): string | undefined {
        if (ctx.failureCategory === 'tool_denied' || ctx.failureCategory === 'plugin_failure') {
            return `Additional context is irrelevant for ${ctx.failureCategory} failures`;
        }
        if (ctx.currentRetryCount >= ctx.maxRetries) {
            return `Retry limit reached (${ctx.currentRetryCount}/${ctx.maxRetries})`;
        }
        return undefined;
    }

    /**
     * edit_success_criteria: always enabled when phase is failed.
     */
    private evaluateEditSuccessCriteria(ctx: ActionLegalityContext): string | undefined {
        if (ctx.phaseStatus !== 'failed') {
            return `Phase is not in failed state (current: ${ctx.phaseStatus})`;
        }
        return undefined;
    }

    /**
     * skip: disabled if hasDownstreamDependents && isCriticalPhase.
     */
    private evaluateSkip(ctx: ActionLegalityContext): string | undefined {
        if (ctx.hasDownstreamDependents && ctx.isCriticalPhase) {
            return 'Cannot skip a critical phase with downstream dependents';
        }
        return undefined;
    }

    /**
     * reroute_worker: disabled if availableWorkerCount <= 1.
     */
    private evaluateRerouteWorker(ctx: ActionLegalityContext): string | undefined {
        if (ctx.availableWorkerCount <= 1) {
            return `No alternative workers available (count: ${ctx.availableWorkerCount})`;
        }
        return undefined;
    }
}
