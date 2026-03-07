// ─────────────────────────────────────────────────────────────────────────────
// src/evaluators/constants.ts — Shared evaluator constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Allowed binaries for toolchain/test-suite evaluation.
 * Only these binaries may be invoked via `execFile` — no shell, no injection.
 */
export const TOOLCHAIN_WHITELIST = new Set([
    'make', 'npm', 'npx', 'tsc', 'node',
    'cargo', 'go', 'python', 'python3',
    'swift', 'swiftc', 'xcodebuild',
    'gcc', 'g++', 'clang', 'clang++',
    'cmake', 'gradle', 'mvn',
    'dotnet', 'rustc',
]);

/**
 * Argument blacklist for interpreter binaries to prevent arbitrary code
 * execution. When `binary` is in `INTERPRETER_BINARIES`, these flags are
 * rejected to block `node -e "..."`, `python -c "..."`, etc.
 */
export const INTERPRETER_BINARIES = new Set(['node', 'python', 'python3']);
export const BLOCKED_ARGS = new Set(['-e', '-c', '--eval', 'exec']);

/** Maximum execution time for toolchain/test commands (ms). */
export const TOOLCHAIN_TIMEOUT_MS = 120_000;

/** Maximum execution time for test suites (ms) — longer than toolchain due to full suite runs. */
export const TEST_SUITE_TIMEOUT_MS = 300_000;
