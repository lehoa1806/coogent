// ─────────────────────────────────────────────────────────────────────────────
// src/mcp/repositories/TaskRepository.ts — Task aggregate persistence
// ─────────────────────────────────────────────────────────────────────────────

import type { Database } from './db-types.js';
import type { TaskState, PhaseArtifacts, PhaseHandoff } from '../types.js';

/**
 * Repository for the `tasks` aggregate root.
 * Handles CRUD operations on the tasks table, including the full
 * composite getTask() query that joins phases and handoffs.
 */
export class TaskRepository {
    constructor(
        private readonly db: Database,
        private readonly scheduleFlush: () => void,
        private readonly workspaceId: string = '',
    ) { }

    /**
     * Insert or update task-level fields. Only provided fields are overwritten.
     */
    upsert(
        masterTaskId: string,
        fields: {
            summary?: string;
            executionPlan?: string;
            consolidationReport?: string;
            consolidationReportJson?: string;
            runbookJson?: string;
            completedAt?: number;
        }
    ): void {
        this.db.run('BEGIN');
        try {
            this.db.run(
                'INSERT OR IGNORE INTO tasks (master_task_id, workspace_id, created_at) VALUES (?, ?, ?)',
                [masterTaskId, this.workspaceId, Date.now()]
            );

            if (fields.summary !== undefined) {
                this.db.run(
                    'UPDATE tasks SET summary = ? WHERE master_task_id = ? AND workspace_id = ?',
                    [fields.summary, masterTaskId, this.workspaceId]
                );
            }
            if (fields.executionPlan !== undefined) {
                this.db.run(
                    'UPDATE tasks SET execution_plan = ? WHERE master_task_id = ? AND workspace_id = ?',
                    [fields.executionPlan, masterTaskId, this.workspaceId]
                );
            }
            if (fields.consolidationReport !== undefined) {
                this.db.run(
                    'UPDATE tasks SET consolidation_report = ? WHERE master_task_id = ? AND workspace_id = ?',
                    [fields.consolidationReport, masterTaskId, this.workspaceId]
                );
            }
            if (fields.runbookJson !== undefined) {
                this.db.run(
                    'UPDATE tasks SET runbook_json = ? WHERE master_task_id = ? AND workspace_id = ?',
                    [fields.runbookJson, masterTaskId, this.workspaceId]
                );
            }
            if (fields.consolidationReportJson !== undefined) {
                this.db.run(
                    'UPDATE tasks SET consolidation_report_json = ? WHERE master_task_id = ? AND workspace_id = ?',
                    [fields.consolidationReportJson, masterTaskId, this.workspaceId]
                );
            }
            if (fields.completedAt !== undefined) {
                this.db.run(
                    'UPDATE tasks SET completed_at = ? WHERE master_task_id = ? AND workspace_id = ?',
                    [fields.completedAt, masterTaskId, this.workspaceId]
                );
            }

            this.db.run(
                'UPDATE tasks SET updated_at = ? WHERE master_task_id = ? AND workspace_id = ?',
                [Date.now(), masterTaskId, this.workspaceId]
            );

            this.db.run('COMMIT');
        } catch (e) {
            this.db.run('ROLLBACK');
            throw e;
        }
        this.scheduleFlush();
    }

    /**
     * Retrieve the full TaskState for a master task, including all phases
     * and handoffs. Returns `undefined` if the task does not exist.
     */
    get(masterTaskId: string): TaskState | undefined {
        const taskStmt = this.db.prepare(
            'SELECT master_task_id, summary, execution_plan, consolidation_report, consolidation_report_json, runbook_json FROM tasks WHERE master_task_id = ? AND workspace_id = ?'
        );
        taskStmt.bind([masterTaskId, this.workspaceId]);

        if (!taskStmt.step()) {
            taskStmt.free();
            return undefined;
        }

        const taskRow = taskStmt.getAsObject() as {
            master_task_id: string;
            summary: string | null;
            execution_plan: string | null;
            consolidation_report: string | null;
            consolidation_report_json: string | null;
            runbook_json: string | null;
        };
        taskStmt.free();

        const phases = new Map<string, PhaseArtifacts>();

        const phaseStmt = this.db.prepare(
            'SELECT phase_id, execution_plan, plan_required FROM phases WHERE master_task_id = ? AND workspace_id = ?'
        );
        phaseStmt.bind([masterTaskId, this.workspaceId]);

        while (phaseStmt.step()) {
            const phaseRow = phaseStmt.getAsObject() as {
                phase_id: string;
                execution_plan: string | null;
                plan_required: number | null;
            };
            phases.set(phaseRow.phase_id, {
                executionPlan: phaseRow.execution_plan ?? undefined,
                planRequired: phaseRow.plan_required === null
                    ? undefined
                    : phaseRow.plan_required === 1,
            });
        }
        phaseStmt.free();

        const handoffStmt = this.db.prepare(
            `SELECT phase_id, decisions, modified_files, blockers, completed_at,
                    next_steps_context, summary, rationale, remaining_work,
                    constraints_json, warnings, changed_files_json,
                    workspace_folder, symbols_touched
             FROM handoffs WHERE master_task_id = ? AND workspace_id = ?`
        );
        handoffStmt.bind([masterTaskId, this.workspaceId]);

        const parseJsonArray = (val: string | null | undefined): string[] | undefined => {
            if (!val) { return undefined; }
            try { return JSON.parse(val) as string[]; } catch { return undefined; }
        };

        while (handoffStmt.step()) {
            const row = handoffStmt.getAsObject() as {
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
            };

            let decisions: string[];
            let modifiedFiles: string[];
            let blockers: string[];
            try {
                decisions = JSON.parse(row.decisions) as string[];
                modifiedFiles = JSON.parse(row.modified_files) as string[];
                blockers = JSON.parse(row.blockers) as string[];
            } catch {
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
                nextStepsContext: row.next_steps_context ?? undefined,
                summary: row.summary ?? undefined,
                rationale: row.rationale ?? undefined,
                remainingWork: parseJsonArray(row.remaining_work),
                constraints: parseJsonArray(row.constraints_json),
                warnings: parseJsonArray(row.warnings),
                changedFilesJson: row.changed_files_json || undefined,
                workspaceFolder: row.workspace_folder || undefined,
                symbolsTouched: parseJsonArray(row.symbols_touched),
            };

            let phase = phases.get(row.phase_id);
            if (!phase) {
                phase = {};
                phases.set(row.phase_id, phase);
            }
            phase.handoff = handoff;
        }
        handoffStmt.free();

        return {
            masterTaskId: taskRow.master_task_id,
            summary: taskRow.summary ?? undefined,
            executionPlan: taskRow.execution_plan ?? undefined,
            consolidationReport: taskRow.consolidation_report ?? undefined,
            consolidationReportJson: taskRow.consolidation_report_json ?? undefined,
            runbookJson: taskRow.runbook_json ?? undefined,
            phases,
        };
    }

