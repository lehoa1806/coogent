// ─────────────────────────────────────────────────────────────────────────────
// src/session/__tests__/SessionDeleteService.test.ts
// ─────────────────────────────────────────────────────────────────────────────

import { SessionDeleteService } from '../SessionDeleteService.js';
import type { CoogentMCPServer } from '../../mcp/CoogentMCPServer.js';
import type { SessionManager } from '../SessionManager.js';

// ── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../../logger/log.js', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function createMockMCPServer(
    overrides: Partial<{ purgeTask: jest.Mock }> = {},
): CoogentMCPServer {
    return {
        purgeTask: jest.fn(),
        ...overrides,
    } as unknown as CoogentMCPServer;
}

function createMockSessionManager(
    overrides: Partial<{ deleteSession: jest.Mock }> = {},
): SessionManager {
    return {
        deleteSession: jest.fn().mockResolvedValue(undefined),
        ...overrides,
    } as unknown as SessionManager;
}

// ── Test Suite ───────────────────────────────────────────────────────────────

describe('SessionDeleteService', () => {
    const SESSION_DIR_NAME = 'test-session-delete-001';

    afterEach(() => {
        jest.clearAllMocks();
    });

    // ── 1. Successful delete (all cascade steps succeed) ─────────────────

    it('returns success when all cascade steps succeed', async () => {
        const mcpServer = createMockMCPServer();
        const sessionManager = createMockSessionManager();

        const service = new SessionDeleteService(mcpServer, sessionManager);
        const result = await service.deleteSession(SESSION_DIR_NAME, false);

        expect(result.success).toBe(true);
        expect(result.sessionDirName).toBe(SESSION_DIR_NAME);
        expect(result.errors).toHaveLength(0);

        // purgeTask should NOT be called for step 1 (not active)
        // but IS called for step 3 (tasks DB purge)
        // Step 1 skipped (isActive=false), Step 3 calls purgeTask
        expect(mcpServer.purgeTask).toHaveBeenCalledTimes(1);
        expect(sessionManager.deleteSession).toHaveBeenCalledWith(SESSION_DIR_NAME);
    });

    // ── 2. Delete active session ─────────────────────────────────────────

    it('calls purgeTask before deleteSession when deleting an active session', async () => {
        const mcpServer = createMockMCPServer();
        const sessionManager = createMockSessionManager();

        const service = new SessionDeleteService(mcpServer, sessionManager);
        const result = await service.deleteSession(SESSION_DIR_NAME, true);

        expect(result.success).toBe(true);
        expect(result.errors).toHaveLength(0);

        // purgeTask called for step 1 (active session) AND step 3 (tasks DB)
        expect(mcpServer.purgeTask).toHaveBeenCalledTimes(2);
        expect(mcpServer.purgeTask).toHaveBeenCalledWith(SESSION_DIR_NAME);
        expect(sessionManager.deleteSession).toHaveBeenCalledWith(SESSION_DIR_NAME);
    });

    // ── 3. Partial failure (sessionManager.deleteSession throws) ─────────

    it('records error but continues cascade when sessionManager.deleteSession throws', async () => {
        const mcpServer = createMockMCPServer();
        const sessionManager = createMockSessionManager({
            deleteSession: jest.fn().mockRejectedValue(new Error('ENOENT: directory not found')),
        });

        const service = new SessionDeleteService(mcpServer, sessionManager);
        const result = await service.deleteSession(SESSION_DIR_NAME, false);

        expect(result.success).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors.some(e => e.includes('SessionManager.deleteSession'))).toBe(true);

        // Step 3 (purgeTask) should still have been called despite step 2 failure
        expect(mcpServer.purgeTask).toHaveBeenCalledTimes(1);
    });

    // ── 4. Delete non-existent session ───────────────────────────────────

    it('handles gracefully when session does not exist', async () => {
        const mcpServer = createMockMCPServer();
        const sessionManager = createMockSessionManager();

        const service = new SessionDeleteService(mcpServer, sessionManager);
        const result = await service.deleteSession('nonexistent-session', false);

        // Should succeed — deleteSession is a no-op for non-existent dirs
        expect(result.success).toBe(true);
        expect(result.sessionDirName).toBe('nonexistent-session');
        expect(result.errors).toHaveLength(0);
    });
});
