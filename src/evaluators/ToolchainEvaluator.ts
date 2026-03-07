// ─────────────────────────────────────────────────────────────────────────────
// src/evaluators/ToolchainEvaluator.ts — V2 toolchain/compiler evaluator
// ─────────────────────────────────────────────────────────────────────────────

import type { IEvaluator, EvaluatorType, Phase, EvaluationResult } from '../types/index.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import log from '../logger/log.js';

const execFileAsync = promisify(execFile);

/** Allowed binaries for toolchain evaluation (no shell, no injection). */
const TOOLCHAIN_WHITELIST = new Set([
    'make', 'npm', 'npx', 'tsc', 'node',
    'cargo', 'go', 'python', 'python3',
    'swift', 'swiftc', 'xcodebuild',
    'gcc', 'g++', 'clang', 'clang++',
    'cmake', 'gradle', 'mvn',
    'dotnet', 'rustc',
]);

/** Maximum execution time for toolchain commands (ms). */
const TOOLCHAIN_TIMEOUT_MS = 120_000;

/**
 * Evaluates success by running a whitelisted toolchain command in the workspace.
 * Criteria format: `"toolchain:<command>"` — e.g., `"toolchain:tsc --noEmit"`.
 *
 * On failure, captures the full compiler/build output (capped at 4KB)
 * as `retryPrompt` for the SelfHealingController.
 *
 * Security:
 * - Only binaries in TOOLCHAIN_WHITELIST are allowed.
 * - Uses execFile (no shell) to prevent command injection.
 * - Strict timeout of 120 seconds.
 */
export class ToolchainEvaluatorV2 implements IEvaluator {
    readonly type: EvaluatorType = 'toolchain';

    constructor(private readonly workspaceRoot: string) { }

    async evaluate(
        phase: Phase,
        _exitCode: number,
        _stdout: string,
        _stderr: string
    ): Promise<EvaluationResult> {
        const criteria = phase.success_criteria;

        if (!criteria.startsWith('toolchain:')) {
            return {
                passed: false,
                reason: 'Criteria does not start with "toolchain:".',
            };
        }

        const command = criteria.slice('toolchain:'.length).trim();
        if (!command) {
            return {
                passed: false,
                reason: 'Empty toolchain command.',
            };
        }

        const parts = command.split(/\s+/);
        const binary = parts[0];
        const args = parts.slice(1);

        if (!TOOLCHAIN_WHITELIST.has(binary)) {
            log.error(`[ToolchainEvaluatorV2] Blocked non-whitelisted binary: "${binary}"`);
            return {
                passed: false,
                reason: `Binary "${binary}" is not in the allowed whitelist.`,
            };
        }

        try {
            await execFileAsync(binary, args, {
                cwd: this.workspaceRoot,
                timeout: TOOLCHAIN_TIMEOUT_MS,
                maxBuffer: 10 * 1024 * 1024,
            });

            return {
                passed: true,
                reason: `Toolchain command "${command}" exited successfully.`,
            };
        } catch (err: unknown) {
            const execErr = err as { stdout?: string; stderr?: string; code?: number | string };
            const combinedOutput = [
                execErr.stderr || '',
                execErr.stdout || '',
            ].join('\n').trim();

            return {
                passed: false,
                reason: `Toolchain command "${command}" failed.`,
                retryPrompt: [
                    `## Toolchain Verification Failed`,
                    `Command: \`${command}\``,
                    ``,
                    `### Error Output`,
                    '```',
                    combinedOutput.slice(-4096),
                    '```',
                    ``,
                    `Please fix the errors reported above.`,
                ].join('\n'),
            };
        }
    }
}
