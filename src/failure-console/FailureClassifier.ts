// ─────────────────────────────────────────────────────────────────────────────
// src/failure-console/FailureClassifier.ts — Deterministic failure classification
// ─────────────────────────────────────────────────────────────────────────────

import type {
    FailureSeverity,
    FailureScope,
    FailureCategory,
    FailurePacket,
} from '../types/failure-console.js';
import type { ErrorCode } from '../types/ipc.js';

/**
 * The output of the classification step — a normalized severity / scope /
 * category triple plus an optional root-event pointer and human message.
 */
export interface ClassifiedFailure {
    /** Severity classification assigned to this failure. */
    readonly severity: FailureSeverity;
    /** Scope at which the failure applies. */
    readonly scope: FailureScope;
    /** Deterministic category for this failure. */
    readonly category: FailureCategory;
    /** Event ID of the identified root cause (if determined). */
    readonly rootEventId?: string;
    /** Human-readable failure message. */
    readonly message: string;
}

/**
 * Static classification mapping entry for a known {@link ErrorCode}.
 */
interface ClassificationRule {
    readonly category: FailureCategory;
    readonly severity: FailureSeverity;
    readonly scope: FailureScope;
}

/**
 * Deterministic mapping from {@link ErrorCode} to classification triples.
 * Every known error code that can be classified without inspecting the packet
 * timeline is listed here.
 */
const ERROR_CODE_MAP: Readonly<Record<string, ClassificationRule>> = {
    WORKER_TIMEOUT: { category: 'timeout', severity: 'recoverable', scope: 'worker' },
    WORKER_CRASH: { category: 'worker_execution_error', severity: 'hard_failure', scope: 'worker' },
    PHASE_FAILED: { category: 'worker_execution_error', severity: 'recoverable', scope: 'phase' },
    TOKEN_OVER_BUDGET: { category: 'context_budget_exceeded', severity: 'recoverable', scope: 'context' },
    CONTEXT_ERROR: { category: 'context_assembly_error', severity: 'recoverable', scope: 'context' },
    VALIDATION_ERROR: { category: 'success_criteria_mismatch', severity: 'recoverable', scope: 'phase' },
    PLAN_ERROR: { category: 'planner_invalid_output', severity: 'hard_failure', scope: 'run' },
    CYCLE_DETECTED: { category: 'scheduler_stall', severity: 'hard_failure', scope: 'run' },
    COMMAND_ERROR: { category: 'tool_invocation_error', severity: 'recoverable', scope: 'tool' },
};

/**
 * Pure, stateless classifier that maps an {@link ErrorCode} (or runtime
 * packet signals) to a deterministic {@link ClassifiedFailure}.
 *
 * Classification is intentionally free of side-effects so that it can be
 * tested in isolation and composed freely in higher-level assemblers.
 */
export class FailureClassifier {
    /**
     * Classify a failure packet into a normalized severity / scope / category
     * triple.
     *
     * @param packet    The runtime failure packet containing timeline events.
     * @param errorCode Optional error code from the engine error path.
     * @returns A fully classified failure record.
     */
    classify(packet: FailurePacket, errorCode?: ErrorCode): ClassifiedFailure {
        const rootEventId = this.resolveRootEvent(packet);

        // ── Fast path: known error code ──────────────────────────────────
        if (errorCode && errorCode in ERROR_CODE_MAP) {
            const rule = ERROR_CODE_MAP[errorCode]!;
            return {
                severity: rule.severity,
                scope: rule.scope,
                category: rule.category,
                ...(rootEventId !== undefined ? { rootEventId } : {}),
                message: this.buildMessage(rule.category, packet),
            };
        }

        // ── Slow path: infer from timeline events ────────────────────────
        const inferred = this.inferFromTimeline(packet);
        return {
            severity: inferred.severity,
            scope: inferred.scope,
            category: inferred.category,
            ...(rootEventId !== undefined ? { rootEventId } : {}),
            message: this.buildMessage(inferred.category, packet),
        };
    }

    // ─── Private helpers ─────────────────────────────────────────────────

    /**
     * Resolve the root-cause event ID from the packet timeline.
     *
     * The root event is the **first** timeline event with
     * `isRootCandidate === true`. If no event is marked as a root candidate,
     * the **last** event in the timeline is used as a fallback.
     */
    private resolveRootEvent(packet: FailurePacket): string | undefined {
        if (packet.timeline.length === 0) {
            return undefined;
        }

        const rootCandidate = packet.timeline.find((e) => e.isRootCandidate);
        if (rootCandidate) {
            return rootCandidate.eventId;
        }

        return packet.timeline[packet.timeline.length - 1]!.eventId;
    }

    /**
     * Infer category / severity / scope from timeline event sources when no
     * known error code is available.
     */
    private inferFromTimeline(packet: FailurePacket): ClassificationRule {
        // Check for tool-sourced root candidates first
        const hasToolRoot = packet.timeline.some(
            (e) => e.source === 'tool' && e.isRootCandidate,
        );
        if (hasToolRoot) {
            return { category: 'tool_invocation_error', severity: 'recoverable', scope: 'tool' };
        }

        // Check for evaluator-sourced events
        const hasEvaluator = packet.timeline.some((e) => e.source === 'evaluator');
        if (hasEvaluator) {
            return { category: 'evaluation_rejection', severity: 'recoverable', scope: 'phase' };
        }

        // Fallback: unknown
        return { category: 'unknown', severity: 'recoverable', scope: 'run' };
    }

    /**
     * Build a human-readable failure message.
     *
     * Format: `"[Category]: [context summary]"`
     */
    private buildMessage(category: FailureCategory, packet: FailurePacket): string {
        const label = category.replaceAll('_', ' ');

        // Use the latest error text if available
        if (packet.latestError) {
            return `${label}: ${packet.latestError}`;
        }

        // Fall back to the root-candidate event summary
        const rootEvent = packet.timeline.find((e) => e.isRootCandidate)
            ?? packet.timeline[packet.timeline.length - 1];
        if (rootEvent) {
            return `${label}: ${rootEvent.summary}`;
        }

        // Generic fallback
        return `${label}: failure in run ${packet.runId}`;
    }
}
