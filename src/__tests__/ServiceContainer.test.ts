// ─────────────────────────────────────────────────────────────────────────────
// src/__tests__/ServiceContainer.test.ts — Unit tests for the R1 service container
// ─────────────────────────────────────────────────────────────────────────────

import { ServiceContainer } from '../ServiceContainer.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  ServiceContainer
// ═══════════════════════════════════════════════════════════════════════════════

describe('ServiceContainer', () => {
    let svc: ServiceContainer;

    beforeEach(() => {
        svc = new ServiceContainer();
    });

    // ── Initialization defaults ────────────────────────────────────────
    it('all service fields are undefined by default', () => {
        expect(svc.stateManager).toBeUndefined();
        expect(svc.engine).toBeUndefined();
        expect(svc.adkController).toBeUndefined();
        expect(svc.contextScoper).toBeUndefined();
        expect(svc.logger).toBeUndefined();
        expect(svc.gitManager).toBeUndefined();
        expect(svc.gitSandbox).toBeUndefined();
        expect(svc.outputRegistry).toBeUndefined();
        expect(svc.plannerAgent).toBeUndefined();
        expect(svc.sessionManager).toBeUndefined();
        expect(svc.handoffExtractor).toBeUndefined();
        expect(svc.consolidationAgent).toBeUndefined();
        expect(svc.currentSessionDir).toBeUndefined();
        expect(svc.mcpServer).toBeUndefined();
        expect(svc.mcpBridge).toBeUndefined();
        expect(svc.sidebarMenu).toBeUndefined();
    });

    it('workerOutputAccumulator is an empty Map by default', () => {
        expect(svc.workerOutputAccumulator).toBeInstanceOf(Map);
        expect(svc.workerOutputAccumulator.size).toBe(0);
    });

    it('sandboxBranchCreatedForSession is an empty Set by default', () => {
        expect(svc.sandboxBranchCreatedForSession).toBeInstanceOf(Set);
        expect(svc.sandboxBranchCreatedForSession.size).toBe(0);
    });

    // ── releaseAll() ───────────────────────────────────────────────────
    it('releaseAll() nullifies all service references', () => {
        // Assign dummy values to verify they get cleared
        svc.stateManager = {} as any;
        svc.engine = {} as any;
        svc.adkController = {} as any;
        svc.contextScoper = {} as any;
        svc.logger = {} as any;
        svc.gitManager = {} as any;
        svc.gitSandbox = {} as any;
        svc.outputRegistry = {} as any;
        svc.plannerAgent = {} as any;
        svc.sessionManager = {} as any;
        svc.handoffExtractor = {} as any;
        svc.consolidationAgent = {} as any;
        svc.currentSessionDir = '/tmp/test';
        svc.mcpServer = {} as any;
        svc.mcpBridge = {} as any;
        svc.sidebarMenu = {} as any;

        svc.releaseAll();

        expect(svc.stateManager).toBeUndefined();
        expect(svc.engine).toBeUndefined();
        expect(svc.adkController).toBeUndefined();
        expect(svc.contextScoper).toBeUndefined();
        expect(svc.logger).toBeUndefined();
        expect(svc.gitManager).toBeUndefined();
        expect(svc.gitSandbox).toBeUndefined();
        expect(svc.outputRegistry).toBeUndefined();
        expect(svc.plannerAgent).toBeUndefined();
        expect(svc.sessionManager).toBeUndefined();
        expect(svc.handoffExtractor).toBeUndefined();
        expect(svc.consolidationAgent).toBeUndefined();
        expect(svc.currentSessionDir).toBeUndefined();
        expect(svc.mcpServer).toBeUndefined();
        expect(svc.mcpBridge).toBeUndefined();
        expect(svc.sidebarMenu).toBeUndefined();
    });

    it('releaseAll() clears the workerOutputAccumulator', () => {
        svc.workerOutputAccumulator.set(1, 'output data');
        svc.workerOutputAccumulator.set(2, 'more data');
        expect(svc.workerOutputAccumulator.size).toBe(2);

        svc.releaseAll();
        expect(svc.workerOutputAccumulator.size).toBe(0);
    });

    it('releaseAll() clears the sandboxBranchCreatedForSession', () => {
        svc.sandboxBranchCreatedForSession.add('session-001');
        svc.sandboxBranchCreatedForSession.add('session-002');
        expect(svc.sandboxBranchCreatedForSession.size).toBe(2);

        svc.releaseAll();
        expect(svc.sandboxBranchCreatedForSession.size).toBe(0);
    });

    it('releaseAll() is idempotent — calling twice does not throw', () => {
        svc.engine = {} as any;
        svc.releaseAll();
        expect(() => svc.releaseAll()).not.toThrow();
    });

    // ── Stateful data operations ──────────────────────────────────────
    it('workerOutputAccumulator supports set/get/delete lifecycle', () => {
        svc.workerOutputAccumulator.set(5, 'chunk1');
        svc.workerOutputAccumulator.set(5, svc.workerOutputAccumulator.get(5) + 'chunk2');
        expect(svc.workerOutputAccumulator.get(5)).toBe('chunk1chunk2');

        svc.workerOutputAccumulator.delete(5);
        expect(svc.workerOutputAccumulator.has(5)).toBe(false);
    });

    it('sandboxBranchCreatedForSession tracks per-session guards', () => {
        const dirName = '20260307-120000-abc123';
        expect(svc.sandboxBranchCreatedForSession.has(dirName)).toBe(false);
        svc.sandboxBranchCreatedForSession.add(dirName);
        expect(svc.sandboxBranchCreatedForSession.has(dirName)).toBe(true);
    });

    // ── isRegistered() / resolve() / getActiveServices() ───────────────
    it('resolve() returns the instance after direct assignment', () => {
        const mockEngine = { fake: 'engine' } as any;
        svc.engine = mockEngine;
        expect(svc.resolve('engine')).toBe(mockEngine);
    });

    it('isRegistered() returns false before and true after direct assignment', () => {
        expect(svc.isRegistered('engine')).toBe(false);
        svc.engine = {} as any;
        expect(svc.isRegistered('engine')).toBe(true);
    });

    it('getActiveServices() lists only initialised services', () => {
        expect(svc.getActiveServices()).toEqual([]);

        svc.stateManager = {} as any;
        svc.engine = {} as any;
        svc.adkController = {} as any;

        const active = svc.getActiveServices();
        expect(active).toContain('stateManager');
        expect(active).toContain('engine');
        expect(active).toContain('adkController');
        expect(active).toHaveLength(3);
    });

    it('releaseAll() clears getActiveServices()', () => {
        svc.engine = {} as any;
        expect(svc.getActiveServices()).toHaveLength(1);

        svc.releaseAll();
        expect(svc.getActiveServices()).toHaveLength(0);
    });

    it('direct assignment works again after releaseAll()', () => {
        svc.engine = {} as any;
        svc.releaseAll();

        const newEngine = { fresh: true } as any;
        svc.engine = newEngine;
        expect(svc.resolve('engine')).toBe(newEngine);
    });

    // ── switchSession() ArtifactDB re-wiring (regression) ──────────────
    it('switchSession() re-wires ArtifactDB on SessionManager from mcpServer', () => {
        const mockArtifactDB = {} as any;
        const mockSessionManager = {
            setCurrentSessionId: jest.fn(),
            setArtifactDB: jest.fn(),
        } as any;
        const mockMcpServer = {
            getArtifactDB: jest.fn().mockReturnValue(mockArtifactDB),
        } as any;
        const mockPlannerAgent = {
            setMasterTaskId: jest.fn(),
        } as any;

        svc.sessionManager = mockSessionManager;
        svc.mcpServer = mockMcpServer;
        svc.plannerAgent = mockPlannerAgent;

        const sessionId = 'test-session-uuid';
        const sessionDirName = '20260310-120000-test-session-uuid';
        const sessionDir = '/tmp/test-session';

        svc.switchSession({ sessionId, sessionDirName, sessionDir });

        expect(mockSessionManager.setCurrentSessionId).toHaveBeenCalledWith(sessionId, sessionDirName);
        expect(mockMcpServer.getArtifactDB).toHaveBeenCalled();
        expect(mockSessionManager.setArtifactDB).toHaveBeenCalledWith(mockArtifactDB);
    });

    it('switchSession() does not call setArtifactDB when mcpServer is undefined', () => {
        const mockSessionManager = {
            setCurrentSessionId: jest.fn(),
            setArtifactDB: jest.fn(),
        } as any;
        const mockPlannerAgent = {
            setMasterTaskId: jest.fn(),
        } as any;

        svc.sessionManager = mockSessionManager;
        svc.mcpServer = undefined;
        svc.plannerAgent = mockPlannerAgent;

        const sessionId = 'test-session-uuid-2';
        const sessionDirName = '20260310-130000-test-session-uuid-2';
        const sessionDir = '/tmp/test-session-2';

        svc.switchSession({ sessionId, sessionDirName, sessionDir });

        expect(mockSessionManager.setCurrentSessionId).toHaveBeenCalledWith(sessionId, sessionDirName);
        expect(mockSessionManager.setArtifactDB).not.toHaveBeenCalled();
    });
});