    /**
     * Delete child records (phases, outputs, evaluations, etc.) but keep
     * the `sessions` and `tasks` rows intact for session history listing.
     * Use this during CMD_RESET to free heavy data without destroying history.
     */
    deleteChildRecords(masterTaskId: string): void {
        this.db.run('BEGIN');
        try {
            this.db.run('DELETE FROM evaluation_results WHERE master_task_id = ? AND workspace_id = ?', [masterTaskId, this.workspaceId]);
            this.db.run('DELETE FROM healing_attempts WHERE master_task_id = ? AND workspace_id = ?', [masterTaskId, this.workspaceId]);
            this.db.run('DELETE FROM plan_revisions WHERE master_task_id = ? AND workspace_id = ?', [masterTaskId, this.workspaceId]);
            this.db.run('DELETE FROM handoffs WHERE master_task_id = ? AND workspace_id = ?', [masterTaskId, this.workspaceId]);
            this.db.run('DELETE FROM worker_outputs WHERE master_task_id = ? AND workspace_id = ?', [masterTaskId, this.workspaceId]);
            this.db.run('DELETE FROM phase_logs WHERE master_task_id = ? AND workspace_id = ?', [masterTaskId, this.workspaceId]);
            this.db.run('DELETE FROM selection_audits WHERE session_id = ? AND workspace_id = ?', [masterTaskId, this.workspaceId]);
            this.db.run('DELETE FROM context_manifests WHERE task_id = ? AND workspace_id = ?', [masterTaskId, this.workspaceId]);
            this.db.run('DELETE FROM phases WHERE master_task_id = ? AND workspace_id = ?', [masterTaskId, this.workspaceId]);
            this.db.run('COMMIT');
        } catch (e) {
            this.db.run('ROLLBACK');
            throw e;
        }
        this.scheduleFlush();
    }

    /**
     * Delete a task and all its child rows.
     * Manually cascades because sql.js does not honour ON DELETE CASCADE.
     */
    delete(masterTaskId: string): void {
        this.db.run('BEGIN');
        try {
            this.db.run('DELETE FROM evaluation_results WHERE master_task_id = ? AND workspace_id = ?', [masterTaskId, this.workspaceId]);
            this.db.run('DELETE FROM healing_attempts WHERE master_task_id = ? AND workspace_id = ?', [masterTaskId, this.workspaceId]);
            this.db.run('DELETE FROM plan_revisions WHERE master_task_id = ? AND workspace_id = ?', [masterTaskId, this.workspaceId]);
            this.db.run('DELETE FROM handoffs WHERE master_task_id = ? AND workspace_id = ?', [masterTaskId, this.workspaceId]);
            this.db.run('DELETE FROM worker_outputs WHERE master_task_id = ? AND workspace_id = ?', [masterTaskId, this.workspaceId]);
            this.db.run('DELETE FROM phase_logs WHERE master_task_id = ? AND workspace_id = ?', [masterTaskId, this.workspaceId]);
            this.db.run('DELETE FROM selection_audits WHERE session_id = ? AND workspace_id = ?', [masterTaskId, this.workspaceId]);
            this.db.run('DELETE FROM context_manifests WHERE task_id = ? AND workspace_id = ?', [masterTaskId, this.workspaceId]);
            this.db.run('DELETE FROM phases WHERE master_task_id = ? AND workspace_id = ?', [masterTaskId, this.workspaceId]);
            this.db.run('DELETE FROM sessions WHERE session_dir_name = ? AND workspace_id = ?', [masterTaskId, this.workspaceId]);
            this.db.run('DELETE FROM tasks WHERE master_task_id = ? AND workspace_id = ?', [masterTaskId, this.workspaceId]);
            this.db.run('COMMIT');
        } catch (e) {
            this.db.run('ROLLBACK');
            throw e;
        }
        this.scheduleFlush();
    }

    /** List all master task IDs in the database, scoped to the current workspace. */
    listIds(): string[] {
        const stmt = this.db.prepare(
            'SELECT master_task_id FROM tasks WHERE workspace_id = ? ORDER BY master_task_id'
        );
        stmt.bind([this.workspaceId]);
        const ids: string[] = [];
        while (stmt.step()) {
            const row = stmt.getAsObject() as { master_task_id: string };
            ids.push(row.master_task_id);
        }
        stmt.free();
        return ids;
    }
}
