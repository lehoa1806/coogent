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

// sql.js ships without TS declarations — resolved via dynamic import()
// inside the create() factory method. This avoids CJS require() in an
// otherwise ESM-style codebase and ensures the WASM binary is only loaded
// when actually needed.

interface SqlJsStatic {
    Database: new (data?: ArrayLike<number>) => Database;
}

interface Database {
    run(sql: string, params?: unknown[]): void;
    exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>;
    prepare(sql: string): Statement;
    export(): Uint8Array;
    close(): void;
}

interface Statement {
    bind(params?: unknown[]): boolean;
    step(): boolean;
    getAsObject(): Record<string, unknown>;
    free(): void;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SQL Schema — DDL executed on every open (CREATE IF NOT EXISTS)
// ═══════════════════════════════════════════════════════════════════════════════

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tasks (
  master_task_id TEXT PRIMARY KEY,
  summary TEXT,
  implementation_plan TEXT,
  consolidation_report TEXT,
  consolidation_report_json TEXT,
  runbook_json TEXT,
  created_at INTEGER NOT NULL DEFAULT 0,
  completed_at INTEGER,
  updated_at INTEGER,
  status TEXT NOT NULL DEFAULT 'running'
);

CREATE TABLE IF NOT EXISTS phases (
  phase_id TEXT NOT NULL,
  master_task_id TEXT NOT NULL,
  implementation_plan TEXT,
  PRIMARY KEY (master_task_id, phase_id),
  FOREIGN KEY (master_task_id) REFERENCES tasks(master_task_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS handoffs (
  phase_id TEXT NOT NULL,
  master_task_id TEXT NOT NULL,
  decisions TEXT NOT NULL,
  modified_files TEXT NOT NULL,
  blockers TEXT NOT NULL,
  completed_at INTEGER NOT NULL,
  next_steps_context TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (master_task_id, phase_id),
  FOREIGN KEY (master_task_id, phase_id) REFERENCES phases(master_task_id, phase_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS worker_outputs (
  master_task_id TEXT NOT NULL,
  phase_id TEXT NOT NULL,
  output TEXT NOT NULL DEFAULT '',
  stderr TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (master_task_id, phase_id),
  FOREIGN KEY (master_task_id) REFERENCES tasks(master_task_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS evaluation_results (
  master_task_id TEXT NOT NULL,
  phase_id TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  passed INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  retry_prompt TEXT,
  evaluator_type TEXT,
  evaluated_at INTEGER NOT NULL,
  PRIMARY KEY (master_task_id, phase_id, attempt),
  FOREIGN KEY (master_task_id) REFERENCES tasks(master_task_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS healing_attempts (
  master_task_id TEXT NOT NULL,
  phase_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  exit_code INTEGER,
  stderr_tail TEXT,
  augmented_prompt TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (master_task_id, phase_id, attempt_number),
  FOREIGN KEY (master_task_id) REFERENCES tasks(master_task_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sessions (
  session_dir_name TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  prompt TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (session_dir_name) REFERENCES tasks(master_task_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS phase_logs (
  master_task_id TEXT NOT NULL,
  phase_id TEXT NOT NULL,
  prompt TEXT NOT NULL DEFAULT '',
  request_context TEXT NOT NULL DEFAULT '',
  response TEXT NOT NULL DEFAULT '',  -- Reserved for future use. Worker output is stored in worker_outputs table.
  exit_code INTEGER,
  started_at INTEGER NOT NULL DEFAULT 0,
  completed_at INTEGER,
  PRIMARY KEY (master_task_id, phase_id),
  FOREIGN KEY (master_task_id) REFERENCES tasks(master_task_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS plan_revisions (
  master_task_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  feedback TEXT,
  draft_json TEXT NOT NULL,
  implementation_plan_md TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (master_task_id, version),
  FOREIGN KEY (master_task_id) REFERENCES tasks(master_task_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS selection_audits (
  subtask_id TEXT PRIMARY KEY,
  subtask_spec TEXT NOT NULL,
  candidate_agents TEXT NOT NULL,
  selected_agent TEXT NOT NULL,
  selection_rationale TEXT NOT NULL,
  compiled_prompt_id TEXT NOT NULL,
  fallback_agent TEXT,
  worker_run_result TEXT,
  timestamp INTEGER NOT NULL,
  session_id TEXT NOT NULL DEFAULT ''
);

-- Sprint 4: Performance indexes
CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_eval_task_phase ON evaluation_results(master_task_id, phase_id);
CREATE INDEX IF NOT EXISTS idx_heal_task_phase ON healing_attempts(master_task_id, phase_id);
CREATE INDEX IF NOT EXISTS idx_plan_task ON plan_revisions(master_task_id);

-- Sprint 4: Unique constraint on session_id (prevents duplicate session rows)
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_session_id ON sessions(session_id);

-- Agent selection audit index
CREATE INDEX IF NOT EXISTS idx_selection_audits_session ON selection_audits(session_id);

-- S4-9: Schema version tracking for migration management
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL,
  description TEXT NOT NULL DEFAULT ''
);
`;

/** Current schema version — bump this when adding new migrations. */
const SCHEMA_VERSION = 3;


// ═══════════════════════════════════════════════════════════════════════════════
//  Flush Configuration
// ═══════════════════════════════════════════════════════════════════════════════

/** Debounce window for coalescing consecutive writes (ms). */
const FLUSH_DEBOUNCE_MS = 500;

/** File permissions for artifacts.db — owner-only read/write. */
const DB_FILE_MODE = 0o600;

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

    /** Handle for the debounced flush timer (cleared on immediate flush). */
    private flushTimer: ReturnType<typeof setTimeout> | undefined;

    /** Promise chain serialising async flushes to prevent concurrent writes. */
    private flushLock: Promise<void> = Promise.resolve();

    /** S1-5 (EH-2): Tracks whether in-memory state has un-persisted changes. */
    private _isDirty = false;

    /** S3-2 (OB-4): Rolling max flush duration for observability. */
    private _lastFlushDurationMs = 0;

    // ── Repository accessors (lazy-initialized) ──────────────────────────
    private _tasks: TaskRepository | undefined;
    private _phases: PhaseRepository | undefined;
    private _handoffs: HandoffRepository | undefined;
    private _verdicts: VerdictRepository | undefined;
    private _sessions: SessionRepository | undefined;
    private _audits: AuditRepository | undefined;

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

    // ── Private constructor — use ArtifactDB.create() ────────────────────
    private constructor(db: Database, dbPath: string) {
        this.db = db;
        this.dbPath = dbPath;
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

        // Enable foreign key enforcement
        db.run('PRAGMA foreign_keys=ON;');

        // Run schema DDL (idempotent) — exec() handles multi-statement strings;
        // run() would silently execute only the first CREATE TABLE.
        db.exec(SCHEMA_SQL);

        // ── Schema Migrations (idempotent) ────────────────────────────────
        // BL-5 audit fix: Add raw_llm_output column to plan_revisions
        try {
            db.run('ALTER TABLE plan_revisions ADD COLUMN raw_llm_output TEXT');
        } catch {
            // Column already exists — ignore
        }

        // F-6 audit fix: Add compilation_manifest column to plan_revisions
        try {
            db.run('ALTER TABLE plan_revisions ADD COLUMN compilation_manifest TEXT');
        } catch {
            // Column already exists — ignore
        }

        // S4-9: Record schema version for migration tracking
        try {
            const versionRows = db.exec('SELECT MAX(version) as v FROM schema_version');
            const currentVersion = (versionRows.length > 0 && versionRows[0].values.length > 0)
                ? (versionRows[0].values[0][0] as number ?? 0)
                : 0;
            if (currentVersion < SCHEMA_VERSION) {
                db.run(
                    'INSERT OR REPLACE INTO schema_version (version, applied_at, description) VALUES (?, ?, ?)',
                    [SCHEMA_VERSION, Date.now(), `Schema v${SCHEMA_VERSION}: selection_audits, phase_logs, plan_revisions`]
                );
                log.info(`[ArtifactDB] Schema version updated: ${currentVersion} → ${SCHEMA_VERSION}`);
            }
        } catch (err) {
            log.warn('[ArtifactDB] Schema version tracking failed:', err);
        }


        const instance = new ArtifactDB(db, dbPath);

        // Initial flush to persist the schema to disk (async — safe in factory)
        await instance.flushAsync();

        return instance;
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
}
