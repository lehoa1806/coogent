// ─────────────────────────────────────────────────────────────────────────────
// src/mcp/repositories/HandoffRepository.ts — Handoff aggregate persistence
// ─────────────────────────────────────────────────────────────────────────────

import type { Database } from './db-types.js';
import type { PhaseHandoff } from '../types.js';

/**
 * Repository for the `handoffs` table.
 * Handles serialization of JSON arrays for decisions, modifiedFiles, blockers.
 */
export class HandoffRepository {
    constructor(
        private readonly db: Database,
        private readonly scheduleFlush: () => void,
    ) { }

    /** Insert or update a phase handoff. */
    upsert(handoff: PhaseHandoff): void {
        const { masterTaskId, phaseId, decisions, modifiedFiles, blockers, completedAt, nextStepsContext } = handoff;

        this.db.run('BEGIN');
        try {
            this.db.run('INSERT OR IGNORE INTO tasks (master_task_id) VALUES (?)', [masterTaskId]);
            this.db.run('INSERT OR IGNORE INTO phases (master_task_id, phase_id) VALUES (?, ?)', [masterTaskId, phaseId]);
            this.db.run(
                `INSERT INTO handoffs (master_task_id, phase_id, decisions, modified_files, blockers, completed_at, next_steps_context)
                 VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(master_task_id, phase_id)
                 DO UPDATE SET decisions = excluded.decisions,
                               modified_files = excluded.modified_files,
                               blockers = excluded.blockers,
                               completed_at = excluded.completed_at,
                               next_steps_context = excluded.next_steps_context`,
                [masterTaskId, phaseId, JSON.stringify(decisions), JSON.stringify(modifiedFiles),
                    JSON.stringify(blockers), completedAt, nextStepsContext ?? '']
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
            'SELECT phase_id, decisions, modified_files, blockers, completed_at, next_steps_context FROM handoffs WHERE master_task_id = ? AND phase_id = ?'
        );
        stmt.bind([masterTaskId, phaseId]);
        if (!stmt.step()) { stmt.free(); return undefined; }
        const row = stmt.getAsObject() as {
            phase_id: string; decisions: string; modified_files: string;
            blockers: string; completed_at: number; next_steps_context: string;
        };
        stmt.free();

        let decisions: string[], modifiedFiles: string[], blockers: string[];
        try {
            decisions = JSON.parse(row.decisions) as string[];
            modifiedFiles = JSON.parse(row.modified_files) as string[];
            blockers = JSON.parse(row.blockers) as string[];
        } catch {
            decisions = []; modifiedFiles = []; blockers = [];
        }

        return {
            phaseId: row.phase_id, masterTaskId, decisions, modifiedFiles, blockers,
            completedAt: row.completed_at, nextStepsContext: row.next_steps_context || undefined,
        };
    }
}
