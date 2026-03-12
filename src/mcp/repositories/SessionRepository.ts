// ─────────────────────────────────────────────────────────────────────────────
// src/mcp/repositories/SessionRepository.ts — Session aggregate persistence
// ─────────────────────────────────────────────────────────────────────────────

import type { Database } from './db-types.js';

/**
 * Repository for the `sessions` table.
 * Manages session lifecycle records including the joined task status query.
 */
export class SessionRepository {
    constructor(
        private readonly db: Database,
        private readonly scheduleFlush: () => void,
        private readonly workspaceId: string = '',
    ) { }

    /** Insert or update a session record. */
    upsert(dirName: string, sessionId: string, prompt: string, createdAt: number): void {
        this.db.run(
            'INSERT OR IGNORE INTO tasks (master_task_id, workspace_id, created_at) VALUES (?, ?, ?)',
            [dirName, this.workspaceId, createdAt]
        );
        this.db.run(
            `INSERT INTO sessions (session_dir_name, session_id, workspace_id, prompt, created_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(session_dir_name)
             DO UPDATE SET session_id = excluded.session_id,
                           prompt = excluded.prompt,
                           created_at = excluded.created_at`,
            [dirName, sessionId, this.workspaceId, prompt, createdAt]
        );
        this.scheduleFlush();
    }

    /** Retrieve the most recently created session. */
    getLatest(): { dirName: string; sessionId: string; prompt: string; createdAt: number } | undefined {
        const stmt = this.db.prepare(
            'SELECT session_dir_name, session_id, prompt, created_at FROM sessions WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 1'
        );
        stmt.bind([this.workspaceId]);
        if (!stmt.step()) { stmt.free(); return undefined; }
        const row = stmt.getAsObject() as {
            session_dir_name: string; session_id: string; prompt: string; created_at: number;
        };
        stmt.free();
        return { dirName: row.session_dir_name, sessionId: row.session_id, prompt: row.prompt, createdAt: row.created_at };
    }

    /**
     * Delete a session and its associated task record.
     * Removes both the `sessions` row and the corresponding `tasks` row.
     */
    delete(sessionDirName: string): void {
        this.db.run('DELETE FROM sessions WHERE session_dir_name = ?', [sessionDirName]);
        this.db.run('DELETE FROM tasks WHERE master_task_id = ?', [sessionDirName]);
        this.scheduleFlush();
    }

    /** List all sessions, joined with tasks to include runbook status and consolidation report. */
    list(): Array<{
        sessionDirName: string; sessionId: string; prompt: string; createdAt: number;
        runbookJson: string | null; status: string | null;
        consolidationReport: string | null; consolidationReportJson: string | null;
        implementationPlan: string | null;
    }> {
        const stmt = this.db.prepare(
            `SELECT s.session_dir_name, s.session_id, s.prompt, s.created_at,
                    t.runbook_json, t.status,
                    t.consolidation_report, t.consolidation_report_json,
                    t.implementation_plan
             FROM sessions s
             LEFT JOIN tasks t ON s.session_dir_name = t.master_task_id
             WHERE s.workspace_id = ?
             ORDER BY s.created_at DESC`
        );
        stmt.bind([this.workspaceId]);
        const results: Array<{
            sessionDirName: string; sessionId: string; prompt: string; createdAt: number;
            runbookJson: string | null; status: string | null;
            consolidationReport: string | null; consolidationReportJson: string | null;
            implementationPlan: string | null;
        }> = [];
        while (stmt.step()) {
            const row = stmt.getAsObject() as {
                session_dir_name: string; session_id: string; prompt: string;
                created_at: number; runbook_json: string | null; status: string | null;
                consolidation_report: string | null; consolidation_report_json: string | null;
                implementation_plan: string | null;
            };
            results.push({
                sessionDirName: row.session_dir_name, sessionId: row.session_id,
                prompt: row.prompt, createdAt: row.created_at,
                runbookJson: row.runbook_json, status: row.status,
                consolidationReport: row.consolidation_report,
                consolidationReportJson: row.consolidation_report_json,
                implementationPlan: row.implementation_plan,
            });
        }
        stmt.free();
        return results;
    }

