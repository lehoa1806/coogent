// ─────────────────────────────────────────────────────────────────────────────
// src/types/evaluators.ts — Evaluator, self-healing, and Git types
// ─────────────────────────────────────────────────────────────────────────────

import type { Phase, PhaseId, UnixTimestampMs } from './phase.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Pillar 3 — Autonomous Resilience Types
// ═══════════════════════════════════════════════════════════════════════════════

/** Evaluator type discriminant. */
export type EvaluatorType = 'exit_code' | 'regex' | 'toolchain' | 'test_suite' | 'composite';

/** Result of evaluating a phase's success criteria. */
export interface EvaluationResult {
    /** Whether the phase passed the evaluation. */
    readonly passed: boolean;
    /** Human-readable reason for the verdict. */
    readonly reason: string;
    /**
     * Optional augmented prompt to feed back to the SelfHealingController
     * when the phase fails. Contains diagnostic output (capped at 4KB).
     */
    readonly retryPrompt?: string;
}

/**
 * Pluggable evaluator interface (V2).
 * Implementations verify phase success and produce diagnostic feedback
 * for the SelfHealingController on failure.
 */
export interface IEvaluator {
    /** Unique type identifier (matches `phase.evaluator`). */
    readonly type: EvaluatorType;
    /**
     * Evaluate whether a phase succeeded.
     * @param phase - The phase configuration (for access to success_criteria, evaluator type, etc.).
     * @param exitCode - The worker process exit code.
     * @param stdout - Captured stdout from the worker.
     * @param stderr - Captured stderr from the worker.
     * @returns An EvaluationResult with pass/fail verdict, reason, and optional retry prompt.
     */
    evaluate(
        phase: Phase,
        exitCode: number,
        stdout: string,
        stderr: string
    ): Promise<EvaluationResult>;
}


/** Result of a self-healing attempt. */
export interface HealingAttempt {
    readonly attemptNumber: number;
    readonly phaseId: PhaseId;
    readonly exitCode: number;
    readonly stderr: string;
    readonly timestamp: UnixTimestampMs;
}

/** Git operation result. */
export interface GitOperationResult {
    readonly success: boolean;
    readonly commitHash?: string;
    readonly message: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Git Sandbox Manager Types
// ═══════════════════════════════════════════════════════════════════════════════

/** Result of a Git sandbox branch operation (create / cleanup). */
export interface GitSandboxResult {
    success: boolean;
    branchName?: string;
    previousBranch?: string;
    message: string;
}

/** Result of the pre-flight check before entering the sandbox. */
export interface PreFlightCheckResult {
    clean: boolean;
    currentBranch: string;
    message: string;
}

/** Options for creating a Git sandbox branch. */
export interface SandboxOptions {
    taskSlug: string;
    /** Branch name prefix (default concept: 'coogent/'). */
    branchPrefix?: string;
}
