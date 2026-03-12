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
import { initializeSchema, TENANT_TABLES, type Database, type SqlJsStatic } from './ArtifactDBSchema.js';
import { ArtifactDBBackup } from './ArtifactDBBackup.js';

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
 * Multi-window safety:
 *   - Multiple Antigravity windows may share the same database file.
 *   - Each window holds its own in-memory sql.js copy.
 *   - Before flushing, the window re-reads the disk file, merges its
 *     in-memory rows via INSERT OR REPLACE, and writes atomically.
 *   - This "reload-before-write" strategy prevents lost updates.
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
    private readonly workspaceId: string;

    /** Cached sql.js factory for creating temporary merge databases during flush. */
    private readonly SQL: SqlJsStatic;

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

    /** Injected backup manager for periodic snapshots. */
    private backupManager: ArtifactDBBackup | null = null;

    /**
     * Inject an ArtifactDBBackup instance for periodic backups.
     * When set, `backupIfDue()` delegates snapshot + rotation to this manager.
     */
    setBackupManager(mgr: ArtifactDBBackup): void {
        this.backupManager = mgr;
    }

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
        return (this._tasks ??= new TaskRepository(this.db, () => this.scheduleFlush(), this.workspaceId));
    }

    /** Phase aggregate repository (plans, outputs, logs). */
    get phases(): PhaseRepository {
        return (this._phases ??= new PhaseRepository(this.db, () => this.scheduleFlush(), this.workspaceId));
    }

    /** Handoff repository. */
    get handoffs(): HandoffRepository {
        return (this._handoffs ??= new HandoffRepository(this.db, () => this.scheduleFlush(), this.workspaceId));
    }

    /** Verdict repository (evaluations + healing attempts). */
    get verdicts(): VerdictRepository {
        return (this._verdicts ??= new VerdictRepository(this.db, () => this.scheduleFlush(), this.workspaceId));
    }

    /** Session repository. */
    get sessions(): SessionRepository {
        return (this._sessions ??= new SessionRepository(this.db, () => this.scheduleFlush(), this.workspaceId));
    }

    /** Audit repository (plan revisions + selection audits). */
    get audits(): AuditRepository {
        return (this._audits ??= new AuditRepository(this.db, () => this.scheduleFlush(), this.workspaceId));
    }

    /** Context manifest repository. */
    get contextManifests(): ContextManifestRepository {
        return (this._contextManifests ??= new ContextManifestRepository(this.db, () => this.scheduleFlush(), this.workspaceId));
    }

    /**
     * Delete a session and its associated task record from the database.
     * Convenience wrapper consistent with the `upsertSession` public API.
     */
    deleteSessionFromDB(sessionDirName: string): void {
        this.sessions.delete(sessionDirName);
    }

    // ── Private constructor — use ArtifactDB.create() ────────────────────
    private constructor(db: Database, dbPath: string, workspaceId: string, SQL: SqlJsStatic) {
        this.db = db;
        this.dbPath = dbPath;
        this.workspaceId = workspaceId;
        this.SQL = SQL;
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
     *
     * Multiple windows may call `create()` concurrently for the same DB path.
     * No exclusive lock is acquired — the reload-before-write flush strategy
     * ensures concurrent writers merge rather than overwrite each other.
     *
     * @param dbPath     Path to the SQLite database file.
     * @param workspaceId  Tenant identifier for workspace-scoped queries (default: '').
     */
    /** Timeout for sql.js WASM initialization (ms). */
    private static readonly INIT_TIMEOUT_MS = 30_000;

    static async create(dbPath: string, workspaceId: string = ''): Promise<ArtifactDB> {
        // Dynamic import — avoids top-level CJS require() and defers WASM
        // loading until the factory is actually called.
        const initSqlJs = (await import('sql.js')).default as (
            config?: { locateFile?: (file: string) => string }
        ) => Promise<SqlJsStatic>;

        // Pre-check: verify WASM binary exists before attempting init
        const wasmPath = path.join(__dirname, 'sql-wasm.wasm');
        if (!fs.existsSync(wasmPath)) {
            throw new Error(
                `[ArtifactDB] sql-wasm.wasm not found at: ${wasmPath}. ` +
                `Ensure the build step (node esbuild.js) has run successfully.`
            );
        }

        const SQL = await Promise.race([
            initSqlJs({
                locateFile: (file: string) => path.join(__dirname, file),
            }),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error(
                    `[ArtifactDB] initSqlJs timed out after ${ArtifactDB.INIT_TIMEOUT_MS}ms. ` +
                    `WASM path: ${wasmPath}`
                )), ArtifactDB.INIT_TIMEOUT_MS)
            ),
        ]);

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

        const instance = new ArtifactDB(db, dbPath, workspaceId, SQL);

        // Initial flush to persist the schema to disk (async — safe in factory)
        await instance.flushAsync();

        return instance;
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Multi-Window Merge — Reload-Before-Write
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Get the column names for a table in the given database.
     */
    private static getTableColumns(db: Database, table: string): string[] {
        const rows = db.exec(`PRAGMA table_info(${table})`);
        if (rows.length === 0) return [];
        // table_info returns: cid, name, type, notnull, dflt_value, pk
        return rows[0].values.map(row => row[1] as string);
    }

    /**
     * Reload the on-disk database and merge this instance's in-memory rows
     * on top of it. Returns the merged database image as a `Uint8Array`.
     *
     * Strategy:
     *   1. Read the current disk file into a temporary sql.js Database.
     *   2. For every tenant-owned table, export all rows from the in-memory
     *      DB and INSERT OR REPLACE them into the disk-loaded copy.
     *   3. Also merge the schema_version table.
     *   4. Export the merged copy and return it.
     *
     * If the disk file does not exist (first write), the in-memory DB is
     * exported directly without merging.
     */
    private async reloadAndMergeAsync(): Promise<Uint8Array> {
        let diskData: Buffer | null = null;
        try {
            diskData = await fsp.readFile(this.dbPath);
        } catch {
            // ENOENT — no file on disk yet; just export in-memory DB
        }

        if (!diskData) {
            return this.db.export();
        }

        // Load disk state into a temporary database
        const diskDb = new this.SQL.Database(diskData);
        try {
            initializeSchema(diskDb); // Ensure disk copy has latest schema
            return ArtifactDB.mergeInto(diskDb, this.db);
        } finally {
            diskDb.close();
        }
    }

    /**
     * Synchronous variant for use in `close()` only.
     * Reads the disk file synchronously and merges.
     */
    private reloadAndMergeSync(): Uint8Array {
        let diskData: Buffer | null = null;
        try {
            diskData = fs.readFileSync(this.dbPath);
        } catch {
            // ENOENT — first write
        }

        if (!diskData) {
            return this.db.export();
        }

        const diskDb = new this.SQL.Database(diskData);
        try {
            initializeSchema(diskDb);
            return ArtifactDB.mergeInto(diskDb, this.db);
        } finally {
            diskDb.close();
        }
    }

    /**
     * Merge all tenant-owned rows (+ schema_version) from `source` into `target`.
     * Uses INSERT OR REPLACE so the source's rows win on primary key conflicts.
     * Returns the exported target image.
     */
    private static mergeInto(target: Database, source: Database): Uint8Array {
        const tablesToMerge = [...TENANT_TABLES, 'schema_version'];

        for (const table of tablesToMerge) {
            const cols = ArtifactDB.getTableColumns(source, table);
            if (cols.length === 0) continue;

            // Read all rows from source
            const rows = source.exec(`SELECT ${cols.map(c => `"${c}"`).join(', ')} FROM "${table}"`);
            if (rows.length === 0 || rows[0].values.length === 0) continue;

            const placeholders = cols.map(() => '?').join(', ');
            const colList = cols.map(c => `"${c}"`).join(', ');
            const sql = `INSERT OR REPLACE INTO "${table}" (${colList}) VALUES (${placeholders})`;

            for (const row of rows[0].values) {
                target.run(sql, row as unknown[]);
            }
        }

        return target.export();
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
                // Reload-before-write: merge in-memory state onto disk state
                const mergedData = await this.reloadAndMergeAsync();
                const buffer = Buffer.from(mergedData);
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
            // Reload-before-write: merge in-memory state onto disk state
            const mergedData = this.reloadAndMergeSync();
            const buffer = Buffer.from(mergedData);
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
        if (!this.backupManager) {
            return; // No backup manager configured
        }

        try {
            await this.backupManager.createSnapshot();
            await this.backupManager.rotateBackups(MAX_BACKUPS);
            this._lastBackupAt = now;
        } catch (err) {
            // Backups are best-effort — never throw
            log.warn(`[ArtifactDB] Backup failed: ${err}`);
        }
    }
}