    /**
     * ARCH-2: Retrieve a single session by its directory name.
     * O(1) lookup via WHERE clause — avoids scanning the full list.
     */
    getByDirName(dirName: string): {
        sessionDirName: string; sessionId: string; prompt: string; createdAt: number;
        runbookJson: string | null; status: string | null;
        consolidationReport: string | null; consolidationReportJson: string | null;
        implementationPlan: string | null;
    } | undefined {
        const stmt = this.db.prepare(
            `SELECT s.session_dir_name, s.session_id, s.prompt, s.created_at,
                    t.runbook_json, t.status,
                    t.consolidation_report, t.consolidation_report_json,
                    t.implementation_plan
             FROM sessions s
             LEFT JOIN tasks t ON s.session_dir_name = t.master_task_id
             WHERE s.session_dir_name = ? AND s.workspace_id = ?`
        );
        stmt.bind([dirName, this.workspaceId]);
        if (!stmt.step()) { stmt.free(); return undefined; }
        const row = stmt.getAsObject() as {
            session_dir_name: string; session_id: string; prompt: string;
            created_at: number; runbook_json: string | null; status: string | null;
            consolidation_report: string | null; consolidation_report_json: string | null;
            implementation_plan: string | null;
        };
        stmt.free();
        return {
            sessionDirName: row.session_dir_name, sessionId: row.session_id,
            prompt: row.prompt, createdAt: row.created_at,
            runbookJson: row.runbook_json, status: row.status,
            consolidationReport: row.consolidation_report,
            consolidationReportJson: row.consolidation_report_json,
            implementationPlan: row.implementation_plan,
        };
    }

    /**
     * ARCH-2: Retrieve a single session by its session ID (UUID).
     * O(1) lookup via WHERE clause — avoids scanning the full list.
     */
    getBySessionId(sessionId: string): {
        sessionDirName: string; sessionId: string; prompt: string; createdAt: number;
        runbookJson: string | null; status: string | null;
    } | undefined {
        const stmt = this.db.prepare(
            `SELECT s.session_dir_name, s.session_id, s.prompt, s.created_at,
                    t.runbook_json, t.status
             FROM sessions s
             LEFT JOIN tasks t ON s.session_dir_name = t.master_task_id
             WHERE s.session_id = ? AND s.workspace_id = ?`
        );
        stmt.bind([sessionId, this.workspaceId]);
        if (!stmt.step()) { stmt.free(); return undefined; }
        const row = stmt.getAsObject() as {
            session_dir_name: string; session_id: string; prompt: string;
            created_at: number; runbook_json: string | null; status: string | null;
        };
        stmt.free();
        return {
            sessionDirName: row.session_dir_name, sessionId: row.session_id,
            prompt: row.prompt, createdAt: row.created_at,
            runbookJson: row.runbook_json, status: row.status,
        };
    }

    /**
     * Retrieve the consolidation report for a specific session.
     * Returns `undefined` if the session is not found.
     */
    getConsolidationReport(sessionDirName: string): {
        markdown: string | null;
        json: string | null;
    } | undefined {
        const stmt = this.db.prepare(
            `SELECT t.consolidation_report, t.consolidation_report_json
             FROM sessions s
             LEFT JOIN tasks t ON s.session_dir_name = t.master_task_id
             WHERE s.session_dir_name = ?`
        );
        stmt.bind([sessionDirName]);
        if (!stmt.step()) { stmt.free(); return undefined; }
        const row = stmt.getAsObject() as {
            consolidation_report: string | null;
            consolidation_report_json: string | null;
        };
        stmt.free();
        return {
            markdown: row.consolidation_report,
            json: row.consolidation_report_json,
        };
    }

    /**
     * Retrieve the implementation plan for a specific session.
     * Returns `undefined` if the session is not found.
     */
    getImplementationPlan(sessionDirName: string): string | null | undefined {
        const stmt = this.db.prepare(
            `SELECT t.implementation_plan
             FROM sessions s
             LEFT JOIN tasks t ON s.session_dir_name = t.master_task_id
             WHERE s.session_dir_name = ?`
        );
        stmt.bind([sessionDirName]);
        if (!stmt.step()) { stmt.free(); return undefined; }
        const row = stmt.getAsObject() as {
            implementation_plan: string | null;
        };
        stmt.free();
        return row.implementation_plan;
    }
}
