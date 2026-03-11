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
});
