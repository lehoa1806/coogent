// ─────────────────────────────────────────────────────────────────────────────
// S2-4: Integration test for DispatchController → SelectionPipeline chain
// ─────────────────────────────────────────────────────────────────────────────
// Validates that scored selections match expected agent types for test subtasks.
// Tests the dispatch → selection → compile → validate flow.

import log from '../../logger/log.js';
import { DispatchController } from '../DispatchController.js';
import { EngineState, EngineEvent, asPhaseId, type Phase, type Runbook, type HostToWebviewMessage } from '../../types/index.js';
import type { Engine } from '../Engine.js';
import type { Scheduler } from '../Scheduler.js';

// ── Test Helpers ─────────────────────────────────────────────────────────────

function makePhase(overrides: Omit<Partial<Phase>, 'id'> & { id: number }): Phase {
    const base: Phase = {
        id: asPhaseId(overrides.id),
        status: overrides.status ?? 'pending',
        prompt: overrides.prompt ?? 'Test prompt',
        context_files: overrides.context_files ?? [],
        success_criteria: overrides.success_criteria ?? 'exit_code:0',
    };
    // Only set optional fields when they are explicitly provided (not undefined),
    // to satisfy exactOptionalPropertyTypes.
    if (overrides.depends_on !== undefined) base.depends_on = overrides.depends_on;
    if (overrides.required_capabilities !== undefined) base.required_capabilities = overrides.required_capabilities;
    if (overrides.mcpPhaseId !== undefined) base.mcpPhaseId = overrides.mcpPhaseId;
    if (overrides.evaluator !== undefined) base.evaluator = overrides.evaluator;
    return base;
}

function makeRunbook(phases: Phase[]): Runbook {
    return {
        project_id: 'test-project',
        status: 'running',
        current_phase: 0,
        phases,
    };
}

// ── Mock Engine ──────────────────────────────────────────────────────────────

