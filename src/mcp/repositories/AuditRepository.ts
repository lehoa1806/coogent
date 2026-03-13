// ─────────────────────────────────────────────────────────────────────────────
// src/mcp/repositories/AuditRepository.ts — Plan revision & selection audit persistence
// ─────────────────────────────────────────────────────────────────────────────

import type { Database } from './db-types.js';
import type { SelectionAuditRecord, AgentType } from '../../agent-selection/types.js';

/**
 * Repository for audit and revision data.
 * Covers the `plan_revisions` and `selection_audits` tables.
 */
export class AuditRepository {
    constructor(
        private readonly db: Database,
        private readonly scheduleFlush: () => void,
        private readonly workspaceId: string = '',
    ) { }

    /** Persist a plan revision with auto-incrementing version. */
    upsertPlanRevision(
        masterTaskId: string,
        fields: {
            feedback?: string; draftJson: string; implementationPlanMd?: string;
            status?: string; rawLlmOutput?: string | undefined; compilationManifest?: string | undefined;
        }
    ): void {
        this.db.run('INSERT OR IGNORE INTO tasks (master_task_id, workspace_id) VALUES (?, ?)', [masterTaskId, this.workspaceId]);
        const versionStmt = this.db.prepare(
            'SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM plan_revisions WHERE master_task_id = ?'
        );
        versionStmt.bind([masterTaskId]);
        versionStmt.step();
        const nextVersion = (versionStmt.getAsObject() as { next_version: number }).next_version;
        versionStmt.free();

        this.db.run(
            `INSERT INTO plan_revisions (master_task_id, version, workspace_id, feedback, draft_json, execution_plan_md, status, created_at, raw_llm_output, compilation_manifest)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [masterTaskId, nextVersion, this.workspaceId, fields.feedback ?? null, fields.draftJson,
                fields.implementationPlanMd ?? null, fields.status ?? 'draft', Date.now(),
                fields.rawLlmOutput ?? null, fields.compilationManifest ?? null]
        );
        this.scheduleFlush();
    }

    /** Retrieve all plan revisions for a task, ordered by version. */
    getPlanRevisions(masterTaskId: string): Array<{
        version: number; feedback: string | null; draftJson: string;
        implementationPlanMd: string | null; status: string; createdAt: number;
    }> {
        const stmt = this.db.prepare(
            'SELECT version, feedback, draft_json, execution_plan_md, status, created_at FROM plan_revisions WHERE master_task_id = ? AND workspace_id = ? ORDER BY version'
        );
        stmt.bind([masterTaskId, this.workspaceId]);
        const results: Array<{
            version: number; feedback: string | null; draftJson: string;
            implementationPlanMd: string | null; status: string; createdAt: number;
        }> = [];
        while (stmt.step()) {
            const row = stmt.getAsObject() as {
                version: number; feedback: string | null; draft_json: string;
                execution_plan_md: string | null; status: string; created_at: number;
            };
            results.push({
                version: row.version, feedback: row.feedback, draftJson: row.draft_json,
                implementationPlanMd: row.execution_plan_md, status: row.status, createdAt: row.created_at,
            });
        }
        stmt.free();
        return results;
    }

    /** Persist an agent selection audit record. */
    insertSelectionAudit(record: SelectionAuditRecord): void {
        this.db.run(
            `INSERT OR REPLACE INTO selection_audits
             (subtask_id, subtask_spec, candidate_agents, selected_agent,
              selection_rationale, compiled_prompt_id, fallback_agent,
              worker_run_result, timestamp, session_id, workspace_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [record.subtask_id, JSON.stringify(record.subtask_spec),
            JSON.stringify(record.candidate_agents), record.selected_agent,
            JSON.stringify(record.selection_rationale), record.compiled_prompt_id,
            record.fallback_agent ?? null,
            record.worker_run_result ? JSON.stringify(record.worker_run_result) : null,
            record.timestamp, (record as SelectionAuditRecord & { session_id?: string }).session_id ?? '',
            this.workspaceId]
        );
        this.scheduleFlush();
    }

    /** Retrieve all selection audit records for a session. */
    getSelectionAudits(sessionId: string): SelectionAuditRecord[] {
        const stmt = this.db.prepare(
            'SELECT subtask_id, subtask_spec, candidate_agents, selected_agent, selection_rationale, compiled_prompt_id, fallback_agent, worker_run_result, timestamp FROM selection_audits WHERE session_id = ? AND workspace_id = ? ORDER BY timestamp'
        );
        stmt.bind([sessionId, this.workspaceId]);
        const results: SelectionAuditRecord[] = [];
        while (stmt.step()) {
            const row = stmt.getAsObject() as {
                subtask_id: string; subtask_spec: string; candidate_agents: string;
                selected_agent: string; selection_rationale: string; compiled_prompt_id: string;
                fallback_agent: string | null; worker_run_result: string | null; timestamp: number;
            };
            results.push({
                subtask_id: row.subtask_id,
                subtask_spec: JSON.parse(row.subtask_spec),
                candidate_agents: JSON.parse(row.candidate_agents),
                selected_agent: row.selected_agent as AgentType,
                selection_rationale: JSON.parse(row.selection_rationale),
                compiled_prompt_id: row.compiled_prompt_id,
                fallback_agent: (row.fallback_agent as AgentType | null) ?? null,
                worker_run_result: row.worker_run_result ? JSON.parse(row.worker_run_result) : undefined,
                timestamp: row.timestamp,
            });
        }
        stmt.free();
        return results;
    }
}
