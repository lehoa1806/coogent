// ─────────────────────────────────────────────────────────────────────────────
// SessionManager.test.ts — Regression tests for session operations
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

        // Pass the full dir name so getSessionDir() resolves the correct path
        await mgr.deleteSession(SESSION_DIR_NAME);

        // Verify directory no longer exists
        await expect(fs.stat(sessionDir)).rejects.toThrow();
    });

    it('calls db.deleteSessionFromDB when ArtifactDB is wired', async () => {
        // Create a fake session directory on disk
        const sessionDir = path.join(ipcDir, SESSION_DIR_NAME);
        await fs.mkdir(sessionDir, { recursive: true });

        // Create a mock ArtifactDB that resolves the UUID to the full dir name
        const mockDeleteSessionFromDB = jest.fn();
        const mockDB = {
            deleteSessionFromDB: mockDeleteSessionFromDB,
            sessions: {
                list: jest.fn().mockReturnValue([
                    {
                        sessionDirName: SESSION_DIR_NAME,
                        sessionId: SESSION_ID,
                        prompt: 'test',
                        createdAt: Date.now(),
                        runbookJson: null,
                        status: 'idle',
                    },
                ]),
            },
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

// ═════════════════════════════════════════════════════════════════════════════
//  listSessions() — DB-only behavior tests
// ═════════════════════════════════════════════════════════════════════════════

describe('SessionManager.listSessions() (DB-only)', () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-mgr-empty-id-'));
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('returns empty list when no ArtifactDB is wired', async () => {
        const mgr = new SessionManager(
            path.join(tmpDir, '.coogent'),
            CURRENT_SESSION_ID,
        );

        const sessions = await mgr.listSessions();
        expect(sessions).toEqual([]);
    });

    it('returns sessions from the DB without scanning disk', async () => {
        const dir1 = '20260309-125955-30ce149f-9555-420d-8538-9ddd61da3e2c';
        const dir2 = '20260309-132221-d4a0c4b6-9eba-445a-8095-f3c19aed81e1';

        const mockDB = {
            sessions: {
                list: jest.fn().mockReturnValue([
                    {
                        sessionDirName: dir1,
                        sessionId: '30ce149f-9555-420d-8538-9ddd61da3e2c',
                        prompt: 'Do something',
                        createdAt: Date.now() - 1000,
                        runbookJson: null,
                        status: 'idle',
                    },
                    {
                        sessionDirName: dir2,
                        sessionId: 'd4a0c4b6-9eba-445a-8095-f3c19aed81e1',
                        prompt: 'Do something else',
                        createdAt: Date.now(),
                        runbookJson: null,
                        status: 'idle',
                    },
                ]),
            },
        } as unknown as ArtifactDB;

        const mgr = new SessionManager(
            path.join(tmpDir, '.coogent'),
            '', // empty string — deferred session
            undefined,
            mockDB,
        );

        const sessions = await mgr.listSessions();

        // Both sessions should appear from DB
        expect(sessions.length).toBe(2);
        for (const s of sessions) {
            expect(s.isActive).toBe(false);
        }
    });

    it('tags the active session with isActive: true', async () => {
        const activeUuid = '30ce149f-9555-420d-8538-9ddd61da3e2c';
        const dir1 = `20260309-125955-${activeUuid}`;
        const dir2 = '20260309-132221-d4a0c4b6-9eba-445a-8095-f3c19aed81e1';

        const mockDB = {
            sessions: {
                list: jest.fn().mockReturnValue([
                    {
                        sessionDirName: dir1,
                        sessionId: activeUuid,
                        prompt: 'Do something',
                        createdAt: Date.now() - 1000,
                        runbookJson: null,
                        status: 'idle',
                    },
                    {
                        sessionDirName: dir2,
                        sessionId: 'd4a0c4b6-9eba-445a-8095-f3c19aed81e1',
                        prompt: 'Do something else',
                        createdAt: Date.now(),
                        runbookJson: null,
                        status: 'idle',
                    },
                ]),
            },
        } as unknown as ArtifactDB;

        const mgr = new SessionManager(
            path.join(tmpDir, '.coogent'),
            activeUuid,
            dir1,
            mockDB,
        );

        const sessions = await mgr.listSessions();

        // Both sessions should appear
        expect(sessions.length).toBe(2);

        const activeSess = sessions.find(s => s.sessionId === activeUuid);
        expect(activeSess).toBeDefined();
        expect(activeSess!.isActive).toBe(true);

        const otherSess = sessions.find(s => s.sessionId !== activeUuid);
        expect(otherSess).toBeDefined();
        expect(otherSess!.isActive).toBe(false);
    });

    it('builds full summary from runbook JSON when present', async () => {
        const dir1 = '20260309-125955-30ce149f-9555-420d-8538-9ddd61da3e2c';
        const runbook = {
            project_id: 'my-project',
            status: 'completed',
            phases: [
                { prompt: 'Build the feature', status: 'completed' },
                { prompt: 'Test the feature', status: 'completed' },
            ],
        };

        const mockDB = {
            sessions: {
                list: jest.fn().mockReturnValue([
                    {
                        sessionDirName: dir1,
                        sessionId: '30ce149f-9555-420d-8538-9ddd61da3e2c',
                        prompt: 'Build the feature',
                        createdAt: Date.now(),
                        runbookJson: JSON.stringify(runbook),
                        status: 'completed',
                    },
                ]),
            },
        } as unknown as ArtifactDB;

        const mgr = new SessionManager(
            path.join(tmpDir, '.coogent'),
            '',
            undefined,
            mockDB,
        );

        const sessions = await mgr.listSessions();

        expect(sessions.length).toBe(1);
        expect(sessions[0].projectId).toBe('my-project');
        expect(sessions[0].phaseCount).toBe(2);
        expect(sessions[0].completedPhases).toBe(2);
        expect(sessions[0].status).toBe('completed');
    });

    it('uses prompt text as projectId when runbookJson is null', async () => {
        const dir1 = '20260309-125955-30ce149f-9555-420d-8538-9ddd61da3e2c';

        const mockDB = {
            sessions: {
                list: jest.fn().mockReturnValue([
                    {
                        sessionDirName: dir1,
                        sessionId: '30ce149f-9555-420d-8538-9ddd61da3e2c',
                        prompt: 'Build a login page with OAuth support',
                        createdAt: Date.now(),
                        runbookJson: null,
                        status: 'idle',
                    },
                ]),
            },
        } as unknown as ArtifactDB;

        const mgr = new SessionManager(
            path.join(tmpDir, '.coogent'),
            '',
            undefined,
            mockDB,
        );

        const sessions = await mgr.listSessions();

        expect(sessions.length).toBe(1);
        expect(sessions[0].projectId).toBe('Build a login page with OAuth support');
    });

    it('falls back to "New session" when both runbookJson and prompt are empty', async () => {
        const dir1 = '20260309-125955-30ce149f-9555-420d-8538-9ddd61da3e2c';

        const mockDB = {
            sessions: {
                list: jest.fn().mockReturnValue([
                    {
                        sessionDirName: dir1,
                        sessionId: '30ce149f-9555-420d-8538-9ddd61da3e2c',
                        prompt: '',
                        createdAt: Date.now(),
                        runbookJson: null,
                        status: 'idle',
                    },
                ]),
            },
        } as unknown as ArtifactDB;

        const mgr = new SessionManager(
            path.join(tmpDir, '.coogent'),
            '',
            undefined,
            mockDB,
        );

        const sessions = await mgr.listSessions();

        expect(sessions.length).toBe(1);
        expect(sessions[0].projectId).toBe('New session');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
//  listSessions() — ArtifactDB wiring regression tests (session history fix)
// ═════════════════════════════════════════════════════════════════════════════

describe('SessionManager.listSessions() — setArtifactDB wiring regression', () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-mgr-wiring-'));
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('returns empty array when ArtifactDB is NOT wired (no constructor arg, no setArtifactDB)', async () => {
        const mgr = new SessionManager(
            path.join(tmpDir, '.coogent'),
            CURRENT_SESSION_ID,
        );
        // No ArtifactDB supplied at all — listSessions must return []
        const sessions = await mgr.listSessions();
        expect(sessions).toEqual([]);
    });

    it('returns sessions when ArtifactDB IS wired via setArtifactDB() post-construction', async () => {
        const mockDB = {
            sessions: {
                list: jest.fn().mockReturnValue([
                    {
                        sessionDirName: '20260310-120000-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
                        sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
                        prompt: 'Test prompt',
                        createdAt: Date.now(),
                        runbookJson: null,
                        status: null,
                    },
                ]),
            },
        } as unknown as ArtifactDB;

        const mgr = new SessionManager(
            path.join(tmpDir, '.coogent'),
            CURRENT_SESSION_ID,
        );

        // Wire the DB after construction (mirrors the real eager-wiring fix)
        mgr.setArtifactDB(mockDB);

        const sessions = await mgr.listSessions();

        expect(sessions.length).toBe(1);
        expect(sessions[0].sessionId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
        expect(sessions[0].firstPrompt).toBe('Test prompt');
        expect(mockDB.sessions.list).toHaveBeenCalledTimes(1);
    });
});
