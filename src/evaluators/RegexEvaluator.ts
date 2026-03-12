// ─────────────────────────────────────────────────────────────────────────────
// src/evaluators/RegexEvaluator.ts — V2 regex-based output evaluator
// ─────────────────────────────────────────────────────────────────────────────

import type { IEvaluator, EvaluatorType, Phase, EvaluationResult } from '../types/index.js';
import log from '../logger/log.js';
import { isRegexSafe } from '../utils/regex-safety.js';

/**
 * Evaluates success by matching a regex pattern against combined stdout/stderr.
 *
 * Criteria formats:
 * - `"regex:<pattern>"` — passes if pattern is found in output.
 * - `"regex_fail:<pattern>"` — passes if pattern is NOT found in output.
 *
 * On failure, provides the matching (or missing) context as retryPrompt
 * with the first 4KB of relevant output.
 */
export class RegexEvaluator implements IEvaluator {
    readonly type: EvaluatorType = 'regex';

    async evaluate(
        phase: Phase,
        exitCode: number,
        stdout: string,
        stderr: string
    ): Promise<EvaluationResult> {
        const criteria = phase.success_criteria;
        const combined = stdout + '\n' + stderr;

        // regex_fail:<pattern> — fail if found
        if (criteria.startsWith('regex_fail:')) {
            const pattern = criteria.slice('regex_fail:'.length);
            try {
                const regex = new RegExp(pattern);
                // E-2: ReDoS protection — reject unsafe patterns
                if (!isRegexSafe(regex, pattern)) {
                    log.warn(`[RegexEvaluator] Rejected unsafe regex pattern: ${pattern}`);
                    return {
                        passed: false,
                        reason: `Regex pattern rejected: potential ReDoS vulnerability in /${pattern}/`,
                    };
                }
                const match = regex.exec(combined);
                if (match) {
                    return {
                        passed: false,
                        reason: `Failure pattern /${pattern}/ was found in output: "${match[0].slice(0, 200)}"`,
                        retryPrompt: [
                            `The output contained a failure pattern that should not be present.`,
                            `Pattern: /${pattern}/`,
                            `Match: "${match[0].slice(0, 500)}"`,
                            `\nRelevant output (last 4KB):`,
                            '```',
                            combined.slice(-4096),
                            '```',
                        ].join('\n'),
                    };
                }
                return {
                    passed: true,
                    reason: `Failure pattern /${pattern}/ was NOT found in output (good).`,
                };
            } catch (err) {
                log.warn(`[RegexEvaluator] Invalid regex pattern "${pattern}":`, err);
                return {
                    passed: false,
                    reason: `Invalid regex pattern: ${pattern}`,
                };
            }
        }

        // regex:<pattern> — pass if found
        if (criteria.startsWith('regex:')) {
            const pattern = criteria.slice('regex:'.length);
            try {
                const regex = new RegExp(pattern);
                // E-2: ReDoS protection — reject unsafe patterns
                if (!isRegexSafe(regex, pattern)) {
                    log.warn(`[RegexEvaluator] Rejected unsafe regex pattern: ${pattern}`);
                    return {
                        passed: false,
                        reason: `Regex pattern rejected: potential ReDoS vulnerability in /${pattern}/`,
                    };
                }
                const match = regex.exec(combined);
                if (match) {
                    return {
                        passed: true,
                        reason: `Required pattern /${pattern}/ found in output.`,
                    };
                }
                return {
                    passed: false,
                    reason: `Required pattern /${pattern}/ was NOT found in output.`,
                    retryPrompt: [
                        `The output did not contain the required pattern.`,
                        `Expected pattern: /${pattern}/`,
                        `\nActual output (last 4KB):`,
                        '```',
                        combined.slice(-4096),
                        '```',
                        `\nPlease ensure your implementation produces output matching the pattern.`,
                    ].join('\n'),
                };
            } catch (err) {
                log.warn(`[RegexEvaluator] Invalid regex pattern "${pattern}":`, err);
                return {
                    passed: false,
                    reason: `Invalid regex pattern: ${pattern}`,
                };
            }
        }

        // Fallback: treat as exit code check
        const passed = exitCode === 0;
        const reason = passed
            ? `No regex criteria specified; exit code ${exitCode} is 0.`
            : `No regex criteria specified; exit code ${exitCode} is non-zero.`;

        if (passed) {
            return { passed: true, reason };
        }

        const trimmedStderr = stderr.slice(-4096);
        return {
            passed: false,
            reason,
            ...(trimmedStderr ? { retryPrompt: trimmedStderr } : {}),
        };
    }
}
