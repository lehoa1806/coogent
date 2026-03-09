// ─────────────────────────────────────────────────────────────────────────────
// SessionRepository.delete.test.ts — Regression tests for session + task deletion
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { CoogentMCPServer } from '../CoogentMCPServer.js';

// ─── Test Fixtures ───────────────────────────────────────────────────────────

const SESSION_DIR_NAME =
    '20260305-173000-a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const SESSION_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const SESSION_PROMPT = 'Refactor auth module';
const CREATED_AT = 1709654400000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function createInMemoryDB(tmpDir: string) {
    const server = new CoogentMCPServer(tmpDir);
    await server.init(tmpDir);
    return server;
}

// ═════════════════════════════════════════════════════════════════════════════
//  SessionRepository.delete() — Regression Tests
// ═════════════════════════════════════════════════════════════════════════════

describe('SessionRepository.delete()', () => {
    let tmpDir: string;
    let server: CoogentMCPServer;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-delete-test-'));
        server = await createInMemoryDB(tmpDir);
    });

    afterEach(async () => {
        server.dispose();
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const getDB = () => (server as any).db;

    it('removes the session row from the sessions table', () => {
        // 1. Insert a session
        getDB().sessions.upsert(SESSION_DIR_NAME, SESSION_ID, SESSION_PROMPT, CREATED_AT);

        // Verify it exists
        const beforeList = getDB().sessions.list();
        expect(beforeList).toHaveLength(1);
        expect(beforeList[0].sessionDirName).toBe(SESSION_DIR_NAME);

        // 2. Delete it
        getDB().sessions.delete(SESSION_DIR_NAME);

        // 3. Verify sessions table is empty
        const afterList = getDB().sessions.list();
        expect(afterList).toHaveLength(0);
    });

    it('removes the corresponding tasks row when deleting a session', () => {
        // 1. Insert a session (upsert also creates a tasks row via INSERT OR IGNORE)
        getDB().sessions.upsert(SESSION_DIR_NAME, SESSION_ID, SESSION_PROMPT, CREATED_AT);

        // Verify the tasks row exists via TaskRepository.get()
        const taskBefore = getDB().tasks.get(SESSION_DIR_NAME);
        expect(taskBefore).toBeDefined();
        expect(taskBefore!.masterTaskId).toBe(SESSION_DIR_NAME);

        // 2. Delete the session
        getDB().sessions.delete(SESSION_DIR_NAME);

        // 3. Verify the tasks row is also deleted
        const taskAfter = getDB().tasks.get(SESSION_DIR_NAME);
        expect(taskAfter).toBeUndefined();
    });

    it('deleting a non-existent session is a no-op', () => {
        // Should not throw
        expect(() => getDB().sessions.delete('non-existent-dir-name')).not.toThrow();
    });

    it('does not affect other sessions when deleting one', () => {
        const otherDirName = '20260306-120000-b2c3d4e5-f6a7-8901-bcde-f12345678901';
        const otherSessionId = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';

        // Insert two sessions
        getDB().sessions.upsert(SESSION_DIR_NAME, SESSION_ID, SESSION_PROMPT, CREATED_AT);
        getDB().sessions.upsert(otherDirName, otherSessionId, 'Other prompt', CREATED_AT + 1000);

        expect(getDB().sessions.list()).toHaveLength(2);

        // Delete only the first
        getDB().sessions.delete(SESSION_DIR_NAME);

        // Verify only the second remains
        const remaining = getDB().sessions.list();
        expect(remaining).toHaveLength(1);
        expect(remaining[0].sessionDirName).toBe(otherDirName);
    });

    it('list() returns empty after deleting the only session', () => {
        getDB().sessions.upsert(SESSION_DIR_NAME, SESSION_ID, SESSION_PROMPT, CREATED_AT);
        getDB().sessions.delete(SESSION_DIR_NAME);

        const result = getDB().sessions.list();
        expect(result).toEqual([]);
    });
});
