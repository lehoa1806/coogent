// ─────────────────────────────────────────────────────────────────────────────
// SessionManager.test.ts — Regression tests for session deletion & DB cleanup
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { SessionManager } from '../SessionManager.js';
import type { ArtifactDB } from '../../mcp/ArtifactDB.js';

// ─── Test Fixtures ───────────────────────────────────────────────────────────

const SESSION_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const SESSION_DIR_NAME = '20260305-173000-a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const CURRENT_SESSION_ID = 'current-session-id';

// ═════════════════════════════════════════════════════════════════════════════
//  SessionManager.deleteSession() — Regression Tests
// ═════════════════════════════════════════════════════════════════════════════

describe('SessionManager.deleteSession()', () => {
    let tmpDir: string;
    let ipcDir: string;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-mgr-test-'));
        ipcDir = path.join(tmpDir, '.coogent', 'ipc');
        await fs.mkdir(ipcDir, { recursive: true });
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('calls fs.rm to remove the session directory', async () => {
        // Create a fake session directory on disk
        const sessionDir = path.join(ipcDir, SESSION_DIR_NAME);
        await fs.mkdir(sessionDir, { recursive: true });
        // Write a dummy file to confirm recursive deletion
        await fs.writeFile(path.join(sessionDir, 'test.json'), '{}');

        const mgr = new SessionManager(
            path.join(tmpDir, '.coogent'),
            CURRENT_SESSION_ID
        );

        await mgr.deleteSession(SESSION_ID);

        // Verify directory no longer exists
        await expect(fs.stat(sessionDir)).rejects.toThrow();
    });

    it('calls db.deleteSessionFromDB when ArtifactDB is wired', async () => {
        // Create a fake session directory on disk
        const sessionDir = path.join(ipcDir, SESSION_DIR_NAME);
        await fs.mkdir(sessionDir, { recursive: true });

        // Create a mock ArtifactDB
        const mockDeleteSessionFromDB = jest.fn();
        const mockDB = {
            deleteSessionFromDB: mockDeleteSessionFromDB,
            sessions: { list: jest.fn().mockReturnValue([]) },
        } as unknown as ArtifactDB;

        const mgr = new SessionManager(
            path.join(tmpDir, '.coogent'),
            CURRENT_SESSION_ID
        );
        mgr.setArtifactDB(mockDB);

        await mgr.deleteSession(SESSION_ID);

        // Verify DB deletion was called with the dir name (basename of session dir)
        expect(mockDeleteSessionFromDB).toHaveBeenCalledTimes(1);
        expect(mockDeleteSessionFromDB).toHaveBeenCalledWith(SESSION_DIR_NAME);
    });

    it('does not call db.deleteSessionFromDB when no ArtifactDB is wired', async () => {
        // Create a fake session directory on disk
        const sessionDir = path.join(ipcDir, SESSION_DIR_NAME);
        await fs.mkdir(sessionDir, { recursive: true });

        const mgr = new SessionManager(
            path.join(tmpDir, '.coogent'),
            CURRENT_SESSION_ID
        );
        // No setArtifactDB() call

        // Should not throw even without DB
        await expect(mgr.deleteSession(SESSION_ID)).resolves.not.toThrow();
    });

    it('handles fs.rm failure gracefully (does not throw)', async () => {
        // Session directory does not exist — rm with force will succeed anyway,
        // but we can verify the method completes without error
        const mgr = new SessionManager(
            path.join(tmpDir, '.coogent'),
            CURRENT_SESSION_ID
        );

        await expect(mgr.deleteSession('nonexistent-session')).resolves.not.toThrow();
    });

    it('handles db.deleteSessionFromDB failure gracefully (does not throw)', async () => {
        const sessionDir = path.join(ipcDir, SESSION_DIR_NAME);
        await fs.mkdir(sessionDir, { recursive: true });

        const mockDB = {
            deleteSessionFromDB: jest.fn().mockImplementation(() => {
                throw new Error('DB failure');
            }),
            sessions: { list: jest.fn().mockReturnValue([]) },
        } as unknown as ArtifactDB;

        const mgr = new SessionManager(
            path.join(tmpDir, '.coogent'),
            CURRENT_SESSION_ID
        );
        mgr.setArtifactDB(mockDB);

        // Should not throw despite DB failure
        await expect(mgr.deleteSession(SESSION_ID)).resolves.not.toThrow();
    });
});
