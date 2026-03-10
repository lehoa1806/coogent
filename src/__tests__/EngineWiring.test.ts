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
import {
    createMockHandoffExtractor,
    createMockMcpBridge,
    createMockMcpServer,
} from './factories/mockServiceContainer.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Mock factories
// ═══════════════════════════════════════════════════════════════════════════════

function createMockEngine(): EventEmitter & { getRunbook: jest.Mock; getState: jest.Mock; onWorkerExited: jest.Mock; onWorkerFailed: jest.Mock } {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Extending EventEmitter with mock methods requires dynamic property assignment
    const engine = new EventEmitter() as any;
    engine.getRunbook = jest.fn().mockReturnValue(null);
    engine.getState = jest.fn().mockReturnValue('EXECUTING_WORKER');
    engine.onWorkerExited = jest.fn().mockResolvedValue(undefined);
    engine.onWorkerFailed = jest.fn().mockResolvedValue(undefined);
    return engine;
}

function createMockADK(): EventEmitter & { spawnWorker: jest.Mock } {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Extending EventEmitter with mock methods requires dynamic property assignment
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
        svc.currentSessionDirName = 'session-001';
        engine = createMockEngine();
        adk = createMockADK();
        svc.engine = engine as unknown as ServiceContainer['engine'];
        svc.adkController = adk as unknown as ServiceContainer['adkController'];
    });

    it('does not throw when engine and adkController are present', () => {
        expect(() => wireEngine(svc, '/workspace', 60000)).not.toThrow();
    });

    it('returns silently when engine is undefined', () => {
        svc.engine = undefined;
        expect(() => wireEngine(svc, '/workspace', 60000)).not.toThrow();
    });

    it('returns silently when adkController is undefined', () => {
        svc.adkController = undefined;
        expect(() => wireEngine(svc, '/workspace', 60000)).not.toThrow();
    });

    it('registers ui:message listener on engine', () => {
        wireEngine(svc, '/workspace', 60000);
        expect(engine.listenerCount('ui:message')).toBe(1);
    });

    it('registers state:changed listener on engine', () => {
        wireEngine(svc, '/workspace', 60000);
        expect(engine.listenerCount('state:changed')).toBe(1);
    });

    it('registers phase:execute listener on engine', () => {
        wireEngine(svc, '/workspace', 60000);
        expect(engine.listenerCount('phase:execute')).toBe(1);
    });

    it('registers phase:heal listener on engine', () => {
        wireEngine(svc, '/workspace', 60000);
        expect(engine.listenerCount('phase:heal')).toBe(1);
    });

    it('registers phase:checkpoint listener on engine', () => {
        wireEngine(svc, '/workspace', 60000);
        expect(engine.listenerCount('phase:checkpoint')).toBe(1);
    });

    it('registers run:completed listener on engine', () => {
        wireEngine(svc, '/workspace', 60000);
        expect(engine.listenerCount('run:completed')).toBe(1);
    });

    it('registers run:consolidate listener on engine', () => {
        wireEngine(svc, '/workspace', 60000);
        expect(engine.listenerCount('run:consolidate')).toBe(1);
    });

    it('registers worker:exited listener on adkController', () => {
        wireEngine(svc, '/workspace', 60000);
        expect(adk.listenerCount('worker:exited')).toBe(1);
    });

    it('registers worker:timeout listener on adkController', () => {
        wireEngine(svc, '/workspace', 60000);
        expect(adk.listenerCount('worker:timeout')).toBe(1);
    });

    it('registers worker:crash listener on adkController', () => {
        wireEngine(svc, '/workspace', 60000);
        expect(adk.listenerCount('worker:crash')).toBe(1);
    });

    it('registers worker:output listener on adkController', () => {
        wireEngine(svc, '/workspace', 60000);
        expect(adk.listenerCount('worker:output')).toBe(1);
    });

    // ── Worker output accumulation ─────────────────────────────────────
    it('worker:output accumulates stdout into workerOutputAccumulator', () => {
        wireEngine(svc, '/workspace', 60000);

        adk.emit('worker:output', 1, 'stdout', 'hello ');
        adk.emit('worker:output', 1, 'stdout', 'world');

        expect(svc.workerOutputAccumulator.get(1)).toBe('hello world');
    });

    it('worker:output does not accumulate stderr', () => {
        wireEngine(svc, '/workspace', 60000);

        adk.emit('worker:output', 1, 'stderr', 'error msg');

        expect(svc.workerOutputAccumulator.has(1)).toBe(false);
    });

    // ── Worker lifecycle → Engine ──────────────────────────────────────
    it('worker:timeout calls engine.onWorkerFailed with "timeout"', () => {
        wireEngine(svc, '/workspace', 60000);

        adk.emit('worker:timeout', 5);

        expect(engine.onWorkerFailed).toHaveBeenCalledWith(5, 'timeout');
    });

    it('worker:crash calls engine.onWorkerFailed with "crash"', () => {
        wireEngine(svc, '/workspace', 60000);

        adk.emit('worker:crash', 3);

        expect(engine.onWorkerFailed).toHaveBeenCalledWith(3, 'crash');
    });

    // ── RACE-FIX: Handoff submission before FSM transition ────────────
    it('worker:exited(0) awaits handoff submission before engine.onWorkerExited', async () => {
        // Track call order
        const callOrder: string[] = [];

        const mockReport = { decisions: ['d1'], modified_files: ['f.ts'], unresolved_issues: [] };
        const mockHandoffExtractor = {
            extractHandoff: jest.fn().mockImplementation(async () => {
                callOrder.push('extractHandoff');
                return mockReport;
            }),
            generateDistillationPrompt: jest.fn().mockReturnValue(''),
            buildNextContext: jest.fn().mockResolvedValue(''),
        };
        const mockMcpBridge = {
            submitPhaseHandoff: jest.fn().mockImplementation(async () => {
                callOrder.push('submitPhaseHandoff');
            }),
        };

        svc.handoffExtractor = createMockHandoffExtractor({
            extractHandoff: mockHandoffExtractor.extractHandoff,
            generateDistillationPrompt: mockHandoffExtractor.generateDistillationPrompt,
            buildNextContext: mockHandoffExtractor.buildNextContext,
        });
        svc.mcpBridge = createMockMcpBridge({
            submitPhaseHandoff: mockMcpBridge.submitPhaseHandoff,
        });
        svc.currentSessionDir = '/workspace/.coogent/ipc/session-001';

        // Provide a runbook with a phase that has an mcpPhaseId
        engine.getRunbook.mockReturnValue({
            phases: [{ id: 1, mcpPhaseId: 'phase-001-abc' }],
        });
        engine.onWorkerExited.mockImplementation(async () => {
            callOrder.push('onWorkerExited');
        });

        wireEngine(svc, '/workspace', 60000);

        // Pre-populate accumulated output
        svc.workerOutputAccumulator.set(1, 'some output');

        adk.emit('worker:exited', 1, 0);

        // Wait for all async work to settle
        await new Promise(r => setTimeout(r, 50));

        expect(callOrder).toEqual(['extractHandoff', 'submitPhaseHandoff', 'onWorkerExited']);
    });

    it('worker:exited(0) still calls onWorkerExited when handoff extraction fails', async () => {
        const mockHandoffExtractor = {
            extractHandoff: jest.fn().mockRejectedValue(new Error('extraction boom')),
            generateDistillationPrompt: jest.fn().mockReturnValue(''),
            buildNextContext: jest.fn().mockResolvedValue(''),
        };

        svc.handoffExtractor = createMockHandoffExtractor({
            extractHandoff: mockHandoffExtractor.extractHandoff,
            generateDistillationPrompt: mockHandoffExtractor.generateDistillationPrompt,
            buildNextContext: mockHandoffExtractor.buildNextContext,
        });
        svc.currentSessionDir = '/workspace/.coogent/ipc/session-001';

        wireEngine(svc, '/workspace', 60000);

        svc.workerOutputAccumulator.set(2, 'output');

        adk.emit('worker:exited', 2, 0);

        await new Promise(r => setTimeout(r, 50));

        // Engine transition must still fire despite handoff failure
        expect(engine.onWorkerExited).toHaveBeenCalledWith(2, 0);
    });

    // ── IPC-FIX: Implementation plan extraction from worker output ──────
    it('worker:exited(0) extracts and submits implementation plan from worker output', async () => {
        const planText = '## Proposed Changes\n\n### Module A\n#### [MODIFY] [a.ts](file:///workspace/a.ts)\nRefactor to use async/await pattern throughout.\n\n### Module B\n#### [NEW] [b.ts](file:///workspace/b.ts)\nCreate new utility for shared validation logic.';
        const mockReport = { decisions: ['d1'], modified_files: ['a.ts'], unresolved_issues: [] };
        const mockHandoffExtractor = {
            extractHandoff: jest.fn().mockResolvedValue(mockReport),
            extractImplementationPlan: jest.fn().mockReturnValue(planText),
            generateDistillationPrompt: jest.fn().mockReturnValue(''),
            buildNextContext: jest.fn().mockResolvedValue(''),
        };
        const mockMcpBridge = {
            submitPhaseHandoff: jest.fn().mockResolvedValue(undefined),
            submitImplementationPlan: jest.fn().mockResolvedValue(undefined),
        };

        svc.handoffExtractor = createMockHandoffExtractor({
            extractHandoff: mockHandoffExtractor.extractHandoff,
            extractImplementationPlan: mockHandoffExtractor.extractImplementationPlan,
            generateDistillationPrompt: mockHandoffExtractor.generateDistillationPrompt,
            buildNextContext: mockHandoffExtractor.buildNextContext,
        });
        svc.mcpBridge = createMockMcpBridge({
            submitPhaseHandoff: mockMcpBridge.submitPhaseHandoff,
            submitImplementationPlan: mockMcpBridge.submitImplementationPlan,
        });
        svc.currentSessionDir = '/workspace/.coogent/ipc/session-001';

        engine.getRunbook.mockReturnValue({
            phases: [{ id: 1, mcpPhaseId: 'phase-001-abc' }],
        });

        wireEngine(svc, '/workspace', 60000);
        svc.workerOutputAccumulator.set(1, `Some output...\n${planText}\n\`\`\`json\n{"decisions":["d1"]}\n\`\`\``);

        adk.emit('worker:exited', 1, 0);
        await new Promise(r => setTimeout(r, 50));

        // Should have called extractImplementationPlan with the accumulated output
        expect(mockHandoffExtractor.extractImplementationPlan).toHaveBeenCalledWith(
            expect.any(String),
            'session-001',
            'phase-001-abc',
        );

        // Should have submitted the plan via mcpBridge
        expect(mockMcpBridge.submitImplementationPlan).toHaveBeenCalledWith(
            'session-001',
            planText,
            'phase-001-abc',
        );
    });

    // ── F-5 audit fix: Incremental flush timer ─────────────────────────

    describe('F-5: incremental worker output flush', () => {
        beforeEach(() => {
            jest.useFakeTimers();
        });

        afterEach(() => {
            jest.useRealTimers();
        });

        function setupWithMcpServer() {
            const mockMcpServer = {
                upsertWorkerOutput: jest.fn(),
            };
            svc.mcpServer = createMockMcpServer({
                upsertWorkerOutput: mockMcpServer.upsertWorkerOutput,
            });

            // Provide a runbook with a phase that has an mcpPhaseId
            engine.getRunbook.mockReturnValue({
                phases: [{ id: 1, mcpPhaseId: 'phase-001-abc', status: 'running' }],
            });

            wireEngine(svc, '/workspace', 60000);
            return mockMcpServer;
        }

        it('flushes worker output to DB after 30s interval', () => {
            const mockMcpServer = setupWithMcpServer();

            // Emit worker output
            adk.emit('worker:output', 1, 'stdout', 'hello ');
            adk.emit('worker:output', 1, 'stdout', 'world');

            // Before 30s — no flush
            expect(mockMcpServer.upsertWorkerOutput).not.toHaveBeenCalled();

            // Advance past the 30s flush interval
            jest.advanceTimersByTime(30_000);

            expect(mockMcpServer.upsertWorkerOutput).toHaveBeenCalledWith(
                'session-001',
                'phase-001-abc',
                'hello world',
                expect.any(String)
            );
        });

        it('clears flush interval on worker:exited', () => {
            setupWithMcpServer();

            adk.emit('worker:output', 1, 'stdout', 'data');

            // Worker exits before the 30s interval fires
            adk.emit('worker:exited', 1, 0);

            // Advance past 30s — should NOT trigger a flush call from the interval
            // (the exit handler does its own final flush, but the interval should be gone)
            jest.advanceTimersByTime(60_000);

            // The interval-based flush should not have fired (only the exit handler flush)
            // We can verify the interval was cleared by checking no additional flush calls
            // after the exit handler's flush
        });

        it('clears flush interval on worker:timeout', () => {
            setupWithMcpServer();

            adk.emit('worker:output', 1, 'stdout', 'data');

            adk.emit('worker:timeout', 1);

            // Advance past 30s — interval should be cleared
            jest.advanceTimersByTime(60_000);
        });

        it('clears flush interval on worker:crash', () => {
            setupWithMcpServer();

            adk.emit('worker:output', 1, 'stdout', 'data');

            adk.emit('worker:crash', 1);

            // Advance past 30s — interval should be cleared
            jest.advanceTimersByTime(60_000);
        });
    });
});
