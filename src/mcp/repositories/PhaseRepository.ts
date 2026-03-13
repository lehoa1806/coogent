// ─────────────────────────────────────────────────────────────────────────────
// src/mcp/repositories/PhaseRepository.ts — Phase aggregate persistence
// ─────────────────────────────────────────────────────────────────────────────

import type { Database } from './db-types.js';

/**
 * Repository for phase-level data: plans, worker outputs, and execution logs.
 * Covers the `phases`, `worker_outputs`, and `phase_logs` tables.
 */
export class PhaseRepository {
    constructor(
        private readonly db: Database,
        private readonly scheduleFlush: () => void,
        private readonly workspaceId: string = '',
    ) { }

    /** Insert or update a phase-level execution plan. */
    upsertPlan(masterTaskId: string, phaseId: string, plan: string): void {
        this.db.run(
            'INSERT OR IGNORE INTO tasks (master_task_id, workspace_id) VALUES (?, ?)',
            [masterTaskId, this.workspaceId]
        );
        this.db.run(
            `INSERT INTO phases (master_task_id, phase_id, workspace_id, execution_plan)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(master_task_id, phase_id)
             DO UPDATE SET execution_plan = excluded.execution_plan`,
            [masterTaskId, phaseId, this.workspaceId, plan]
        );
        this.scheduleFlush();
    }

    /** Get a phase-level execution plan. */
    getPlan(masterTaskId: string, phaseId: string): string | undefined {
        const stmt = this.db.prepare(
            'SELECT execution_plan FROM phases WHERE master_task_id = ? AND phase_id = ? AND workspace_id = ?'
        );
        stmt.bind([masterTaskId, phaseId, this.workspaceId]);
        if (!stmt.step()) { stmt.free(); return undefined; }
        const row = stmt.getAsObject() as { execution_plan: string | null };
        stmt.free();
        return row.execution_plan ?? undefined;
    }

    /** Set whether an execution plan is required for a phase. */
    upsertPlanRequired(masterTaskId: string, phaseId: string, required: boolean): void {
        this.db.run(
            'INSERT OR IGNORE INTO tasks (master_task_id, workspace_id) VALUES (?, ?)',
            [masterTaskId, this.workspaceId]
        );
        this.db.run(
            `INSERT INTO phases (master_task_id, phase_id, workspace_id, plan_required)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(master_task_id, phase_id)
             DO UPDATE SET plan_required = excluded.plan_required`,
            [masterTaskId, phaseId, this.workspaceId, required ? 1 : 0]
        );
        this.scheduleFlush();
    }

    /** List all phase IDs belonging to a given master task. */
    listIds(masterTaskId: string): string[] {
        const stmt = this.db.prepare(
            'SELECT phase_id FROM phases WHERE master_task_id = ? AND workspace_id = ? ORDER BY phase_id'
        );
        stmt.bind([masterTaskId, this.workspaceId]);
        const ids: string[] = [];
        while (stmt.step()) {
            const row = stmt.getAsObject() as { phase_id: string };
            ids.push(row.phase_id);
        }
        stmt.free();
        return ids;
    }

    /** Persist accumulated worker output for a phase. */
    upsertOutput(masterTaskId: string, phaseId: string, output: string, stderr: string = ''): void {
        this.db.run(
            'INSERT OR IGNORE INTO tasks (master_task_id, workspace_id) VALUES (?, ?)',
            [masterTaskId, this.workspaceId]
        );
        this.db.run(
            `INSERT INTO worker_outputs (master_task_id, phase_id, workspace_id, output, stderr)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(master_task_id, phase_id)
             DO UPDATE SET output = excluded.output, stderr = excluded.stderr`,
            [masterTaskId, phaseId, this.workspaceId, output, stderr]
        );
        this.scheduleFlush();
    }

    /** Retrieve all worker outputs for a task, keyed by phase_id. */
    getOutputs(masterTaskId: string): Record<string, string> {
        const stmt = this.db.prepare(
            'SELECT phase_id, output FROM worker_outputs WHERE master_task_id = ? AND workspace_id = ?'
        );
        stmt.bind([masterTaskId, this.workspaceId]);
        const result: Record<string, string> = {};
        while (stmt.step()) {
            const row = stmt.getAsObject() as { phase_id: string; output: string };
            result[row.phase_id] = row.output;
        }
        stmt.free();
        return result;
    }

    /** Insert or update a phase execution log. */
    upsertLog(
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
            this.db.run(
                'INSERT OR IGNORE INTO phase_logs (master_task_id, phase_id, workspace_id) VALUES (?, ?, ?)',
                [masterTaskId, phaseId, this.workspaceId]
            );
            if (fields.prompt !== undefined) {
                this.db.run('UPDATE phase_logs SET prompt = ? WHERE master_task_id = ? AND phase_id = ? AND workspace_id = ?', [fields.prompt, masterTaskId, phaseId, this.workspaceId]);
            }
            if (fields.requestContext !== undefined) {
                this.db.run('UPDATE phase_logs SET request_context = ? WHERE master_task_id = ? AND phase_id = ? AND workspace_id = ?', [fields.requestContext, masterTaskId, phaseId, this.workspaceId]);
            }
            if (fields.response !== undefined) {
                this.db.run('UPDATE phase_logs SET response = ? WHERE master_task_id = ? AND phase_id = ? AND workspace_id = ?', [fields.response, masterTaskId, phaseId, this.workspaceId]);
            }
            if (fields.exitCode !== undefined) {
                this.db.run('UPDATE phase_logs SET exit_code = ? WHERE master_task_id = ? AND phase_id = ? AND workspace_id = ?', [fields.exitCode, masterTaskId, phaseId, this.workspaceId]);
            }
            if (fields.startedAt !== undefined) {
                this.db.run('UPDATE phase_logs SET started_at = ? WHERE master_task_id = ? AND phase_id = ? AND workspace_id = ?', [fields.startedAt, masterTaskId, phaseId, this.workspaceId]);
            }
            if (fields.completedAt !== undefined) {
                this.db.run('UPDATE phase_logs SET completed_at = ? WHERE master_task_id = ? AND phase_id = ? AND workspace_id = ?', [fields.completedAt, masterTaskId, phaseId, this.workspaceId]);
            }
            this.db.run('COMMIT');
        } catch (e) {
            this.db.run('ROLLBACK');
            throw e;
        }
        this.scheduleFlush();
    }

    /** Retrieve a phase execution log. */
    getLog(masterTaskId: string, phaseId: string): {
        prompt: string;
        requestContext: string;
        response: string;
        exitCode: number | null;
        startedAt: number;
        completedAt: number | null;
    } | undefined {
        const stmt = this.db.prepare(
            'SELECT prompt, request_context, response, exit_code, started_at, completed_at FROM phase_logs WHERE master_task_id = ? AND phase_id = ? AND workspace_id = ?'
        );
        stmt.bind([masterTaskId, phaseId, this.workspaceId]);
        if (!stmt.step()) { stmt.free(); return undefined; }
        const row = stmt.getAsObject() as {
            prompt: string; request_context: string; response: string;
            exit_code: number | null; started_at: number; completed_at: number | null;
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
}
