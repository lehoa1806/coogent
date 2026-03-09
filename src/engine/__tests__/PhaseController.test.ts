// ─────────────────────────────────────────────────────────────────────────────
// src/engine/__tests__/PhaseController.test.ts — M-15 audit fix
// ─────────────────────────────────────────────────────────────────────────────
// Dedicated tests for PhaseController covering restartPhase state-machine
// fallthrough logic, editPhase mutation, pausePhase, stopPhase, and skipPhase.

jest.mock('vscode', () => ({
    commands: { registerCommand: jest.fn() },
    window: { showWarningMessage: jest.fn(), showErrorMessage: jest.fn(), showInformationMessage: jest.fn() },
    workspace: { workspaceFolders: [] },
    Uri: { file: jest.fn() },
}), { virtual: true });

import { PhaseController } from '../PhaseController.js';
import { EngineState, EngineEvent, asPhaseId, type Phase, type Runbook } from '../../types/index.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Mock factories
// ═══════════════════════════════════════════════════════════════════════════════

function makeMockEngine(stateOverride: EngineState = EngineState.IDLE) {
    let currentState = stateOverride;
    return {
        getState: jest.fn(() => currentState),
        _setState(s: EngineState) { currentState = s; },
        getRunbook: jest.fn(),
        transition: jest.fn((_event: EngineEvent) => {
            // Simulate valid transitions returning next state
            currentState = EngineState.EXECUTING_WORKER;
            return currentState;
        }),
        emit: jest.fn(),
        emitUIMessage: jest.fn(),
        persist: jest.fn().mockResolvedValue(undefined),
        dispatchReadyPhases: jest.fn().mockResolvedValue(undefined),
        getScheduler: jest.fn().mockReturnValue({
            isAllDone: jest.fn().mockReturnValue(false),
        }),
        getStateManager: jest.fn().mockReturnValue({
            getSessionDir: () => '/tmp/session',
        }),
        getHealer: jest.fn().mockReturnValue({
            clearAttempts: jest.fn(),
        }),
        setPauseRequested: jest.fn(),
        setRunbook: jest.fn(),
        setActiveWorkerCount: jest.fn(),
        replaceStateManager: jest.fn(),
        cleanupTimers: jest.fn(),
        resetControllers: jest.fn(),
        advanceSchedule: jest.fn(),
        startStallWatchdog: jest.fn(),
        stopStallWatchdog: jest.fn(),
        addHealingTimer: jest.fn(),
        removeHealingTimer: jest.fn(),
        isPauseRequested: jest.fn().mockReturnValue(false),
        getActiveWorkerCount: jest.fn().mockReturnValue(0),
        incrementActiveWorkerCount: jest.fn(),
        getEvaluation: jest.fn(),
    } as any;
}

function makeRunbook(phases: Phase[]): Runbook {
    return {
        project_id: 'test-project',
        status: 'running',
        current_phase: 0,
        phases,
    };
}

