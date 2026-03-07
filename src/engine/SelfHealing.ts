// ─────────────────────────────────────────────────────────────────────────────
// src/engine/SelfHealing.ts — Auto-retry with error feedback injection
// ─────────────────────────────────────────────────────────────────────────────

import type { Phase, HealingAttempt } from '../types/index.js';
import { asPhaseId, asTimestamp } from '../types/index.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Self-Healing Controller
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Manages self-healing retry loops for failed phases.
 *
 * Strategy:
 * 1. When a phase fails, capture stderr/stdout from the failed attempt.
 * 2. Create an augmented prompt that includes the failure context.
 * 3. Spawn a new worker with the augmented prompt.
 * 4. Apply exponential backoff between retries.
 * 5. After `maxRetries`, surface the failure to the user.
 *
 * The SelfHealing controller does NOT make state transitions itself —
 * it produces healing plans that the Engine executes.
 */
export class SelfHealingController {
    private maxRetries: number;
    private readonly baseDelayMs: number;
    private readonly attempts = new Map<number, HealingAttempt[]>();

    constructor(options?: { maxRetries?: number; baseDelayMs?: number }) {
        this.maxRetries = options?.maxRetries ?? 2;
        this.baseDelayMs = options?.baseDelayMs ?? 2_000;
    }

    /**
     * Update the global max retries at runtime (called when VS Code settings change).
     * Per-phase overrides (`phase.max_retries`) still take precedence.
     */
    setMaxRetries(maxRetries: number): void {
        this.maxRetries = maxRetries;
    }

    /**
     * Record a failed attempt for a phase.
     */
    recordFailure(phaseId: number, exitCode: number, stderr: string): void {
        const existing = this.attempts.get(phaseId) ?? [];
        existing.push({
            attemptNumber: existing.length + 1,
            phaseId: asPhaseId(phaseId),
            exitCode,
            stderr,
            timestamp: asTimestamp(),
        });
        this.attempts.set(phaseId, existing);
    }

    /**
     * Lightweight retry attempt recorder.
     * Increments the retry counter for a phase without requiring
     * exit code or stderr (used when only tracking attempt count).
     */
    recordAttempt(phaseId: number): void {
        const existing = this.attempts.get(phaseId) ?? [];
        existing.push({
            attemptNumber: existing.length + 1,
            phaseId: asPhaseId(phaseId),
            exitCode: -1,
            stderr: '',
            timestamp: asTimestamp(),
        });
        this.attempts.set(phaseId, existing);
    }

    /**
     * Check if a phase can be retried (hasn't exceeded max retries).
     */
    canRetry(phaseId: number): boolean {
        const phaseMaxRetries = this.maxRetries;
        const attempts = this.attempts.get(phaseId) ?? [];
        return attempts.length < phaseMaxRetries;
    }


    /**
     * Check if a phase can be retried, respecting per-phase overrides.
     */
    canRetryWithPhase(phase: Phase): boolean {
        const limit = phase.max_retries ?? this.maxRetries;
        const attempts = this.attempts.get(phase.id) ?? [];
        return attempts.length < limit;
    }

    /**
     * Get the number of attempts for a phase.
     */
    getAttemptCount(phaseId: number): number {
        return (this.attempts.get(phaseId) ?? []).length;
    }


    /**
     * Get the delay before the next retry (exponential backoff).
     */
    getRetryDelay(phaseId: number): number {
        const attempts = this.attempts.get(phaseId) ?? [];
        const retryCount = attempts.length;
        // Exponential backoff: 2s, 4s, 8s, ...
        return this.baseDelayMs * Math.pow(2, retryCount);
    }

    /**
     * Build an augmented prompt for a retry attempt.
     * Injects the failure context from the previous attempt into the prompt.
     */
    buildHealingPrompt(phase: Phase): string {
        const attempts = this.attempts.get(phase.id) ?? [];
        const lastAttempt = attempts[attempts.length - 1];

        if (!lastAttempt) return phase.prompt;

        const retryNumber = attempts.length;
        const totalAllowed = phase.max_retries ?? this.maxRetries;

        return [
            `## Task (Retry ${retryNumber}/${totalAllowed})`,
            phase.prompt,
            ``,
            `## ⚠️ Previous Attempt Failed`,
            `The previous attempt to complete this task failed with exit code ${lastAttempt.exitCode}.`,
            ``,
            `### Error Output`,
            '```',
            lastAttempt.stderr.slice(0, 4096), // Cap error context at 4KB
            '```',
            ``,
            `## Instructions`,
            `Please analyze the error above and fix the issue. Do NOT repeat the same approach.`,
            `Focus on the root cause indicated by the error output.`,
        ].join('\n');
    }

    /**
     * Build an augmented prompt for a retry attempt using evaluator-provided context.
     * Used by V2 evaluators that produce structured `retryPrompt` in EvaluationResult.
     * Falls back to buildHealingPrompt() when no evaluator context is available.
     */
    buildHealingPromptWithContext(phase: Phase, evaluatorContext: string): string {
        const attempts = this.attempts.get(phase.id) ?? [];
        const retryNumber = attempts.length;
        const totalAllowed = phase.max_retries ?? this.maxRetries;

        return [
            `## Task (Retry ${retryNumber}/${totalAllowed})`,
            phase.prompt,
            ``,
            `## ⚠️ Previous Attempt Failed (Evaluator Feedback)`,
            evaluatorContext,
            ``,
            `## Instructions`,
            `Please analyze the evaluator feedback above and fix the issue.`,
            `Do NOT repeat the same approach that caused the failure.`,
            `Focus on the root cause indicated by the diagnostic output.`,
        ].join('\n');
    }

    /**
     * Clear all attempts for a phase (e.g., after user manually retries).
     */
    clearAttempts(phaseId: number): void {
        this.attempts.delete(phaseId);
    }

    /**
     * Clear all tracking data.
     */
    reset(): void {
        this.attempts.clear();
    }

    /**
     * Get the history of all attempts for a phase.
     */
    getHistory(phaseId: number): readonly HealingAttempt[] {
        return this.attempts.get(phaseId) ?? [];
    }
}
