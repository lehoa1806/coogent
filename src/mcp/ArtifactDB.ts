// ─────────────────────────────────────────────────────────────────────────────
// src/mcp/ArtifactDB.ts — Persistent SQLite data-access layer for MCP artifacts
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import log from '../logger/log.js';
import { TaskRepository } from './repositories/TaskRepository.js';
import { PhaseRepository } from './repositories/PhaseRepository.js';
import { HandoffRepository } from './repositories/HandoffRepository.js';
import { VerdictRepository } from './repositories/VerdictRepository.js';
import { SessionRepository } from './repositories/SessionRepository.js';
import { AuditRepository } from './repositories/AuditRepository.js';
import { ContextManifestRepository } from './repositories/ContextManifestRepository.js';
import { initializeSchema, type Database, type SqlJsStatic } from './ArtifactDBSchema.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Flush Configuration
// ═══════════════════════════════════════════════════════════════════════════════

/** Debounce window for coalescing consecutive writes (ms). */
const FLUSH_DEBOUNCE_MS = 500;

/** File permissions for artifacts.db — owner-only read/write. */
const DB_FILE_MODE = 0o600;

/** H-2 P6: Minimum interval between backups (5 minutes). */
const BACKUP_INTERVAL_MS = 300_000;

/** H-2 P6: Maximum number of backup files to retain. */
const MAX_BACKUPS = 3;

// ═══════════════════════════════════════════════════════════════════════════════
//  ArtifactDB
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Thin, typed data-access layer wrapping sql.js for persistent MCP artifact
 * storage. All data is persisted to a single SQLite file on disk.
 *
 * Flush strategy:
 *   - Write operations schedule a debounced async flush (500ms window).
 *   - Consecutive writes within the window are coalesced into a single I/O.
 *   - `close()` performs a final synchronous flush for deactivation safety.
 *   - Writes use atomic rename (tmp → real) to prevent corruption on crash.
 *
 * Usage:
 *   const db = await ArtifactDB.create('/path/to/coogent.db');
 *   db.tasks.upsert(taskId, { summary: 'Hello' });
 *   const task = db.tasks.get(taskId);
 *   db.close();
 */
export class ArtifactDB {

    private db: Database;
    private readonly dbPath: string;

    /** Path to the `.lock` file used for multi-instance protection. */
    private readonly lockFilePath: string;

    /** Cached reference to the process 'exit' handler so it can be removed on close(). */
    private exitHandler: (() => void) | undefined;

    /** Handle for the debounced flush timer (cleared on immediate flush). */
    private flushTimer: ReturnType<typeof setTimeout> | undefined;

    /** Promise chain serialising async flushes to prevent concurrent writes. */
    private flushLock: Promise<void> = Promise.resolve();

    /** S1-5 (EH-2): Tracks whether in-memory state has un-persisted changes. */
    private _isDirty = false;

    /** S3-2 (OB-4): Rolling max flush duration for observability. */
    private _lastFlushDurationMs = 0;

    /** H-2 P6: Timestamp of last successful backup (epoch ms, 0 = never). */
    private _lastBackupAt = 0;

    // ── Repository accessors (lazy-initialized) ──────────────────────────
    private _tasks: TaskRepository | undefined;
    private _phases: PhaseRepository | undefined;
    private _handoffs: HandoffRepository | undefined;
    private _verdicts: VerdictRepository | undefined;
    private _sessions: SessionRepository | undefined;
    private _audits: AuditRepository | undefined;
    private _contextManifests: ContextManifestRepository | undefined;

    /** Task aggregate repository. */
    get tasks(): TaskRepository {
        return (this._tasks ??= new TaskRepository(this.db, () => this.scheduleFlush()));
    }

    /** Phase aggregate repository (plans, outputs, logs). */
    get phases(): PhaseRepository {
        return (this._phases ??= new PhaseRepository(this.db, () => this.scheduleFlush()));
    }

