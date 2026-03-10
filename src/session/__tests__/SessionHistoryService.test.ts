// ─────────────────────────────────────────────────────────────────────────────
// src/session/__tests__/SessionHistoryService.test.ts
// ─────────────────────────────────────────────────────────────────────────────

import { SessionHistoryService } from '../SessionHistoryService.js';
import type { SessionManager, SessionSummary } from '../SessionManager.js';
import type { SessionRestoreService, SessionRestoreResult } from '../SessionRestoreService.js';
import type { SessionDeleteService, SessionDeleteResult } from '../SessionDeleteService.js';
import type { CoogentMCPServer } from '../../mcp/CoogentMCPServer.js';

// ── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../../logger/log.js', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../SessionManager.js', () => ({
    stripSessionDirPrefix: jest.fn((dirName: string) => {
        const match = dirName.match(/^\d{8}-\d{6}-(.+)$/);
        return match ? match[1] : dirName;
    }),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

const MOCK_SESSIONS: SessionSummary[] = [
    {
        sessionId: 'abc-123',
        projectId: 'project-alpha',
        status: 'completed',
        phaseCount: 3,
        completedPhases: 3,
        createdAt: Date.now() - 1000,
        firstPrompt: 'Build feature X',
    },
    {
        sessionId: 'def-456',
        projectId: 'project-beta',
        status: 'running',
        phaseCount: 5,
        completedPhases: 2,
        createdAt: Date.now() - 2000,
        firstPrompt: 'Fix bug Y',
    },
];

function makeRestoreResult(
    sessionDirName: string,
    success: boolean,
    errors: string[] = [],
): SessionRestoreResult {
    return {
        success,
        sessionDirName,
        healthStatus: success ? 'healthy' : 'invalid',
        runbook: success
            ? { project_id: 'test', status: 'running', phases: [] }
            : null,
        workerOutputs: success ? { 'phase-001': 'output' } : {},
        errors,
    } as SessionRestoreResult;
}

function makeDeleteResult(
    sessionDirName: string,
    success: boolean,
    errors: string[] = [],
): SessionDeleteResult {
    return { success, sessionDirName, errors };
}

function createMockSessionManager(): SessionManager {
    return {
        listSessions: jest.fn().mockResolvedValue(MOCK_SESSIONS),
        searchSessions: jest.fn().mockResolvedValue([MOCK_SESSIONS[0]]),
        setCurrentSessionId: jest.fn(),
        getCurrentSessionDirName: jest.fn().mockReturnValue('20260309-105927-current-uuid'),
    } as unknown as SessionManager;
}

function createMockRestoreService(
    result: SessionRestoreResult,
): SessionRestoreService {
    return {
        restore: jest.fn().mockResolvedValue(result),
    } as unknown as SessionRestoreService;
}

function createMockDeleteService(
    result: SessionDeleteResult,
): SessionDeleteService {
    return {
        deleteSession: jest.fn().mockResolvedValue(result),
    } as unknown as SessionDeleteService;
}

function createMockMCPServer(): CoogentMCPServer {
    return {} as unknown as CoogentMCPServer;
}

// ── Test Suite ───────────────────────────────────────────────────────────────

