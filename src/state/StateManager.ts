// ─────────────────────────────────────────────────────────────────────────────
// src/state/StateManager.ts — Runbook persistence, locking, and crash recovery
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import Ajv from 'ajv';
import { RUNBOOK_FILENAME, asTimestamp } from '../types/index.js';
import type { Runbook, WALEntry, EngineState } from '../types/index.js';
import log from '../logger/log.js';

// Inline JSON Schema — no external file dependency (esbuild-safe)
const runbookSchema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'Coogent Task Runbook',
    type: 'object',
    required: ['project_id', 'status', 'current_phase', 'phases'],
    properties: {
        project_id: { type: 'string', minLength: 1 },
        status: { type: 'string', enum: ['idle', 'running', 'paused_error', 'completed'] },
        current_phase: { type: 'integer', minimum: 0 },
        summary: { type: 'string' },
        implementation_plan: { type: 'string' },
        phases: {
            type: 'array',
            minItems: 1,
            items: {
                type: 'object',
                required: ['id', 'status', 'prompt', 'context_files', 'success_criteria'],
                properties: {
                    id: { type: 'integer' },
                    status: { type: 'string', enum: ['pending', 'running', 'completed', 'failed'] },
                    prompt: { type: 'string', minLength: 1 },
                    context_files: { type: 'array', items: { type: 'string', minLength: 1 } },
                    success_criteria: { type: 'string', minLength: 1 },
                    depends_on: { type: 'array', items: { type: 'integer' } },
                    evaluator: { type: 'string', enum: ['exit_code', 'regex', 'toolchain', 'test_suite'] },
                    max_retries: { type: 'integer', minimum: 0 },
                    context_summary: { type: 'string' },
                },
            },
        },
    },
} as const;

const ajv = new Ajv({ allErrors: true });
const validateRunbook = ajv.compile<Runbook>(runbookSchema);

/**
 * Manages all `.task-runbook.json` I/O.
 *
 * Design Principles:
 * - All reads/writes are serialized through this class (no direct fs calls elsewhere).
 * - Mutations use a WAL (Write-Ahead Log) + atomic rename pattern.
 * - File locking prevents race conditions from external editors.
 * - Schema validation via ajv on every load.
 *
 * Files are stored under the session directory:
 *   `.coogent/ipc/<id>/.task-runbook.json`
 *   `.coogent/ipc/<id>/.wal.json`
 *   `.coogent/ipc/<id>/.lock`
 *
 * See ARCHITECTURE.md § Persistence Strategy for the full design.
 * See 02-review.md § R10 — singleton removed for multi-workspace support.
 */
export class StateManager {
    private readonly runbookPath: string;
    private readonly walPath: string;
    private readonly lockPath: string;
    private readonly sessionDir: string;
    private dirEnsured = false;

    /** In-memory cache of the last-read runbook. */
    private cachedRunbook: Runbook | null = null;

    /** Whether we currently hold the file lock. */
    private isLocked = false;

    /**
     * In-process async mutex — serializes all saveRunbook() calls.
     * Prevents interleaving when multiple async paths (worker exit + user pause)
     * trigger persist() within the same event loop.
     * See 02-review.md § P0-1.
     */
    private writeLock: Promise<void> = Promise.resolve();

    /**
     * @param sessionDir Absolute path to the session directory
     *   (e.g., `<workspace>/.coogent/ipc/<uuid>/`).
     */
    constructor(sessionDir: string) {
        this.sessionDir = sessionDir;
        this.runbookPath = path.join(sessionDir, RUNBOOK_FILENAME);
        this.walPath = path.join(sessionDir, '.wal.json');
        this.lockPath = path.join(sessionDir, '.lock');
    }