function makePhase(id: number, status: Phase['status'] = 'pending'): Phase {
    return {
        id: asPhaseId(id),
        status,
        prompt: `Phase ${id}`,
        context_files: [],
        success_criteria: 'exit_code:0',
        max_retries: 0,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('PhaseController', () => {
    let engine: ReturnType<typeof makeMockEngine>;
    let controller: PhaseController;

    beforeEach(() => {
        engine = makeMockEngine();
        controller = new PhaseController(engine);
    });

    // ─────────────────────────────────────────────────────────────────────
    //  editPhase
    // ─────────────────────────────────────────────────────────────────────

    describe('editPhase()', () => {
        it('should update prompt, context_files, and success_criteria on the phase', async () => {
            const phase = makePhase(0);
            const runbook = makeRunbook([phase]);
            engine.getRunbook.mockReturnValue(runbook);

            await controller.editPhase(0, {
                prompt: 'Updated prompt',
                context_files: ['a.ts', 'b.ts'],
                success_criteria: 'exit_code:0; contains:OK',
            });

            expect(phase.prompt).toBe('Updated prompt');
            expect(phase.context_files).toEqual(['a.ts', 'b.ts']);
            expect(phase.success_criteria).toBe('exit_code:0; contains:OK');
            expect(engine.persist).toHaveBeenCalledTimes(1);
            expect(engine.emitUIMessage).toHaveBeenCalledWith(
                expect.objectContaining({ type: 'STATE_SNAPSHOT' })
            );
        });

        it('should be a no-op when no runbook is loaded', async () => {
            engine.getRunbook.mockReturnValue(null);
            await controller.editPhase(0, { prompt: 'x' });
            expect(engine.persist).not.toHaveBeenCalled();
        });

        it('should be a no-op when phase does not exist', async () => {
            const runbook = makeRunbook([makePhase(0)]);
            engine.getRunbook.mockReturnValue(runbook);
            await controller.editPhase(99, { prompt: 'x' });
            expect(engine.persist).not.toHaveBeenCalled();
        });

        it('should apply partial patches (only prompt)', async () => {
            const phase = makePhase(0);
            phase.context_files = ['original.ts'];
            const runbook = makeRunbook([phase]);
            engine.getRunbook.mockReturnValue(runbook);

            await controller.editPhase(0, { prompt: 'New prompt only' });
            expect(phase.prompt).toBe('New prompt only');
            expect(phase.context_files).toEqual(['original.ts']); // unchanged
        });
    });

    // ─────────────────────────────────────────────────────────────────────
    //  pausePhase
    // ─────────────────────────────────────────────────────────────────────

    describe('pausePhase()', () => {
        it('should set pause requested and emit log entry', () => {
            controller.pausePhase(0);
            expect(engine.setPauseRequested).toHaveBeenCalledWith(true);
            expect(engine.emitUIMessage).toHaveBeenCalledWith(
                expect.objectContaining({ type: 'LOG_ENTRY' })
            );
        });
    });

    // ─────────────────────────────────────────────────────────────────────
    //  stopPhase
    // ─────────────────────────────────────────────────────────────────────

    describe('stopPhase()', () => {
        it('should emit phase:stop for a running phase', async () => {
            const phase = makePhase(0, 'running');
            const runbook = makeRunbook([phase]);
            engine.getRunbook.mockReturnValue(runbook);

            await controller.stopPhase(0);
            expect(engine.emit).toHaveBeenCalledWith('phase:stop', 0);
        });

        it('should be a no-op for a non-running phase', async () => {
            const phase = makePhase(0, 'pending');
            const runbook = makeRunbook([phase]);
            engine.getRunbook.mockReturnValue(runbook);

            await controller.stopPhase(0);
            expect(engine.emit).not.toHaveBeenCalled();
        });

        it('should be a no-op when no runbook is loaded', async () => {
            engine.getRunbook.mockReturnValue(null);
            await controller.stopPhase(0);
            expect(engine.emit).not.toHaveBeenCalled();
        });
    });

    // ─────────────────────────────────────────────────────────────────────
    //  restartPhase — 5 entry state branches
    // ─────────────────────────────────────────────────────────────────────

    describe('restartPhase()', () => {
        let runbook: Runbook;

        beforeEach(() => {
            const phase = makePhase(0, 'failed');
            runbook = makeRunbook([phase, makePhase(1)]);
            engine.getRunbook.mockReturnValue(runbook);
        });

        it('should restart from ERROR_PAUSED (RETRY transition)', async () => {
            engine._setState(EngineState.ERROR_PAUSED);
            engine.transition.mockReturnValue(EngineState.EXECUTING_WORKER);

            await controller.restartPhase(0);

            expect(engine.transition).toHaveBeenCalledWith(EngineEvent.RETRY);
            expect(runbook.phases[0].status).toBe('pending');
            expect(runbook.current_phase).toBe(0);
            expect(engine.getHealer().clearAttempts).toHaveBeenCalledWith(0);
            expect(engine.persist).toHaveBeenCalled();
            expect(engine.dispatchReadyPhases).toHaveBeenCalled();
        });

        it('should restart from IDLE (START transition)', async () => {
            engine._setState(EngineState.IDLE);
            engine.transition.mockReturnValue(EngineState.EXECUTING_WORKER);

            await controller.restartPhase(0);

            expect(engine.transition).toHaveBeenCalledWith(EngineEvent.START);
            expect(runbook.phases[0].status).toBe('pending');
            expect(engine.dispatchReadyPhases).toHaveBeenCalled();
        });

        it('should restart from READY (START transition)', async () => {
            engine._setState(EngineState.READY);
            engine.transition.mockReturnValue(EngineState.EXECUTING_WORKER);

            await controller.restartPhase(0);

            expect(engine.transition).toHaveBeenCalledWith(EngineEvent.START);
            expect(runbook.phases[0].status).toBe('pending');
        });

        it('should restart from COMPLETED (START transition)', async () => {
            engine._setState(EngineState.COMPLETED);
            engine.transition.mockReturnValue(EngineState.EXECUTING_WORKER);

            await controller.restartPhase(0);

            expect(engine.transition).toHaveBeenCalledWith(EngineEvent.START);
            expect(runbook.phases[0].status).toBe('pending');
        });

        it('should proceed from EXECUTING_WORKER (passthrough — no new transition)', async () => {
            engine._setState(EngineState.EXECUTING_WORKER);
            // In EXECUTING_WORKER, the code falls through to the reset logic
            // without making any transition call (state === EXECUTING_WORKER)

            await controller.restartPhase(0);

            // No transition call — EXECUTING_WORKER goes to the else branch
            expect(engine.transition).not.toHaveBeenCalled();
            expect(runbook.phases[0].status).toBe('pending');
            expect(engine.dispatchReadyPhases).toHaveBeenCalled();
        });

        it('should reject restart from PLANNING state with warning', async () => {
            engine._setState(EngineState.PLANNING);

            await controller.restartPhase(0);

            expect(engine.emitUIMessage).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: 'LOG_ENTRY',
                    payload: expect.objectContaining({
                        level: 'warn',
                        message: expect.stringContaining('Cannot restart'),
                    }),
                })
            );
            expect(engine.persist).not.toHaveBeenCalled();
        });

        it('should reject restart from PARSING state with warning', async () => {
            engine._setState(EngineState.PARSING);

            await controller.restartPhase(0);

            expect(engine.emitUIMessage).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: 'LOG_ENTRY',
                    payload: expect.objectContaining({ level: 'warn' }),
                })
            );
            expect(engine.persist).not.toHaveBeenCalled();
        });

        it('should not restart a currently running phase', async () => {
            runbook.phases[0].status = 'running';
            engine._setState(EngineState.EXECUTING_WORKER);

            await controller.restartPhase(0);

            // running phase guard returns early before any state logic
            expect(engine.persist).not.toHaveBeenCalled();
            expect(engine.dispatchReadyPhases).not.toHaveBeenCalled();
        });

        it('should be a no-op when no runbook is loaded', async () => {
            engine.getRunbook.mockReturnValue(null);
            await controller.restartPhase(0);
            expect(engine.persist).not.toHaveBeenCalled();
        });

        it('should be a no-op when phase does not exist', async () => {
            await controller.restartPhase(99);
            expect(engine.persist).not.toHaveBeenCalled();
        });

        it('should return early when transition fails (returns null)', async () => {
            engine._setState(EngineState.ERROR_PAUSED);
            engine.transition.mockReturnValue(null); // transition rejected

            await controller.restartPhase(0);

            expect(engine.persist).not.toHaveBeenCalled();
            expect(engine.dispatchReadyPhases).not.toHaveBeenCalled();
        });
    });

    // ─────────────────────────────────────────────────────────────────────
    //  reviewDiff
    // ─────────────────────────────────────────────────────────────────────

    describe('reviewDiff()', () => {
        it('should emit phase:review-diff event', async () => {
            const runbook = makeRunbook([makePhase(0)]);
            engine.getRunbook.mockReturnValue(runbook);

            await controller.reviewDiff(0);
            expect(engine.emit).toHaveBeenCalledWith('phase:review-diff', 0);
        });

        it('should be a no-op when phase does not exist', async () => {
            const runbook = makeRunbook([makePhase(0)]);
            engine.getRunbook.mockReturnValue(runbook);

            await controller.reviewDiff(99);
            expect(engine.emit).not.toHaveBeenCalled();
        });
    });

    // ─────────────────────────────────────────────────────────────────────
    //  skipPhase
    // ─────────────────────────────────────────────────────────────────────

    describe('skipPhase()', () => {
        it('should mark phase as completed and advance current_phase', async () => {
            const phase = makePhase(0, 'failed');
            const runbook = makeRunbook([phase, makePhase(1)]);
            engine.getRunbook.mockReturnValue(runbook);
            engine.transition.mockReturnValue(EngineState.READY);
            engine.getScheduler().isAllDone.mockReturnValue(false);

            await controller.skipPhase(0);

            expect(phase.status).toBe('completed');
            expect(runbook.current_phase).toBe(1);
            expect(engine.persist).toHaveBeenCalled();
            expect(engine.emitUIMessage).toHaveBeenCalledWith(
                expect.objectContaining({ type: 'PHASE_STATUS' })
            );
        });

        it('should be a no-op when SKIP_PHASE transition fails', async () => {
            const runbook = makeRunbook([makePhase(0, 'failed')]);
            engine.getRunbook.mockReturnValue(runbook);
            engine.transition.mockReturnValue(null);

            await controller.skipPhase(0);
            expect(engine.persist).not.toHaveBeenCalled();
        });

        it('should complete the run when all phases are done with no failures', async () => {
            const phase = makePhase(0, 'failed');
            const runbook = makeRunbook([phase]);
            engine.getRunbook.mockReturnValue(runbook);
            engine.transition.mockReturnValue(EngineState.READY);
            engine.getScheduler().isAllDone.mockReturnValue(true);

            await controller.skipPhase(0);

            expect(runbook.status).toBe('completed');
            expect(engine.emit).toHaveBeenCalledWith('run:completed', runbook);
        });

        it('should pause on error when all done but some phases failed', async () => {
            const phases = [makePhase(0, 'failed'), makePhase(1, 'failed')];
            phases[1].status = 'failed'; // simulate a prior failure
            const runbook = makeRunbook(phases);
            engine.getRunbook.mockReturnValue(runbook);
            engine.transition.mockReturnValue(EngineState.READY);
            engine.getScheduler().isAllDone.mockReturnValue(true);

            await controller.skipPhase(0);

            // Phase 0 is now 'completed' but phase 1 is still 'failed'
            expect(runbook.status).toBe('paused_error');
        });
    });
});
