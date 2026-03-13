// ─────────────────────────────────────────────────────────────────────────────
// WorkspaceTenanting.test.ts — Workspace isolation tests for hybrid storage
// ─────────────────────────────────────────────────────────────────────────────
// Verifies that workspace_id tenanting correctly isolates data between workspaces.
// Uses a single CoogentMCPServer and directly creates repository pairs with
// different workspaceIds against the same underlying sql.js Database handle.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { CoogentMCPServer } from '../CoogentMCPServer.js';
import { TaskRepository } from '../repositories/TaskRepository.js';
import { SessionRepository } from '../repositories/SessionRepository.js';
import { VerdictRepository } from '../repositories/VerdictRepository.js';
import { AuditRepository } from '../repositories/AuditRepository.js';
import { ContextManifestRepository, type ContextManifestRow } from '../repositories/ContextManifestRepository.js';
import { HandoffRepository } from '../repositories/HandoffRepository.js';
import { PhaseRepository } from '../repositories/PhaseRepository.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const TASK_A = 'task-20260311-ws-a-00000000-0000-0000-0000-000000000001';
const TASK_B = 'task-20260311-ws-b-00000000-0000-0000-0000-000000000002';
const PHASE_ID = 'phase-001-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SESSION_ID = 'session-tenant-test';
const WS_ALPHA = 'workspace-alpha';
const WS_BETA = 'workspace-beta';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** No-op flush for tests — we don't need disk persistence. */
const noop = () => {};

