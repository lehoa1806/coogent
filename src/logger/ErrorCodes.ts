// ─────────────────────────────────────────────────────────────────────────────
// src/logger/ErrorCodes.ts — Structured error codes for telemetry & debugging
// ─────────────────────────────────────────────────────────────────────────────
// S3-1 (OB-1): Defect identified in audit — error messages are unstructured
// free-text strings. This enum provides machine-parseable codes for JSONL logs
// and automated alerting.

/**
 * Structured error codes for all known failure categories.
 * Format: `ERR_<MODULE>_<VERB>` (e.g., ERR_SM_RECOVERY_FAILED).
 *
 * Used in TelemetryLogger JSONL entries and the Dump State command output.
 */
export enum ErrorCode {
    // ── State Manager ────────────────────────────────────────────────────
    /** WAL recovery failed during crash recovery. */
    ERR_SM_RECOVERY_FAILED = 'ERR_SM_RECOVERY_FAILED',
    /** Runbook schema validation failed. */
    ERR_SM_VALIDATION_FAILED = 'ERR_SM_VALIDATION_FAILED',
    /** Stale lockfile detected and cleaned. */
    ERR_SM_STALE_LOCK = 'ERR_SM_STALE_LOCK',
    /** Save runbook I/O error. */
    ERR_SM_SAVE_FAILED = 'ERR_SM_SAVE_FAILED',

    // ── ArtifactDB ───────────────────────────────────────────────────────
    /** Async or sync flush to disk failed. */
    ERR_ADB_FLUSH_FAILED = 'ERR_ADB_FLUSH_FAILED',
    /** Schema migration ALTER TABLE failed. */
    ERR_ADB_MIGRATION_FAILED = 'ERR_ADB_MIGRATION_FAILED',
    /** WASM initialization failed. */
    ERR_ADB_INIT_FAILED = 'ERR_ADB_INIT_FAILED',

    // ── ADK Controller ───────────────────────────────────────────────────
    /** Worker process creation failed. */
    ERR_ADK_SPAWN_FAILED = 'ERR_ADK_SPAWN_FAILED',
    /** Worker timed out (no output within watchdog window). */
    ERR_ADK_WORKER_TIMEOUT = 'ERR_ADK_WORKER_TIMEOUT',
    /** Worker process crashed (non-zero exit). */
    ERR_ADK_WORKER_CRASH = 'ERR_ADK_WORKER_CRASH',
    /** PID registration I/O error. */
    ERR_ADK_PID_REG_FAILED = 'ERR_ADK_PID_REG_FAILED',
    /** Prompt injection detected in phase prompt. */
    ERR_ADK_INJECTION_DETECTED = 'ERR_ADK_INJECTION_DETECTED',
    /** Worker output exceeded size cap. */
    ERR_ADK_OUTPUT_TRUNCATED = 'ERR_ADK_OUTPUT_TRUNCATED',

    // ── Engine ────────────────────────────────────────────────────────────
    /** Invalid FSM transition attempted. */
    ERR_ENG_INVALID_TRANSITION = 'ERR_ENG_INVALID_TRANSITION',
    /** Phase dispatch failed (no ready phases). */
    ERR_ENG_DISPATCH_STALL = 'ERR_ENG_DISPATCH_STALL',
    /** Evaluation pipeline failed. */
    ERR_ENG_EVAL_FAILED = 'ERR_ENG_EVAL_FAILED',

    // ── Context ──────────────────────────────────────────────────────────
    /** Secrets detected in context file (blocking mode). */
    ERR_CTX_SECRETS_BLOCKED = 'ERR_CTX_SECRETS_BLOCKED',
    /** Context assembly exceeded token budget. */
    ERR_CTX_OVER_BUDGET = 'ERR_CTX_OVER_BUDGET',
    /** Path traversal / symlink escape detected. */
    ERR_CTX_PATH_TRAVERSAL = 'ERR_CTX_PATH_TRAVERSAL',

    // ── Plugin ────────────────────────────────────────────────────────────
    /** Plugin activation failed. */
    ERR_PLG_ACTIVATE_FAILED = 'ERR_PLG_ACTIVATE_FAILED',
    /** User declined plugin activation. */
    ERR_PLG_USER_DENIED = 'ERR_PLG_USER_DENIED',

    // ── Handoff ──────────────────────────────────────────────────────────
    /** Handoff JSON parsing / Zod validation failed. */
    ERR_HO_PARSE_FAILED = 'ERR_HO_PARSE_FAILED',
    /** MCP bridge submission failed. */
    ERR_HO_SUBMIT_FAILED = 'ERR_HO_SUBMIT_FAILED',

    // ── Selection Pipeline ───────────────────────────────────────────────
    /** Agent selection validation failed. */
    ERR_SEL_VALIDATION_FAILED = 'ERR_SEL_VALIDATION_FAILED',
    /** Prompt compilation failed. */
    ERR_SEL_COMPILE_FAILED = 'ERR_SEL_COMPILE_FAILED',
}