    /** Ensure session directory exists (called once before first write). */
    private async ensureDir(): Promise<void> {
        if (this.dirEnsured) return;
        await fs.mkdir(this.sessionDir, { recursive: true });
        this.dirEnsured = true;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Read Operations
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Load the runbook from disk and validate against JSON Schema.
     * Returns `null` if the file does not exist.
     * @throws {RunbookValidationError} If the file fails schema validation.
     */
    public async loadRunbook(): Promise<Runbook | null> {
        try {
            const raw = await fs.readFile(this.runbookPath, 'utf-8');
            const parsed: unknown = JSON.parse(raw);
            const runbook = this.validateSchema(parsed);
            this.cachedRunbook = runbook;
            return runbook;
        } catch (err: unknown) {
            if (isNodeError(err) && err.code === 'ENOENT') {
                this.cachedRunbook = null;
                return null;
            }
            throw err;
        }
    }

    /** Get the in-memory cached runbook (avoids disk I/O). */
    public getCachedRunbook(): Runbook | null {
        return this.cachedRunbook;
    }

    /** Get the absolute path to the session directory. */
    public getSessionDir(): string {
        return this.sessionDir;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Write Operations (WAL + Atomic Rename)
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Persist the runbook to disk using the WAL + atomic rename pattern.
     *
     * All calls are serialized through an in-process mutex (`writeLock`)
     * to prevent interleaving from concurrent async paths.
     *
     * Sequence: mutex → lock → WAL → temp write → atomic rename → clear WAL → unlock.
     */
    public async saveRunbook(
        runbook: Runbook,
        engineState: EngineState
    ): Promise<void> {
        // Serialize through the in-process mutex (P0-1 fix)
        const ticket = this.writeLock.then(() =>
            this._doSave(runbook, engineState)
        );
        // Chain the next call after this one, swallow errors to keep the chain alive
        this.writeLock = ticket.catch(() => { });
        return ticket;
    }

    /**
     * Internal save implementation — runs under the writeLock mutex.
     */
    private async _doSave(
        runbook: Runbook,
        engineState: EngineState
    ): Promise<void> {
        // Enforce schema validation on the write path (P0-3)
        this.validateSchema(runbook);

        await this.ensureDir();
        await this.acquireLock();
        try {
            // WAL entry — crash recovery point
            const walEntry: WALEntry = {
                timestamp: asTimestamp(),
                engineState,
                currentPhase: runbook.current_phase,
                snapshot: runbook,
            };
            await fs.writeFile(this.walPath, JSON.stringify(walEntry, null, 2), 'utf-8');

            // Atomic write: temp → rename
            const tmpPath = this.runbookPath + '.tmp';
            await fs.writeFile(tmpPath, JSON.stringify(runbook, null, 2), 'utf-8');
            await fs.rename(tmpPath, this.runbookPath);

            // Clear WAL (best-effort)
            await fs.unlink(this.walPath).catch(() => { });

            this.cachedRunbook = runbook;
        } finally {
            await this.releaseLock();
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Crash Recovery
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Recover from an interrupted session.
     * 1. Clean stale lockfiles left by a crashed process (P0-2 fix).
     * 2. Replay WAL if present.
     * @returns `true` if WAL recovery was performed.
     */
    public async recoverFromCrash(): Promise<boolean> {
        // FIRST: Always clean stale locks from crashed processes
        await this.cleanStaleLock();

        // THEN: Replay WAL if present — check existence first to avoid ENOENT
        try {
            await fs.access(this.walPath);
        } catch {
            return false; // No WAL file — no recovery needed
        }

        try {
            const walRaw = await fs.readFile(this.walPath, 'utf-8');
            let walEntry: WALEntry;
            try {
                walEntry = JSON.parse(walRaw) as WALEntry;
            } catch (parseErr) {
                // Corrupt WAL — delete it and log warning (#33)
                log.warn('[StateManager] Corrupt WAL file (invalid JSON). Deleting...');
                await fs.unlink(this.walPath).catch(() => { });
                await this.cleanOrphanedTmpFiles();
                return false;
            }

            // Validate schema before restoring from WAL (prevents restoring corrupted data)
            try {
                this.validateSchema(walEntry.snapshot);
            } catch (validationErr) {
                log.warn('[StateManager] WAL snapshot failed schema validation. Deleting WAL...', validationErr);
                await fs.unlink(this.walPath).catch(() => { });
                await this.cleanOrphanedTmpFiles();
                return false;
            }

            log.info(`[StateManager] WAL found (ts=${walEntry.timestamp}). Recovering...`);

            // MUST acquire lock to avoid race conditions with other writers during recovery
            await this.acquireLock();
            try {
                // Atomic write: temp → rename
                const tmpPath = this.runbookPath + '.tmp';
                await fs.writeFile(
                    tmpPath,
                    JSON.stringify(walEntry.snapshot, null, 2),
                    'utf-8'
                );
                await fs.rename(tmpPath, this.runbookPath);

                await fs.unlink(this.walPath).catch(() => { });

                this.cachedRunbook = walEntry.snapshot;
                log.info('[StateManager] Recovery complete.');

                // Clean orphaned .tmp files after successful recovery (#34)
                await this.cleanOrphanedTmpFiles();
                return true;
            } finally {
                await this.releaseLock();
            }
        } catch (err: unknown) {
            log.error('[StateManager] Recovery failed:', err);
            throw err;
        }
    }

    /**
     * Remove stale lockfiles left by a process that died without releasing.
     * Checks if the PID in the lockfile is still alive; if dead, removes it.
     * See 02-review.md § P0-2.
     */
    private async cleanStaleLock(): Promise<void> {
        try {
            const pidStr = await fs.readFile(this.lockPath, 'utf-8');
            const pid = parseInt(pidStr.trim(), 10);

            if (isNaN(pid)) {
                // Corrupt lockfile — remove it unconditionally
                await fs.unlink(this.lockPath).catch(() => { });
                log.info('[StateManager] Removed corrupt lockfile.');
                return;
            }

            try {
                process.kill(pid, 0); // Check if process is alive (signal 0)
                // Process is alive — lock is legitimate, do NOT remove
                log.warn(`[StateManager] Lockfile held by live PID ${pid}.`);
            } catch {
                // Process is dead — lock is stale
                await fs.unlink(this.lockPath).catch(() => { });
                log.info(`[StateManager] Removed stale lockfile (dead PID ${pid}).`);
            }
        } catch (err: unknown) {
            if (isNodeError(err) && err.code === 'ENOENT') {
                return; // No lockfile — nothing to clean
            }
            // Unexpected error — log but don't throw (recovery should proceed)
            log.warn('[StateManager] cleanStaleLock error:', err);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  File Locking
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Acquire an **advisory** file lock via lockfile (O_CREAT | O_EXCL).
     *
     * **W-7 Design Note**: This lock only guards against *external* processes
     * (e.g., another VS Code window or a text editor) modifying the runbook
     * file concurrently. The primary write serialization within this process
     * is the in-process `writeLock` async mutex (see L87), which prevents
     * interleaving from concurrent async paths (worker exit + user pause).
     *
     * The 100ms busy-poll is acceptable because contention from external
     * processes is rare and short-lived.
     *
     * @param timeoutMs Maximum wait before throwing (default: 5000ms).
     */
    private async acquireLock(timeoutMs = 5000): Promise<void> {
        // W-3 fix: Skip re-acquisition if we already hold the lock
        if (this.isLocked) return;
        const deadline = Date.now() + timeoutMs;
        let staleLockCleaned = false;

        while (Date.now() < deadline) {
            try {
                await fs.writeFile(this.lockPath, String(process.pid), { flag: 'wx' });
                this.isLocked = true;
                return;
            } catch (err: unknown) {
                if (isNodeError(err) && err.code === 'EEXIST') {
                    // On first EEXIST, try cleaning stale lock (#32)
                    if (!staleLockCleaned) {
                        await this.cleanStaleLock();
                        staleLockCleaned = true;
                    } else {
                        await sleep(100);
                    }
                    continue;
                }
                throw err;
            }
        }

        throw new Error(
            `[StateManager] Failed to acquire lock within ${timeoutMs}ms. ` +
            `The runbook may be locked by another process.`
        );
    }

    /** Release the exclusive lock. */
    private async releaseLock(): Promise<void> {
        if (!this.isLocked) return;
        try { await fs.unlink(this.lockPath); } catch { /* best-effort */ }
        this.isLocked = false;
    }

    /**
     * Remove orphaned .tmp files left by interrupted atomic writes (#34).
     * Best-effort cleanup — never throws.
     */
    private async cleanOrphanedTmpFiles(): Promise<void> {
        try {
            const entries = await fs.readdir(this.sessionDir);
            for (const entry of entries) {
                if (entry.endsWith('.tmp')) {
                    await fs.unlink(path.join(this.sessionDir, entry)).catch(() => { });
                    log.info(`[StateManager] Cleaned orphaned temp file: ${entry}`);
                }
            }
        } catch {
            // Session dir may not exist — nothing to clean
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Schema Validation (ajv)
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Validate parsed JSON against the runbook JSON Schema.
     * @throws {RunbookValidationError} With human-readable error details.
     */
    private validateSchema(data: unknown): Runbook {
        if (validateRunbook(data)) {
            return data;
        }

        const errors = (validateRunbook.errors ?? [])
            .map(e => `  ${e.instancePath || '/'}: ${e.message}`)
            .join('\n');

        throw new RunbookValidationError(
            `Runbook schema validation failed:\n${errors}`,
            validateRunbook.errors ?? []
        );
    }
}

/**
 * Error thrown when a runbook file fails JSON Schema validation.
 */
export class RunbookValidationError extends Error {
    constructor(
        message: string,
        public readonly validationErrors: readonly object[]
    ) {
        super(message);
        this.name = 'RunbookValidationError';
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Utility Functions
// ═══════════════════════════════════════════════════════════════════════════════

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
    return (err instanceof Error && 'code' in err) ||
        (typeof err === 'object' && err !== null && 'code' in err && 'message' in err);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
