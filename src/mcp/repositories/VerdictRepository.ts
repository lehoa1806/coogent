// ─────────────────────────────────────────────────────────────────────────────
// src/mcp/repositories/VerdictRepository.ts — Evaluation & healing persistence
// ─────────────────────────────────────────────────────────────────────────────

import type { Database } from './db-types.js';

/**
 * Repository for evaluation results and self-healing attempts.
 * Covers the `evaluation_results` and `healing_attempts` tables.
 */
export class VerdictRepository {
    constructor(
        private readonly db: Database,
        private readonly scheduleFlush: () => void,
    ) { }

    /** Persist an evaluation result for a phase attempt. */
    upsertEvaluation(
        masterTaskId: string,
        phaseId: string,
        fields: {
            attempt?: number; passed: boolean; reason?: string;
            retryPrompt?: string; evaluatorType?: string; evaluatedAt: number;
        }
    ): void {
        const attempt = fields.attempt ?? 1;
        this.db.run(
            `INSERT INTO evaluation_results (master_task_id, phase_id, attempt, passed, reason, retry_prompt, evaluator_type, evaluated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(master_task_id, phase_id, attempt)
             DO UPDATE SET passed = excluded.passed, reason = excluded.reason,
                           retry_prompt = excluded.retry_prompt, evaluator_type = excluded.evaluator_type,
                           evaluated_at = excluded.evaluated_at`,
            [masterTaskId, phaseId, attempt, fields.passed ? 1 : 0, fields.reason ?? '',
                fields.retryPrompt ?? null, fields.evaluatorType ?? null, fields.evaluatedAt]
        );
        this.scheduleFlush();
    }

    /** Retrieve evaluation results, optionally filtered by phase. */
    getEvaluations(masterTaskId: string, phaseId?: string): Array<{
        phaseId: string; attempt: number; passed: boolean; reason: string;
        retryPrompt: string | null; evaluatorType: string | null; evaluatedAt: number;
    }> {
        const sql = phaseId
            ? 'SELECT phase_id, attempt, passed, reason, retry_prompt, evaluator_type, evaluated_at FROM evaluation_results WHERE master_task_id = ? AND phase_id = ? ORDER BY attempt'
            : 'SELECT phase_id, attempt, passed, reason, retry_prompt, evaluator_type, evaluated_at FROM evaluation_results WHERE master_task_id = ? ORDER BY phase_id, attempt';
        const stmt = this.db.prepare(sql);
        stmt.bind(phaseId ? [masterTaskId, phaseId] : [masterTaskId]);
        const results: Array<{
            phaseId: string; attempt: number; passed: boolean; reason: string;
            retryPrompt: string | null; evaluatorType: string | null; evaluatedAt: number;
        }> = [];
        while (stmt.step()) {
            const row = stmt.getAsObject() as {
                phase_id: string; attempt: number; passed: number; reason: string;
                retry_prompt: string | null; evaluator_type: string | null; evaluated_at: number;
            };
            results.push({
                phaseId: row.phase_id, attempt: row.attempt, passed: row.passed !== 0,
                reason: row.reason, retryPrompt: row.retry_prompt,
                evaluatorType: row.evaluator_type, evaluatedAt: row.evaluated_at,
            });
        }
        stmt.free();
        return results;
    }

    /** Persist a self-healing attempt for a phase. */
    upsertHealing(
        masterTaskId: string, phaseId: string,
        fields: { attemptNumber: number; exitCode?: number; stderrTail?: string; augmentedPrompt?: string; createdAt: number; }
    ): void {
        this.db.run(
            `INSERT INTO healing_attempts (master_task_id, phase_id, attempt_number, exit_code, stderr_tail, augmented_prompt, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(master_task_id, phase_id, attempt_number)
             DO UPDATE SET exit_code = excluded.exit_code, stderr_tail = excluded.stderr_tail,
                           augmented_prompt = excluded.augmented_prompt, created_at = excluded.created_at`,
            [masterTaskId, phaseId, fields.attemptNumber, fields.exitCode ?? null,
                fields.stderrTail ?? null, fields.augmentedPrompt ?? null, fields.createdAt]
        );
        this.scheduleFlush();
    }

    /** Retrieve healing attempts, optionally filtered by phase. */
    getHealings(masterTaskId: string, phaseId?: string): Array<{
        phaseId: string; attemptNumber: number; exitCode: number | null;
        stderrTail: string | null; augmentedPrompt: string | null; createdAt: number;
    }> {
        const sql = phaseId
            ? 'SELECT phase_id, attempt_number, exit_code, stderr_tail, augmented_prompt, created_at FROM healing_attempts WHERE master_task_id = ? AND phase_id = ? ORDER BY attempt_number'
            : 'SELECT phase_id, attempt_number, exit_code, stderr_tail, augmented_prompt, created_at FROM healing_attempts WHERE master_task_id = ? ORDER BY phase_id, attempt_number';
        const stmt = this.db.prepare(sql);
        stmt.bind(phaseId ? [masterTaskId, phaseId] : [masterTaskId]);
        const results: Array<{
            phaseId: string; attemptNumber: number; exitCode: number | null;
            stderrTail: string | null; augmentedPrompt: string | null; createdAt: number;
        }> = [];
        while (stmt.step()) {
            const row = stmt.getAsObject() as {
                phase_id: string; attempt_number: number; exit_code: number | null;
                stderr_tail: string | null; augmented_prompt: string | null; created_at: number;
            };
            results.push({
                phaseId: row.phase_id, attemptNumber: row.attempt_number, exitCode: row.exit_code,
                stderrTail: row.stderr_tail, augmentedPrompt: row.augmented_prompt, createdAt: row.created_at,
            });
        }
        stmt.free();
        return results;
    }
}