describe('SessionHistoryService', () => {
    const SESSION_DIR_NAME = '20260309-105927-abc-def-ghi-jkl-mno';

    afterEach(() => {
        jest.clearAllMocks();
    });

    // ── 1. listSessions delegates to SessionManager ─────────────────────

    it('delegates listSessions to SessionManager', async () => {
        const sessionManager = createMockSessionManager();
        const restoreService = createMockRestoreService(makeRestoreResult(SESSION_DIR_NAME, true));
        const deleteService = createMockDeleteService(makeDeleteResult(SESSION_DIR_NAME, true));
        createMockMCPServer(); // keep mock instantiation for side-effect validation

        const service = new SessionHistoryService(
            sessionManager, restoreService, deleteService,
        );

        const sessions = await service.listSessions();

        expect(sessionManager.listSessions).toHaveBeenCalledTimes(1);
        expect(sessions).toEqual(MOCK_SESSIONS);
    });

    // ── 2. searchSessions delegates with query ──────────────────────────

    it('delegates searchSessions to SessionManager with query', async () => {
        const sessionManager = createMockSessionManager();
        const restoreService = createMockRestoreService(makeRestoreResult(SESSION_DIR_NAME, true));
        const deleteService = createMockDeleteService(makeDeleteResult(SESSION_DIR_NAME, true));
        createMockMCPServer(); // keep mock instantiation for side-effect validation

        const service = new SessionHistoryService(
            sessionManager, restoreService, deleteService,
        );

        const results = await service.searchSessions('alpha');

        expect(sessionManager.searchSessions).toHaveBeenCalledWith('alpha');
        expect(results).toEqual([MOCK_SESSIONS[0]]);
    });

    // ── 3. loadSession calls restore and updates sessionManager ─────────

    it('calls restore and updates active session on success', async () => {
        const sessionManager = createMockSessionManager();
        const successResult = makeRestoreResult(SESSION_DIR_NAME, true);
        const restoreService = createMockRestoreService(successResult);
        const deleteService = createMockDeleteService(makeDeleteResult(SESSION_DIR_NAME, true));
        createMockMCPServer(); // keep mock instantiation for side-effect validation

        const service = new SessionHistoryService(
            sessionManager, restoreService, deleteService,
        );

        const result = await service.loadSession(SESSION_DIR_NAME);

        expect(result.success).toBe(true);
        expect(restoreService.restore).toHaveBeenCalledWith(SESSION_DIR_NAME);
        expect(sessionManager.setCurrentSessionId).toHaveBeenCalledTimes(1);
        // sessionManager.setCurrentSessionId is called with the stripped session ID
        expect(sessionManager.setCurrentSessionId).toHaveBeenCalledWith(
            expect.any(String),
            SESSION_DIR_NAME,
        );
    });

    // ── 4. loadSession returns error on failed restore ──────────────────

    it('returns error and does NOT update active session on failed restore', async () => {
        const sessionManager = createMockSessionManager();
        const failResult = makeRestoreResult(SESSION_DIR_NAME, false, ['Session is invalid']);
        const restoreService = createMockRestoreService(failResult);
        const deleteService = createMockDeleteService(makeDeleteResult(SESSION_DIR_NAME, true));
        createMockMCPServer(); // keep mock instantiation for side-effect validation

        const service = new SessionHistoryService(
            sessionManager, restoreService, deleteService,
        );

        const result = await service.loadSession(SESSION_DIR_NAME);

        expect(result.success).toBe(false);
        expect(result.errors).toContain('Session is invalid');
        expect(restoreService.restore).toHaveBeenCalledWith(SESSION_DIR_NAME);
        // setCurrentSessionId should NOT be called on failure
        expect(sessionManager.setCurrentSessionId).not.toHaveBeenCalled();
    });

    // ── 5. deleteSession identifies active session correctly ─────────────

    it('passes isActive=true when deleting the currently active session', async () => {
        const sessionManager = createMockSessionManager();
        const restoreService = createMockRestoreService(makeRestoreResult(SESSION_DIR_NAME, true));
        const deleteResult = makeDeleteResult('20260309-105927-current-uuid', true);
        const deleteService = createMockDeleteService(deleteResult);
        createMockMCPServer(); // keep mock instantiation for side-effect validation

        const service = new SessionHistoryService(
            sessionManager, restoreService, deleteService,
        );

        // Delete the same session that is currently active
        const result = await service.deleteSession(
            '20260309-105927-current-uuid',
            '20260309-105927-current-uuid',
        );

        expect(result.success).toBe(true);
        expect(deleteService.deleteSession).toHaveBeenCalledWith(
            '20260309-105927-current-uuid',
            true, // isActiveSession = true
        );
    });

    // ── 6. deleteSession for inactive session passes isActive=false ──────

    it('passes isActive=false when deleting an inactive session', async () => {
        const sessionManager = createMockSessionManager();
        const restoreService = createMockRestoreService(makeRestoreResult(SESSION_DIR_NAME, true));
        const deleteResult = makeDeleteResult(SESSION_DIR_NAME, true);
        const deleteService = createMockDeleteService(deleteResult);
        createMockMCPServer(); // keep mock instantiation for side-effect validation

        const service = new SessionHistoryService(
            sessionManager, restoreService, deleteService,
        );

        const result = await service.deleteSession(
            SESSION_DIR_NAME,
            '20260309-105927-current-uuid', // different from target
        );

        expect(result.success).toBe(true);
        expect(deleteService.deleteSession).toHaveBeenCalledWith(
            SESSION_DIR_NAME,
            false, // isActiveSession = false
        );
    });
});
