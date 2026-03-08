// ─────────────────────────────────────────────────────────────────────────────
// src/agent-selection/WorkerResultHandler.ts — Post-execution result handler
// ─────────────────────────────────────────────────────────────────────────────

import type { WorkerRunResult, RecoveryAction, AgentType } from './types.js';

/**
 * Inspects {@link WorkerRunResult} fit assessments and determines recovery
 * actions for the orchestrator. Centralizes the decision logic that maps a
 * worker's self-reported outcome into an actionable {@link RecoveryAction}.
 */
export class WorkerResultHandler {
    /**
     * Determine the appropriate recovery action based on a worker's run result.
     *
     * Decision logic (evaluated in order — first match wins):
     * 1. `status === 'completed'` and `confidence >= 0.7` and no mismatch → `'accept'`
     * 2. `status === 'completed'` but `confidence < 0.7` → `'accept'` (low-confidence; log warnings)
     * 3. `status === 'blocked'` and `context_sufficiency === 'insufficient'` and no mismatch → `'enrich_context'`
     * 4. `agent_mismatch === true` → `'reassign'`
     * 5. `status === 'blocked'` and `context_sufficiency === 'insufficient'` and mismatch → `'reassign'`
     * 6. `status === 'failed'` → `'escalate_to_planner'`
     * 7. Default → `'escalate_to_planner'`
     */
    handle(result: WorkerRunResult): RecoveryAction {
        const { status, confidence, fit_assessment } = result;
        const { agent_mismatch, context_sufficiency } = fit_assessment;

        // 1. Clean completion with acceptable confidence
        if (status === 'completed' && confidence >= 0.7 && !agent_mismatch) {
            return 'accept';
        }

        // 2. Completed but low confidence — still accept, caller should log warnings
        if (status === 'completed') {
            return 'accept';
        }

        // 3. Blocked due to insufficient context, but agent type was correct
        if (
            status === 'blocked' &&
            context_sufficiency === 'insufficient' &&
            !agent_mismatch
        ) {
            return 'enrich_context';
        }

        // 4. Agent mismatch detected (regardless of status)
        if (agent_mismatch) {
            return 'reassign';
        }

        // 5. Blocked with insufficient context AND mismatch (already caught by #4,
        //    but kept for explicitness in case ordering changes)
        if (
            status === 'blocked' &&
            context_sufficiency === 'insufficient' &&
            agent_mismatch
        ) {
            return 'reassign';
        }

        // 6. Hard failure
        if (status === 'failed') {
            return 'escalate_to_planner';
        }

        // 7. Catch-all
        return 'escalate_to_planner';
    }

    /**
     * Extract the recommended reassignment target from the worker's fit
     * assessment, if one was reported.
     *
     * @returns The recommended {@link AgentType} to reassign to, or `null` if
     *          no recommendation was provided.
     */
    getReassignmentTarget(result: WorkerRunResult): AgentType | null {
        return result.fit_assessment.recommended_reassignment ?? null;
    }

    /**
     * Check whether the result indicates a successful, high-confidence
     * completion with no fit issues.
     *
     * Criteria (all must hold):
     * - `status === 'completed'`
     * - `confidence >= 0.8`
     * - `task_fit === 'good'`
     * - `agent_mismatch === false`
     */
    isCleanSuccess(result: WorkerRunResult): boolean {
        return (
            result.status === 'completed' &&
            result.confidence >= 0.8 &&
            result.fit_assessment.task_fit === 'good' &&
            !result.fit_assessment.agent_mismatch
        );
    }
}
