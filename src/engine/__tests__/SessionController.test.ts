// ─────────────────────────────────────────────────────────────────────────────
// src/engine/__tests__/SessionController.test.ts — M-15 audit fix
// ─────────────────────────────────────────────────────────────────────────────
// Dedicated tests for SessionController covering switchSession state-validation,
// loadRunbook lifecycle (success, missing, cycles, dangling deps), and reset.

jest.mock('vscode', () => ({
    commands: { registerCommand: jest.fn() },
    window: { showWarningMessage: jest.fn(), showErrorMessage: jest.fn(), showInformationMessage: jest.fn() },
    workspace: { workspaceFolders: [] },
    Uri: { file: jest.fn() },
}), { virtual: true });

import { SessionController } from '../SessionController.js';
import { EngineState, EngineEvent, asPhaseId, type Runbook } from '../../types/index.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Mock factories
// ═══════════════════════════════════════════════════════════════════════════════

function makeMockEngine(stateOverride: EngineState = EngineState.IDLE) {
    let currentState = stateOverride;
    return {
        getState: jest.fn(() => currentState),
        _setState(s: EngineState) { currentState = s; },
        getRunbook: jest.fn().mockReturnValue(null),
        setRunbook: jest.fn(),
        transition: jest.fn((event: EngineEvent) => {
            // Default: simulate successful transitions
            if (event === EngineEvent.LOAD_RUNBOOK) return EngineState.PARSING;
            if (event === EngineEvent.PARSE_SUCCESS) return EngineState.READY;
            if (event === EngineEvent.PARSE_FAILURE) return EngineState.IDLE;
            if (event === EngineEvent.RESET) return EngineState.IDLE;
            return null;
        }),
        emit: jest.fn(),
        emitUIMessage: jest.fn(),
        persist: jest.fn().mockResolvedValue(undefined),
        getStateManager: jest.fn(),
        getScheduler: jest.fn().mockReturnValue({
            detectCycles: jest.fn().mockReturnValue([]),
            isAllDone: jest.fn().mockReturnValue(false),
        }),
        getHealer: jest.fn().mockReturnValue({
            reset: jest.fn(),
            clearAttempts: jest.fn(),
        }),
        setPauseRequested: jest.fn(),
        setActiveWorkerCount: jest.fn(),
        replaceStateManager: jest.fn(),
        cleanupTimers: jest.fn(),
        resetControllers: jest.fn(),
        dispatchReadyPhases: jest.fn(),
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

function makeMockStateManager(runbook: Runbook | null = null) {
    return {
        loadRunbook: jest.fn().mockResolvedValue(runbook),
        saveRunbook: jest.fn().mockResolvedValue(undefined),
        getSessionDir: jest.fn().mockReturnValue('/tmp/session'),
    } as any;
}

function makeValidRunbook(): Runbook {
    return {
        project_id: 'test-project',
        status: 'idle',
        current_phase: 0,
        phases: [
            {
                id: asPhaseId(0),
                status: 'pending',
                prompt: 'Phase 0',
                context_files: [],
                success_criteria: 'exit_code:0',
                max_retries: 0,
            },
            {
                id: asPhaseId(1),
                status: 'pending',
                prompt: 'Phase 1',
                context_files: [],
                success_criteria: 'exit_code:0',
                depends_on: [asPhaseId(0)],
                max_retries: 0,
            },
        ],
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('SessionController', () => {
    let engine: ReturnType<typeof makeMockEngine>;
    let controller: SessionController;

    beforeEach(() => {
        engine = makeMockEngine();
        controller = new SessionController(engine);
    });

    // ─────────────────────────────────────────────────────────────────────
    //  loadRunbook
    // ─────────────────────────────────────────────────────────────────────

    describe('loadRunbook()', () => {
        it('should load a valid runbook and transition to READY', async () => {
            const runbook = makeValidRunbook();
            const sm = makeMockStateManager(runbook);
            engine.getStateManager.mockReturnValue(sm);

            await controller.loadRunbook();

            expect(engine.transition).toHaveBeenCalledWith(EngineEvent.LOAD_RUNBOOK);
            expect(engine.setRunbook).toHaveBeenCalledWith(runbook);
            expect(engine.transition).toHaveBeenCalledWith(EngineEvent.PARSE_SUCCESS);
            expect(engine.emitUIMessage).toHaveBeenCalledWith(
                expect.objectContaining({ type: 'STATE_SNAPSHOT' })
            );
        });

        it('should emit RUNBOOK_NOT_FOUND error when no runbook on disk', async () => {
            const sm = makeMockStateManager(null);
            engine.getStateManager.mockReturnValue(sm);

            await controller.loadRunbook();

            expect(engine.transition).toHaveBeenCalledWith(EngineEvent.PARSE_FAILURE);
            expect(engine.emitUIMessage).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: 'ERROR',
                    payload: expect.objectContaining({ code: 'RUNBOOK_NOT_FOUND' }),
                })
            );
        });

        it('should detect cyclic dependencies and emit CYCLE_DETECTED error', async () => {
            const runbook = makeValidRunbook();
            const sm = makeMockStateManager(runbook);
            engine.getStateManager.mockReturnValue(sm);
            engine.getScheduler().detectCycles.mockReturnValue([0, 1]); // cycle detected

            await controller.loadRunbook();

            expect(engine.transition).toHaveBeenCalledWith(EngineEvent.PARSE_FAILURE);
            expect(engine.emitUIMessage).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: 'ERROR',
                    payload: expect.objectContaining({ code: 'CYCLE_DETECTED' }),
                })
            );
        });

        it('should detect dangling depends_on references (MF-1)', async () => {
            const runbook = makeValidRunbook();
            // Add a dangling dependency reference
            runbook.phases[1].depends_on = [asPhaseId(99)]; // non-existent
            const sm = makeMockStateManager(runbook);
            engine.getStateManager.mockReturnValue(sm);

            await controller.loadRunbook();

            expect(engine.transition).toHaveBeenCalledWith(EngineEvent.PARSE_FAILURE);
            expect(engine.emitUIMessage).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: 'ERROR',
                    payload: expect.objectContaining({ code: 'VALIDATION_ERROR' }),
                })
            );
        });

        it('should handle loadRunbook() throwing an error', async () => {
            const sm = makeMockStateManager(null);
            sm.loadRunbook.mockRejectedValue(new Error('Disk read failed'));
            engine.getStateManager.mockReturnValue(sm);

            await controller.loadRunbook();

            expect(engine.transition).toHaveBeenCalledWith(EngineEvent.PARSE_FAILURE);
            expect(engine.emitUIMessage).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: 'ERROR',
                    payload: expect.objectContaining({
                        code: 'PARSE_ERROR',
                        message: 'Disk read failed',
                    }),
                })
            );
        });

        it('should be a no-op when LOAD_RUNBOOK transition fails', async () => {
            engine.transition.mockReturnValue(null); // all transitions rejected

            await controller.loadRunbook();

            expect(engine.setRunbook).not.toHaveBeenCalled();
        });
    });

    // ─────────────────────────────────────────────────────────────────────
    //  reset
    // ─────────────────────────────────────────────────────────────────────

    describe('reset()', () => {
        it('should reset all engine state and emit messages', async () => {
            engine._setState(EngineState.COMPLETED);

            await controller.reset();

            expect(engine.transition).toHaveBeenCalledWith(EngineEvent.RESET);
            expect(engine.cleanupTimers).toHaveBeenCalled();
            expect(engine.setRunbook).toHaveBeenCalledWith(null);
            expect(engine.resetControllers).toHaveBeenCalled();
            expect(engine.setActiveWorkerCount).toHaveBeenCalledWith(0);
            expect(engine.setPauseRequested).toHaveBeenCalledWith(false);
            expect(engine.getHealer().reset).toHaveBeenCalled();
        });

        it('should replace StateManager when provided', async () => {
            const newSM = makeMockStateManager();
            await controller.reset(newSM);
            expect(engine.replaceStateManager).toHaveBeenCalledWith(newSM);
        });

        it('should not replace StateManager when not provided', async () => {
            await controller.reset();
            expect(engine.replaceStateManager).not.toHaveBeenCalled();
        });

        it('should be a no-op when RESET transition fails', async () => {
            engine.transition.mockReturnValue(null);
            await controller.reset();
            expect(engine.cleanupTimers).not.toHaveBeenCalled();
        });
    });

    // ─────────────────────────────────────────────────────────────────────
    //  switchSession
    // ─────────────────────────────────────────────────────────────────────

    describe('switchSession()', () => {
        it('should allow switching from IDLE', async () => {
            engine._setState(EngineState.IDLE);
            const newSM = makeMockStateManager(makeValidRunbook());
            engine.getStateManager.mockReturnValue(newSM);

            await controller.switchSession(newSM);

            // From IDLE, no RESET transition needed
            expect(engine.replaceStateManager).toHaveBeenCalledWith(newSM);
            expect(engine.setRunbook).toHaveBeenCalledWith(null);
            expect(engine.resetControllers).toHaveBeenCalled();
            expect(engine.setActiveWorkerCount).toHaveBeenCalledWith(0);
        });

        it('should allow switching from READY (resets first)', async () => {
            engine._setState(EngineState.READY);
            const newSM = makeMockStateManager(makeValidRunbook());
            engine.getStateManager.mockReturnValue(newSM);

            await controller.switchSession(newSM);

            // From READY (not IDLE), should call RESET first
            expect(engine.transition).toHaveBeenCalledWith(EngineEvent.RESET);
            expect(engine.replaceStateManager).toHaveBeenCalledWith(newSM);
        });

        it('should allow switching from COMPLETED', async () => {
            engine._setState(EngineState.COMPLETED);
            const newSM = makeMockStateManager(makeValidRunbook());
            engine.getStateManager.mockReturnValue(newSM);

            await controller.switchSession(newSM);

            expect(engine.transition).toHaveBeenCalledWith(EngineEvent.RESET);
            expect(engine.replaceStateManager).toHaveBeenCalledWith(newSM);
        });

        it('should allow switching from ERROR_PAUSED', async () => {
            engine._setState(EngineState.ERROR_PAUSED);
            const newSM = makeMockStateManager(makeValidRunbook());
            engine.getStateManager.mockReturnValue(newSM);

            await controller.switchSession(newSM);

            expect(engine.replaceStateManager).toHaveBeenCalledWith(newSM);
        });

        it('should allow switching from PLAN_REVIEW', async () => {
            engine._setState(EngineState.PLAN_REVIEW);
            const newSM = makeMockStateManager(makeValidRunbook());
            engine.getStateManager.mockReturnValue(newSM);

            await controller.switchSession(newSM);

            expect(engine.replaceStateManager).toHaveBeenCalledWith(newSM);
        });

        it('should REJECT switching during EXECUTING_WORKER', async () => {
            engine._setState(EngineState.EXECUTING_WORKER);
            const newSM = makeMockStateManager();

            await controller.switchSession(newSM);

            expect(engine.emitUIMessage).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: 'LOG_ENTRY',
                    payload: expect.objectContaining({
                        level: 'warn',
                        message: expect.stringContaining('Cannot switch session'),
                    }),
                })
            );
            expect(engine.replaceStateManager).not.toHaveBeenCalled();
        });

        it('should REJECT switching during EVALUATING', async () => {
            engine._setState(EngineState.EVALUATING);
            const newSM = makeMockStateManager();

            await controller.switchSession(newSM);

            expect(engine.emitUIMessage).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: 'LOG_ENTRY',
                    payload: expect.objectContaining({ level: 'warn' }),
                })
            );
            expect(engine.replaceStateManager).not.toHaveBeenCalled();
        });

        it('should REJECT switching during PLANNING', async () => {
            engine._setState(EngineState.PLANNING);
            const newSM = makeMockStateManager();

            await controller.switchSession(newSM);

            expect(engine.replaceStateManager).not.toHaveBeenCalled();
        });

        it('should REJECT switching during PARSING', async () => {
            engine._setState(EngineState.PARSING);
            const newSM = makeMockStateManager();

            await controller.switchSession(newSM);

            expect(engine.replaceStateManager).not.toHaveBeenCalled();
        });

        it('should call loadRunbook() after switching', async () => {
            engine._setState(EngineState.IDLE);
            const newSM = makeMockStateManager(makeValidRunbook());
            engine.getStateManager.mockReturnValue(newSM);

            await controller.switchSession(newSM);

            // loadRunbook is called internally — verify via LOAD_RUNBOOK transition
            expect(engine.transition).toHaveBeenCalledWith(EngineEvent.LOAD_RUNBOOK);
        });
    });
});
