// ─────────────────────────────────────────────────────────────────────────────
// src/evaluators/ExitCodeEvaluator.ts — V2 exit code evaluator
// ─────────────────────────────────────────────────────────────────────────────

import type { IEvaluator, EvaluatorType, Phase, EvaluationResult } from '../types/index.js';

/**
 * V2 evaluator: matches process exit code against the criteria.
 * Criteria format: `"exit_code:0"` or `"exit_code:1"` etc.
 * Default: exit code 0 means success.
 *
 * On failure, includes the last 4KB of stderr as retryPrompt
 * so the SelfHealingController can feed it back to the worker.
 */
export class ExitCodeEvaluatorV2 implements IEvaluator {
    readonly type: EvaluatorType = 'exit_code';

    async evaluate(
        phase: Phase,
        exitCode: number,
        _stdout: string,
        stderr: string
    ): Promise<EvaluationResult> {
        const criteria = phase.success_criteria;
        let expectedCode = 0;

        if (criteria.startsWith('exit_code:')) {
            expectedCode = parseInt(criteria.split(':')[1], 10);
        }

        const passed = exitCode === expectedCode;

        if (passed) {
            return {
                passed: true,
                reason: `Exit code ${exitCode} matches expected ${expectedCode}.`,
            };
        }

        return {
            passed: false,
            reason: `Exit code ${exitCode} does not match expected ${expectedCode}.`,
            ...(stderr.slice(-4096) ? { retryPrompt: stderr.slice(-4096) } : {}),
        };
    }
}
