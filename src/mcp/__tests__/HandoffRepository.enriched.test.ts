// ─────────────────────────────────────────────────────────────────────────────
// HandoffRepository.enriched.test.ts — Tests for enriched handoff persistence
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { CoogentMCPServer } from '../CoogentMCPServer.js';
import type { PhaseHandoff } from '../types.js';

// ─── Test Fixtures ───────────────────────────────────────────────────────────

const VALID_MASTER_TASK_ID =
    '20260305-173000-a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const VALID_PHASE_ID =
    'phase-001-a1b2c3d4-e5f6-7890-abcd-ef1234567890';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Create an in-memory ArtifactDB by initialising a CoogentMCPServer
 * with a fresh temp directory. Returns the server so we can access
 * the DB's repository accessors directly.
 */
async function createInMemoryDB(tmpDir: string) {
    const server = new CoogentMCPServer(tmpDir);
    await server.init(tmpDir);
    return server;
}

// ═════════════════════════════════════════════════════════════════════════════
//  Enriched Handoff Persistence Tests
// ═════════════════════════════════════════════════════════════════════════════

describe('HandoffRepository — Enriched fields', () => {
    let tmpDir: string;
    let server: CoogentMCPServer;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'handoff-enriched-test-'));
        server = await createInMemoryDB(tmpDir);
    });

    afterEach(async () => {
        server.dispose();
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const getDB = () => (server as any).db;

    it('upsert with all enriched fields persists them correctly', () => {
        const handoff: PhaseHandoff = {
            masterTaskId: VALID_MASTER_TASK_ID,
            phaseId: VALID_PHASE_ID,
            decisions: ['Used approach A'],
            modifiedFiles: ['src/main.ts'],
            blockers: [],
            completedAt: Date.now(),
            nextStepsContext: 'Wire phase 2',
            summary: 'Implemented the auth module',
            rationale: 'Chose JWT over sessions for statelessness',
            remainingWork: ['Add refresh token', 'Add rate limiting'],
            constraints: ['Must use existing DB schema'],
            warnings: ['Token expiry not configurable yet'],
            changedFilesJson: JSON.stringify([{ path: 'src/main.ts', action: 'modified' }]),
            workspaceFolder: '/workspace/project',
            symbolsTouched: ['AuthService.login', 'TokenValidator.verify'],
        };

        getDB().handoffs.upsert(handoff);

        const retrieved = getDB().handoffs.get(VALID_MASTER_TASK_ID, VALID_PHASE_ID);
        expect(retrieved).toBeDefined();
        expect(retrieved!.summary).toBe('Implemented the auth module');
        expect(retrieved!.rationale).toBe('Chose JWT over sessions for statelessness');
        expect(retrieved!.remainingWork).toEqual(['Add refresh token', 'Add rate limiting']);
        expect(retrieved!.constraints).toEqual(['Must use existing DB schema']);
        expect(retrieved!.warnings).toEqual(['Token expiry not configurable yet']);
        expect(retrieved!.changedFilesJson).toBe(
            JSON.stringify([{ path: 'src/main.ts', action: 'modified' }])
        );
        expect(retrieved!.workspaceFolder).toBe('/workspace/project');
        expect(retrieved!.symbolsTouched).toEqual(['AuthService.login', 'TokenValidator.verify']);
    });

    it('get after enriched upsert deserializes all new fields correctly', () => {
        const handoff: PhaseHandoff = {
            masterTaskId: VALID_MASTER_TASK_ID,
            phaseId: VALID_PHASE_ID,
            decisions: ['D1'],
            modifiedFiles: ['f1.ts'],
            blockers: ['B1'],
            completedAt: 1709500000000,
            nextStepsContext: 'Context for next',
            summary: 'Phase summary text',
            rationale: 'Rationale text',
            remainingWork: ['item1', 'item2'],
            constraints: ['constraint1'],
            warnings: ['warning1', 'warning2'],
            changedFilesJson: '{"files":[]}',
            workspaceFolder: '/home/user/project',
            symbolsTouched: ['Foo.bar', 'Baz.qux'],
        };

        getDB().handoffs.upsert(handoff);

        const result = getDB().handoffs.get(VALID_MASTER_TASK_ID, VALID_PHASE_ID);
        expect(result).toBeDefined();

        // Core fields
        expect(result!.phaseId).toBe(VALID_PHASE_ID);
        expect(result!.masterTaskId).toBe(VALID_MASTER_TASK_ID);
        expect(result!.decisions).toEqual(['D1']);
        expect(result!.modifiedFiles).toEqual(['f1.ts']);
        expect(result!.blockers).toEqual(['B1']);
        expect(result!.completedAt).toBe(1709500000000);
        expect(result!.nextStepsContext).toBe('Context for next');

        // Enriched fields
        expect(result!.summary).toBe('Phase summary text');
        expect(result!.rationale).toBe('Rationale text');
        expect(result!.remainingWork).toEqual(['item1', 'item2']);
        expect(result!.constraints).toEqual(['constraint1']);
        expect(result!.warnings).toEqual(['warning1', 'warning2']);
        expect(result!.changedFilesJson).toBe('{"files":[]}');
        expect(result!.workspaceFolder).toBe('/home/user/project');
        expect(result!.symbolsTouched).toEqual(['Foo.bar', 'Baz.qux']);
    });

    it('upsert with only legacy fields is backward compatible — new fields are undefined', () => {
        const handoff: PhaseHandoff = {
            masterTaskId: VALID_MASTER_TASK_ID,
            phaseId: VALID_PHASE_ID,
            decisions: ['Legacy decision'],
            modifiedFiles: ['legacy.ts'],
            blockers: [],
            completedAt: Date.now(),
        };

        getDB().handoffs.upsert(handoff);

        const result = getDB().handoffs.get(VALID_MASTER_TASK_ID, VALID_PHASE_ID);
        expect(result).toBeDefined();

        // Core fields present
        expect(result!.decisions).toEqual(['Legacy decision']);
        expect(result!.modifiedFiles).toEqual(['legacy.ts']);
        expect(result!.blockers).toEqual([]);

        // Enriched fields should be undefined
        expect(result!.summary).toBeUndefined();
        expect(result!.rationale).toBeUndefined();
        expect(result!.remainingWork).toBeUndefined();
        expect(result!.constraints).toBeUndefined();
        expect(result!.warnings).toBeUndefined();
        expect(result!.changedFilesJson).toBeUndefined();
        expect(result!.workspaceFolder).toBeUndefined();
        expect(result!.symbolsTouched).toBeUndefined();
    });

    it('update existing handoff with new fields updates them correctly', () => {
        // Initial upsert — legacy-only
        const initial: PhaseHandoff = {
            masterTaskId: VALID_MASTER_TASK_ID,
            phaseId: VALID_PHASE_ID,
            decisions: ['Initial decision'],
            modifiedFiles: ['initial.ts'],
            blockers: [],
            completedAt: 1709400000000,
        };
        getDB().handoffs.upsert(initial);

        // Verify initial state
        const before = getDB().handoffs.get(VALID_MASTER_TASK_ID, VALID_PHASE_ID);
        expect(before!.summary).toBeUndefined();
        expect(before!.rationale).toBeUndefined();

        // Update with enriched fields
        const updated: PhaseHandoff = {
            masterTaskId: VALID_MASTER_TASK_ID,
            phaseId: VALID_PHASE_ID,
            decisions: ['Updated decision'],
            modifiedFiles: ['initial.ts', 'new.ts'],
            blockers: [],
            completedAt: 1709500000000,
            summary: 'Updated summary',
            rationale: 'Updated rationale',
            remainingWork: ['remaining task'],
            constraints: ['new constraint'],
            warnings: ['new warning'],
            changedFilesJson: '[]',
            workspaceFolder: '/workspace/updated',
            symbolsTouched: ['NewClass.method'],
        };
        getDB().handoffs.upsert(updated);

        const after = getDB().handoffs.get(VALID_MASTER_TASK_ID, VALID_PHASE_ID);
        expect(after).toBeDefined();

        // Core fields updated
        expect(after!.decisions).toEqual(['Updated decision']);
        expect(after!.modifiedFiles).toEqual(['initial.ts', 'new.ts']);
        expect(after!.completedAt).toBe(1709500000000);

        // Enriched fields now present
        expect(after!.summary).toBe('Updated summary');
        expect(after!.rationale).toBe('Updated rationale');
        expect(after!.remainingWork).toEqual(['remaining task']);
        expect(after!.constraints).toEqual(['new constraint']);
        expect(after!.warnings).toEqual(['new warning']);
        expect(after!.changedFilesJson).toBe('[]');
        expect(after!.workspaceFolder).toBe('/workspace/updated');
        expect(after!.symbolsTouched).toEqual(['NewClass.method']);
    });
});
