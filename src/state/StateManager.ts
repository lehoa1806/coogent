// ─────────────────────────────────────────────────────────────────────────────
// src/state/StateManager.ts — Runbook persistence, locking, and crash recovery
// ─────────────────────────────────────────────────────────────────────────────
// R4 refactor: Encryption, validation, and file locking are now delegated to
//   RunbookEncryptor, RunbookValidator, and FileLock collaborators.
// Sprint 4: Added AES-256-CBC encryption for WAL and runbook files.
// Post-audit: Upgraded key management from PBKDF2-over-filepath to
//             VS Code SecretStorage API (OS keychain-backed).

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { asTimestamp, type Runbook, type WALEntry, type EngineState } from '../types/index.js';
import type { ArtifactDB } from '../mcp/ArtifactDB.js';
import { RUNBOOK_FILE, WAL_FILE, LOCK_FILE } from '../constants/paths.js';
import log from '../logger/log.js';
import { RunbookEncryptor, type SecretStorageLike } from './RunbookEncryptor.js';
import { validateRunbookSchema } from './RunbookValidator.js';
import { FileLock } from './FileLock.js';

// Re-export for backward compatibility — existing tests import from here
export type { SecretStorageLike } from './RunbookEncryptor.js';
export { RunbookValidationError } from './RunbookValidator.js';

/**
 * Manages all `.task-runbook.json` I/O.
 *
 * Design Principles:
 * - All reads/writes are serialized through this class (no direct fs calls elsewhere).
 * - Mutations use a WAL (Write-Ahead Log) + atomic rename pattern.
 * - File locking prevents race conditions from external editors.
 * - Schema validation via ajv on every load.
 *
 * Files are stored under the extension-managed session directory
 * (resolved via `WorkspaceHelper.getStorageBasePath()`):
 *   `<storageUri>/ipc/<id>/.task-runbook.json`
 *   `<storageUri>/ipc/<id>/.wal.json`
 *   `<storageUri>/ipc/<id>/.lock`
 *
 * See architecture.md § Persistence Strategy for the full design.
 * See 02-review.md § R10 — singleton removed for multi-workspace support.
 */
export class StateManager {
    private runbookPath: string;
    private walPath: string;
    private sessionDir: string;
    private dirEnsured = false;

    /** In-memory cache of the last-read runbook. */
    private cachedRunbook: Runbook | null = null;

    /** R4: Delegated collaborators */
    private readonly encryptor: RunbookEncryptor;
    private readonly lock: FileLock;

    /** Optional ArtifactDB for runbook persistence — set via setArtifactDB(). */
    private artifactDb: ArtifactDB | undefined;

    /** Master task ID for DB operations — set via setMasterTaskId(). */
    private masterTaskId: string | undefined;

    /**
     * In-process async mutex — serializes all saveRunbook() calls.
     * Prevents interleaving when multiple async paths (worker exit + user pause)
     * trigger persist() within the same event loop.
     * See 02-review.md § P0-1.
     */
    private writeLock: Promise<void> = Promise.resolve();

    /**
     * @param sessionDir Absolute path to the session directory. Should be
     *   resolved from extension-managed storage via
     *   `WorkspaceHelper.getStorageBasePath()` (e.g., `<storageUri>/ipc/<uuid>/`).
     * @param enableEncryption Whether to encrypt files at rest (default: false).
     * @param secretStorage Optional VS Code SecretStorage for secure key management.
     *   When provided, the encryption key is stored in the OS keychain instead of
     *   being derived from the filesystem path.
     */
    constructor(sessionDir: string, enableEncryption = false, secretStorage?: SecretStorageLike) {
        this.sessionDir = sessionDir;
        this.runbookPath = path.join(sessionDir, RUNBOOK_FILE);
        this.walPath = path.join(sessionDir, WAL_FILE);
        this.encryptor = new RunbookEncryptor(enableEncryption, secretStorage);
        this.lock = new FileLock(path.join(sessionDir, LOCK_FILE));
    }

