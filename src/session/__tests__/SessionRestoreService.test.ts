// ─────────────────────────────────────────────────────────────────────────────
// src/session/__tests__/SessionRestoreService.test.ts
// ─────────────────────────────────────────────────────────────────────────────

import { SessionRestoreService } from '../SessionRestoreService.js';
import type { Engine } from '../../engine/Engine.js';
import type { CoogentMCPServer } from '../../mcp/CoogentMCPServer.js';
import type { SessionHealthResult, SessionHealthStatus } from '../SessionHealthValidator.js';

// ── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../../logger/log.js', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../state/StateManager.js', () => ({
    StateManager: jest.fn().mockImplementation((_dir: string) => ({
        setArtifactDB: jest.fn(),
        getCachedRunbook: jest.fn().mockReturnValue(null),
    })),
}));

jest.mock('../../constants/paths.js', () => ({
    getSessionDir: jest.fn((_base: string, dirName: string) => `/tmp/coogent-test/ipc/${dirName}`),
    RUNBOOK_FILE: '.task-runbook.json',
}));

// Mock SessionHealthValidator — we control its validate() return via mockValidate
const mockValidate = jest.fn<SessionHealthResult, [string]>();
jest.mock('../SessionHealthValidator.js', () => ({
    SessionHealthValidator: jest.fn().mockImplementation(() => ({
        validate: mockValidate,
    })),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeHealthResult(
    sessionDirName: string,
    status: SessionHealthStatus,
    errors: string[] = [],
): SessionHealthResult {
    return {
        status,
        sessionDirName,
        hasMetadata: status !== 'invalid',
        hasSnapshot: status !== 'invalid',
        hasRunbookInDB: status === 'healthy',
        errors,
    };
}

function createMockEngine(overrides: Partial<Engine> = {}): Engine {
    const mockStateManager = {
        getCachedRunbook: jest.fn().mockReturnValue({
            project_id: 'test-project',
            status: 'running',
            phases: [{ prompt: 'do something', status: 'completed' }],
        }),
    };
    return {
        switchSession: jest.fn().mockResolvedValue(undefined),
        getStateManager: jest.fn().mockReturnValue(mockStateManager),
        ...overrides,
    } as unknown as Engine;
}

function createMockMCPServer(
    overrides: Partial<{
        getArtifactDB: jest.Mock;
        getTaskState: jest.Mock;
        getWorkerOutputs: jest.Mock;
        upsertSummary: jest.Mock;
        upsertImplementationPlan: jest.Mock;
    }> = {},
): CoogentMCPServer {
    return {
        getArtifactDB: jest.fn().mockReturnValue({}),
        getTaskState: jest.fn().mockReturnValue({
            summary: 'Test summary',
            implementationPlan: 'Test plan',
        }),
        getWorkerOutputs: jest.fn().mockReturnValue({
            'phase-001': 'output-1',
            'phase-002': 'output-2',
        }),
        upsertSummary: jest.fn(),
        upsertImplementationPlan: jest.fn(),
        ...overrides,
    } as unknown as CoogentMCPServer;
}

// ── Test Suite ───────────────────────────────────────────────────────────────

describe('SessionRestoreService', () => {
    const STORAGE_BASE = '/tmp/coogent-test';
    const SESSION_DIR_NAME = 'test-session-restore-001';

    afterEach(() => {
        jest.clearAllMocks();
    });

    // ── 1. Successful restore ────────────────────────────────────────────

    it('returns success with runbook and worker outputs when all steps pass', async () => {
        mockValidate.mockReturnValue(makeHealthResult(SESSION_DIR_NAME, 'healthy'));

        const engine = createMockEngine();
        const mcpServer = createMockMCPServer();

        const service = new SessionRestoreService(engine, mcpServer, STORAGE_BASE);
        const result = await service.restore(SESSION_DIR_NAME);

        expect(result.success).toBe(true);
        expect(result.sessionDirName).toBe(SESSION_DIR_NAME);
        expect(result.healthStatus).toBe('healthy');
        expect(result.runbook).toBeTruthy();
        expect(Object.keys(result.workerOutputs).length).toBe(2);
        expect(result.errors).toHaveLength(0);

        // Engine interaction
        expect(engine.switchSession).toHaveBeenCalledTimes(1);
        expect(mcpServer.getTaskState).toHaveBeenCalledWith(SESSION_DIR_NAME);
        expect(mcpServer.upsertSummary).toHaveBeenCalledWith(SESSION_DIR_NAME, 'Test summary');
        expect(mcpServer.getWorkerOutputs).toHaveBeenCalledWith(SESSION_DIR_NAME);
    });

    // ── 2. Invalid session ───────────────────────────────────────────────

    it('returns failure immediately for invalid sessions without calling engine', async () => {
        mockValidate.mockReturnValue(
            makeHealthResult(SESSION_DIR_NAME, 'invalid', ['No session metadata found in DB']),
        );

        const engine = createMockEngine();
        const mcpServer = createMockMCPServer();

        const service = new SessionRestoreService(engine, mcpServer, STORAGE_BASE);
        const result = await service.restore(SESSION_DIR_NAME);

        expect(result.success).toBe(false);
        expect(result.healthStatus).toBe('invalid');
        expect(result.runbook).toBeNull();
        expect(result.workerOutputs).toEqual({});
        expect(result.errors.length).toBeGreaterThan(0);

        // Engine should NOT have been called
        expect(engine.switchSession).not.toHaveBeenCalled();
        expect(mcpServer.getTaskState).not.toHaveBeenCalled();
    });

    // ── 3. Degraded session ──────────────────────────────────────────────

    it('still attempts restore for degraded sessions but records warnings', async () => {
        mockValidate.mockReturnValue(
            makeHealthResult(SESSION_DIR_NAME, 'degraded', ['No runbook found']),
        );

        const engine = createMockEngine();
        const mcpServer = createMockMCPServer();

        const service = new SessionRestoreService(engine, mcpServer, STORAGE_BASE);
        const result = await service.restore(SESSION_DIR_NAME);

        // Degraded is non-fatal — restore proceeds
        expect(result.success).toBe(true);
        expect(result.healthStatus).toBe('degraded');
        expect(result.errors).toContain('No runbook found');

        // Engine WAS called despite degraded status
        expect(engine.switchSession).toHaveBeenCalledTimes(1);
    });

    // ── 4. Engine switchSession failure ──────────────────────────────────

    it('returns failure when engine.switchSession throws', async () => {
        mockValidate.mockReturnValue(makeHealthResult(SESSION_DIR_NAME, 'healthy'));

        const engine = createMockEngine({
            switchSession: jest.fn().mockRejectedValue(new Error('FSM reset failed')),
        } as unknown as Partial<Engine>);
        const mcpServer = createMockMCPServer();

        const service = new SessionRestoreService(engine, mcpServer, STORAGE_BASE);
        const result = await service.restore(SESSION_DIR_NAME);

        expect(result.success).toBe(false);
        expect(result.healthStatus).toBe('healthy');
        expect(result.errors.some(e => e.includes('Engine switchSession failed'))).toBe(true);
        expect(result.errors.some(e => e.includes('FSM reset failed'))).toBe(true);

        // Worker outputs should NOT be collected after engine failure
        expect(mcpServer.getWorkerOutputs).not.toHaveBeenCalled();
    });

    // ── 5. Idempotent restore ────────────────────────────────────────────

    it('succeeds when calling restore twice with the same sessionDirName', async () => {
        mockValidate.mockReturnValue(makeHealthResult(SESSION_DIR_NAME, 'healthy'));

        const engine = createMockEngine();
        const mcpServer = createMockMCPServer();

        const service = new SessionRestoreService(engine, mcpServer, STORAGE_BASE);

        const result1 = await service.restore(SESSION_DIR_NAME);
        const result2 = await service.restore(SESSION_DIR_NAME);

        expect(result1.success).toBe(true);
        expect(result2.success).toBe(true);
        expect(engine.switchSession).toHaveBeenCalledTimes(2);
    });
});
