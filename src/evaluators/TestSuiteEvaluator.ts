// ─────────────────────────────────────────────────────────────────────────────
// src/evaluators/TestSuiteEvaluator.ts — V2 test suite evaluator
// ─────────────────────────────────────────────────────────────────────────────

import type { IEvaluator, EvaluatorType, Phase, EvaluationResult } from '../types/index.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import log from '../logger/log.js';
import {
    TOOLCHAIN_WHITELIST,
    INTERPRETER_BINARIES,
    BLOCKED_ARGS,
    TEST_SUITE_TIMEOUT_MS,
} from './constants.js';

const execFileAsync = promisify(execFile);

/** Known failure patterns across common test frameworks. */
const FAILURE_PATTERNS: { pattern: RegExp; framework: string }[] = [
    { pattern: /FAIL\s/, framework: 'Jest' },
    { pattern: /FAILED\s/, framework: 'pytest' },
    { pattern: /\d+ failure/i, framework: 'generic' },
    { pattern: /Tests:\s+\d+ failed/i, framework: 'Jest summary' },
    { pattern: /FAILURES!/i, framework: 'JUnit/TestNG' },
    { pattern: /test result: FAILED/i, framework: 'Rust/cargo test' },
];

/**
 * Evaluates success by running a whitelisted test command.
 * Criteria format: `"test_suite:<command>"` — e.g., `"test_suite:npx jest"`.
 *
 * On failure, captures test failure logs (capped at 4KB) as `retryPrompt`
 * for the SelfHealingController to inject into the retry worker.
 *
 * Security:
 * - Only binaries in TOOLCHAIN_WHITELIST are allowed.
 * - Interpreter binaries (node, python) blocked from -e/-c arbitrary execution.
 * - Uses execFile (no shell) to prevent command injection.
 * - Strict timeout enforced via TOOLCHAIN_TIMEOUT_MS.
 */
export class TestSuiteEvaluatorV2 implements IEvaluator {
    readonly type: EvaluatorType = 'test_suite';

    constructor(private readonly workspaceRoot: string) { }

    async evaluate(
        phase: Phase,
        _exitCode: number,
        _stdout: string,
        _stderr: string
    ): Promise<EvaluationResult> {
        const criteria = phase.success_criteria;

        if (!criteria.startsWith('test_suite:')) {
            return {
                passed: false,
                reason: 'Criteria does not start with "test_suite:".',
            };
        }

        const command = criteria.slice('test_suite:'.length).trim();
        if (!command) {
            return {
                passed: false,
                reason: 'Empty test suite command.',
            };
        }

        const parts = command.split(/\s+/);
        const binary = parts[0];
        const args = parts.slice(1);

        if (!TOOLCHAIN_WHITELIST.has(binary)) {
            log.error(`[TestSuiteEvaluatorV2] Blocked non-whitelisted binary: "${binary}"`);
            return {
                passed: false,
                reason: `Binary "${binary}" is not in the allowed whitelist.`,
            };
        }

        // Block arbitrary code execution via interpreter flags (-e, -c, --eval)
        if (INTERPRETER_BINARIES.has(binary)) {
            const blocked = args.find(a => BLOCKED_ARGS.has(a));
            if (blocked) {
                log.error(`[TestSuiteEvaluatorV2] Blocked dangerous flag "${blocked}" for interpreter "${binary}"`);
                return {
                    passed: false,
                    reason: `Flag "${blocked}" is blocked for interpreter "${binary}" to prevent arbitrary code execution.`,
                };
            }
        }

        try {
            const { stdout, stderr } = await execFileAsync(binary, args, {
                cwd: this.workspaceRoot,
                timeout: TEST_SUITE_TIMEOUT_MS,
                maxBuffer: 10 * 1024 * 1024,
            });

            // Check for known failure patterns even if exit code is 0
            const combined = stdout + '\n' + stderr;
            const matchedPattern = FAILURE_PATTERNS.find(fp => fp.pattern.test(combined));

            if (matchedPattern) {
                return {
                    passed: false,
                    reason: `Test suite passed exit code but ${matchedPattern.framework} failure pattern detected.`,
                    retryPrompt: [
                        `## Test Suite Failed`,
                        `Command: \`${command}\``,
                        `Framework: ${matchedPattern.framework}`,
                        ``,
                        `### Test Output`,
                        '```',
                        combined.slice(-4096),
                        '```',
                        ``,
                        `Please fix the failing tests above.`,
                    ].join('\n'),
                };
            }

            return {
                passed: true,
                reason: `Test suite "${command}" passed — no failure patterns detected.`,
            };
        } catch (err: unknown) {
            const execErr = err as { stdout?: string; stderr?: string; code?: number | string };
            const combinedOutput = [
                execErr.stderr || '',
                execErr.stdout || '',
            ].join('\n').trim();

            return {
                passed: false,
                reason: `Test suite "${command}" failed with non-zero exit code.`,
                retryPrompt: [
                    `## Test Suite Failed`,
                    `Command: \`${command}\``,
                    ``,
                    `### Test Failure Output`,
                    '```',
                    combinedOutput.slice(-4096),
                    '```',
                    ``,
                    `Please analyze the test failures above and fix the implementation.`,
                    `Do NOT modify the tests — fix the code under test.`,
                ].join('\n'),
            };
        }
    }
}
