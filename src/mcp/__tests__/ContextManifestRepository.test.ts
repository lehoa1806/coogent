// ─────────────────────────────────────────────────────────────────────────────
// ContextManifestRepository.test.ts — Tests for context manifest persistence
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { CoogentMCPServer } from '../CoogentMCPServer.js';
import type { ContextManifestRow } from '../repositories/ContextManifestRepository.js';

// ─── Test Fixtures ───────────────────────────────────────────────────────────

const TASK_ID = '20260305-173000-a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const PHASE_ID = 'phase-001-a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const SESSION_ID = 'session-abc-123';

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function createInMemoryDB(tmpDir: string) {
    const server = new CoogentMCPServer(tmpDir);
    await server.init(tmpDir);
    return server;
}

// ═════════════════════════════════════════════════════════════════════════════
//  Context Manifest Persistence Tests
// ═════════════════════════════════════════════════════════════════════════════

describe('ContextManifestRepository', () => {
    let tmpDir: string;
    let server: CoogentMCPServer;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ctx-manifest-test-'));
        server = await createInMemoryDB(tmpDir);
    });

    afterEach(async () => {
        server.dispose();
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const getDB = () => (server as any).db;

    it('upsert persists a context manifest successfully', () => {
        const manifest: ContextManifestRow = {
            manifestId: 'manifest-001',
            sessionId: SESSION_ID,
            taskId: TASK_ID,
            phaseId: PHASE_ID,
            workspaceFolder: '/workspace/project',
            payloadJson: JSON.stringify({ files: ['a.ts'], tokens: 1500 }),
            createdAt: Date.now(),
        };

        // Should not throw
        expect(() => getDB().contextManifests.upsert(manifest)).not.toThrow();
    });

    it('get by manifestId returns correct data', () => {
        const manifest: ContextManifestRow = {
            manifestId: 'manifest-002',
            sessionId: SESSION_ID,
            taskId: TASK_ID,
            phaseId: PHASE_ID,
            workspaceFolder: '/workspace/project',
            payloadJson: JSON.stringify({ files: ['b.ts'], budget: 8000 }),
            createdAt: 1709500000000,
        };

        getDB().contextManifests.upsert(manifest);

        const result = getDB().contextManifests.get('manifest-002');
        expect(result).toBeDefined();
        expect(result!.manifestId).toBe('manifest-002');
        expect(result!.sessionId).toBe(SESSION_ID);
        expect(result!.taskId).toBe(TASK_ID);
        expect(result!.phaseId).toBe(PHASE_ID);
        expect(result!.workspaceFolder).toBe('/workspace/project');
        expect(result!.payloadJson).toBe(JSON.stringify({ files: ['b.ts'], budget: 8000 }));
        expect(result!.createdAt).toBe(1709500000000);
    });

    it('getByPhase returns all manifests for a task+phase', () => {
        const manifest1: ContextManifestRow = {
            manifestId: 'manifest-010',
            sessionId: SESSION_ID,
            taskId: TASK_ID,
            phaseId: PHASE_ID,
            payloadJson: '{"v":1}',
            createdAt: 1000,
        };

        const manifest2: ContextManifestRow = {
            manifestId: 'manifest-011',
            sessionId: SESSION_ID,
            taskId: TASK_ID,
            phaseId: PHASE_ID,
            payloadJson: '{"v":2}',
            createdAt: 2000,
        };

        getDB().contextManifests.upsert(manifest1);
        getDB().contextManifests.upsert(manifest2);

        const results = getDB().contextManifests.getByPhase(TASK_ID, PHASE_ID);
        expect(results).toHaveLength(2);
        // Ordered by createdAt ASC
        expect(results[0].manifestId).toBe('manifest-010');
        expect(results[1].manifestId).toBe('manifest-011');
    });

    it('get for non-existent id returns undefined', () => {
        const result = getDB().contextManifests.get('non-existent-manifest-id');
        expect(result).toBeUndefined();
    });

    it('multiple manifests for same phase are all returned by getByPhase', () => {
        // Insert 3 manifests for the same task+phase
        for (let i = 0; i < 3; i++) {
            const manifest: ContextManifestRow = {
                manifestId: `manifest-multi-${i}`,
                sessionId: SESSION_ID,
                taskId: TASK_ID,
                phaseId: PHASE_ID,
                payloadJson: JSON.stringify({ index: i }),
                createdAt: 1000 + i * 100,
            };
            getDB().contextManifests.upsert(manifest);
        }

        const results = getDB().contextManifests.getByPhase(TASK_ID, PHASE_ID);
        expect(results).toHaveLength(3);

        // Verify ordering by createdAt ASC
        expect(results[0].manifestId).toBe('manifest-multi-0');
        expect(results[0].createdAt).toBe(1000);
        expect(results[1].manifestId).toBe('manifest-multi-1');
        expect(results[1].createdAt).toBe(1100);
        expect(results[2].manifestId).toBe('manifest-multi-2');
        expect(results[2].createdAt).toBe(1200);

        // Verify payloads are distinct
        expect(JSON.parse(results[0].payloadJson)).toEqual({ index: 0 });
        expect(JSON.parse(results[1].payloadJson)).toEqual({ index: 1 });
        expect(JSON.parse(results[2].payloadJson)).toEqual({ index: 2 });
    });

    it('getByPhase returns empty array when no manifests exist for task+phase', () => {
        const results = getDB().contextManifests.getByPhase('nonexistent-task', 'nonexistent-phase');
        expect(results).toEqual([]);
    });

    it('upsert updates existing manifest on conflict', () => {
        const initial: ContextManifestRow = {
            manifestId: 'manifest-upsert',
            sessionId: SESSION_ID,
            taskId: TASK_ID,
            phaseId: PHASE_ID,
            payloadJson: '{"version":"v1"}',
            createdAt: 1000,
        };
        getDB().contextManifests.upsert(initial);

        // Update with same manifestId
        const updated: ContextManifestRow = {
            manifestId: 'manifest-upsert',
            sessionId: 'session-updated',
            taskId: TASK_ID,
            phaseId: PHASE_ID,
            workspaceFolder: '/updated/path',
            payloadJson: '{"version":"v2"}',
            createdAt: 2000,
        };
        getDB().contextManifests.upsert(updated);

        const result = getDB().contextManifests.get('manifest-upsert');
        expect(result).toBeDefined();
        expect(result!.sessionId).toBe('session-updated');
        expect(result!.payloadJson).toBe('{"version":"v2"}');
        expect(result!.workspaceFolder).toBe('/updated/path');
        expect(result!.createdAt).toBe(2000);

        // Should only have one manifest with this ID
        const byPhase = getDB().contextManifests.getByPhase(TASK_ID, PHASE_ID);
        expect(byPhase).toHaveLength(1);
    });
});
