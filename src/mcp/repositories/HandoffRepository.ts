// ─────────────────────────────────────────────────────────────────────────────
// src/mcp/repositories/HandoffRepository.ts — Handoff aggregate persistence
// ─────────────────────────────────────────────────────────────────────────────

import type { Database } from './db-types.js';
import type { PhaseHandoff } from '../types.js';

/**
 * Raw SQL row as returned by `getAsObject()` — column names match the
 * `handoffs` table definition in ArtifactDB.
 * @internal Used only for typed deserialization inside this repository.
 */
interface HandoffDbRow {
    [key: string]: unknown;
    phase_id: string;
    decisions: string;
    modified_files: string;
    blockers: string;
    completed_at: number;
    next_steps_context: string | null;
    summary: string | null;
    rationale: string | null;
    remaining_work: string | null;
    constraints_json: string | null;
    warnings: string | null;
    changed_files_json: string | null;
    workspace_folder: string | null;
    symbols_touched: string | null;
}

/**
 * Repository for the `handoffs` table.
 * Handles serialization of JSON arrays for decisions, modifiedFiles, blockers,
 * remainingWork, constraints, warnings, and symbolsTouched.
 */
export class HandoffRepository {
    constructor(
        private readonly db: Database,
        private readonly scheduleFlush: () => void,
        private readonly workspaceId: string = '',
    ) { }

    /** Insert or update a phase handoff. */
    upsert(handoff: PhaseHandoff): void {
        const {
            masterTaskId, phaseId, decisions, modifiedFiles, blockers,
            completedAt, nextStepsContext, summary, rationale,
            remainingWork, constraints, warnings, changedFilesJson,
            workspaceFolder, symbolsTouched,
        } = handoff;

        this.db.run('BEGIN');
        try {
            this.db.run('INSERT OR IGNORE INTO tasks (master_task_id, workspace_id) VALUES (?, ?)', [masterTaskId, this.workspaceId]);
            this.db.run('INSERT OR IGNORE INTO phases (master_task_id, phase_id, workspace_id) VALUES (?, ?, ?)', [masterTaskId, phaseId, this.workspaceId]);
            this.db.run(
                `INSERT INTO handoffs (
                    master_task_id, phase_id, workspace_id, decisions, modified_files, blockers,
                    completed_at, next_steps_context, summary, rationale,
                    remaining_work, constraints_json, warnings,
                    changed_files_json, workspace_folder, symbols_touched
                 )
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(master_task_id, phase_id)
                 DO UPDATE SET decisions = excluded.decisions,
                               modified_files = excluded.modified_files,
                               blockers = excluded.blockers,
                               completed_at = excluded.completed_at,
                               next_steps_context = excluded.next_steps_context,
                               summary = excluded.summary,
                               rationale = excluded.rationale,
                               remaining_work = excluded.remaining_work,
                               constraints_json = excluded.constraints_json,
                               warnings = excluded.warnings,
                               changed_files_json = excluded.changed_files_json,
                               workspace_folder = excluded.workspace_folder,
                               symbols_touched = excluded.symbols_touched`,
                [
                    masterTaskId, phaseId, this.workspaceId,
                    JSON.stringify(decisions), JSON.stringify(modifiedFiles),
                    JSON.stringify(blockers), completedAt, nextStepsContext ?? '',
                    summary ?? null, rationale ?? null,
                    remainingWork ? JSON.stringify(remainingWork) : null,
                    constraints ? JSON.stringify(constraints) : null,
                    warnings ? JSON.stringify(warnings) : null,
                    changedFilesJson ?? null,
                    workspaceFolder ?? null,
                    symbolsTouched ? JSON.stringify(symbolsTouched) : null,
                ]
            );
            this.db.run('COMMIT');
        } catch (e) {
            this.db.run('ROLLBACK');
            throw e;
        }
        this.scheduleFlush();
    }

    /** Retrieve a phase handoff. */
    get(masterTaskId: string, phaseId: string): PhaseHandoff | undefined {
        const stmt = this.db.prepare(
            `SELECT phase_id, decisions, modified_files, blockers, completed_at,
                    next_steps_context, summary, rationale, remaining_work,
                    constraints_json, warnings, changed_files_json,
                    workspace_folder, symbols_touched
             FROM handoffs WHERE master_task_id = ? AND phase_id = ?`
        );
        stmt.bind([masterTaskId, phaseId]);
        if (!stmt.step()) { stmt.free(); return undefined; }
        const row = stmt.getAsObject<HandoffDbRow>();
        stmt.free();

        const parseJsonArray = (val: string | null): string[] | undefined => {
            if (!val) { return undefined; }
            try { return JSON.parse(val) as string[]; } catch { return undefined; }
        };

        let decisions: string[], modifiedFiles: string[], blockers: string[];
        try {
            decisions = JSON.parse(row.decisions) as string[];
            modifiedFiles = JSON.parse(row.modified_files) as string[];
            blockers = JSON.parse(row.blockers) as string[];
        } catch {
            decisions = []; modifiedFiles = []; blockers = [];
        }

        return {
            phaseId: row.phase_id,
            masterTaskId,
            decisions,
            modifiedFiles,
            blockers,
            completedAt: row.completed_at,
            nextStepsContext: row.next_steps_context || undefined,
            summary: row.summary || undefined,
            rationale: row.rationale || undefined,
            remainingWork: parseJsonArray(row.remaining_work),
            constraints: parseJsonArray(row.constraints_json),
            warnings: parseJsonArray(row.warnings),
            changedFilesJson: row.changed_files_json || undefined,
            workspaceFolder: row.workspace_folder || undefined,
            symbolsTouched: parseJsonArray(row.symbols_touched),
        };
    }
}