    /** Handoff repository. */
    get handoffs(): HandoffRepository {
        return (this._handoffs ??= new HandoffRepository(this.db, () => this.scheduleFlush()));
    }

    /** Verdict repository (evaluations + healing attempts). */
    get verdicts(): VerdictRepository {
        return (this._verdicts ??= new VerdictRepository(this.db, () => this.scheduleFlush()));
    }

    /** Session repository. */
    get sessions(): SessionRepository {
        return (this._sessions ??= new SessionRepository(this.db, () => this.scheduleFlush()));
    }

    /** Audit repository (plan revisions + selection audits). */
    get audits(): AuditRepository {
        return (this._audits ??= new AuditRepository(this.db, () => this.scheduleFlush()));
    }

    /** Context manifest repository. */
    get contextManifests(): ContextManifestRepository {
        return (this._contextManifests ??= new ContextManifestRepository(this.db, () => this.scheduleFlush()));
    }

    /**
     * Delete a session and its associated task record from the database.
     * Convenience wrapper consistent with the `upsertSession` public API.
     */
    deleteSessionFromDB(sessionDirName: string): void {
        this.sessions.delete(sessionDirName);
    }

    // ── Private constructor — use ArtifactDB.create() ────────────────────
    private constructor(db: Database, dbPath: string) {
        this.db = db;
        this.dbPath = dbPath;
        this.lockFilePath = dbPath + '.lock';
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Factory
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Initialise sql.js WASM, load an existing DB file from disk (or create
     * a new one), run schema migrations, and return an `ArtifactDB` instance.
     *
     * The WASM binary is resolved relative to `__dirname` so it works after
     * esbuild bundles everything into `out/extension.js`.
     */
    static async create(dbPath: string): Promise<ArtifactDB> {
        // ── H-1 P5: Acquire file lock for multi-instance protection ────────
        await ArtifactDB.acquireLock(dbPath);

        // Dynamic import — avoids top-level CJS require() and defers WASM
        // loading until the factory is actually called.
        const initSqlJs = (await import('sql.js')).default as (
            config?: { locateFile?: (file: string) => string }
        ) => Promise<SqlJsStatic>;

        const SQL = await initSqlJs({
            locateFile: (file: string) => path.join(__dirname, file),
        });

        let db: Database;

        // Load existing DB from disk, or create a fresh one (async I/O)
        let existingData: Buffer | null = null;
        try {
            existingData = await fsp.readFile(dbPath);
        } catch {
            // ENOENT — fresh database will be created below
        }

        if (existingData) {
            db = new SQL.Database(existingData);
        } else {
            // Ensure parent directory exists
            await fsp.mkdir(path.dirname(dbPath), { recursive: true });
            db = new SQL.Database();
        }

        // NOTE: WAL mode is a no-op in sql.js (pure WASM in-memory engine).
        // Persistence is handled by flush() which atomically writes the full
        // database image to disk. No -wal sidecar file is produced.

        // Run DDL and version-gated migrations (idempotent, extracted to ArtifactDBSchema)
        initializeSchema(db);


        const instance = new ArtifactDB(db, dbPath);

        // Register process exit handler to clean up lock file on crash
        instance.exitHandler = () => instance.disposeLock();
        process.on('exit', instance.exitHandler);

        // Initial flush to persist the schema to disk (async — safe in factory)
        await instance.flushAsync();

        return instance;
    }

    // ─────────────────────────────────────────────────────────────────────
    //  H-1 P5: File Lock — Multi-Instance Protection
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Attempt to acquire an exclusive `.lock` file for the given DB path.
     * Writes the current process PID for debugging. If a lock already exists,
     * checks whether the holding PID is still alive; stale locks from dead
     * processes are automatically cleaned up and retried.
     *
     * @throws Error if another live VS Code process holds the lock.
     */
    private static async acquireLock(dbPath: string): Promise<void> {
        const lockPath = dbPath + '.lock';

        // Ensure parent directory exists (lock file lives alongside the DB)
        await fsp.mkdir(path.dirname(lockPath), { recursive: true });

        try {
            // 'wx' = exclusive create: fails if file already exists
            const fd = await fsp.open(lockPath, 'wx');
            await fd.writeFile(String(process.pid));
            await fd.close();
            // Lock acquired
        } catch (err: unknown) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code !== 'EEXIST') {
                throw err; // Unexpected error — propagate
            }

            // Lock file exists — check if the holder is still alive
            let holderPid: number | null = null;
            try {
                const content = await fsp.readFile(lockPath, 'utf-8');
                holderPid = parseInt(content.trim(), 10);
            } catch {
                // Lock file disappeared between our check and read — retry
                await ArtifactDB.acquireLock(dbPath);
                return;
            }

            if (Number.isNaN(holderPid) || holderPid <= 0) {
                // Corrupt lock file — delete and retry
                await fsp.unlink(lockPath).catch(() => { });
                await ArtifactDB.acquireLock(dbPath);
                return;
            }

            // Check if the PID is still alive (signal 0 = existence check)
            let isAlive = false;
            try {
                process.kill(holderPid, 0);
                isAlive = true;
            } catch {
                // Process is dead — stale lock
            }

            if (isAlive) {
                throw new Error(
                    'Another VS Code window is using this workspace\'s Coogent database. ' +
                    'Only one instance can write at a time.'
                );
            }

            // Stale lock from a dead process — clean up and retry
            log.info(`[ArtifactDB] Removing stale lock file (PID ${holderPid} is dead)`);
            await fsp.unlink(lockPath).catch(() => { });
            await ArtifactDB.acquireLock(dbPath);
        }
    }

    /**
     * Remove the `.lock` file and unregister the process exit handler.
     * Safe to call multiple times (idempotent).
     */
    private disposeLock(): void {
        try {
            fs.unlinkSync(this.lockFilePath);
        } catch {
            // Lock file already removed or never created — safe to ignore
        }

        if (this.exitHandler) {
            process.removeListener('exit', this.exitHandler);
            this.exitHandler = undefined;
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Lifecycle
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Export the database to disk one final time and free WASM memory.
     * After calling `close()`, the instance must not be used.
     *
     * Uses synchronous flush because VS Code's `deactivate()` may not
     * await async operations reliably.
     */
    close(): void {
        // Cancel any pending debounced flush
        if (this.flushTimer !== undefined) {
            clearTimeout(this.flushTimer);
            this.flushTimer = undefined;
        }
        this.flushSync();
        this.db.close();

        // H-1 P5: Release the lock file on close
        this.disposeLock();
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Private — Disk Persistence
    // ─────────────────────────────────────────────────────────────────────

    /** S1-5 (EH-2): Check if the DB has unflushed changes. */
    get isDirty(): boolean {
        return this._isDirty;
    }

    /** S3-2 (OB-4): Duration of last flush in milliseconds. */
    get lastFlushDurationMs(): number {
        return this._lastFlushDurationMs;
    }

    /**
     * Schedule an async flush with debouncing. Multiple calls within the
     * debounce window (500ms) are coalesced into a single disk write.
     * This prevents event-loop blocking during rapid phase completions.
     */
    private scheduleFlush(): void {
        this._isDirty = true;
        if (this.flushTimer !== undefined) {
            clearTimeout(this.flushTimer);
        }
        this.flushTimer = setTimeout(() => {
            this.flushTimer = undefined;
            this.flushAsync().catch(log.onError);
        }, FLUSH_DEBOUNCE_MS);
    }

    /**
     * Async flush: export the in-memory DB to disk using atomic rename.
     * Writes are serialised through `flushLock` to prevent concurrent I/O.
     *
     * S1-5 (EH-2): Surfaces failures via VS Code warning.
     * S3-2 (OB-4): Instruments flush duration.
     *
     * Pattern: write to `.tmp` → rename to real path (atomic on POSIX).
     * If the write fails, the previous DB file remains intact.
     */
    private async flushAsync(): Promise<void> {
        const ticket = this.flushLock.then(async () => {
            const start = performance.now();
            try {
                const data = this.db.export();
                const buffer = Buffer.from(data);
                const tmpPath = this.dbPath + '.tmp';
                await fsp.writeFile(tmpPath, buffer, { mode: DB_FILE_MODE });
                await fsp.rename(tmpPath, this.dbPath);
                this._isDirty = false;
                this._lastFlushDurationMs = performance.now() - start;

                // S3-2: Warn if flush is slow (> 200ms)
                if (this._lastFlushDurationMs > 200) {
                    log.warn(`ArtifactDB: flush took ${this._lastFlushDurationMs.toFixed(0)}ms`);
                }

                // H-2 P6: Trigger periodic backup after successful flush
                await this.backupIfDue();
            } catch (err) {
                this._isDirty = true;
                this._lastFlushDurationMs = performance.now() - start;
                log.error(`ArtifactDB: flush failed: ${err}`);

                // S1-5 (EH-2): Surface failure to user
                vscode.window.showWarningMessage(
                    `Coogent: Database flush failed. Changes are still in memory. Error: ${err}`
                );
            }
        });
        this.flushLock = ticket.catch(() => { /* swallow — errors already logged */ });
        return ticket;
    }

    /**
     * Synchronous flush for use in `close()` only.
     *
     * VS Code's `deactivate()` may not reliably await async operations,
     * so the final flush before WASM memory is freed must be synchronous.
     * Uses atomic rename (tmp → real) and sets owner-only permissions.
     */
    private flushSync(): void {
        try {
            const data = this.db.export();
            const buffer = Buffer.from(data);
            const tmpPath = this.dbPath + '.tmp';
            fs.writeFileSync(tmpPath, buffer, { mode: DB_FILE_MODE });
            fs.renameSync(tmpPath, this.dbPath);
        } catch (err) {
            log.error(`ArtifactDB: flushSync failed: ${err}`);
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    //  H-2 P6: Periodic Database Backup
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Create a timestamped backup of the database file if enough time has
     * elapsed since the last backup. Best-effort — failures are logged as
     * warnings but never thrown.
     *
     * Backup uses atomic copy (write to `.tmp` then rename) to prevent
     * partial backups. At most `MAX_BACKUPS` are retained; the oldest is
     * deleted when a new one is created beyond the limit.
     */
    private async backupIfDue(): Promise<void> {
        const now = Date.now();
        if (now - this._lastBackupAt < BACKUP_INTERVAL_MS) {
            return;
        }

        try {
            const dbDir = path.dirname(this.dbPath);
            const dbBase = path.basename(this.dbPath);
            const backupName = `${dbBase}.backup-${now}`;
            const backupPath = path.join(dbDir, backupName);
            const tmpBackupPath = backupPath + '.tmp';

            // Atomic copy: write to tmp first, then rename
            await fsp.copyFile(this.dbPath, tmpBackupPath);
            await fsp.rename(tmpBackupPath, backupPath);

            this._lastBackupAt = now;
            log.info(`[ArtifactDB] Backup created: ${backupName}`);

            // Prune old backups beyond MAX_BACKUPS
            const entries = await fsp.readdir(dbDir);
            const backupPrefix = `${dbBase}.backup-`;
            const backups = entries
                .filter(f => f.startsWith(backupPrefix))
                .sort(); // Lexicographic sort — timestamps sort correctly

            if (backups.length > MAX_BACKUPS) {
                const toDelete = backups.slice(0, backups.length - MAX_BACKUPS);
                for (const old of toDelete) {
                    await fsp.unlink(path.join(dbDir, old)).catch(() => { });
                }
            }
        } catch (err) {
            // Backups are best-effort — never throw
            log.warn(`[ArtifactDB] Backup failed: ${err}`);
        }
    }
}
