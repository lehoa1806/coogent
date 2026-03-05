// ─────────────────────────────────────────────────────────────────────────────
// src/evaluators/CompilerEvaluator.ts — Pluggable success evaluation chain
// ─────────────────────────────────────────────────────────────────────────────

import type { SuccessEvaluator, EvaluatorType } from '../types/index.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import log from '../logger/log.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Exit Code Evaluator (V1 — default)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * V1 evaluator: matches process exit code against the criteria.
 * Criteria format: `"exit_code:0"` or `"exit_code:1"` etc.
 * Default: exit code 0 means success.
 */
export class ExitCodeEvaluator implements SuccessEvaluator {
    readonly type: EvaluatorType = 'exit_code';

    async evaluate(
        criteria: string,
        exitCode: number,
        _stdout: string,
        _stderr: string
    ): Promise<boolean> {
        if (criteria.startsWith('exit_code:')) {
            const expected = parseInt(criteria.split(':')[1], 10);
            return exitCode === expected;
        }
        // Default: exit 0 means success
        return exitCode === 0;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Regex Output Evaluator
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Evaluates success by matching a regex pattern against stdout or stderr.
 * Criteria format: `"regex:pattern"` — matches against combined output.
 * Optionally: `"regex_fail:pattern"` — fails if pattern is found.
 */
export class RegexOutputEvaluator implements SuccessEvaluator {
    readonly type: EvaluatorType = 'regex';

    async evaluate(
        criteria: string,
        _exitCode: number,
        stdout: string,
        stderr: string
    ): Promise<boolean> {
        const combined = stdout + '\n' + stderr;

        // regex_fail:pattern — fail if found
        if (criteria.startsWith('regex_fail:')) {
            const pattern = criteria.slice('regex_fail:'.length);
            try {
                return !new RegExp(pattern).test(combined);
            } catch (err) {
                log.warn(`[RegexOutputEvaluator] Invalid regex pattern "${pattern}":`, err);
                return false; // Treat invalid regex as failure
            }
        }

        // regex:pattern — pass if found
        if (criteria.startsWith('regex:')) {
            const pattern = criteria.slice('regex:'.length);
            try {
                return new RegExp(pattern).test(combined);
            } catch (err) {
                log.warn(`[RegexOutputEvaluator] Invalid regex pattern "${pattern}":`, err);
                return false; // Treat invalid regex as failure
            }
        }

        // Unknown criteria — fall back to exit code
        return _exitCode === 0;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Toolchain Evaluator (Pillar 3)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Allowed binaries for toolchain evaluation.
 * Only these commands can be executed via the `toolchain:` evaluator.
 * See 02-review.md § P1-5.
 */
const TOOLCHAIN_WHITELIST = new Set([
    'make', 'npm', 'npx', 'tsc', 'node',
    'cargo', 'go', 'python', 'python3',
    'swift', 'swiftc', 'xcodebuild',
    'gcc', 'g++', 'clang', 'clang++',
    'cmake', 'gradle', 'mvn',
    'dotnet', 'rustc',
]);

/**
 * Evaluates success by running a whitelisted toolchain command in the workspace.
 * Criteria format: `"toolchain:<command>"` — e.g., `"toolchain:make test"`.
 * Succeeds if the toolchain command exits with code 0.
 *
 * Security: Only binaries in TOOLCHAIN_WHITELIST are allowed. All commands
 * use execFile (no shell) to prevent injection.
 */
export class ToolchainEvaluator implements SuccessEvaluator {
    readonly type: EvaluatorType = 'toolchain';

    constructor(private readonly workspaceRoot: string) { }

    async evaluate(
        criteria: string,
        _exitCode: number,
        _stdout: string,
        _stderr: string
    ): Promise<boolean> {
        if (!criteria.startsWith('toolchain:')) return false;

        const command = criteria.slice('toolchain:'.length).trim();
        if (!command) return false;

        // Parse command into binary + args
        const parts = command.split(/\s+/);
        const binary = parts[0];
        const args = parts.slice(1);

        // Whitelist check (P1-5 fix)
        if (!TOOLCHAIN_WHITELIST.has(binary)) {
            log.error(`[ToolchainEvaluator] Blocked non-whitelisted binary: "${binary}"`);
            return false;
        }

        const execFileAsync = promisify(execFile);

        try {
            await execFileAsync(binary, args, {
                cwd: this.workspaceRoot,
                timeout: 120_000,
                maxBuffer: 10 * 1024 * 1024,
            });
            return true; // exit code 0
        } catch {
            return false; // non-zero exit
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Test Suite Evaluator (Pillar 3)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Evaluates success by running a whitelisted test command and checking both
 * exit code AND parsing test results from stdout.
 * Criteria format: `"test_suite:<command>"` — e.g., `"test_suite:npx jest"`.
 *
 * Security: Only binaries in TOOLCHAIN_WHITELIST are allowed.
 */
export class TestSuiteEvaluator implements SuccessEvaluator {
    readonly type: EvaluatorType = 'test_suite';

    constructor(private readonly workspaceRoot: string) { }

    async evaluate(
        criteria: string,
        _exitCode: number,
        _stdout: string,
        _stderr: string
    ): Promise<boolean> {
        if (!criteria.startsWith('test_suite:')) return false;

        const command = criteria.slice('test_suite:'.length).trim();
        if (!command) return false;

        // Parse command into binary + args
        const parts = command.split(/\s+/);
        const binary = parts[0];
        const args = parts.slice(1);

        // Whitelist check (P1-5 fix)
        if (!TOOLCHAIN_WHITELIST.has(binary)) {
            log.error(`[TestSuiteEvaluator] Blocked non-whitelisted binary: "${binary}"`);
            return false;
        }

        const execFileAsync = promisify(execFile);

        try {
            const { stdout } = await execFileAsync(binary, args, {
                cwd: this.workspaceRoot,
                timeout: 300_000, // 5 minute timeout for test suites
                maxBuffer: 10 * 1024 * 1024,
            });

            // Also check for known failure patterns in stdout
            const failurePatterns = [
                /FAIL\s/,        // Jest
                /FAILED\s/,      // pytest
                /\d+ failure/i,  // generic
            ];

            return !failurePatterns.some(p => p.test(stdout));
        } catch {
            return false;
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Evaluator Registry
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Registry of all available evaluators.
 * Selects the appropriate evaluator based on `phase.evaluator` field.
 */
export class EvaluatorRegistry {
    private readonly evaluators: Map<EvaluatorType, SuccessEvaluator>;

    constructor(workspaceRoot: string) {
        this.evaluators = new Map();
        this.evaluators.set('exit_code', new ExitCodeEvaluator());
        this.evaluators.set('regex', new RegexOutputEvaluator());
        this.evaluators.set('toolchain', new ToolchainEvaluator(workspaceRoot));
        this.evaluators.set('test_suite', new TestSuiteEvaluator(workspaceRoot));
    }

    /**
     * Get the evaluator for a given type (defaults to `exit_code`).
     */
    get(type?: EvaluatorType): SuccessEvaluator {
        return this.evaluators.get(type ?? 'exit_code') ?? this.evaluators.get('exit_code')!;
    }
}


// ═══════════════════════════════════════════════════════════════════════════════
//  Factory Function
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Instantiate the correct evaluator based on the evaluator type.
 * Convenience wrapper around EvaluatorRegistry for standalone use.
 *
 * @param type - The evaluator type discriminant (defaults to 'exit_code').
 * @param workspaceRoot - Workspace root path (required for toolchain/test_suite evaluators).
 */
export function createEvaluator(
    type: EvaluatorType = 'exit_code',
    workspaceRoot: string = process.cwd(),
): SuccessEvaluator {
    switch (type) {
        case 'exit_code':
            return new ExitCodeEvaluator();
        case 'regex':
            return new RegexOutputEvaluator();
        case 'toolchain':
            return new ToolchainEvaluator(workspaceRoot);
        case 'test_suite':
            return new TestSuiteEvaluator(workspaceRoot);
        default:
            return new ExitCodeEvaluator();
    }
}
