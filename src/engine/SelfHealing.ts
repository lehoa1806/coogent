// ─────────────────────────────────────────────────────────────────────────────
// src/engine/SelfHealing.ts — Auto-retry with error feedback injection
// ─────────────────────────────────────────────────────────────────────────────

import { asPhaseId, asTimestamp, type Phase, type HealingAttempt } from '../types/index.js';
import type { ArtifactDB } from '../mcp/ArtifactDB.js';
import log from '../logger/log.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  M-2, P11: Sanitize agent output before injecting into healing prompts.
//  Guards against prompt injection via self-healing: a compromised agent
//  could embed instructions in its output that propagate to retry attempts.
//
//  Strategy:
//  1. Truncate to last 4000 chars — limits exposure surface.
//  2. Strip markdown heading markers (# ## ### etc.) — reduces instruction
//     injection effectiveness since models weight headings as directives.
//  3. Wrap in <previous_output>…</previous_output> delimiters — helps the
//     model distinguish prior data from current instructions.
// ═══════════════════════════════════════════════════════════════════════════════
const MAX_OUTPUT_CHARS = 4_000;

function sanitizeAgentOutput(raw: string): string {
    // 1. Truncate to the last MAX_OUTPUT_CHARS characters
    const truncated = raw.length > MAX_OUTPUT_CHARS
        ? `[…truncated ${raw.length - MAX_OUTPUT_CHARS} chars…]\n` + raw.slice(-MAX_OUTPUT_CHARS)
        : raw;

    // 2. Strip markdown heading markers at the start of lines
    const stripped = truncated.replace(/^#{1,6}\s/gm, '');

    // 3. Wrap in clearly delimited block
    return `<previous_output>\n${stripped}\n</previous_output>`;
}

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
    private db: ArtifactDB | undefined;
    private masterTaskId: string = '';

    constructor(options?: { maxRetries?: number; baseDelayMs?: number }) {
        this.maxRetries = options?.maxRetries ?? 2;
        this.baseDelayMs = options?.baseDelayMs ?? 2_000;
    }

    /**
     * S3 audit fix: Inject DB instance for persisting healing attempts.
     */
    setArtifactDB(db: ArtifactDB, masterTaskId: string): void {
        this.db = db;
        this.masterTaskId = masterTaskId;
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
     * @param mcpPhaseId — Optional full phase ID (format: phase-NNN-UUID) for
     *   DB persistence. When omitted, falls back to truncated `phase-NNN`.
     */
    recordFailure(phaseId: number, exitCode: number, stderr: string, mcpPhaseId?: string): void {
        const existing = this.attempts.get(phaseId) ?? [];
        existing.push({
            attemptNumber: existing.length + 1,
            phaseId: asPhaseId(phaseId),
            exitCode,
            stderr,
            timestamp: asTimestamp(),
        });
        this.attempts.set(phaseId, existing);

        // S3 audit fix: Persist healing attempt to DB (best-effort)
        // H1 audit fix: Use full mcpPhaseId when available for cross-table join consistency
        if (this.db && this.masterTaskId) {
            try {
                const phaseIdStr = mcpPhaseId ?? `phase-${String(phaseId).padStart(3, '0')}`;
                this.db.verdicts.upsertHealing(this.masterTaskId, phaseIdStr, {
                    attemptNumber: existing.length,
                    exitCode,
                    stderrTail: stderr.slice(-4096),
                    createdAt: Date.now(),
                });
            } catch (err) {
                log.warn('[SelfHealingController] Failed to persist healing attempt:', err);
            }
        }
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
     * Get the delay before the next retry (exponential backoff with jitter).
     *
     * Jitter (±20%) prevents correlated retries when multiple DAG-parallel
     * phases fail around the same time — without it, synchronized retries
     * can overload the same upstream resource repeatedly.
     */
    getRetryDelay(phaseId: number): number {
        const attempts = this.attempts.get(phaseId) ?? [];
        const retryCount = attempts.length;
        // Exponential backoff: 2s, 4s, 8s, ...
        const baseDelay = this.baseDelayMs * Math.pow(2, retryCount);
        // L-9: Add ±20% jitter to prevent correlated retries in DAG parallelism
        const jitterFactor = 0.8 + Math.random() * 0.4;
        return Math.round(baseDelay * jitterFactor);
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

        // M-2 P11: Sanitize stderr before injection to prevent prompt
        // injection via self-healing output propagation.
        const sanitizedStderr = sanitizeAgentOutput(lastAttempt.stderr);

        return [
            `## Task (Retry ${retryNumber}/${totalAllowed})`,
            phase.prompt,
            ``,
            `## ⚠️ Previous Attempt Failed`,
            `The previous attempt to complete this task failed with exit code ${lastAttempt.exitCode}.`,
            ``,
            `### Error Output`,
            sanitizedStderr,
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

        // M-2 P11: Sanitize evaluator context before injection to prevent
        // prompt injection via self-healing output propagation.
        const sanitizedContext = sanitizeAgentOutput(evaluatorContext);

        return [
            `## Task (Retry ${retryNumber}/${totalAllowed})`,
            phase.prompt,
            ``,
            `## ⚠️ Previous Attempt Failed (Evaluator Feedback)`,
            sanitizedContext,
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
