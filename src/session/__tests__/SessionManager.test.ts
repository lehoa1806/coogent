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

    it('calls db.deleteSessionCascade when ArtifactDB is wired', async () => {
        // Create a fake session directory on disk
        const sessionDir = path.join(ipcDir, SESSION_DIR_NAME);
        await fs.mkdir(sessionDir, { recursive: true });

        // Create a mock ArtifactDB that resolves the UUID to the full dir name
        const mockDeleteSessionCascade = jest.fn();
        const sessionRow = {
            sessionDirName: SESSION_DIR_NAME,
            sessionId: SESSION_ID,
            prompt: 'test',
            createdAt: Date.now(),
            runbookJson: null,
            status: 'idle',
            consolidationReport: null,
            consolidationReportJson: null,
            implementationPlan: null,
        };
        const mockDB = {
            deleteSessionCascade: mockDeleteSessionCascade,
            sessions: {
                list: jest.fn().mockReturnValue([sessionRow]),
                getBySessionId: jest.fn().mockImplementation((id: string) =>
                    id === SESSION_ID ? sessionRow : undefined,
                ),
                getByDirName: jest.fn().mockImplementation((name: string) =>
                    name === SESSION_DIR_NAME ? sessionRow : undefined,
                ),
            },
        } as unknown as ArtifactDB;

        const mgr = new SessionManager(
            path.join(tmpDir, '.coogent'),
            CURRENT_SESSION_ID
        );
        mgr.setArtifactDB(mockDB);

        await mgr.deleteSession(SESSION_ID);

        // Verify DB deletion was called with the dir name (basename of session dir)
        expect(mockDeleteSessionCascade).toHaveBeenCalledTimes(1);
        expect(mockDeleteSessionCascade).toHaveBeenCalledWith(SESSION_DIR_NAME);
    });

    it('does not call db.deleteSessionCascade when no ArtifactDB is wired', async () => {
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

    it('handles db.deleteSessionCascade failure gracefully (does not throw)', async () => {
        const sessionDir = path.join(ipcDir, SESSION_DIR_NAME);
        await fs.mkdir(sessionDir, { recursive: true });

        const mockDB = {
            deleteSessionCascade: jest.fn().mockImplementation(() => {
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
                        consolidationReport: null,
                        consolidationReportJson: null,
                        implementationPlan: null,
                    },
                    {
                        sessionDirName: dir2,
                        sessionId: 'd4a0c4b6-9eba-445a-8095-f3c19aed81e1',
                        prompt: 'Do something else',
                        createdAt: Date.now(),
                        runbookJson: null,
                        status: 'idle',
                        consolidationReport: null,
                        consolidationReportJson: null,
                        implementationPlan: null,
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
                        consolidationReport: null,
                        consolidationReportJson: null,
                        implementationPlan: null,
                    },
                    {
                        sessionDirName: dir2,
                        sessionId: 'd4a0c4b6-9eba-445a-8095-f3c19aed81e1',
                        prompt: 'Do something else',
                        createdAt: Date.now(),
                        runbookJson: null,
                        status: 'idle',
                        consolidationReport: null,
                        consolidationReportJson: null,
                        implementationPlan: null,
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
                        consolidationReport: null,
                        consolidationReportJson: null,
                        implementationPlan: null,
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
                        consolidationReport: null,
                        consolidationReportJson: null,
                        implementationPlan: null,
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
                        consolidationReport: null,
                        consolidationReportJson: null,
                        implementationPlan: null,
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
                        consolidationReport: null,
                        consolidationReportJson: null,
                        implementationPlan: null,
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

// ═════════════════════════════════════════════════════════════════════════════
//  listSessions() — Session history population regression tests
// ═════════════════════════════════════════════════════════════════════════════

describe('SessionManager.listSessions() — session history population', () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-mgr-history-'));
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('returns sessions sorted by createdAt descending (most recent first)', async () => {
        const now = Date.now();
        const mockDB = {
            sessions: {
                list: jest.fn().mockReturnValue([
                    {
                        sessionDirName: '20260301-100000-aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee',
                        sessionId: 'aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee',
                        prompt: 'Oldest session',
                        createdAt: now - 3000,
                        runbookJson: null,
                        status: 'idle',
                        consolidationReport: null,
                        consolidationReportJson: null,
                        implementationPlan: null,
                    },
                    {
                        sessionDirName: '20260303-100000-cccc3333-bbbb-cccc-dddd-eeeeeeeeeeee',
                        sessionId: 'cccc3333-bbbb-cccc-dddd-eeeeeeeeeeee',
                        prompt: 'Newest session',
                        createdAt: now,
                        runbookJson: null,
                        status: 'idle',
                        consolidationReport: null,
                        consolidationReportJson: null,
                        implementationPlan: null,
                    },
                    {
                        sessionDirName: '20260302-100000-bbbb2222-bbbb-cccc-dddd-eeeeeeeeeeee',
                        sessionId: 'bbbb2222-bbbb-cccc-dddd-eeeeeeeeeeee',
                        prompt: 'Middle session',
                        createdAt: now - 1000,
                        runbookJson: null,
                        status: 'idle',
                        consolidationReport: null,
                        consolidationReportJson: null,
                        implementationPlan: null,
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

        expect(sessions.length).toBe(3);
        // Most recent first
        expect(sessions[0].sessionId).toBe('cccc3333-bbbb-cccc-dddd-eeeeeeeeeeee');
        expect(sessions[1].sessionId).toBe('bbbb2222-bbbb-cccc-dddd-eeeeeeeeeeee');
        expect(sessions[2].sessionId).toBe('aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee');
        // Verify timestamps are descending
        expect(sessions[0].createdAt).toBeGreaterThan(sessions[1].createdAt);
        expect(sessions[1].createdAt).toBeGreaterThan(sessions[2].createdAt);
    });

    it('handles DB errors gracefully and returns empty array', async () => {
        const mockDB = {
            sessions: {
                list: jest.fn().mockImplementation(() => {
                    throw new Error('Database corrupted');
                }),
            },
        } as unknown as ArtifactDB;

        const mgr = new SessionManager(
            path.join(tmpDir, '.coogent'),
            '',
            undefined,
            mockDB,
        );

        // Should not throw — returns empty array
        const sessions = await mgr.listSessions();
        expect(sessions).toEqual([]);
    });

    it('derives projectId from runbook.project_id or prompt depending on runbookJson presence', async () => {
        const now = Date.now();
        const runbook = {
            project_id: 'auth-service',
            status: 'in_progress',
            phases: [
                { prompt: 'Implement OAuth flow', status: 'completed' },
                { prompt: 'Add JWT validation', status: 'in_progress' },
            ],
        };

        const mockDB = {
            sessions: {
                list: jest.fn().mockReturnValue([
                    {
                        sessionDirName: '20260310-100000-aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee',
                        sessionId: 'aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee',
                        prompt: 'Implement OAuth flow',
                        createdAt: now,
                        runbookJson: JSON.stringify(runbook),
                        status: 'in_progress',
                        consolidationReport: null,
                        consolidationReportJson: null,
                        implementationPlan: null,
                    },
                    {
                        sessionDirName: '20260310-090000-bbbb2222-bbbb-cccc-dddd-eeeeeeeeeeee',
                        sessionId: 'bbbb2222-bbbb-cccc-dddd-eeeeeeeeeeee',
                        prompt: 'Fix the login page',
                        createdAt: now - 1000,
                        runbookJson: null,
                        status: 'idle',
                        consolidationReport: null,
                        consolidationReportJson: null,
                        implementationPlan: null,
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

        expect(sessions.length).toBe(2);

        // Session with runbook: projectId from runbook.project_id
        const withRunbook = sessions.find(s => s.sessionId === 'aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee');
        expect(withRunbook).toBeDefined();
        expect(withRunbook!.projectId).toBe('auth-service');
        expect(withRunbook!.phaseCount).toBe(2);
        expect(withRunbook!.completedPhases).toBe(1);

        // Session without runbook: projectId derived from prompt
        const withoutRunbook = sessions.find(s => s.sessionId === 'bbbb2222-bbbb-cccc-dddd-eeeeeeeeeeee');
        expect(withoutRunbook).toBeDefined();
        expect(withoutRunbook!.projectId).toBe('Fix the login page');
        expect(withoutRunbook!.phaseCount).toBe(0);
        expect(withoutRunbook!.completedPhases).toBe(0);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
//  getConsolidationReport() — Consolidation report retrieval tests
// ═════════════════════════════════════════════════════════════════════════════

describe('SessionManager.getConsolidationReport()', () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-mgr-consol-'));
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('should return markdown and JSON when report exists', async () => {
        const dirName = '20260310-120000-aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee';
        const mockDB = {
            sessions: {
                list: jest.fn().mockReturnValue([]),
                getConsolidationReport: jest.fn().mockReturnValue({
                    markdown: '# Report\nAll phases completed.',
                    json: '{"summary":"done"}',
                }),
            },
        } as unknown as ArtifactDB;

        const mgr = new SessionManager(
            path.join(tmpDir, '.coogent'),
            '',
            undefined,
            mockDB,
        );

        const result = await mgr.getConsolidationReport(dirName);

        expect(result).not.toBeNull();
        expect(result!.markdown).toBe('# Report\nAll phases completed.');
        expect(result!.json).toBe('{"summary":"done"}');
        expect(mockDB.sessions.getConsolidationReport).toHaveBeenCalledWith(dirName);
    });

    it('should return null when no report exists', async () => {
        const dirName = '20260310-120000-bbbb2222-bbbb-cccc-dddd-eeeeeeeeeeee';
        const mockDB = {
            sessions: {
                list: jest.fn().mockReturnValue([]),
                getConsolidationReport: jest.fn().mockReturnValue(undefined),
            },
        } as unknown as ArtifactDB;

        const mgr = new SessionManager(
            path.join(tmpDir, '.coogent'),
            '',
            undefined,
            mockDB,
        );

        const result = await mgr.getConsolidationReport(dirName);

        expect(result).toBeNull();
    });

    it('should return null when ArtifactDB is not wired', async () => {
        const mgr = new SessionManager(
            path.join(tmpDir, '.coogent'),
            CURRENT_SESSION_ID,
        );

        const result = await mgr.getConsolidationReport('20260310-120000-any-uuid');

        expect(result).toBeNull();
    });

    it('should handle DB errors gracefully and return null', async () => {
        const dirName = '20260310-120000-cccc3333-bbbb-cccc-dddd-eeeeeeeeeeee';
        const mockDB = {
            sessions: {
                list: jest.fn().mockReturnValue([]),
                getConsolidationReport: jest.fn().mockImplementation(() => {
                    throw new Error('DB read failure');
                }),
            },
        } as unknown as ArtifactDB;

        const mgr = new SessionManager(
            path.join(tmpDir, '.coogent'),
            '',
            undefined,
            mockDB,
        );

        const result = await mgr.getConsolidationReport(dirName);

        expect(result).toBeNull();
    });
});

// ═════════════════════════════════════════════════════════════════════════════
//  listSessions() — hasConsolidationReport field tests
// ═════════════════════════════════════════════════════════════════════════════

describe('SessionManager.listSessions() — hasConsolidationReport field', () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-mgr-has-report-'));
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('should set hasConsolidationReport to true when consolidationReport is present', async () => {
        const mockDB = {
            sessions: {
                list: jest.fn().mockReturnValue([
                    {
                        sessionDirName: '20260310-120000-aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee',
                        sessionId: 'aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee',
                        prompt: 'Session with report',
                        createdAt: Date.now(),
                        runbookJson: null,
                        status: 'completed',
                        consolidationReport: '# Full Consolidation Report',
                        consolidationReportJson: '{"phases":[]}',
                        implementationPlan: null,
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
        expect(sessions[0].hasConsolidationReport).toBe(true);
    });

    it('should set hasConsolidationReport to false when consolidationReport is null', async () => {
        const mockDB = {
            sessions: {
                list: jest.fn().mockReturnValue([
                    {
                        sessionDirName: '20260310-120000-bbbb2222-bbbb-cccc-dddd-eeeeeeeeeeee',
                        sessionId: 'bbbb2222-bbbb-cccc-dddd-eeeeeeeeeeee',
                        prompt: 'Session without report',
                        createdAt: Date.now(),
                        runbookJson: null,
                        status: 'idle',
                        consolidationReport: null,
                        consolidationReportJson: null,
                        implementationPlan: null,
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
        expect(sessions[0].hasConsolidationReport).toBe(false);
    });

    it('should set hasConsolidationReport correctly for sessions with runbook data', async () => {
        const runbook = {
            project_id: 'alpha',
            status: 'completed',
            phases: [
                { prompt: 'Phase 1', status: 'completed' },
            ],
        };

        const mockDB = {
            sessions: {
                list: jest.fn().mockReturnValue([
                    {
                        sessionDirName: '20260310-120000-cccc3333-bbbb-cccc-dddd-eeeeeeeeeeee',
                        sessionId: 'cccc3333-bbbb-cccc-dddd-eeeeeeeeeeee',
                        prompt: 'Phase 1',
                        createdAt: Date.now(),
                        runbookJson: JSON.stringify(runbook),
                        status: 'completed',
                        consolidationReport: '# Report for alpha',
                        consolidationReportJson: '{"outcome":"success"}',
                        implementationPlan: null,
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
        expect(sessions[0].projectId).toBe('alpha');
        expect(sessions[0].hasConsolidationReport).toBe(true);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
//  getImplementationPlan() — Implementation plan retrieval tests
// ═════════════════════════════════════════════════════════════════════════════

describe('SessionManager.getImplementationPlan()', () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-mgr-impl-plan-'));
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('should return implementation plan when it exists', async () => {
        const dirName = '20260310-120000-aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee';
        const mockDB = {
            sessions: {
                list: jest.fn().mockReturnValue([]),
                getImplementationPlan: jest.fn().mockReturnValue('## Approach\nDo the thing.'),
            },
        } as unknown as ArtifactDB;

        const mgr = new SessionManager(
            path.join(tmpDir, '.coogent'),
            '',
            undefined,
            mockDB,
        );

        const result = await mgr.getImplementationPlan(dirName);

        expect(result).toBe('## Approach\nDo the thing.');
        expect(mockDB.sessions.getImplementationPlan).toHaveBeenCalledWith(dirName);
    });

    it('should return null when no plan exists', async () => {
        const dirName = '20260310-120000-bbbb2222-bbbb-cccc-dddd-eeeeeeeeeeee';
        const mockDB = {
            sessions: {
                list: jest.fn().mockReturnValue([]),
                getImplementationPlan: jest.fn().mockReturnValue(undefined),
            },
        } as unknown as ArtifactDB;

        const mgr = new SessionManager(
            path.join(tmpDir, '.coogent'),
            '',
            undefined,
            mockDB,
        );

        const result = await mgr.getImplementationPlan(dirName);

        expect(result).toBeNull();
    });

    it('should return null when ArtifactDB is not wired', async () => {
        const mgr = new SessionManager(
            path.join(tmpDir, '.coogent'),
            'current-session-id',
        );

        const result = await mgr.getImplementationPlan('20260310-120000-any-uuid');

        expect(result).toBeNull();
    });

    it('should handle DB errors gracefully and return null', async () => {
        const dirName = '20260310-120000-cccc3333-bbbb-cccc-dddd-eeeeeeeeeeee';
        const mockDB = {
            sessions: {
                list: jest.fn().mockReturnValue([]),
                getImplementationPlan: jest.fn().mockImplementation(() => {
                    throw new Error('DB read failure');
                }),
            },
        } as unknown as ArtifactDB;

        const mgr = new SessionManager(
            path.join(tmpDir, '.coogent'),
            '',
            undefined,
            mockDB,
        );

        const result = await mgr.getImplementationPlan(dirName);

        expect(result).toBeNull();
    });
});

// ═════════════════════════════════════════════════════════════════════════════
//  listSessions() — hasImplementationPlan field tests
// ═════════════════════════════════════════════════════════════════════════════

describe('SessionManager.listSessions() — hasImplementationPlan field', () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-mgr-has-plan-'));
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('should set hasImplementationPlan to true when implementationPlan is present', async () => {
        const mockDB = {
            sessions: {
                list: jest.fn().mockReturnValue([
                    {
                        sessionDirName: '20260310-120000-aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee',
                        sessionId: 'aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee',
                        prompt: 'Session with plan',
                        createdAt: Date.now(),
                        runbookJson: null,
                        status: 'completed',
                        consolidationReport: null,
                        consolidationReportJson: null,
                        implementationPlan: '## Plan\nDo the thing.',
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
        expect(sessions[0].hasImplementationPlan).toBe(true);
    });

    it('should set hasImplementationPlan to false when implementationPlan is null', async () => {
        const mockDB = {
            sessions: {
                list: jest.fn().mockReturnValue([
                    {
                        sessionDirName: '20260310-120000-bbbb2222-bbbb-cccc-dddd-eeeeeeeeeeee',
                        sessionId: 'bbbb2222-bbbb-cccc-dddd-eeeeeeeeeeee',
                        prompt: 'Session without plan',
                        createdAt: Date.now(),
                        runbookJson: null,
                        status: 'idle',
                        consolidationReport: null,
                        consolidationReportJson: null,
                        implementationPlan: null,
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
        expect(sessions[0].hasImplementationPlan).toBe(false);
    });
});