/**
 * Extract the raw sql.js Database handle from a CoogentMCPServer.
 * Path: server → ArtifactDB (private db) → sql.js Database (private db).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getRawDb(server: CoogentMCPServer): any {
    return (server as any).db.db;
}

/**
 * Raw SQL query helper — returns all matching rows as plain objects.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rawQuery(sqlDb: any, sql: string, params: unknown[] = []): Record<string, unknown>[] {
    const stmt = sqlDb.prepare(sql);
    stmt.bind(params);
    const rows: Record<string, unknown>[] = [];
    while (stmt.step()) {
        rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
}

// ═════════════════════════════════════════════════════════════════════════════
//  Workspace Tenanting Tests
// ═════════════════════════════════════════════════════════════════════════════

describe('Workspace Tenanting — cross-workspace data isolation', () => {
    let tmpDir: string;
    let server: CoogentMCPServer;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let rawDb: any;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-tenant-test-'));
        server = new CoogentMCPServer(tmpDir);
        await server.init(tmpDir, WS_ALPHA); // default workspace doesn't matter — we create repos directly
        rawDb = getRawDb(server);
    });

    afterEach(async () => {
        server.dispose();
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    // ─────────────────────────────────────────────────────────────────────
    //  TaskRepository — listIds scopes by workspace
    // ─────────────────────────────────────────────────────────────────────

    it('TaskRepository.listIds returns only tasks for the calling workspace', () => {
        const tasksA = new TaskRepository(rawDb, noop, WS_ALPHA);
        const tasksB = new TaskRepository(rawDb, noop, WS_BETA);

        // Insert a task via workspace A
        tasksA.upsert(TASK_A, { summary: 'Alpha task' });

        // Workspace A should see it
        expect(tasksA.listIds()).toContain(TASK_A);
        // Workspace B should NOT see it
        expect(tasksB.listIds()).not.toContain(TASK_A);

        // Insert a different task via workspace B
        tasksB.upsert(TASK_B, { summary: 'Beta task' });

        // Each workspace sees only its own task
        expect(tasksA.listIds()).toContain(TASK_A);
        expect(tasksA.listIds()).not.toContain(TASK_B);
        expect(tasksB.listIds()).toContain(TASK_B);
        expect(tasksB.listIds()).not.toContain(TASK_A);
    });

    // ─────────────────────────────────────────────────────────────────────
    //  TaskRepository — get() scopes by workspace
    // ─────────────────────────────────────────────────────────────────────

    it('TaskRepository.get returns undefined for a task from another workspace', () => {
        const tasksA = new TaskRepository(rawDb, noop, WS_ALPHA);
        const tasksB = new TaskRepository(rawDb, noop, WS_BETA);

        tasksA.upsert(TASK_A, { summary: 'Alpha task' });

        // Workspace A can read it
        expect(tasksA.get(TASK_A)).toBeDefined();
        expect(tasksA.get(TASK_A)!.summary).toBe('Alpha task');

        // Workspace B cannot read it
        expect(tasksB.get(TASK_A)).toBeUndefined();
    });

    // ─────────────────────────────────────────────────────────────────────
    //  TaskRepository — delete() does not delete another workspace's task
    // ─────────────────────────────────────────────────────────────────────

    it('TaskRepository.delete does not delete tasks from another workspace', () => {
        const tasksA = new TaskRepository(rawDb, noop, WS_ALPHA);
        const tasksB = new TaskRepository(rawDb, noop, WS_BETA);

        tasksA.upsert(TASK_A, { summary: 'Alpha task' });

        // Workspace B tries to delete workspace A's task — should be a no-op
        tasksB.delete(TASK_A);

        // Workspace A's task should still exist
        expect(tasksA.get(TASK_A)).toBeDefined();
        expect(tasksA.listIds()).toContain(TASK_A);
    });

    // ─────────────────────────────────────────────────────────────────────
    //  TaskRepository — deleteChildRecords() does not affect other workspace
    // ─────────────────────────────────────────────────────────────────────

    it('TaskRepository.deleteChildRecords does not affect another workspace data', () => {
        const tasksA = new TaskRepository(rawDb, noop, WS_ALPHA);
        const tasksB = new TaskRepository(rawDb, noop, WS_BETA);
        const phasesA = new PhaseRepository(rawDb, noop, WS_ALPHA);

        // Insert task and child data via workspace A
        tasksA.upsert(TASK_A, { summary: 'Alpha task' });
        phasesA.upsertPlan(TASK_A, PHASE_ID, 'Alpha plan');
        phasesA.upsertOutput(TASK_A, PHASE_ID, 'Alpha output');

        // Workspace B tries to delete child records — should be a no-op
        tasksB.deleteChildRecords(TASK_A);

        // Workspace A's child data should still exist
        expect(phasesA.getPlan(TASK_A, PHASE_ID)).toBe('Alpha plan');
        expect(phasesA.getOutputs(TASK_A)).toHaveProperty(PHASE_ID);
    });

    // ─────────────────────────────────────────────────────────────────────
    //  SessionRepository — list scopes by workspace
    // ─────────────────────────────────────────────────────────────────────

    it('SessionRepository.list returns only sessions for the calling workspace', () => {
        const sessionsA = new SessionRepository(rawDb, noop, WS_ALPHA);
        const sessionsB = new SessionRepository(rawDb, noop, WS_BETA);

        sessionsA.upsert('dir-alpha', 'session-alpha', 'Alpha prompt', 1000);
        sessionsB.upsert('dir-beta', 'session-beta', 'Beta prompt', 2000);

        const listA = sessionsA.list();
        expect(listA).toHaveLength(1);
        expect(listA[0].sessionDirName).toBe('dir-alpha');

        const listB = sessionsB.list();
        expect(listB).toHaveLength(1);
        expect(listB[0].sessionDirName).toBe('dir-beta');
    });

    // ─────────────────────────────────────────────────────────────────────
    //  SessionRepository — getLatest scopes by workspace
    // ─────────────────────────────────────────────────────────────────────

    it('SessionRepository.getLatest returns only the latest session for the calling workspace', () => {
        const sessionsA = new SessionRepository(rawDb, noop, WS_ALPHA);
        const sessionsB = new SessionRepository(rawDb, noop, WS_BETA);

        sessionsA.upsert('dir-alpha', 'session-alpha', 'Alpha prompt', 1000);
        sessionsB.upsert('dir-beta', 'session-beta', 'Beta prompt', 2000);

        const latestA = sessionsA.getLatest();
        expect(latestA).toBeDefined();
        expect(latestA!.dirName).toBe('dir-alpha');

        const latestB = sessionsB.getLatest();
        expect(latestB).toBeDefined();
        expect(latestB!.dirName).toBe('dir-beta');
    });

    // ─────────────────────────────────────────────────────────────────────
    //  SessionRepository — delete() does not affect another workspace
    // ─────────────────────────────────────────────────────────────────────

    it('SessionRepository.delete does not affect another workspace sessions', () => {
        const sessionsA = new SessionRepository(rawDb, noop, WS_ALPHA);
        const sessionsB = new SessionRepository(rawDb, noop, WS_BETA);

        sessionsA.upsert('dir-alpha', 'session-alpha', 'Alpha prompt', 1000);

        // Workspace B tries to delete workspace A's session — should be a no-op
        sessionsB.delete('dir-alpha');

        // Workspace A's session should still exist
        const listA = sessionsA.list();
        expect(listA).toHaveLength(1);
        expect(listA[0].sessionDirName).toBe('dir-alpha');
    });

    // ─────────────────────────────────────────────────────────────────────
    //  SessionRepository — getConsolidationReport() scopes by workspace
    // ─────────────────────────────────────────────────────────────────────

    it('SessionRepository.getConsolidationReport returns undefined for another workspace', () => {
        const sessionsA = new SessionRepository(rawDb, noop, WS_ALPHA);
        const sessionsB = new SessionRepository(rawDb, noop, WS_BETA);
        const tasksA = new TaskRepository(rawDb, noop, WS_ALPHA);

        sessionsA.upsert('dir-alpha', 'session-alpha', 'Alpha prompt', 1000);
        tasksA.upsert('dir-alpha', { consolidationReport: 'Alpha report' });

        // Workspace A can read it
        const reportA = sessionsA.getConsolidationReport('dir-alpha');
        expect(reportA).toBeDefined();
        expect(reportA!.markdown).toBe('Alpha report');

        // Workspace B cannot read it
        expect(sessionsB.getConsolidationReport('dir-alpha')).toBeUndefined();
    });

    // ─────────────────────────────────────────────────────────────────────
    //  SessionRepository — getImplementationPlan() scopes by workspace
    // ─────────────────────────────────────────────────────────────────────

    it('SessionRepository.getImplementationPlan returns undefined for another workspace', () => {
        const sessionsA = new SessionRepository(rawDb, noop, WS_ALPHA);
        const sessionsB = new SessionRepository(rawDb, noop, WS_BETA);
        const tasksA = new TaskRepository(rawDb, noop, WS_ALPHA);

        sessionsA.upsert('dir-alpha', 'session-alpha', 'Alpha prompt', 1000);
        tasksA.upsert('dir-alpha', { implementationPlan: 'Alpha plan' });

        // Workspace A can read it
        expect(sessionsA.getImplementationPlan('dir-alpha')).toBe('Alpha plan');

        // Workspace B cannot read it
        expect(sessionsB.getImplementationPlan('dir-alpha')).toBeUndefined();
    });

    // ─────────────────────────────────────────────────────────────────────
    //  VerdictRepository — writes workspace_id correctly
    // ─────────────────────────────────────────────────────────────────────

    it('VerdictRepository writes the correct workspace_id to evaluation_results', () => {
        const verdicts = new VerdictRepository(rawDb, noop, WS_ALPHA);

        verdicts.upsertEvaluation(TASK_A, PHASE_ID, {
            passed: true,
            reason: 'All criteria met',
            evaluatedAt: Date.now(),
        });

        const rows = rawQuery(rawDb,
            'SELECT workspace_id FROM evaluation_results WHERE master_task_id = ?',
            [TASK_A]
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].workspace_id).toBe(WS_ALPHA);
    });

    // ─────────────────────────────────────────────────────────────────────
    //  VerdictRepository — getEvaluations() scopes by workspace
    // ─────────────────────────────────────────────────────────────────────

    it('VerdictRepository.getEvaluations returns empty for another workspace', () => {
        const verdictsA = new VerdictRepository(rawDb, noop, WS_ALPHA);
        const verdictsB = new VerdictRepository(rawDb, noop, WS_BETA);

        verdictsA.upsertEvaluation(TASK_A, PHASE_ID, {
            passed: true,
            reason: 'All criteria met',
            evaluatedAt: Date.now(),
        });

        // Workspace A can read it
        expect(verdictsA.getEvaluations(TASK_A)).toHaveLength(1);
        expect(verdictsA.getEvaluations(TASK_A, PHASE_ID)).toHaveLength(1);

        // Workspace B cannot read it
        expect(verdictsB.getEvaluations(TASK_A)).toHaveLength(0);
        expect(verdictsB.getEvaluations(TASK_A, PHASE_ID)).toHaveLength(0);
    });

    // ─────────────────────────────────────────────────────────────────────
    //  VerdictRepository — getHealings() scopes by workspace
    // ─────────────────────────────────────────────────────────────────────

    it('VerdictRepository.getHealings returns empty for another workspace', () => {
        const verdictsA = new VerdictRepository(rawDb, noop, WS_ALPHA);
        const verdictsB = new VerdictRepository(rawDb, noop, WS_BETA);

        verdictsA.upsertHealing(TASK_A, PHASE_ID, {
            attemptNumber: 1,
            exitCode: 1,
            stderrTail: 'error',
            createdAt: Date.now(),
        });

        // Workspace A can read it
        expect(verdictsA.getHealings(TASK_A)).toHaveLength(1);
        expect(verdictsA.getHealings(TASK_A, PHASE_ID)).toHaveLength(1);

        // Workspace B cannot read it
        expect(verdictsB.getHealings(TASK_A)).toHaveLength(0);
        expect(verdictsB.getHealings(TASK_A, PHASE_ID)).toHaveLength(0);
    });

    // ─────────────────────────────────────────────────────────────────────
    //  HandoffRepository — get() scopes by workspace
    // ─────────────────────────────────────────────────────────────────────

    it('HandoffRepository.get returns undefined for a handoff from another workspace', () => {
        const handoffsA = new HandoffRepository(rawDb, noop, WS_ALPHA);
        const handoffsB = new HandoffRepository(rawDb, noop, WS_BETA);

        handoffsA.upsert({
            masterTaskId: TASK_A,
            phaseId: PHASE_ID,
            decisions: ['decision-1'],
            modifiedFiles: ['file1.ts'],
            blockers: [],
            completedAt: Date.now(),
        });

        // Workspace A can read it
        const handoffA = handoffsA.get(TASK_A, PHASE_ID);
        expect(handoffA).toBeDefined();
        expect(handoffA!.decisions).toEqual(['decision-1']);

        // Workspace B cannot read it
        expect(handoffsB.get(TASK_A, PHASE_ID)).toBeUndefined();
    });

    // ─────────────────────────────────────────────────────────────────────
    //  PhaseRepository — getPlan() scopes by workspace
    // ─────────────────────────────────────────────────────────────────────

    it('PhaseRepository.getPlan returns undefined for another workspace', () => {
        const phasesA = new PhaseRepository(rawDb, noop, WS_ALPHA);
        const phasesB = new PhaseRepository(rawDb, noop, WS_BETA);

        phasesA.upsertPlan(TASK_A, PHASE_ID, 'Alpha execution plan');

        // Workspace A can read it
        expect(phasesA.getPlan(TASK_A, PHASE_ID)).toBe('Alpha execution plan');

        // Workspace B cannot read it
        expect(phasesB.getPlan(TASK_A, PHASE_ID)).toBeUndefined();
    });

    // ─────────────────────────────────────────────────────────────────────
    //  PhaseRepository — listIds() scopes by workspace
    // ─────────────────────────────────────────────────────────────────────

    it('PhaseRepository.listIds returns empty for another workspace', () => {
        const phasesA = new PhaseRepository(rawDb, noop, WS_ALPHA);
        const phasesB = new PhaseRepository(rawDb, noop, WS_BETA);

        phasesA.upsertPlan(TASK_A, PHASE_ID, 'Alpha plan');

        // Workspace A can list it
        expect(phasesA.listIds(TASK_A)).toContain(PHASE_ID);

        // Workspace B gets empty list
        expect(phasesB.listIds(TASK_A)).toHaveLength(0);
    });

    // ─────────────────────────────────────────────────────────────────────
    //  PhaseRepository — getOutputs() scopes by workspace
    // ─────────────────────────────────────────────────────────────────────

    it('PhaseRepository.getOutputs returns empty for another workspace', () => {
        const phasesA = new PhaseRepository(rawDb, noop, WS_ALPHA);
        const phasesB = new PhaseRepository(rawDb, noop, WS_BETA);

        phasesA.upsertOutput(TASK_A, PHASE_ID, 'Alpha output');

        // Workspace A can read it
        const outputsA = phasesA.getOutputs(TASK_A);
        expect(outputsA).toHaveProperty(PHASE_ID);
        expect(outputsA[PHASE_ID]).toBe('Alpha output');

        // Workspace B gets empty object
        const outputsB = phasesB.getOutputs(TASK_A);
        expect(Object.keys(outputsB)).toHaveLength(0);
    });

    // ─────────────────────────────────────────────────────────────────────
    //  PhaseRepository — getLog() scopes by workspace
    // ─────────────────────────────────────────────────────────────────────

    it('PhaseRepository.getLog returns undefined for another workspace', () => {
        const phasesA = new PhaseRepository(rawDb, noop, WS_ALPHA);
        const phasesB = new PhaseRepository(rawDb, noop, WS_BETA);

        phasesA.upsertLog(TASK_A, PHASE_ID, {
            prompt: 'Alpha prompt',
            response: 'Alpha response',
            startedAt: 1000,
        });

        // Workspace A can read it
        const logA = phasesA.getLog(TASK_A, PHASE_ID);
        expect(logA).toBeDefined();
        expect(logA!.prompt).toBe('Alpha prompt');

        // Workspace B cannot read it
        expect(phasesB.getLog(TASK_A, PHASE_ID)).toBeUndefined();
    });

    // ─────────────────────────────────────────────────────────────────────
    //  AuditRepository — writes workspace_id correctly
    // ─────────────────────────────────────────────────────────────────────

    it('AuditRepository writes the correct workspace_id to plan_revisions', () => {
        const audits = new AuditRepository(rawDb, noop, WS_ALPHA);

        audits.upsertPlanRevision(TASK_A, {
            draftJson: JSON.stringify({ phases: [] }),
        });

        const rows = rawQuery(rawDb,
            'SELECT workspace_id FROM plan_revisions WHERE master_task_id = ?',
            [TASK_A]
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].workspace_id).toBe(WS_ALPHA);
    });

    // ─────────────────────────────────────────────────────────────────────
    //  AuditRepository — getPlanRevisions() scopes by workspace
    // ─────────────────────────────────────────────────────────────────────

    it('AuditRepository.getPlanRevisions returns empty for another workspace', () => {
        const auditsA = new AuditRepository(rawDb, noop, WS_ALPHA);
        const auditsB = new AuditRepository(rawDb, noop, WS_BETA);

        auditsA.upsertPlanRevision(TASK_A, {
            draftJson: JSON.stringify({ phases: [] }),
        });

        // Workspace A can read it
        expect(auditsA.getPlanRevisions(TASK_A)).toHaveLength(1);

        // Workspace B cannot read it
        expect(auditsB.getPlanRevisions(TASK_A)).toHaveLength(0);
    });

    // ─────────────────────────────────────────────────────────────────────
    //  AuditRepository — getSelectionAudits() scopes by workspace
    // ─────────────────────────────────────────────────────────────────────

    it('AuditRepository.getSelectionAudits returns empty for another workspace', () => {
        const auditsA = new AuditRepository(rawDb, noop, WS_ALPHA);
        const auditsB = new AuditRepository(rawDb, noop, WS_BETA);

        auditsA.insertSelectionAudit({
            subtask_id: 'subtask-1',
            subtask_spec: {
                subtask_id: 'subtask-1',
                title: 'Test',
                goal: 'Test goal',
                task_type: 'code_modification',
                reasoning_type: ['local_code_reasoning'],
                required_capabilities: ['typescript'],
                required_inputs: [],
                context_requirements: { preferred_format: ['full_target_file'], must_include: [], optional: [] },
                dependency_inputs: [],
                assumptions_allowed: [],
                assumptions_forbidden: [],
                required_confirmations: [],
                risk_level: 'low',
                failure_cost: 'low',
                deliverable: { type: 'patch_with_summary', must_include: [] },
                verification_needed: [],
                fallback_strategy: 'escalate',
            },
            candidate_agents: [{ agent_type: 'CodeEditor', score: 0.9, rejected: false }],
            selected_agent: 'CodeEditor',
            selection_rationale: ['Best fit'],
            compiled_prompt_id: 'prompt-1',
            fallback_agent: null,
            timestamp: Date.now(),
            session_id: TASK_A,
        } as any); // eslint-disable-line @typescript-eslint/no-explicit-any

        // Workspace A can read it
        expect(auditsA.getSelectionAudits(TASK_A)).toHaveLength(1);

        // Workspace B cannot read it
        expect(auditsB.getSelectionAudits(TASK_A)).toHaveLength(0);
    });

    // ─────────────────────────────────────────────────────────────────────
    //  ContextManifestRepository — writes workspace_id correctly
    // ─────────────────────────────────────────────────────────────────────

    it('ContextManifestRepository writes the correct workspace_id to context_manifests', () => {
        const manifests = new ContextManifestRepository(rawDb, noop, WS_ALPHA);

        const manifest: ContextManifestRow = {
            manifestId: 'manifest-ws-test-001',
            sessionId: SESSION_ID,
            taskId: TASK_A,
            phaseId: PHASE_ID,
            payloadJson: JSON.stringify({ files: ['foo.ts'] }),
            createdAt: Date.now(),
        };
        manifests.upsert(manifest);

        const rows = rawQuery(rawDb,
            'SELECT workspace_id FROM context_manifests WHERE manifest_id = ?',
            ['manifest-ws-test-001']
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].workspace_id).toBe(WS_ALPHA);
    });

    // ─────────────────────────────────────────────────────────────────────
    //  ContextManifestRepository — get() scopes by workspace
    // ─────────────────────────────────────────────────────────────────────

    it('ContextManifestRepository.get returns undefined for another workspace', () => {
        const manifestsA = new ContextManifestRepository(rawDb, noop, WS_ALPHA);
        const manifestsB = new ContextManifestRepository(rawDb, noop, WS_BETA);

        manifestsA.upsert({
            manifestId: 'manifest-ws-test-002',
            sessionId: SESSION_ID,
            taskId: TASK_A,
            phaseId: PHASE_ID,
            payloadJson: JSON.stringify({ files: ['bar.ts'] }),
            createdAt: Date.now(),
        });

        // Workspace A can read it
        expect(manifestsA.get('manifest-ws-test-002')).toBeDefined();

        // Workspace B cannot read it
        expect(manifestsB.get('manifest-ws-test-002')).toBeUndefined();
    });

    // ─────────────────────────────────────────────────────────────────────
    //  ContextManifestRepository — getByPhase() scopes by workspace
    // ─────────────────────────────────────────────────────────────────────

    it('ContextManifestRepository.getByPhase returns empty for another workspace', () => {
        const manifestsA = new ContextManifestRepository(rawDb, noop, WS_ALPHA);
        const manifestsB = new ContextManifestRepository(rawDb, noop, WS_BETA);

        manifestsA.upsert({
            manifestId: 'manifest-ws-test-003',
            sessionId: SESSION_ID,
            taskId: TASK_A,
            phaseId: PHASE_ID,
            payloadJson: JSON.stringify({ files: ['baz.ts'] }),
            createdAt: Date.now(),
        });

        // Workspace A can read it
        expect(manifestsA.getByPhase(TASK_A, PHASE_ID)).toHaveLength(1);

        // Workspace B gets empty array
        expect(manifestsB.getByPhase(TASK_A, PHASE_ID)).toHaveLength(0);
    });
});
