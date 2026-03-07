// ─────────────────────────────────────────────────────────────────────────────
// src/__tests__/EngineWiring.test.ts — Unit tests for the R1 engine wiring module
// ─────────────────────────────────────────────────────────────────────────────

jest.mock('vscode', () => ({
    commands: { registerCommand: jest.fn() },
    window: { showWarningMessage: jest.fn(), showErrorMessage: jest.fn(), showInformationMessage: jest.fn() },
    workspace: { workspaceFolders: [] },
    Uri: { file: jest.fn() },
}), { virtual: true });


import { wireEngine } from '../EngineWiring.js';
import { ServiceContainer } from '../ServiceContainer.js';
import { EventEmitter } from 'events';

// ═══════════════════════════════════════════════════════════════════════════════
//  Mock factories
// ═══════════════════════════════════════════════════════════════════════════════

function createMockEngine(): EventEmitter & { getRunbook: jest.Mock; getState: jest.Mock; onWorkerExited: jest.Mock; onWorkerFailed: jest.Mock } {
    const engine = new EventEmitter() as any;
    engine.getRunbook = jest.fn().mockReturnValue(null);
    engine.getState = jest.fn().mockReturnValue('EXECUTING_WORKER');
    engine.onWorkerExited = jest.fn().mockResolvedValue(undefined);
    engine.onWorkerFailed = jest.fn().mockResolvedValue(undefined);
    return engine;
}

function createMockADK(): EventEmitter & { spawnWorker: jest.Mock } {
    const adk = new EventEmitter() as any;
    adk.spawnWorker = jest.fn().mockResolvedValue(undefined);
    return adk;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  wireEngine
// ═══════════════════════════════════════════════════════════════════════════════

describe('wireEngine', () => {
    let svc: ServiceContainer;
    let engine: ReturnType<typeof createMockEngine>;
    let adk: ReturnType<typeof createMockADK>;

    beforeEach(() => {
        svc = new ServiceContainer();
        engine = createMockEngine();
        adk = createMockADK();
        svc.engine = engine as any;
        svc.adkController = adk as any;
    });

    it('does not throw when engine and adkController are present', () => {
        expect(() => wireEngine(svc, 'session-001', '/workspace', 60000)).not.toThrow();
    });

    it('returns silently when engine is undefined', () => {
        svc.engine = undefined;
        expect(() => wireEngine(svc, 'session-001', '/workspace', 60000)).not.toThrow();
    });

    it('returns silently when adkController is undefined', () => {
        svc.adkController = undefined;
        expect(() => wireEngine(svc, 'session-001', '/workspace', 60000)).not.toThrow();
    });

    it('registers ui:message listener on engine', () => {
        wireEngine(svc, 'session-001', '/workspace', 60000);
        expect(engine.listenerCount('ui:message')).toBe(1);
    });

    it('registers state:changed listener on engine', () => {
        wireEngine(svc, 'session-001', '/workspace', 60000);
        expect(engine.listenerCount('state:changed')).toBe(1);
    });

    it('registers phase:execute listener on engine', () => {
        wireEngine(svc, 'session-001', '/workspace', 60000);
        expect(engine.listenerCount('phase:execute')).toBe(1);
    });

    it('registers phase:heal listener on engine', () => {
        wireEngine(svc, 'session-001', '/workspace', 60000);
        expect(engine.listenerCount('phase:heal')).toBe(1);
    });

    it('registers phase:checkpoint listener on engine', () => {
        wireEngine(svc, 'session-001', '/workspace', 60000);
        expect(engine.listenerCount('phase:checkpoint')).toBe(1);
    });

    it('registers run:completed listener on engine', () => {
        wireEngine(svc, 'session-001', '/workspace', 60000);
        expect(engine.listenerCount('run:completed')).toBe(1);
    });

    it('registers run:consolidate listener on engine', () => {
        wireEngine(svc, 'session-001', '/workspace', 60000);
        expect(engine.listenerCount('run:consolidate')).toBe(1);
    });

    it('registers worker:exited listener on adkController', () => {
        wireEngine(svc, 'session-001', '/workspace', 60000);
        expect(adk.listenerCount('worker:exited')).toBe(1);
    });

    it('registers worker:timeout listener on adkController', () => {
        wireEngine(svc, 'session-001', '/workspace', 60000);
        expect(adk.listenerCount('worker:timeout')).toBe(1);
    });

    it('registers worker:crash listener on adkController', () => {
        wireEngine(svc, 'session-001', '/workspace', 60000);
        expect(adk.listenerCount('worker:crash')).toBe(1);
    });

    it('registers worker:output listener on adkController', () => {
        wireEngine(svc, 'session-001', '/workspace', 60000);
        expect(adk.listenerCount('worker:output')).toBe(1);
    });

    // ── Worker output accumulation ─────────────────────────────────────
    it('worker:output accumulates stdout into workerOutputAccumulator', () => {
        wireEngine(svc, 'session-001', '/workspace', 60000);

        adk.emit('worker:output', 1, 'stdout', 'hello ');
        adk.emit('worker:output', 1, 'stdout', 'world');

        expect(svc.workerOutputAccumulator.get(1)).toBe('hello world');
    });

    it('worker:output does not accumulate stderr', () => {
        wireEngine(svc, 'session-001', '/workspace', 60000);

        adk.emit('worker:output', 1, 'stderr', 'error msg');

        expect(svc.workerOutputAccumulator.has(1)).toBe(false);
    });

    // ── Worker lifecycle → Engine ──────────────────────────────────────
    it('worker:timeout calls engine.onWorkerFailed with "timeout"', () => {
        wireEngine(svc, 'session-001', '/workspace', 60000);

        adk.emit('worker:timeout', 5);

        expect(engine.onWorkerFailed).toHaveBeenCalledWith(5, 'timeout');
    });

    it('worker:crash calls engine.onWorkerFailed with "crash"', () => {
        wireEngine(svc, 'session-001', '/workspace', 60000);

        adk.emit('worker:crash', 3);

        expect(engine.onWorkerFailed).toHaveBeenCalledWith(3, 'crash');
    });
});
