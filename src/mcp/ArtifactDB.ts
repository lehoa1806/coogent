// ─────────────────────────────────────────────────────────────────────────────
// src/mcp/ArtifactDB.ts — Persistent SQLite data-access layer for MCP artifacts
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TaskState, PhaseArtifacts, PhaseHandoff } from './types.js';

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
  consolidation_report TEXT
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
  PRIMARY KEY (master_task_id, phase_id),
  FOREIGN KEY (master_task_id, phase_id) REFERENCES phases(master_task_id, phase_id) ON DELETE CASCADE
);
`;

// ═══════════════════════════════════════════════════════════════════════════════
//  ArtifactDB
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Thin, typed data-access layer wrapping sql.js for persistent MCP artifact
 * storage. All data is persisted to a single SQLite file on disk.
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

        // Load existing DB from disk, or create a fresh one
        if (fs.existsSync(dbPath)) {
            const buffer = fs.readFileSync(dbPath);
            db = new SQL.Database(buffer);
        } else {
            // Ensure parent directory exists
            const dir = path.dirname(dbPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
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

        // Initial flush to persist the schema to disk
        instance.flush();

        return instance;
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Lifecycle
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Export the database to disk one final time and free WASM memory.
     * After calling `close()`, the instance must not be used.
     */
    close(): void {
        this.flush();
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
        }
    ): void {
        this.db.run('BEGIN');
        try {
            // Ensure the row exists
            this.db.run(
                'INSERT OR IGNORE INTO tasks (master_task_id) VALUES (?)',
                [masterTaskId]
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

            this.db.run('COMMIT');
        } catch (e) {
            this.db.run('ROLLBACK');
            throw e;
        }
        this.flush();
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
            'SELECT master_task_id, summary, implementation_plan, consolidation_report FROM tasks WHERE master_task_id = ?'
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
            phases,
        };

        return taskState;
    }

    /**
     * Delete a task and all its phases + handoffs (cascading via FK).
     */
    deleteTask(masterTaskId: string): void {
        this.db.run(
            'DELETE FROM tasks WHERE master_task_id = ?',
            [masterTaskId]
        );
        this.flush();
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

        this.flush();
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
        const { masterTaskId, phaseId, decisions, modifiedFiles, blockers, completedAt } = handoff;

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
                `INSERT INTO handoffs (master_task_id, phase_id, decisions, modified_files, blockers, completed_at)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT(master_task_id, phase_id)
                 DO UPDATE SET decisions = excluded.decisions,
                               modified_files = excluded.modified_files,
                               blockers = excluded.blockers,
                               completed_at = excluded.completed_at`,
                [
                    masterTaskId,
                    phaseId,
                    JSON.stringify(decisions),
                    JSON.stringify(modifiedFiles),
                    JSON.stringify(blockers),
                    completedAt,
                ]
            );

            this.db.run('COMMIT');
        } catch (e) {
            this.db.run('ROLLBACK');
            throw e;
        }
        this.flush();
    }

    /**
     * Retrieve a phase handoff, deserializing JSON strings back to arrays.
     */
    getHandoff(masterTaskId: string, phaseId: string): PhaseHandoff | undefined {
        const stmt = this.db.prepare(
            'SELECT phase_id, decisions, modified_files, blockers, completed_at FROM handoffs WHERE master_task_id = ? AND phase_id = ?'
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
        };
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Private — Disk Persistence
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Export the in-memory database to disk.
     * Called after every write operation to ensure durability.
     */
    private flush(): void {
        const data = this.db.export();
        const buffer = Buffer.from(data);
        fs.writeFileSync(this.dbPath, buffer);
    }
}
