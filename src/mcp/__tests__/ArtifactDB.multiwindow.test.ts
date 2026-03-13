// ─────────────────────────────────────────────────────────────────────────────
// ArtifactDB.multiwindow.test.ts — Multi-window merge safety tests
// ─────────────────────────────────────────────────────────────────────────────
// Validates that multiple ArtifactDB instances pointing at the same database
// file can coexist, writing and reading data without data loss.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ArtifactDB } from '../ArtifactDB.js';

describe('ArtifactDB — Multi-Window Safety', () => {
    let tmpDir: string;
    let dbPath: string;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact-multiwindow-'));
        dbPath = path.join(tmpDir, 'artifacts.db');
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    // ─────────────────────────────────────────────────────────────────────
    //  Basic: Two instances can open the same file without errors
    // ─────────────────────────────────────────────────────────────────────

    it('two instances can open the same database file concurrently', async () => {
        const dbA = await ArtifactDB.create(dbPath, 'workspace-alpha');
        const dbB = await ArtifactDB.create(dbPath, 'workspace-beta');

        // Both should be operational — no lock error
        expect(dbA).toBeDefined();
        expect(dbB).toBeDefined();

        dbA.close();
        dbB.close();
    });

    // ─────────────────────────────────────────────────────────────────────
    //  Merge: Writes from two instances are both preserved
    // ─────────────────────────────────────────────────────────────────────

    it('concurrent writes from two instances are merged on flush', async () => {
        const dbA = await ArtifactDB.create(dbPath, 'workspace-alpha');
        const dbB = await ArtifactDB.create(dbPath, 'workspace-beta');

        const taskIdA = 'task-20260311-multiwin-a-00000000-0000-0000-0000-000000000001';
        const taskIdB = 'task-20260311-multiwin-b-00000000-0000-0000-0000-000000000002';

        // Instance A writes task-1
        dbA.tasks.upsert(taskIdA, { summary: 'Alpha task' });
        // Instance B writes task-2
        dbB.tasks.upsert(taskIdB, { summary: 'Beta task' });

        // Close both (flushSync merges and writes)
        dbA.close();
        dbB.close();

        // Reopen and verify both tasks exist
        // Use workspace-alpha to verify task A, workspace-beta to verify task B
        const dbVerifyA = await ArtifactDB.create(dbPath, 'workspace-alpha');
        const dbVerifyB = await ArtifactDB.create(dbPath, 'workspace-beta');
        try {
            const taskA = dbVerifyA.tasks.get(taskIdA);
            const taskB = dbVerifyB.tasks.get(taskIdB);

            expect(taskA).toBeDefined();
            expect(taskA!.summary).toBe('Alpha task');
            expect(taskB).toBeDefined();
            expect(taskB!.summary).toBe('Beta task');
        } finally {
            dbVerifyA.close();
            dbVerifyB.close();
        }
    });

    // ─────────────────────────────────────────────────────────────────────
    //  Last-write-wins for same-row conflicts
    // ─────────────────────────────────────────────────────────────────────

    it('last flush wins for same-row conflicts (INSERT OR REPLACE)', async () => {
        const taskId = 'task-20260311-conflict-00000000-0000-0000-0000-000000000001';

        const dbA = await ArtifactDB.create(dbPath, 'workspace-alpha');
        const dbB = await ArtifactDB.create(dbPath, 'workspace-alpha');

        // Both modify the same task
        dbA.tasks.upsert(taskId, { summary: 'Version from A' });
        dbB.tasks.upsert(taskId, { summary: 'Version from B' });

        // A flushes first, then B flushes (B's version should win)
        dbA.close();
        dbB.close();

        // Verify B's version is on disk (last writer wins)
        const dbVerify = await ArtifactDB.create(dbPath, 'workspace-alpha');
        try {
            const task = dbVerify.tasks.get(taskId);
            expect(task).toBeDefined();
            expect(task!.summary).toBe('Version from B');
        } finally {
            dbVerify.close();
        }
    });

    // ─────────────────────────────────────────────────────────────────────
    //  Sequential: A closes, B picks up A's data
    // ─────────────────────────────────────────────────────────────────────

    it('second instance picks up first instance data after first flushes', async () => {
        const taskIdA = 'task-20260311-seq-a-00000000-0000-0000-0000-000000000001';
        const taskIdB = 'task-20260311-seq-b-00000000-0000-0000-0000-000000000002';

        // Instance A writes and closes
        const dbA = await ArtifactDB.create(dbPath, 'workspace-alpha');
        dbA.tasks.upsert(taskIdA, { summary: 'Task from A' });
        dbA.close();

        // Instance B opens (should load A's data from disk), writes its own, closes
        const dbB = await ArtifactDB.create(dbPath, 'workspace-beta');
        dbB.tasks.upsert(taskIdB, { summary: 'Task from B' });
        dbB.close();

        // Verify both tasks exist on disk
        // Use workspace-alpha to verify task A, workspace-beta to verify task B
        const dbVerifyA = await ArtifactDB.create(dbPath, 'workspace-alpha');
        const dbVerifyB = await ArtifactDB.create(dbPath, 'workspace-beta');
        try {
            const taskA = dbVerifyA.tasks.get(taskIdA);
            const taskB = dbVerifyB.tasks.get(taskIdB);

            expect(taskA).toBeDefined();
            expect(taskA!.summary).toBe('Task from A');
            expect(taskB).toBeDefined();
            expect(taskB!.summary).toBe('Task from B');
        } finally {
            dbVerifyA.close();
            dbVerifyB.close();
        }
    });

    // ─────────────────────────────────────────────────────────────────────
    //  No .lock file is created
    // ─────────────────────────────────────────────────────────────────────

    it('does not create a .lock file', async () => {
        const dbA = await ArtifactDB.create(dbPath, 'workspace-alpha');

        const lockExists = await fs.access(dbPath + '.lock').then(() => true).catch(() => false);
        expect(lockExists).toBe(false);

        dbA.close();
    });
});
