// ─────────────────────────────────────────────────────────────────────────────
// src/mcp/repositories/FailureConsoleRepository.ts — Failure console persistence
// ─────────────────────────────────────────────────────────────────────────────

import type { Database } from './db-types.js';

/**
 * Raw SQL row shape for the `failure_console_records` table.
 * Column names match the DDL in ArtifactDBSchema.ts.
 */
export interface FailureConsoleRow {
    [key: string]: unknown;
    id: string;
    master_task_id: string;
    session_id: string;
    workspace_id: string;
    phase_id: string | null;
    worker_id: string | null;
    severity: string;
    scope: string;
    category: string;
    root_event_id: string | null;
    contributing_event_ids: string;
    message: string;
    evidence_json: string;
    suggested_actions_json: string;
    chosen_action_json: string | null;
    created_at: number;
    updated_at: number;
}

/**
 * Repository for the `failure_console_records` table.
 * Stores classified failure records displayed in the failure console UI.
 */
export class FailureConsoleRepository {
    constructor(
        private readonly db: Database,
        private readonly scheduleFlush: () => void,
        private readonly workspaceId: string = '',
    ) { }

    /**
     * Insert or replace a failure console record.
     *
     * @param record  The failure record to persist. Array fields
     *                (`contributingEventIds`) are serialised to JSON strings
     *                by the caller; JSON blob fields (`evidenceJson`,
     *                `suggestedActionsJson`, `chosenActionJson`) are stored
     *                as-is.
     */
    upsert(record: {
        id: string;
        masterTaskId: string;
        sessionId: string;
        phaseId?: string;
        workerId?: string;
        severity: string;
        scope: string;
        category: string;
        rootEventId?: string;
        contributingEventIds: string[];
        message: string;
        evidenceJson: string;
        suggestedActionsJson: string;
        chosenActionJson?: string;
        createdAt: number;
        updatedAt: number;
    }): void {
        this.db.run('BEGIN');
        try {
            this.db.run(
                `INSERT OR REPLACE INTO failure_console_records
                 (id, master_task_id, session_id, workspace_id, phase_id, worker_id,
                  severity, scope, category, root_event_id, contributing_event_ids,
                  message, evidence_json, suggested_actions_json, chosen_action_json,
                  created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    record.id,
                    record.masterTaskId,
                    record.sessionId,
                    this.workspaceId,
                    record.phaseId ?? null,
                    record.workerId ?? null,
                    record.severity,
                    record.scope,
                    record.category,
                    record.rootEventId ?? null,
                    JSON.stringify(record.contributingEventIds),
                    record.message,
                    record.evidenceJson,
                    record.suggestedActionsJson,
                    record.chosenActionJson ?? null,
                    record.createdAt,
                    record.updatedAt,
                ],
            );
            this.db.run('COMMIT');
        } catch (e) {
            this.db.run('ROLLBACK');
            throw e;
        }
        this.scheduleFlush();
    }

    /**
     * Retrieve a single failure console record by ID.
     *
     * @param id  Primary key of the record.
     * @returns The raw DB row, or `null` if not found.
     */
    get(id: string): FailureConsoleRow | null {
        const stmt = this.db.prepare(
            `SELECT id, master_task_id, session_id, workspace_id, phase_id,
                    worker_id, severity, scope, category, root_event_id,
                    contributing_event_ids, message, evidence_json,
                    suggested_actions_json, chosen_action_json,
                    created_at, updated_at
             FROM failure_console_records
             WHERE id = ? AND workspace_id = ?`,
        );
        stmt.bind([id, this.workspaceId]);
        if (!stmt.step()) { stmt.free(); return null; }
        const row = stmt.getAsObject<FailureConsoleRow>();
        stmt.free();
        return row;
    }

    /**
     * List all failure console records for a given master task,
     * ordered by `created_at` descending (newest first).
     *
     * @param masterTaskId  The task to query records for.
     */
    listByTask(masterTaskId: string): FailureConsoleRow[] {
        const stmt = this.db.prepare(
            `SELECT id, master_task_id, session_id, workspace_id, phase_id,
                    worker_id, severity, scope, category, root_event_id,
                    contributing_event_ids, message, evidence_json,
                    suggested_actions_json, chosen_action_json,
                    created_at, updated_at
             FROM failure_console_records
             WHERE master_task_id = ? AND workspace_id = ?
             ORDER BY created_at DESC`,
        );
        stmt.bind([masterTaskId, this.workspaceId]);

        const results: FailureConsoleRow[] = [];
        while (stmt.step()) {
            results.push(stmt.getAsObject<FailureConsoleRow>());
        }
        stmt.free();
        return results;
    }

    /**
     * Update the chosen recovery action for an existing failure record.
     *
     * @param id               Primary key of the record to update.
     * @param chosenActionJson  JSON-serialised `OperatorRecoveryDecision`.
     * @param updatedAt         Unix timestamp (ms) for the update.
     */
    updateChosenAction(id: string, chosenActionJson: string, updatedAt: number): void {
        this.db.run(
            `UPDATE failure_console_records
             SET chosen_action_json = ?, updated_at = ?
             WHERE id = ? AND workspace_id = ?`,
            [chosenActionJson, updatedAt, id, this.workspaceId],
        );
        this.scheduleFlush();
    }
}
