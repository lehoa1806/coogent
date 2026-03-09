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
    ) { }

    /** Insert or update a session record. */
    upsert(dirName: string, sessionId: string, prompt: string, createdAt: number): void {
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

    /** Retrieve the most recently created session. */
    getLatest(): { dirName: string; sessionId: string; prompt: string; createdAt: number } | undefined {
        const stmt = this.db.prepare(
            'SELECT session_dir_name, session_id, prompt, created_at FROM sessions ORDER BY created_at DESC LIMIT 1'
        );
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

    /** List all sessions, joined with tasks to include runbook status. */
    list(): Array<{
        sessionDirName: string; sessionId: string; prompt: string; createdAt: number;
        runbookJson: string | null; status: string | null;
    }> {
        const stmt = this.db.prepare(
            `SELECT s.session_dir_name, s.session_id, s.prompt, s.created_at,
                    t.runbook_json, t.status
             FROM sessions s
             LEFT JOIN tasks t ON s.session_dir_name = t.master_task_id
             ORDER BY s.created_at DESC`
        );
        const results: Array<{
            sessionDirName: string; sessionId: string; prompt: string; createdAt: number;
            runbookJson: string | null; status: string | null;
        }> = [];
        while (stmt.step()) {
            const row = stmt.getAsObject() as {
                session_dir_name: string; session_id: string; prompt: string;
                created_at: number; runbook_json: string | null; status: string | null;
            };
            results.push({
                sessionDirName: row.session_dir_name, sessionId: row.session_id,
                prompt: row.prompt, createdAt: row.created_at,
                runbookJson: row.runbook_json, status: row.status,
            });
        }
        stmt.free();
        return results;
    }
}