    /** Ensure session directory exists (called once before first write). */
    private async ensureDir(): Promise<void> {
        if (this.dirEnsured) return;
        await fs.mkdir(this.sessionDir, { recursive: true });
        this.dirEnsured = true;
    }

    /**
     * Attach an ArtifactDB instance for DB-primary runbook persistence.
     * When set, `saveRunbook()` writes to DB first (throws on failure),
     * then writes the IPC file as a best-effort crash-recovery backup.
     * `loadRunbook()` reads from DB first, falling back to IPC file
     * only for WAL/crash-recovery scenarios.
     */
    public setArtifactDB(db: ArtifactDB, masterTaskId: string): void {
        this.artifactDb = db;
        this.masterTaskId = masterTaskId;
    }

    /**
     * Re-bind the session directory (and derived paths) for deferred session init.
     * Called when the real session is materialised on first `plan:request`.
     */
    public setSessionDir(dir: string): void {
        this.sessionDir = dir;
        this.runbookPath = path.join(dir, RUNBOOK_FILE);
        this.walPath = path.join(dir, WAL_FILE);
        this.lock.setLockPath(path.join(dir, LOCK_FILE));
        this.dirEnsured = false;   // force re-creation on next write
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Read Operations
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Load the runbook — DB is authoritative, IPC file is WAL/crash fallback.
     * Returns `null` if no runbook exists in either store.
     * @throws {RunbookValidationError} If the runbook fails schema validation.
     */
    public async loadRunbook(): Promise<Runbook | null> {
        await this.encryptor.init();

        // ── DB-first read (C1 audit fix: DB is authoritative) ──────────
        if (this.artifactDb && this.masterTaskId) {
            try {
                const task = this.artifactDb.tasks.get(this.masterTaskId);
                if (task?.runbookJson) {
                    const parsed: unknown = JSON.parse(task.runbookJson);
                    const runbook = validateRunbookSchema(parsed);
                    this.cachedRunbook = runbook;
                    log.info('[StateManager] Runbook loaded from DB (authoritative).');
                    return runbook;
                }
            } catch (dbErr) {
                log.warn('[StateManager] DB runbook read failed — falling back to IPC file:', dbErr);
            }
        }

        // ── IPC file fallback (WAL/crash recovery only) ────────────────
        try {
            const raw = await fs.readFile(this.runbookPath, 'utf-8');
            const content = this.encryptor.maybeDecrypt(raw);
            const parsed: unknown = JSON.parse(content);
            const runbook = validateRunbookSchema(parsed);
            this.cachedRunbook = runbook;
            log.info('[StateManager] Runbook loaded from IPC file (fallback).');

            // Promote IPC data → DB so subsequent reads hit the authoritative path
            if (this.artifactDb && this.masterTaskId) {
                try {
                    this.artifactDb.tasks.upsert(this.masterTaskId, {
                        runbookJson: JSON.stringify(runbook),
                    });
                    log.info('[StateManager] Promoted IPC runbook to DB.');
                } catch (promoteErr) {
                    log.warn('[StateManager] Failed to promote IPC runbook to DB:', promoteErr);
                }
            }

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
        validateRunbookSchema(runbook);

        await this.encryptor.init();
        await this.ensureDir();
        await this.lock.acquire();
        try {
            // ── C1 audit fix: DB is authoritative — write first, throw on failure ──
            if (this.artifactDb && this.masterTaskId) {
                this.artifactDb.tasks.upsert(this.masterTaskId, {
                    runbookJson: JSON.stringify(runbook),
                });
            }

            // IPC file write — best-effort crash-recovery backup
            // WAL entry — crash recovery point
            const walEntry: WALEntry = {
                timestamp: asTimestamp(),
                engineState,
                currentPhase: runbook.current_phase,
                snapshot: runbook,
            };
            const walContent = this.encryptor.maybeEncrypt(JSON.stringify(walEntry, null, 2));
            await fs.writeFile(this.walPath, walContent, 'utf-8');

            // Atomic write: temp → rename
            const tmpPath = this.runbookPath + '.tmp';
            const runbookContent = this.encryptor.maybeEncrypt(JSON.stringify(runbook, null, 2));
            await fs.writeFile(tmpPath, runbookContent, 'utf-8');
            await fs.rename(tmpPath, this.runbookPath);

            // Clear WAL (best-effort)
            await fs.unlink(this.walPath).catch(() => { });

            this.cachedRunbook = runbook;
        } finally {
            await this.lock.release();
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
        await this.encryptor.init();
        // FIRST: Always clean stale locks from crashed processes
        await this.lock.cleanStale();

        // THEN: Replay WAL if present — check existence first to avoid ENOENT
        try {
            await fs.access(this.walPath);
        } catch {
            return false; // No WAL file — no recovery needed
        }

        try {
            const walRawEncoded = await fs.readFile(this.walPath, 'utf-8');
            const walRaw = this.encryptor.maybeDecrypt(walRawEncoded);
            let walEntry: WALEntry;
            try {
                walEntry = JSON.parse(walRaw) as WALEntry;
            } catch {
                // Corrupt WAL — delete it and log warning (#33)
                log.warn('[StateManager] Corrupt WAL file (invalid JSON). Deleting...');
                await fs.unlink(this.walPath).catch(() => { });
                await this.cleanOrphanedTmpFiles();
                return false;
            }

            // Validate schema before restoring from WAL (prevents restoring corrupted data)
            try {
                validateRunbookSchema(walEntry.snapshot);
            } catch (validationErr) {
                log.warn('[StateManager] WAL snapshot failed schema validation. Deleting WAL...', validationErr);
                await fs.unlink(this.walPath).catch(() => { });
                await this.cleanOrphanedTmpFiles();
                return false;
            }

            log.info(`[StateManager] WAL found (ts=${walEntry.timestamp}). Recovering...`);

            // MUST acquire lock to avoid race conditions with other writers during recovery
            await this.lock.acquire();
            try {
                // Atomic write: temp → rename
                const tmpPath = this.runbookPath + '.tmp';
                await fs.writeFile(
                    tmpPath,
                    JSON.stringify(walEntry.snapshot, null, 2),
                    'utf-8'
                );
                await fs.rename(tmpPath, this.runbookPath);

                // Persist recovered snapshot to DB (authoritative store)
                if (this.artifactDb && this.masterTaskId) {
                    try {
                        this.artifactDb.tasks.upsert(this.masterTaskId, {
                            runbookJson: JSON.stringify(walEntry.snapshot),
                        });
                        log.info('[StateManager] WAL recovery persisted to DB.');
                    } catch (dbErr) {
                        log.warn('[StateManager] Failed to persist WAL recovery to DB:', dbErr);
                    }
                }

                await fs.unlink(this.walPath).catch(() => { });

                this.cachedRunbook = walEntry.snapshot;
                log.info('[StateManager] Recovery complete.');

                // Clean orphaned .tmp files after successful recovery (#34)
                await this.cleanOrphanedTmpFiles();
                return true;
            } finally {
                await this.lock.release();
            }
        } catch (err: unknown) {
            log.error('[StateManager] Recovery failed:', err);
            throw err;
        }
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
    //  Backward Compatibility — initEncryption()
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Initialise the encryption key from VS Code SecretStorage.
     * Delegates to RunbookEncryptor — preserved for backward compatibility
     * with tests that call this method directly.
     */
    public async initEncryption(): Promise<void> {
        return this.encryptor.init();
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Utility Functions
// ═══════════════════════════════════════════════════════════════════════════════

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
    return (err instanceof Error && 'code' in err) ||
        (typeof err === 'object' && err !== null && 'code' in err && 'message' in err);
}
