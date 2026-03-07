// ─────────────────────────────────────────────────────────────────────────────
// src/mcp/ArtifactDB.ts — Persistent SQLite data-access layer for MCP artifacts
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { TaskState, PhaseArtifacts, PhaseHandoff } from './types.js';
import log from '../logger/log.js';

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
  response TEXT NOT NULL DEFAULT '',  -- DEPRECATED (BL-3): dead schema, never populated. Worker output stored in worker_outputs table.
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

-- Sprint 4: Performance indexes
CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_eval_task_phase ON evaluation_results(master_task_id, phase_id);
CREATE INDEX IF NOT EXISTS idx_heal_task_phase ON healing_attempts(master_task_id, phase_id);
CREATE INDEX IF NOT EXISTS idx_plan_task ON plan_revisions(master_task_id);

-- Sprint 4: Unique constraint on session_id (prevents duplicate session rows)
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_session_id ON sessions(session_id);
`;


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
 *   db.upsertTask(taskId, { summary: 'Hello' });
 *   const task = db.getTask(taskId);
 *   db.close();
 */
export class ArtifactDB {
    private db: Database;
    private readonly dbPath: string;

    /** Handle for the debounced flush timer (cleared on immediate flush). */
    private flushTimer: ReturnType<typeof setTimeout> | undefined;

    /** Promise chain serialising async flushes to prevent concurrent writes. */
    private flushLock: Promise<void> = Promise.resolve();

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
    //  Task CRUD
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Insert or update task-level fields. Only provided fields are overwritten.
     */
    upsertTask(
        masterTaskId: string,
        fields: {
            summary?: string;
            implementationPlan?: string;
            consolidationReport?: string;
            consolidationReportJson?: string;
            runbookJson?: string;
            completedAt?: number;
        }
    ): void {
        this.db.run('BEGIN');
        try {
            // Ensure the row exists (set created_at on initial creation)
            this.db.run(
                'INSERT OR IGNORE INTO tasks (master_task_id, created_at) VALUES (?, ?)',
                [masterTaskId, Date.now()]
            );

            if (fields.summary !== undefined) {
                this.db.run(
                    'UPDATE tasks SET summary = ? WHERE master_task_id = ?',
                    [fields.summary, masterTaskId]
                );
            }
            if (fields.implementationPlan !== undefined) {
                this.db.run(
                    'UPDATE tasks SET implementation_plan = ? WHERE master_task_id = ?',
                    [fields.implementationPlan, masterTaskId]
                );
            }
            if (fields.consolidationReport !== undefined) {
                this.db.run(
                    'UPDATE tasks SET consolidation_report = ? WHERE master_task_id = ?',
                    [fields.consolidationReport, masterTaskId]
                );
            }
            if (fields.runbookJson !== undefined) {
                this.db.run(
                    'UPDATE tasks SET runbook_json = ? WHERE master_task_id = ?',
                    [fields.runbookJson, masterTaskId]
                );
            }
            if (fields.consolidationReportJson !== undefined) {
                this.db.run(
                    'UPDATE tasks SET consolidation_report_json = ? WHERE master_task_id = ?',
                    [fields.consolidationReportJson, masterTaskId]
                );
            }
            if (fields.completedAt !== undefined) {
                this.db.run(
                    'UPDATE tasks SET completed_at = ? WHERE master_task_id = ?',
                    [fields.completedAt, masterTaskId]
                );
            }

            // Always set updated_at on any upsert
            this.db.run(
                'UPDATE tasks SET updated_at = ? WHERE master_task_id = ?',
                [Date.now(), masterTaskId]
            );

            this.db.run('COMMIT');
        } catch (e) {
            this.db.run('ROLLBACK');
            throw e;
        }
        this.scheduleFlush();
    }

    /**
     * Retrieve the full `TaskState` for a master task, including all phases
     * and handoffs, reconstructing the `Map<string, PhaseArtifacts>` from
     * DB rows.
     *
     * Returns `undefined` if the task does not exist.
     */
    getTask(masterTaskId: string): TaskState | undefined {
        // ── Task row ─────────────────────────────────────────────────────
        const taskStmt = this.db.prepare(
            'SELECT master_task_id, summary, implementation_plan, consolidation_report, consolidation_report_json, runbook_json FROM tasks WHERE master_task_id = ?'
        );
        taskStmt.bind([masterTaskId]);

        if (!taskStmt.step()) {
            taskStmt.free();
            return undefined;
        }

        const taskRow = taskStmt.getAsObject() as {
            master_task_id: string;
            summary: string | null;
            implementation_plan: string | null;
            consolidation_report: string | null;
            consolidation_report_json: string | null;
            runbook_json: string | null;
        };
        taskStmt.free();

        // ── Build phases map ─────────────────────────────────────────────
        const phases = new Map<string, PhaseArtifacts>();

        const phaseStmt = this.db.prepare(
            'SELECT phase_id, implementation_plan FROM phases WHERE master_task_id = ?'
        );
        phaseStmt.bind([masterTaskId]);

        while (phaseStmt.step()) {
            const phaseRow = phaseStmt.getAsObject() as {
                phase_id: string;
                implementation_plan: string | null;
            };
            phases.set(phaseRow.phase_id, {
                implementationPlan: phaseRow.implementation_plan ?? undefined,
            });
        }
        phaseStmt.free();

        // ── Attach handoffs to their phases ──────────────────────────────
        const handoffStmt = this.db.prepare(
            'SELECT phase_id, decisions, modified_files, blockers, completed_at FROM handoffs WHERE master_task_id = ?'
        );
        handoffStmt.bind([masterTaskId]);

        while (handoffStmt.step()) {
            const row = handoffStmt.getAsObject() as {
                phase_id: string;
                decisions: string;
                modified_files: string;
                blockers: string;
                completed_at: number;
            };

            let decisions: string[];
            let modifiedFiles: string[];
            let blockers: string[];
            try {
                decisions = JSON.parse(row.decisions) as string[];
                modifiedFiles = JSON.parse(row.modified_files) as string[];
                blockers = JSON.parse(row.blockers) as string[];
            } catch {
                // Defensive: corrupted JSON → fall back to empty arrays
                decisions = [];
                modifiedFiles = [];
                blockers = [];
            }

            const handoff: PhaseHandoff = {
                phaseId: row.phase_id,
                masterTaskId,
                decisions,
                modifiedFiles,
                blockers,
                completedAt: row.completed_at,
            };

            // Ensure phase entry exists (defensive — FK should guarantee it)
            let phase = phases.get(row.phase_id);
            if (!phase) {
                phase = {};
                phases.set(row.phase_id, phase);
            }
            phase.handoff = handoff;
        }
        handoffStmt.free();

        // ── Assemble TaskState ───────────────────────────────────────────
        const taskState: TaskState = {
            masterTaskId: taskRow.master_task_id,
            summary: taskRow.summary ?? undefined,
            implementationPlan: taskRow.implementation_plan ?? undefined,
            consolidationReport: taskRow.consolidation_report ?? undefined,
            consolidationReportJson: taskRow.consolidation_report_json ?? undefined,
            runbookJson: taskRow.runbook_json ?? undefined,
            phases,
        };

        return taskState;
    }

    /**
     * Delete a task and all its child rows.
     * Manually cascades because sql.js does not honour ON DELETE CASCADE.
     */
    deleteTask(masterTaskId: string): void {
        this.db.run('BEGIN');
        try {
            this.db.run('DELETE FROM evaluation_results WHERE master_task_id = ?', [masterTaskId]);
            this.db.run('DELETE FROM healing_attempts WHERE master_task_id = ?', [masterTaskId]);
            this.db.run('DELETE FROM plan_revisions WHERE master_task_id = ?', [masterTaskId]);
            this.db.run('DELETE FROM handoffs WHERE master_task_id = ?', [masterTaskId]);
            this.db.run('DELETE FROM worker_outputs WHERE master_task_id = ?', [masterTaskId]);
            this.db.run('DELETE FROM phase_logs WHERE master_task_id = ?', [masterTaskId]);
            this.db.run('DELETE FROM phases WHERE master_task_id = ?', [masterTaskId]);
            // H3 audit fix: Cascade to sessions (prevents orphan session rows)
            this.db.run('DELETE FROM sessions WHERE session_dir_name = ?', [masterTaskId]);
            this.db.run('DELETE FROM tasks WHERE master_task_id = ?', [masterTaskId]);
            this.db.run('COMMIT');
        } catch (e) {
            this.db.run('ROLLBACK');
            throw e;
        }
        this.scheduleFlush();
    }

    /**
     * List all master task IDs in the database.
     */
    listTaskIds(): string[] {
        const results = this.db.exec('SELECT master_task_id FROM tasks ORDER BY master_task_id');
        if (results.length === 0) {
            return [];
        }
        return results[0].values.map((row: unknown[]) => row[0] as string);
    }

    /**
     * List all phase IDs belonging to a given master task.
     * Lighter than `getTask()` — avoids deserializing handoff JSON arrays.
     */
    listPhaseIds(masterTaskId: string): string[] {
        const stmt = this.db.prepare(
            'SELECT phase_id FROM phases WHERE master_task_id = ? ORDER BY phase_id'
        );
        stmt.bind([masterTaskId]);

        const ids: string[] = [];
        while (stmt.step()) {
            const row = stmt.getAsObject() as { phase_id: string };
            ids.push(row.phase_id);
        }
        stmt.free();
        return ids;
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Phase CRUD
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Insert or update a phase-level implementation plan.
     * Ensures the parent task row exists first.
     */
    upsertPhasePlan(masterTaskId: string, phaseId: string, plan: string): void {
        // Ensure parent task exists
        this.db.run(
            'INSERT OR IGNORE INTO tasks (master_task_id) VALUES (?)',
            [masterTaskId]
        );

        this.db.run(
            `INSERT INTO phases (master_task_id, phase_id, implementation_plan)
             VALUES (?, ?, ?)
             ON CONFLICT(master_task_id, phase_id)
             DO UPDATE SET implementation_plan = excluded.implementation_plan`,
            [masterTaskId, phaseId, plan]
        );

        this.scheduleFlush();
    }

    /**
     * Get a phase-level implementation plan.
     */
    getPhasePlan(masterTaskId: string, phaseId: string): string | undefined {
        const stmt = this.db.prepare(
            'SELECT implementation_plan FROM phases WHERE master_task_id = ? AND phase_id = ?'
        );
        stmt.bind([masterTaskId, phaseId]);

        if (!stmt.step()) {
            stmt.free();
            return undefined;
        }

        const row = stmt.getAsObject() as { implementation_plan: string | null };
        stmt.free();
        return row.implementation_plan ?? undefined;
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Handoff CRUD
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Insert or update a phase handoff. `decisions`, `modifiedFiles`, and
     * `blockers` arrays are serialized as JSON strings for storage.
     * Ensures the parent task and phase rows exist first.
     */
    upsertHandoff(handoff: PhaseHandoff): void {
        const { masterTaskId, phaseId, decisions, modifiedFiles, blockers, completedAt, nextStepsContext } = handoff;

        this.db.run('BEGIN');
        try {
            // Ensure parent task exists
            this.db.run(
                'INSERT OR IGNORE INTO tasks (master_task_id) VALUES (?)',
                [masterTaskId]
            );

            // Ensure parent phase exists
            this.db.run(
                'INSERT OR IGNORE INTO phases (master_task_id, phase_id) VALUES (?, ?)',
                [masterTaskId, phaseId]
            );

            this.db.run(
                `INSERT INTO handoffs (master_task_id, phase_id, decisions, modified_files, blockers, completed_at, next_steps_context)
                 VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(master_task_id, phase_id)
                 DO UPDATE SET decisions = excluded.decisions,
                               modified_files = excluded.modified_files,
                               blockers = excluded.blockers,
                               completed_at = excluded.completed_at,
                               next_steps_context = excluded.next_steps_context`,
                [
                    masterTaskId,
                    phaseId,
                    JSON.stringify(decisions),
                    JSON.stringify(modifiedFiles),
                    JSON.stringify(blockers),
                    completedAt,
                    nextStepsContext ?? '',
                ]
            );

            this.db.run('COMMIT');
        } catch (e) {
            this.db.run('ROLLBACK');
            throw e;
        }
        this.scheduleFlush();
    }

    /**
     * Retrieve a phase handoff, deserializing JSON strings back to arrays.
     */
    getHandoff(masterTaskId: string, phaseId: string): PhaseHandoff | undefined {
        const stmt = this.db.prepare(
            'SELECT phase_id, decisions, modified_files, blockers, completed_at, next_steps_context FROM handoffs WHERE master_task_id = ? AND phase_id = ?'
        );
        stmt.bind([masterTaskId, phaseId]);

        if (!stmt.step()) {
            stmt.free();
            return undefined;
        }

        const row = stmt.getAsObject() as {
            phase_id: string;
            decisions: string;
            modified_files: string;
            blockers: string;
            completed_at: number;
            next_steps_context: string;
        };
        stmt.free();

        let decisions: string[];
        let modifiedFiles: string[];
        let blockers: string[];
        try {
            decisions = JSON.parse(row.decisions) as string[];
            modifiedFiles = JSON.parse(row.modified_files) as string[];
            blockers = JSON.parse(row.blockers) as string[];
        } catch {
            // Defensive: corrupted JSON → fall back to empty arrays
            decisions = [];
            modifiedFiles = [];
            blockers = [];
        }

        return {
            phaseId: row.phase_id,
            masterTaskId,
            decisions,
            modifiedFiles,
            blockers,
            completedAt: row.completed_at,
            nextStepsContext: row.next_steps_context || undefined,
        };
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Worker Output CRUD
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Persist accumulated worker output for a phase.
     * Each phase's output is stored as a single TEXT blob.
     */
    upsertWorkerOutput(masterTaskId: string, phaseId: string, output: string, stderr: string = ''): void {
        // Ensure parent task exists
        this.db.run(
            'INSERT OR IGNORE INTO tasks (master_task_id) VALUES (?)',
            [masterTaskId]
        );

        this.db.run(
            `INSERT INTO worker_outputs (master_task_id, phase_id, output, stderr)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(master_task_id, phase_id)
             DO UPDATE SET output = excluded.output, stderr = excluded.stderr`,
            [masterTaskId, phaseId, output, stderr]
        );

        this.scheduleFlush();
    }

    /**
     * Retrieve all worker outputs for a task, keyed by phase_id.
     */
    getWorkerOutputs(masterTaskId: string): Record<string, string> {
        const stmt = this.db.prepare(
            'SELECT phase_id, output FROM worker_outputs WHERE master_task_id = ?'
        );
        stmt.bind([masterTaskId]);

        const result: Record<string, string> = {};
        while (stmt.step()) {
            const row = stmt.getAsObject() as { phase_id: string; output: string };
            result[row.phase_id] = row.output;
        }
        stmt.free();
        return result;
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Session CRUD
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Insert or update a session record.
     * Replaces the old `current-session` file approach.
     */
    upsertSession(
        dirName: string,
        sessionId: string,
        prompt: string,
        createdAt: number
    ): void {
        // FK safety: ensure parent task row exists (matches upsertHandoff pattern)
        this.db.run(
            'INSERT OR IGNORE INTO tasks (master_task_id, created_at) VALUES (?, ?)',
            [dirName, createdAt]
        );

        this.db.run(
            `INSERT INTO sessions (session_dir_name, session_id, prompt, created_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(session_dir_name)
             DO UPDATE SET session_id = excluded.session_id,
                           prompt = excluded.prompt,
                           created_at = excluded.created_at`,
            [dirName, sessionId, prompt, createdAt]
        );
        this.scheduleFlush();
    }

    /**
     * Retrieve the most recently created session.
     * Returns `undefined` if no sessions have been recorded.
     */
    getLatestSession(): { dirName: string; sessionId: string; prompt: string; createdAt: number } | undefined {
        const stmt = this.db.prepare(
            'SELECT session_dir_name, session_id, prompt, created_at FROM sessions ORDER BY created_at DESC LIMIT 1'
        );

        if (!stmt.step()) {
            stmt.free();
            return undefined;
        }

        const row = stmt.getAsObject() as {
            session_dir_name: string;
            session_id: string;
            prompt: string;
            created_at: number;
        };
        stmt.free();

        return {
            dirName: row.session_dir_name,
            sessionId: row.session_id,
            prompt: row.prompt,
            createdAt: row.created_at,
        };
    }

    /**
     * List all sessions, joined with tasks to include runbook status.
     * Ordered by created_at descending (most recent first).
     * Used by SessionManager to replace the IPC-based directory scan.
     */
    listSessions(): Array<{
        sessionDirName: string;
        sessionId: string;
        prompt: string;
        createdAt: number;
        runbookJson: string | null;
        status: string | null;
    }> {
        const stmt = this.db.prepare(
            `SELECT s.session_dir_name, s.session_id, s.prompt, s.created_at,
                    t.runbook_json, t.status
             FROM sessions s
             LEFT JOIN tasks t ON s.session_dir_name = t.master_task_id
             ORDER BY s.created_at DESC`
        );

        const results: Array<{
            sessionDirName: string;
            sessionId: string;
            prompt: string;
            createdAt: number;
            runbookJson: string | null;
            status: string | null;
        }> = [];

        while (stmt.step()) {
            const row = stmt.getAsObject() as {
                session_dir_name: string;
                session_id: string;
                prompt: string;
                created_at: number;
                runbook_json: string | null;
                status: string | null;
            };
            results.push({
                sessionDirName: row.session_dir_name,
                sessionId: row.session_id,
                prompt: row.prompt,
                createdAt: row.created_at,
                runbookJson: row.runbook_json,
                status: row.status,
            });
        }
        stmt.free();
        return results;
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Phase Log CRUD
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Insert or update a phase execution log.
     * Only provided fields are overwritten (partial upsert).
     */
    upsertPhaseLog(
        masterTaskId: string,
        phaseId: string,
        fields: {
            prompt?: string;
            requestContext?: string;
            response?: string;
            exitCode?: number;
            startedAt?: number;
            completedAt?: number;
        }
    ): void {
        this.db.run('BEGIN');
        try {
            // Ensure the row exists with defaults
            this.db.run(
                `INSERT OR IGNORE INTO phase_logs (master_task_id, phase_id) VALUES (?, ?)`,
                [masterTaskId, phaseId]
            );

            if (fields.prompt !== undefined) {
                this.db.run(
                    'UPDATE phase_logs SET prompt = ? WHERE master_task_id = ? AND phase_id = ?',
                    [fields.prompt, masterTaskId, phaseId]
                );
            }
            if (fields.requestContext !== undefined) {
                this.db.run(
                    'UPDATE phase_logs SET request_context = ? WHERE master_task_id = ? AND phase_id = ?',
                    [fields.requestContext, masterTaskId, phaseId]
                );
            }
            if (fields.response !== undefined) {
                this.db.run(
                    'UPDATE phase_logs SET response = ? WHERE master_task_id = ? AND phase_id = ?',
                    [fields.response, masterTaskId, phaseId]
                );
            }
            if (fields.exitCode !== undefined) {
                this.db.run(
                    'UPDATE phase_logs SET exit_code = ? WHERE master_task_id = ? AND phase_id = ?',
                    [fields.exitCode, masterTaskId, phaseId]
                );
            }
            if (fields.startedAt !== undefined) {
                this.db.run(
                    'UPDATE phase_logs SET started_at = ? WHERE master_task_id = ? AND phase_id = ?',
                    [fields.startedAt, masterTaskId, phaseId]
                );
            }
            if (fields.completedAt !== undefined) {
                this.db.run(
                    'UPDATE phase_logs SET completed_at = ? WHERE master_task_id = ? AND phase_id = ?',
                    [fields.completedAt, masterTaskId, phaseId]
                );
            }

            this.db.run('COMMIT');
        } catch (e) {
            this.db.run('ROLLBACK');
            throw e;
        }
        this.scheduleFlush();
    }

    /**
     * Retrieve a phase execution log.
     * Returns `undefined` if no log exists for the given phase.
     */
    getPhaseLog(
        masterTaskId: string,
        phaseId: string
    ): {
        prompt: string;
        requestContext: string;
        response: string;
        exitCode: number | null;
        startedAt: number;
        completedAt: number | null;
    } | undefined {
        const stmt = this.db.prepare(
            'SELECT prompt, request_context, response, exit_code, started_at, completed_at FROM phase_logs WHERE master_task_id = ? AND phase_id = ?'
        );
        stmt.bind([masterTaskId, phaseId]);

        if (!stmt.step()) {
            stmt.free();
            return undefined;
        }

        const row = stmt.getAsObject() as {
            prompt: string;
            request_context: string;
            response: string;
            exit_code: number | null;
            started_at: number;
            completed_at: number | null;
        };
        stmt.free();

        return {
            prompt: row.prompt,
            requestContext: row.request_context,
            response: row.response,
            exitCode: row.exit_code,
            startedAt: row.started_at,
            completedAt: row.completed_at,
        };
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Evaluation Result CRUD
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Persist an evaluation result for a phase attempt.
     */
    upsertEvaluationResult(
        masterTaskId: string,
        phaseId: string,
        fields: {
            attempt?: number;
            passed: boolean;
            reason?: string;
            retryPrompt?: string;
            evaluatorType?: string;
            evaluatedAt: number;
        }
    ): void {
        const attempt = fields.attempt ?? 1;
        this.db.run(
            `INSERT INTO evaluation_results (master_task_id, phase_id, attempt, passed, reason, retry_prompt, evaluator_type, evaluated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(master_task_id, phase_id, attempt)
             DO UPDATE SET passed = excluded.passed,
                           reason = excluded.reason,
                           retry_prompt = excluded.retry_prompt,
                           evaluator_type = excluded.evaluator_type,
                           evaluated_at = excluded.evaluated_at`,
            [
                masterTaskId,
                phaseId,
                attempt,
                fields.passed ? 1 : 0,
                fields.reason ?? '',
                fields.retryPrompt ?? null,
                fields.evaluatorType ?? null,
                fields.evaluatedAt,
            ]
        );
        this.scheduleFlush();
    }

    /**
     * Retrieve evaluation results for a task, optionally filtered by phase.
     */
    getEvaluationResults(
        masterTaskId: string,
        phaseId?: string
    ): Array<{
        phaseId: string;
        attempt: number;
        passed: boolean;
        reason: string;
        retryPrompt: string | null;
        evaluatorType: string | null;
        evaluatedAt: number;
    }> {
        const sql = phaseId
            ? 'SELECT phase_id, attempt, passed, reason, retry_prompt, evaluator_type, evaluated_at FROM evaluation_results WHERE master_task_id = ? AND phase_id = ? ORDER BY attempt'
            : 'SELECT phase_id, attempt, passed, reason, retry_prompt, evaluator_type, evaluated_at FROM evaluation_results WHERE master_task_id = ? ORDER BY phase_id, attempt';
        const stmt = this.db.prepare(sql);
        stmt.bind(phaseId ? [masterTaskId, phaseId] : [masterTaskId]);

        const results: Array<{
            phaseId: string;
            attempt: number;
            passed: boolean;
            reason: string;
            retryPrompt: string | null;
            evaluatorType: string | null;
            evaluatedAt: number;
        }> = [];

        while (stmt.step()) {
            const row = stmt.getAsObject() as {
                phase_id: string;
                attempt: number;
                passed: number;
                reason: string;
                retry_prompt: string | null;
                evaluator_type: string | null;
                evaluated_at: number;
            };
            results.push({
                phaseId: row.phase_id,
                attempt: row.attempt,
                passed: row.passed !== 0,
                reason: row.reason,
                retryPrompt: row.retry_prompt,
                evaluatorType: row.evaluator_type,
                evaluatedAt: row.evaluated_at,
            });
        }
        stmt.free();
        return results;
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Healing Attempt CRUD
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Persist a self-healing attempt for a phase.
     */
    upsertHealingAttempt(
        masterTaskId: string,
        phaseId: string,
        fields: {
            attemptNumber: number;
            exitCode?: number;
            stderrTail?: string;
            augmentedPrompt?: string;
            createdAt: number;
        }
    ): void {
        this.db.run(
            `INSERT INTO healing_attempts (master_task_id, phase_id, attempt_number, exit_code, stderr_tail, augmented_prompt, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(master_task_id, phase_id, attempt_number)
             DO UPDATE SET exit_code = excluded.exit_code,
                           stderr_tail = excluded.stderr_tail,
                           augmented_prompt = excluded.augmented_prompt,
                           created_at = excluded.created_at`,
            [
                masterTaskId,
                phaseId,
                fields.attemptNumber,
                fields.exitCode ?? null,
                fields.stderrTail ?? null,
                fields.augmentedPrompt ?? null,
                fields.createdAt,
            ]
        );
        this.scheduleFlush();
    }

    /**
     * Retrieve healing attempts for a task, optionally filtered by phase.
     */
    getHealingAttempts(
        masterTaskId: string,
        phaseId?: string
    ): Array<{
        phaseId: string;
        attemptNumber: number;
        exitCode: number | null;
        stderrTail: string | null;
        augmentedPrompt: string | null;
        createdAt: number;
    }> {
        const sql = phaseId
            ? 'SELECT phase_id, attempt_number, exit_code, stderr_tail, augmented_prompt, created_at FROM healing_attempts WHERE master_task_id = ? AND phase_id = ? ORDER BY attempt_number'
            : 'SELECT phase_id, attempt_number, exit_code, stderr_tail, augmented_prompt, created_at FROM healing_attempts WHERE master_task_id = ? ORDER BY phase_id, attempt_number';
        const stmt = this.db.prepare(sql);
        stmt.bind(phaseId ? [masterTaskId, phaseId] : [masterTaskId]);

        const results: Array<{
            phaseId: string;
            attemptNumber: number;
            exitCode: number | null;
            stderrTail: string | null;
            augmentedPrompt: string | null;
            createdAt: number;
        }> = [];

        while (stmt.step()) {
            const row = stmt.getAsObject() as {
                phase_id: string;
                attempt_number: number;
                exit_code: number | null;
                stderr_tail: string | null;
                augmented_prompt: string | null;
                created_at: number;
            };
            results.push({
                phaseId: row.phase_id,
                attemptNumber: row.attempt_number,
                exitCode: row.exit_code,
                stderrTail: row.stderr_tail,
                augmentedPrompt: row.augmented_prompt,
                createdAt: row.created_at,
            });
        }
        stmt.free();
        return results;
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Plan Revision CRUD
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Persist a plan revision with auto-incrementing version.
     */
    upsertPlanRevision(
        masterTaskId: string,
        fields: {
            feedback?: string;
            draftJson: string;
            implementationPlanMd?: string;
            status?: string;
        }
    ): void {
        // Ensure parent task exists
        this.db.run(
            'INSERT OR IGNORE INTO tasks (master_task_id) VALUES (?)',
            [masterTaskId]
        );

        // Determine next version number
        const versionStmt = this.db.prepare(
            'SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM plan_revisions WHERE master_task_id = ?'
        );
        versionStmt.bind([masterTaskId]);
        versionStmt.step();
        const nextVersion = (versionStmt.getAsObject() as { next_version: number }).next_version;
        versionStmt.free();

        this.db.run(
            `INSERT INTO plan_revisions (master_task_id, version, feedback, draft_json, implementation_plan_md, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                masterTaskId,
                nextVersion,
                fields.feedback ?? null,
                fields.draftJson,
                fields.implementationPlanMd ?? null,
                fields.status ?? 'draft',
                Date.now(),
            ]
        );

        this.scheduleFlush();
    }

    /**
     * Retrieve all plan revisions for a task, ordered by version.
     */
    getPlanRevisions(
        masterTaskId: string
    ): Array<{
        version: number;
        feedback: string | null;
        draftJson: string;
        implementationPlanMd: string | null;
        status: string;
        createdAt: number;
    }> {
        const stmt = this.db.prepare(
            'SELECT version, feedback, draft_json, implementation_plan_md, status, created_at FROM plan_revisions WHERE master_task_id = ? ORDER BY version'
        );
        stmt.bind([masterTaskId]);

        const results: Array<{
            version: number;
            feedback: string | null;
            draftJson: string;
            implementationPlanMd: string | null;
            status: string;
            createdAt: number;
        }> = [];

        while (stmt.step()) {
            const row = stmt.getAsObject() as {
                version: number;
                feedback: string | null;
                draft_json: string;
                implementation_plan_md: string | null;
                status: string;
                created_at: number;
            };
            results.push({
                version: row.version,
                feedback: row.feedback,
                draftJson: row.draft_json,
                implementationPlanMd: row.implementation_plan_md,
                status: row.status,
                createdAt: row.created_at,
            });
        }
        stmt.free();
        return results;
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Private — Disk Persistence
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Schedule an async flush with debouncing. Multiple calls within the
     * debounce window (500ms) are coalesced into a single disk write.
     * This prevents event-loop blocking during rapid phase completions.
     */
    private scheduleFlush(): void {
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
     * Pattern: write to `.tmp` → rename to real path (atomic on POSIX).
     * If the write fails, the previous DB file remains intact.
     */
    private async flushAsync(): Promise<void> {
        const ticket = this.flushLock.then(async () => {
            try {
                const data = this.db.export();
                const buffer = Buffer.from(data);
                const tmpPath = this.dbPath + '.tmp';
                await fsp.writeFile(tmpPath, buffer, { mode: DB_FILE_MODE });
                await fsp.rename(tmpPath, this.dbPath);
            } catch (err) {
                log.error(`ArtifactDB: flush failed: ${err}`);
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
