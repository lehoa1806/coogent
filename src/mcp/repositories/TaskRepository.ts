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
    ) { }

    /**
     * Insert or update task-level fields. Only provided fields are overwritten.
     */
    upsert(
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
     * Retrieve the full TaskState for a master task, including all phases
     * and handoffs. Returns `undefined` if the task does not exist.
     */
    get(masterTaskId: string): TaskState | undefined {
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
            implementationPlan: taskRow.implementation_plan ?? undefined,
            consolidationReport: taskRow.consolidation_report ?? undefined,
            consolidationReportJson: taskRow.consolidation_report_json ?? undefined,
            runbookJson: taskRow.runbook_json ?? undefined,
            phases,
        };
    }

    /**
     * Delete a task and all its child rows.
     * Manually cascades because sql.js does not honour ON DELETE CASCADE.
     */
    delete(masterTaskId: string): void {
        this.db.run('BEGIN');
        try {
            this.db.run('DELETE FROM evaluation_results WHERE master_task_id = ?', [masterTaskId]);
            this.db.run('DELETE FROM healing_attempts WHERE master_task_id = ?', [masterTaskId]);
            this.db.run('DELETE FROM plan_revisions WHERE master_task_id = ?', [masterTaskId]);
            this.db.run('DELETE FROM handoffs WHERE master_task_id = ?', [masterTaskId]);
            this.db.run('DELETE FROM worker_outputs WHERE master_task_id = ?', [masterTaskId]);
            this.db.run('DELETE FROM phase_logs WHERE master_task_id = ?', [masterTaskId]);
            this.db.run('DELETE FROM selection_audits WHERE session_id = ?', [masterTaskId]);
            this.db.run('DELETE FROM phases WHERE master_task_id = ?', [masterTaskId]);
            this.db.run('DELETE FROM sessions WHERE session_dir_name = ?', [masterTaskId]);
            this.db.run('DELETE FROM tasks WHERE master_task_id = ?', [masterTaskId]);
            this.db.run('COMMIT');
        } catch (e) {
            this.db.run('ROLLBACK');
            throw e;
        }
        this.scheduleFlush();
    }

    /** List all master task IDs in the database. */
    listIds(): string[] {
        const results = this.db.exec('SELECT master_task_id FROM tasks ORDER BY master_task_id');
        if (results.length === 0) {
            return [];
        }
        return results[0].values.map((row: unknown[]) => row[0] as string);
    }
}