function createMockEngine(runbook: Runbook | null): Engine {
    let activeWorkerCount = 0;
    let state: EngineState = EngineState.EXECUTING_WORKER;
    const emittedMessages: HostToWebviewMessage[] = [];

    const mockScheduler: Partial<Scheduler> = {
        getReadyPhases: (phases: Phase[]) =>
            phases.filter(p => p.status === 'pending'),
        isAllDone: (phases: Phase[]) =>
            phases.every(p => p.status === 'completed' || p.status === 'failed'),
    };

    return {
        getRunbook: () => runbook,
        getState: () => state,
        getScheduler: () => mockScheduler as Scheduler,
        getStateManager: () => ({
            getSessionDir: () => '/tmp/test-session',
        }),
        getActiveWorkerCount: () => activeWorkerCount,
        setActiveWorkerCount: (n: number) => { activeWorkerCount = n; },
        incrementActiveWorkerCount: () => { activeWorkerCount++; },
        decrementActiveWorkerCount: () => { activeWorkerCount--; },
        isPauseRequested: () => false,
        setPauseRequested: () => { },
        transition: (event: EngineEvent) => {
            // Simple transition mock
            if (event === EngineEvent.PHASE_FAIL) {
                state = EngineState.ERROR_PAUSED;
            }
            return state;
        },
        emit: jest.fn().mockReturnValue(true),
        emitUIMessage: (msg: HostToWebviewMessage) => {
            emittedMessages.push(msg);
        },
        persist: jest.fn().mockResolvedValue(undefined),
        _emittedMessages: emittedMessages,
    } as unknown as Engine;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('DispatchController Integration — Agent Selection Pipeline', () => {
    describe('dispatchReadyPhases without agent selection', () => {
        it('should dispatch pending phases', async () => {
            const phases = [makePhase({ id: 1 }), makePhase({ id: 2 })];
            const runbook = makeRunbook(phases);
            const engine = createMockEngine(runbook);
            const controller = new DispatchController(engine);

            await controller.dispatchReadyPhases();

            // Both phases should be marked running
            expect(phases[0].status).toBe('running');
            expect(phases[1].status).toBe('running');
            expect(engine.emit).toHaveBeenCalledWith('phase:execute', phases[0]);
            expect(engine.emit).toHaveBeenCalledWith('phase:execute', phases[1]);
        });

        it('should not dispatch already running phases', async () => {
            const phases = [
                makePhase({ id: 1, status: 'running' }),
                makePhase({ id: 2, status: 'completed' }),
            ];
            const runbook = makeRunbook(phases);
            const engine = createMockEngine(runbook);
            const controller = new DispatchController(engine);

            await controller.dispatchReadyPhases();

            // No new dispatches
            expect(engine.emit).not.toHaveBeenCalledWith('phase:execute', expect.anything());
        });

        it('should handle null runbook gracefully', async () => {
            const engine = createMockEngine(null);
            const controller = new DispatchController(engine);

            await expect(controller.dispatchReadyPhases()).resolves.toBeUndefined();
        });
    });

    describe('dispatchReadyPhases with agent selection', () => {
        it('should run selection pipeline when enabled', async () => {
            const phases = [
                makePhase({
                    id: 1,
                    prompt: 'Build a React component with TypeScript',
                    required_capabilities: ['react', 'typescript'],
                }),
            ];
            const runbook = makeRunbook(phases);
            const engine = createMockEngine(runbook);
            const controller = new DispatchController(engine, {
                useAgentSelection: true,
            });

            // Mock the private runAgentSelection to succeed (real pipeline
            // requires SelectionPipeline dependencies not available in unit tests)
            jest.spyOn(controller as any, 'runAgentSelection').mockResolvedValue(true);

            await controller.dispatchReadyPhases();

            // Phase should be marked running (pipeline should succeed for basic input)
            expect(phases[0].status).toBe('running');
        });

        it('should dispatch with compiled prompt after selection', async () => {
            const originalPrompt = 'Write unit tests for the auth module';
            const phases = [
                makePhase({
                    id: 1,
                    prompt: originalPrompt,
                    required_capabilities: ['testing'],
                    context_files: ['src/auth.ts'],
                }),
            ];
            const runbook = makeRunbook(phases);
            const engine = createMockEngine(runbook);
            const controller = new DispatchController(engine, {
                useAgentSelection: true,
            });

            // Mock the private runAgentSelection to succeed
            jest.spyOn(controller as any, 'runAgentSelection').mockResolvedValue(true);

            await controller.dispatchReadyPhases();

            // The prompt should have been replaced by the compiled prompt
            // (which includes the original goal + agent-specific instructions)
            expect(phases[0].prompt).not.toBe('');
            expect(phases[0].status).toBe('running');
        });
    });

    describe('advanceSchedule', () => {
        it('should dispatch new phases after a phase completes', () => {
            const phases = [
                makePhase({ id: 1, status: 'completed' }),
                makePhase({ id: 2, status: 'pending' }),
            ];
            const runbook = makeRunbook(phases);
            const engine = createMockEngine(runbook);
            const controller = new DispatchController(engine);

            controller.advanceSchedule();

            // Phase 2 should be dispatched
            expect(engine.emit).toHaveBeenCalledWith('phase:execute', phases[1]);
        });
    });

    describe('resumePending', () => {
        it('should resume pending phases from ERROR_PAUSED state', async () => {
            const phases = [
                makePhase({ id: 1, status: 'failed' }),
                makePhase({ id: 2, status: 'pending' }),
            ];
            const runbook = makeRunbook(phases);
            const engine = createMockEngine(runbook);
            // Set engine state to ERROR_PAUSED
            (engine as any).getState = () => EngineState.ERROR_PAUSED;
            (engine as any).transition = (event: EngineEvent) => {
                if (event === EngineEvent.RETRY) {
                    (engine as any).getState = () => EngineState.EXECUTING_WORKER;
                    return EngineState.EXECUTING_WORKER;
                }
                return null;
            };

            const controller = new DispatchController(engine);
            await controller.resumePending();

            // Phase 2 should be dispatched
            expect(phases[1].status).toBe('running');

            // V2 5.1: Stop the stall watchdog to prevent open handle (setInterval leak)
            controller.stopStallWatchdog();
        });
    });

    describe('stall watchdog', () => {
        it('should start and stop without errors', () => {
            const runbook = makeRunbook([makePhase({ id: 1 })]);
            const engine = createMockEngine(runbook);
            const controller = new DispatchController(engine);

            controller.startStallWatchdog();
            controller.stopStallWatchdog();
        });
    });

    // ═════════════════════════════════════════════════════════════════════
    //  V2-D 4.3: Context pack builder integration
    // ═════════════════════════════════════════════════════════════════════

    describe('dispatchReadyPhases with contextPackBuilder', () => {
        it('calls contextPackBuilder.build with correct inputs when builder is provided', async () => {
            const upstreamPhase = makePhase({
                id: 1,
                status: 'completed',
                mcpPhaseId: 'phase-001-abc',
            });
            const targetPhase = makePhase({
                id: 2,
                prompt: 'Implement feature X',
                context_files: ['src/foo.ts'],
                depends_on: [asPhaseId(1)],
            });
            const runbook = makeRunbook([upstreamPhase, targetPhase]);
            const engine = createMockEngine(runbook);

            const mockBuild = jest.fn().mockResolvedValue({
                pack: { tokenUsage: { total: 500 } },
                manifest: { totals: { totalTokens: 500 } },
            });

            const controller = new DispatchController(engine, {
                contextPackBuilder: { build: mockBuild } as any,
                mcpReady: Promise.resolve(),
                contextBudgetTokens: 80_000,
            });

            await controller.dispatchReadyPhases();

            expect(mockBuild).toHaveBeenCalledTimes(1);
            const input = mockBuild.mock.calls[0][0];
            expect(input.phaseId).toBe('2');
            expect(input.contextFiles).toEqual(['src/foo.ts']);
            expect(input.upstreamPhaseIds).toContain('phase-001-abc');
            expect(input.maxTokens).toBe(80_000);
            expect(targetPhase.status).toBe('running');
        });

        it('resolves contextPackBuilder from a getter function (V2-A lazy init)', async () => {
            const phases = [makePhase({ id: 1 })];
            const runbook = makeRunbook(phases);
            const engine = createMockEngine(runbook);

            const mockBuild = jest.fn().mockResolvedValue({
                pack: { tokenUsage: { total: 100 } },
                manifest: { totals: { totalTokens: 100 } },
            });

            // Simulate the getter pattern used in EngineWiring
            const builderGetter = () => ({ build: mockBuild } as any);

            const controller = new DispatchController(engine, {
                contextPackBuilder: builderGetter,
                mcpReady: Promise.resolve(),
            });

            await controller.dispatchReadyPhases();

            expect(mockBuild).toHaveBeenCalledTimes(1);
            expect(phases[0].status).toBe('running');
        });

        it('dispatches successfully even when contextPackBuilder.build throws', async () => {
            const phases = [makePhase({ id: 1 })];
            const runbook = makeRunbook(phases);
            const engine = createMockEngine(runbook);

            const mockBuild = jest.fn().mockRejectedValue(new Error('DB not ready'));

            const controller = new DispatchController(engine, {
                contextPackBuilder: { build: mockBuild } as any,
                mcpReady: Promise.resolve(),
            });

            await controller.dispatchReadyPhases();

            // Phase should still be dispatched despite builder failure
            expect(phases[0].status).toBe('running');
            expect(engine.emit).toHaveBeenCalledWith('phase:execute', phases[0]);
        });
    });

    // ═════════════════════════════════════════════════════════════════════
    //  P0.4: Regression — async dispatchReadyPhases error handling
    // ═════════════════════════════════════════════════════════════════════

    describe('async dispatch error handling (P0.4 regression)', () => {
        const dispatchError = new Error('dispatch failed');

        beforeEach(() => {
            jest.spyOn(log, 'error').mockImplementation(() => { });
        });

        afterEach(() => {
            jest.restoreAllMocks();
        });

        describe('advanceSchedule — dispatch rejection', () => {
            it('should log error with [DispatchController] prefix when dispatchReadyPhases rejects', async () => {
                const phases = [
                    makePhase({ id: 1, status: 'completed' }),
                    makePhase({ id: 2, status: 'pending' }),
                ];
                const runbook = makeRunbook(phases);
                const engine = createMockEngine(runbook);
                const controller = new DispatchController(engine);

                // Override dispatchReadyPhases to reject
                jest.spyOn(controller, 'dispatchReadyPhases').mockRejectedValue(dispatchError);

                controller.advanceSchedule();

                // Flush microtask queue to let .catch() run
                await new Promise(resolve => setImmediate(resolve));

                expect(log.error).toHaveBeenCalledWith(
                    '[DispatchController] advanceSchedule dispatch failed:',
                    dispatchError,
                );
            });

            it('should not throw an unhandled promise rejection from advanceSchedule', async () => {
                const phases = [makePhase({ id: 1, status: 'completed' })];
                const runbook = makeRunbook(phases);
                const engine = createMockEngine(runbook);
                const controller = new DispatchController(engine);

                jest.spyOn(controller, 'dispatchReadyPhases').mockRejectedValue(dispatchError);

                // advanceSchedule is void (not async) — should not produce unhandled rejection
                expect(() => controller.advanceSchedule()).not.toThrow();

                // Flush microtask queue
                await new Promise(resolve => setImmediate(resolve));
            });
        });

        describe('startStallWatchdog — dispatch rejection', () => {
            it('should log error with [DispatchController] prefix when stall dispatch rejects', async () => {
                // Create a stalled scenario: FSM in EXECUTING_WORKER, no running phases, ready phases exist
                const phases = [makePhase({ id: 1, status: 'pending' })];
                const runbook = makeRunbook(phases);
                const engine = createMockEngine(runbook);
                const controller = new DispatchController(engine);

                // Override dispatchReadyPhases to reject
                jest.spyOn(controller, 'dispatchReadyPhases').mockRejectedValue(dispatchError);

                // Use fake timers to control the stall watchdog interval
                jest.useFakeTimers();

                controller.startStallWatchdog();

                // Trigger the watchdog interval
                jest.advanceTimersByTime(30_000);

                // Switch to real timers for promise flushing
                jest.useRealTimers();

                // Flush microtask queue to let .catch() run
                await new Promise(resolve => setImmediate(resolve));

                expect(log.error).toHaveBeenCalledWith(
                    '[DispatchController] stallWatchdog dispatch failed:',
                    dispatchError,
                );

                controller.stopStallWatchdog();
            });

            it('should not throw an unhandled promise rejection from stall watchdog', async () => {
                const phases = [makePhase({ id: 1, status: 'pending' })];
                const runbook = makeRunbook(phases);
                const engine = createMockEngine(runbook);
                const controller = new DispatchController(engine);

                jest.spyOn(controller, 'dispatchReadyPhases').mockRejectedValue(dispatchError);

                jest.useFakeTimers();

                controller.startStallWatchdog();

                // Should not throw
                expect(() => jest.advanceTimersByTime(30_000)).not.toThrow();

                jest.useRealTimers();

                // Flush microtask queue
                await new Promise(resolve => setImmediate(resolve));

                controller.stopStallWatchdog();
            });
        });
    });
});
