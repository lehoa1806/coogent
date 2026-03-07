// ─────────────────────────────────────────────────────────────────────────────
// src/__tests__/PlannerWiring.test.ts — Unit tests for the R1 planner wiring module
// ─────────────────────────────────────────────────────────────────────────────

jest.mock('vscode', () => ({
    commands: { registerCommand: jest.fn() },
    window: { showWarningMessage: jest.fn(), showErrorMessage: jest.fn(), showInformationMessage: jest.fn() },
    workspace: { workspaceFolders: [] },
    Uri: { file: jest.fn() },
}), { virtual: true });


import { wirePlanner } from '../PlannerWiring.js';
import { ServiceContainer } from '../ServiceContainer.js';
import { EventEmitter } from 'events';

// ═══════════════════════════════════════════════════════════════════════════════
//  Mock factories
// ═══════════════════════════════════════════════════════════════════════════════

function createMockEngine(): EventEmitter & { abort: jest.Mock } {
    const engine = new EventEmitter() as any;
    engine.abort = jest.fn().mockResolvedValue(undefined);
    return engine;
}

function createMockPlannerAgent(): EventEmitter & { plan: jest.Mock; retryParse: jest.Mock; hasTimeoutOutput: jest.Mock; getDraft: jest.Mock; setAvailableTags: jest.Mock; getLastSystemPrompt: jest.Mock } {
    const agent = new EventEmitter() as any;
    agent.plan = jest.fn().mockResolvedValue(undefined);
    agent.retryParse = jest.fn().mockResolvedValue(undefined);
    agent.hasTimeoutOutput = jest.fn().mockReturnValue(false);
    agent.getDraft = jest.fn().mockReturnValue(null);
    agent.setAvailableTags = jest.fn();
    agent.getLastSystemPrompt = jest.fn().mockReturnValue(null);
    return agent;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  wirePlanner
// ═══════════════════════════════════════════════════════════════════════════════

describe('wirePlanner', () => {
    let svc: ServiceContainer;
    let engine: ReturnType<typeof createMockEngine>;
    let planner: ReturnType<typeof createMockPlannerAgent>;

    beforeEach(() => {
        svc = new ServiceContainer();
        engine = createMockEngine();
        planner = createMockPlannerAgent();
        svc.engine = engine as any;
        svc.plannerAgent = planner as any;
    });

    it('does not throw when engine and plannerAgent are present', () => {
        expect(() => wirePlanner(svc, 'session-001')).not.toThrow();
    });

    it('returns silently when engine is undefined', () => {
        svc.engine = undefined;
        expect(() => wirePlanner(svc, 'session-001')).not.toThrow();
    });

    it('returns silently when plannerAgent is undefined', () => {
        svc.plannerAgent = undefined;
        expect(() => wirePlanner(svc, 'session-001')).not.toThrow();
    });

    // ── Engine → PlannerAgent event wiring ─────────────────────────────

    it('plan:request triggers plannerAgent.plan(prompt)', () => {
        wirePlanner(svc, 'session-001');
        engine.emit('plan:request', 'Refactor auth module');
        expect(planner.plan).toHaveBeenCalledWith('Refactor auth module');
    });

    it('plan:rejected triggers plannerAgent.plan(prompt, feedback)', async () => {
        wirePlanner(svc, 'session-001');
        engine.emit('plan:rejected', 'Refactor auth', 'Add more phases');
        // The handler wraps in an async IIFE — flush microtasks to let it complete
        await new Promise(r => setTimeout(r, 10));
        expect(planner.plan).toHaveBeenCalledWith('Refactor auth', 'Add more phases');
    });

    it('plan:retryParse triggers plannerAgent.retryParse()', () => {
        wirePlanner(svc, 'session-001');
        engine.emit('plan:retryParse');
        expect(planner.retryParse).toHaveBeenCalledTimes(1);
    });

    // ── PlannerAgent → Engine event wiring ─────────────────────────────

    it('registers plan:generated listener on plannerAgent', () => {
        wirePlanner(svc, 'session-001');
        expect(planner.listenerCount('plan:generated')).toBe(1);
    });

    it('registers plan:error listener on plannerAgent', () => {
        wirePlanner(svc, 'session-001');
        expect(planner.listenerCount('plan:error')).toBe(1);
    });

    it('registers plan:timeout listener on plannerAgent', () => {
        wirePlanner(svc, 'session-001');
        expect(planner.listenerCount('plan:timeout')).toBe(1);
    });

    it('registers plan:status listener on plannerAgent', () => {
        wirePlanner(svc, 'session-001');
        expect(planner.listenerCount('plan:status')).toBe(1);
    });

    it('plan:error calls engine.abort()', () => {
        wirePlanner(svc, 'session-001');
        planner.emit('plan:error', new Error('LLM timeout'));
        expect(engine.abort).toHaveBeenCalledTimes(1);
    });

    it('plan:timeout without output calls engine.abort()', () => {
        planner.hasTimeoutOutput.mockReturnValue(false);
        wirePlanner(svc, 'session-001');
        planner.emit('plan:timeout', false);
        expect(engine.abort).toHaveBeenCalledTimes(1);
    });

    it('plan:timeout with output does NOT call engine.abort()', () => {
        wirePlanner(svc, 'session-001');
        planner.emit('plan:timeout', true);
        expect(engine.abort).not.toHaveBeenCalled();
    });
});
