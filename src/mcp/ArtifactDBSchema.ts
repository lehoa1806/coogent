// ─────────────────────────────────────────────────────────────────────────────
// src/mcp/ArtifactDBSchema.ts — DDL and migration logic for ArtifactDB
//
// Extracted from ArtifactDB.ts to separate schema concerns from runtime
// persistence and repository management.
// ─────────────────────────────────────────────────────────────────────────────

import log from '../logger/log.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  sql.js Type Contracts
//
//  sql.js ships without TS declarations — these minimal interfaces define
//  the subset of the API used by ArtifactDB and its schema module.
// ═══════════════════════════════════════════════════════════════════════════════

export interface SqlJsStatic {
    Database: new (data?: ArrayLike<number>) => Database;
}

export interface Database {
    run(sql: string, params?: unknown[]): void;
    exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>;
    prepare(sql: string): Statement;
    export(): Uint8Array;
    close(): void;
}

export interface Statement {
    bind(params?: unknown[]): boolean;
    step(): boolean;
    getAsObject(): Record<string, unknown>;
    free(): void;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Tenant-Owned Tables
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Canonical list of tables that are scoped by `workspace_id`.
 * Used by ArtifactDB's reload-and-merge flush strategy and by schema migrations.
 */
export const TENANT_TABLES = [
    'tasks', 'phases', 'handoffs', 'worker_outputs', 'sessions', 'phase_logs',
    'evaluation_results', 'healing_attempts', 'plan_revisions', 'selection_audits', 'context_manifests',
] as const;

// ═══════════════════════════════════════════════════════════════════════════════
//  SQL Schema — DDL executed on every open (CREATE IF NOT EXISTS)
// ═══════════════════════════════════════════════════════════════════════════════

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tasks (
  master_task_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT '',
  summary TEXT,
  execution_plan TEXT,
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
  workspace_id TEXT NOT NULL DEFAULT '',
  execution_plan TEXT,
  PRIMARY KEY (master_task_id, phase_id),
  FOREIGN KEY (master_task_id) REFERENCES tasks(master_task_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS handoffs (
  phase_id TEXT NOT NULL,
  master_task_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT '',
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
  workspace_id TEXT NOT NULL DEFAULT '',
  output TEXT NOT NULL DEFAULT '',
  stderr TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (master_task_id, phase_id),
  FOREIGN KEY (master_task_id) REFERENCES tasks(master_task_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS evaluation_results (
  master_task_id TEXT NOT NULL,
  phase_id TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  workspace_id TEXT NOT NULL DEFAULT '',
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
  workspace_id TEXT NOT NULL DEFAULT '',
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
  workspace_id TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (session_dir_name) REFERENCES tasks(master_task_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS phase_logs (
  master_task_id TEXT NOT NULL,
  phase_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT '',
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
  workspace_id TEXT NOT NULL DEFAULT '',
  feedback TEXT,
  draft_json TEXT NOT NULL,
  execution_plan_md TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (master_task_id, version),
  FOREIGN KEY (master_task_id) REFERENCES tasks(master_task_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS selection_audits (
  subtask_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT '',
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

CREATE TABLE IF NOT EXISTS context_manifests (
  manifest_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  phase_id TEXT NOT NULL,
  workspace_folder TEXT,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ctx_manifest_phase ON context_manifests(task_id, phase_id);

-- v9-10: Tenant indexes for workspace-scoped queries
CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspace_id);
CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_id);
CREATE INDEX IF NOT EXISTS idx_eval_workspace ON evaluation_results(workspace_id);
CREATE INDEX IF NOT EXISTS idx_heal_workspace ON healing_attempts(workspace_id);
CREATE INDEX IF NOT EXISTS idx_plan_revisions_workspace ON plan_revisions(workspace_id);
CREATE INDEX IF NOT EXISTS idx_selection_audits_workspace ON selection_audits(workspace_id);
CREATE INDEX IF NOT EXISTS idx_ctx_manifest_workspace ON context_manifests(workspace_id);

`;

/** Current schema version — bump this when adding new migrations. */
export const SCHEMA_VERSION = 10;

// ═══════════════════════════════════════════════════════════════════════════════
//  Schema Initialization
// ═══════════════════════════════════════════════════════════════════════════════

/** Read the current schema version from the DB (0 if no rows). */
export function readSchemaVersion(db: Database): number {
    try {
        const rows = db.exec('SELECT MAX(version) FROM schema_version');
        if (rows.length > 0 && rows[0].values.length > 0) {
            return (rows[0].values[0][0] as number) ?? 0;
        }
    } catch { /* table might not exist yet on very first boot */ }
    return 0;
}

/**
 * Bootstrap the schema_version table, run DDL, and apply incremental
 * column migrations. Idempotent — safe to call on every open.
 *
 * @param db  The sql.js Database instance.
 */
export function initializeSchema(db: Database): void {
    // Enable foreign key enforcement
    db.run('PRAGMA foreign_keys=ON;');

    // Bootstrap the version-tracking table (always idempotent — single
    // lightweight CREATE IF NOT EXISTS) so we can read the current version.
    db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL,
        description TEXT NOT NULL DEFAULT ''
    );`);

    const currentVersion = readSchemaVersion(db);

    if (currentVersion < SCHEMA_VERSION) {
        log.info(`[ArtifactDB] Schema outdated (v${currentVersion} → v${SCHEMA_VERSION}), running migrations…`);

        // Run full DDL (idempotent) — exec() handles multi-statement strings;
        // run() would silently execute only the first CREATE TABLE.
        db.exec(SCHEMA_SQL);

        // ── Incremental column migrations (idempotent) ────────────────
        // BL-5 audit fix: Add raw_llm_output column to plan_revisions
        try {
            db.run('ALTER TABLE plan_revisions ADD COLUMN raw_llm_output TEXT');
        } catch { /* Column already exists */ }

        // F-6 audit fix: Add compilation_manifest column to plan_revisions
        try {
            db.run('ALTER TABLE plan_revisions ADD COLUMN compilation_manifest TEXT');
        } catch { /* Column already exists */ }

        // v6: Backfill tasks columns that may be missing in older DBs
        try { db.run('ALTER TABLE tasks ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0'); } catch { /* already exists */ }
        try { db.run('ALTER TABLE tasks ADD COLUMN runbook_json TEXT'); } catch { /* already exists */ }
        try { db.run('ALTER TABLE tasks ADD COLUMN consolidation_report_json TEXT'); } catch { /* already exists */ }
        try { db.run('ALTER TABLE tasks ADD COLUMN status TEXT NOT NULL DEFAULT \'running\''); } catch { /* already exists */ }
        try { db.run('ALTER TABLE tasks ADD COLUMN updated_at INTEGER'); } catch { /* already exists */ }
        try { db.run('ALTER TABLE tasks ADD COLUMN completed_at INTEGER'); } catch { /* already exists */ }

        // Plan requirement detection: add plan_required flag to phases
        try {
            db.run('ALTER TABLE phases ADD COLUMN plan_required INTEGER');
        } catch { /* Column already exists */ }

        // v5: Richer handoff columns for context sharing
        try { db.run('ALTER TABLE handoffs ADD COLUMN summary TEXT'); } catch { /* already exists */ }
        try { db.run('ALTER TABLE handoffs ADD COLUMN rationale TEXT'); } catch { /* already exists */ }
        try { db.run('ALTER TABLE handoffs ADD COLUMN remaining_work TEXT'); } catch { /* already exists */ }
        try { db.run('ALTER TABLE handoffs ADD COLUMN constraints_json TEXT'); } catch { /* already exists */ }
        try { db.run('ALTER TABLE handoffs ADD COLUMN warnings TEXT'); } catch { /* already exists */ }
        try { db.run('ALTER TABLE handoffs ADD COLUMN changed_files_json TEXT'); } catch { /* already exists */ }
        try { db.run('ALTER TABLE handoffs ADD COLUMN workspace_folder TEXT'); } catch { /* already exists */ }
        try { db.run('ALTER TABLE handoffs ADD COLUMN symbols_touched TEXT'); } catch { /* already exists */ }

        // v8: Backfill worker_outputs.stderr for older DBs
        try { db.run('ALTER TABLE worker_outputs ADD COLUMN stderr TEXT NOT NULL DEFAULT \'\''); } catch { /* already exists */ }

        // v9-10: Add workspace_id column to all tenant-owned tables (backfill with empty string sentinel)
        for (const table of TENANT_TABLES) {
            try { db.run(`ALTER TABLE ${table} ADD COLUMN workspace_id TEXT NOT NULL DEFAULT ''`); } catch { /* already exists */ }
        }

        // Record the new schema version
        db.run(
            'INSERT OR REPLACE INTO schema_version (version, applied_at, description) VALUES (?, ?, ?)',
            [SCHEMA_VERSION, Date.now(), `Schema v${SCHEMA_VERSION}: workspace_id tenanting for all tenant-owned tables`]
        );
        log.info(`[ArtifactDB] Schema migrated to v${SCHEMA_VERSION}.`);
    }
}
