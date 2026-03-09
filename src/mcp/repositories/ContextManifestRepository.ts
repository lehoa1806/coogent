// ─────────────────────────────────────────────────────────────────────────────
// src/mcp/repositories/ContextManifestRepository.ts — Context manifest persistence
// ─────────────────────────────────────────────────────────────────────────────

import type { Database } from './db-types.js';

/** Shape of a context manifest row. */
export interface ContextManifestRow {
    manifestId: string;
    sessionId: string;
    taskId: string;
    phaseId: string;
    workspaceFolder?: string | undefined;
    payloadJson: string;
    createdAt: number;
}

/**
 * Repository for the `context_manifests` table.
 * Stores structured context packs produced by phases for downstream consumers.
 */
export class ContextManifestRepository {
    constructor(
        private readonly db: Database,
        private readonly scheduleFlush: () => void,
    ) { }

    /** Insert or update a context manifest. */
    upsert(manifest: ContextManifestRow): void {
        const { manifestId, sessionId, taskId, phaseId, workspaceFolder, payloadJson, createdAt } = manifest;

        this.db.run('BEGIN');
        try {
            this.db.run(
                `INSERT INTO context_manifests (manifest_id, session_id, task_id, phase_id, workspace_folder, payload_json, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(manifest_id)
                 DO UPDATE SET session_id = excluded.session_id,
                               task_id = excluded.task_id,
                               phase_id = excluded.phase_id,
                               workspace_folder = excluded.workspace_folder,
                               payload_json = excluded.payload_json,
                               created_at = excluded.created_at`,
                [manifestId, sessionId, taskId, phaseId, workspaceFolder ?? null, payloadJson, createdAt]
            );
            this.db.run('COMMIT');
        } catch (e) {
            this.db.run('ROLLBACK');
            throw e;
        }
        this.scheduleFlush();
    }

    /** Retrieve a single context manifest by ID. */
    get(manifestId: string): ContextManifestRow | undefined {
        const stmt = this.db.prepare(
            `SELECT manifest_id, session_id, task_id, phase_id, workspace_folder,
                    payload_json, created_at
             FROM context_manifests WHERE manifest_id = ?`
        );
        stmt.bind([manifestId]);
        if (!stmt.step()) { stmt.free(); return undefined; }
        const row = stmt.getAsObject() as Record<string, unknown>;
        stmt.free();

        return {
            manifestId: row.manifest_id as string,
            sessionId: row.session_id as string,
            taskId: row.task_id as string,
            phaseId: row.phase_id as string,
            workspaceFolder: (row.workspace_folder as string) || undefined,
            payloadJson: row.payload_json as string,
            createdAt: row.created_at as number,
        };
    }

    /** Retrieve all context manifests for a given task + phase. */
    getByPhase(taskId: string, phaseId: string): ContextManifestRow[] {
        const stmt = this.db.prepare(
            `SELECT manifest_id, session_id, task_id, phase_id, workspace_folder,
                    payload_json, created_at
             FROM context_manifests WHERE task_id = ? AND phase_id = ?
             ORDER BY created_at ASC`
        );
        stmt.bind([taskId, phaseId]);

        const results: ContextManifestRow[] = [];
        while (stmt.step()) {
            const row = stmt.getAsObject() as Record<string, unknown>;
            results.push({
                manifestId: row.manifest_id as string,
                sessionId: row.session_id as string,
                taskId: row.task_id as string,
                phaseId: row.phase_id as string,
                workspaceFolder: (row.workspace_folder as string) || undefined,
                payloadJson: row.payload_json as string,
                createdAt: row.created_at as number,
            });
        }
        stmt.free();

        return results;
    }
}
