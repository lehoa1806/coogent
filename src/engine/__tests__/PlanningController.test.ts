// ─────────────────────────────────────────────────────────────────────────────
// src/engine/__tests__/PlanningController.test.ts — M-15 audit fix
// ─────────────────────────────────────────────────────────────────────────────
// Dedicated tests for PlanningController covering the full plan lifecycle:
// planRequest → planGenerated → planApproved/planRejected, plus planRetryParse.

jest.mock('vscode', () => ({
    commands: { registerCommand: jest.fn() },
    window: { showWarningMessage: jest.fn(), showErrorMessage: jest.fn(), showInformationMessage: jest.fn() },
    workspace: { workspaceFolders: [] },
    Uri: { file: jest.fn() },
}), { virtual: true });

import { PlanningController } from '../PlanningController.js';
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
            // Simulate the expected FSM transitions
            if (event === EngineEvent.PLAN_REQUEST) { currentState = EngineState.PLANNING; return currentState; }
            if (event === EngineEvent.PLAN_GENERATED) { currentState = EngineState.PLAN_REVIEW; return currentState; }
            if (event === EngineEvent.PLAN_APPROVED) { currentState = EngineState.PARSING; return currentState; }
            if (event === EngineEvent.PLAN_REJECTED) { currentState = EngineState.PLANNING; return currentState; }
            if (event === EngineEvent.PARSE_SUCCESS) { currentState = EngineState.READY; return currentState; }
            if (event === EngineEvent.PARSE_FAILURE) { currentState = EngineState.IDLE; return currentState; }
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

function makeDraftRunbook(): Runbook {
    return {
        project_id: 'planned-project',
        status: 'idle',
        current_phase: 0,
        phases: [
            {
                id: asPhaseId(0),
                status: 'pending',
                prompt: 'Phase 0 from plan',
                context_files: [],
                success_criteria: 'exit_code:0',
                max_retries: 1,
            },
        ],
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('PlanningController', () => {
    let engine: ReturnType<typeof makeMockEngine>;
    let controller: PlanningController;

    beforeEach(() => {
        engine = makeMockEngine();
        controller = new PlanningController(engine);
    });

    // ─────────────────────────────────────────────────────────────────────
    //  planRequest
    // ─────────────────────────────────────────────────────────────────────

    describe('planRequest()', () => {
        it('should store prompt, clear draft, transition to PLANNING, and emit plan:request', () => {
            controller.planRequest('Build a REST API');

            expect(controller.getPlanPrompt()).toBe('Build a REST API');
            expect(controller.getPlanDraft()).toBeNull();
            expect(engine.transition).toHaveBeenCalledWith(EngineEvent.PLAN_REQUEST);
            expect(engine.emit).toHaveBeenCalledWith('plan:request', 'Build a REST API');
            expect(engine.emitUIMessage).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: 'PLAN_STATUS',
                    payload: expect.objectContaining({ status: 'generating' }),
                })
            );
            expect(engine.emitUIMessage).toHaveBeenCalledWith(
                expect.objectContaining({ type: 'STATE_SNAPSHOT' })
            );
        });

        it('should not emit events when PLAN_REQUEST transition fails', () => {
            engine.transition.mockReturnValue(null);

            controller.planRequest('Build a REST API');

            expect(engine.emit).not.toHaveBeenCalled();
            expect(engine.emitUIMessage).not.toHaveBeenCalled();
        });

        it('should clear previous draft when called again', () => {
            const draft = makeDraftRunbook();
            controller.planRequest('First try');
            // Simulate planGenerated
            controller.planGenerated(draft, []);
            expect(controller.getPlanDraft()).toBe(draft);

            // Second request clears previous draft
            controller.planRequest('Second try');
            expect(controller.getPlanDraft()).toBeNull();
            expect(controller.getPlanPrompt()).toBe('Second try');
        });
    });

    // ─────────────────────────────────────────────────────────────────────
    //  planGenerated
    // ─────────────────────────────────────────────────────────────────────

    describe('planGenerated()', () => {
        it('should store draft, transition to PLAN_REVIEW, and emit PLAN_DRAFT', () => {
            engine._setState(EngineState.PLANNING);
            const draft = makeDraftRunbook();
            const fileTree = ['src/index.ts', 'src/api.ts'];

            controller.planGenerated(draft, fileTree);

            expect(controller.getPlanDraft()).toBe(draft);
            expect(engine.transition).toHaveBeenCalledWith(EngineEvent.PLAN_GENERATED);
            expect(engine.emitUIMessage).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: 'PLAN_DRAFT',
                    payload: expect.objectContaining({ draft, fileTree }),
                })
            );
        });

        it('should not emit UI messages when PLAN_GENERATED transition fails', () => {
            engine.transition.mockReturnValue(null);
            const draft = makeDraftRunbook();

            controller.planGenerated(draft, []);

            // Draft is still stored (before transition check)
            expect(controller.getPlanDraft()).toBe(draft);
            expect(engine.emitUIMessage).not.toHaveBeenCalled();
        });
    });

    // ─────────────────────────────────────────────────────────────────────
    //  planApproved
    // ─────────────────────────────────────────────────────────────────────

    describe('planApproved()', () => {
        it('should save draft, transition to PARSING → READY, and load runbook', async () => {
            engine._setState(EngineState.PLAN_REVIEW);
            const draft = makeDraftRunbook();
            controller.planGenerated(draft, []);

            const sm = makeMockStateManager(draft);
            engine.getStateManager.mockReturnValue(sm);

            await controller.planApproved();

            // Should save the draft first
            expect(sm.saveRunbook).toHaveBeenCalledWith(draft, expect.any(String));
            // Should emit plan:approved
            expect(engine.emit).toHaveBeenCalledWith('plan:approved', draft);
            // Should transition PLAN_REVIEW → PARSING
            expect(engine.transition).toHaveBeenCalledWith(EngineEvent.PLAN_APPROVED);
            // Should load and validate the saved runbook
            expect(sm.loadRunbook).toHaveBeenCalled();
            expect(engine.setRunbook).toHaveBeenCalledWith(draft);
            expect(engine.transition).toHaveBeenCalledWith(EngineEvent.PARSE_SUCCESS);
        });

        it('should emit error when no draft is available', async () => {
            // Don't set a draft
            await controller.planApproved();

            expect(engine.emit).toHaveBeenCalledWith(
                'error',
                expect.objectContaining({ message: expect.stringContaining('no draft') })
            );
        });

        it('should handle loadRunbook returning null after save', async () => {
            engine._setState(EngineState.PLAN_REVIEW);
            const draft = makeDraftRunbook();
            controller.planGenerated(draft, []);

            const sm = makeMockStateManager(null); // load returns null
            engine.getStateManager.mockReturnValue(sm);

            await controller.planApproved();

            expect(engine.transition).toHaveBeenCalledWith(EngineEvent.PARSE_FAILURE);
        });

        it('should handle loadRunbook throwing an error', async () => {
            engine._setState(EngineState.PLAN_REVIEW);
            const draft = makeDraftRunbook();
            controller.planGenerated(draft, []);

            const sm = makeMockStateManager(null);
            sm.loadRunbook.mockRejectedValue(new Error('Corrupted file'));
            engine.getStateManager.mockReturnValue(sm);

            await controller.planApproved();

            expect(engine.transition).toHaveBeenCalledWith(EngineEvent.PARSE_FAILURE);
            expect(engine.emitUIMessage).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: 'ERROR',
                    payload: expect.objectContaining({
                        code: 'PARSE_ERROR',
                        message: 'Corrupted file',
                    }),
                })
            );
        });

        it('should be a no-op when PLAN_APPROVED transition fails', async () => {
            engine._setState(EngineState.PLAN_REVIEW);
            const draft = makeDraftRunbook();
            controller.planGenerated(draft, []);

            engine.transition.mockReturnValue(null);
            const sm = makeMockStateManager(draft);
            engine.getStateManager.mockReturnValue(sm);

            await controller.planApproved();

            // saveRunbook is called before transition, but loadRunbook should not be
            expect(sm.saveRunbook).toHaveBeenCalled();
            // loadRunbook should NOT be called since transition failed
            expect(sm.loadRunbook).not.toHaveBeenCalled();
        });
    });

    // ─────────────────────────────────────────────────────────────────────
    //  planRejected
    // ─────────────────────────────────────────────────────────────────────

    describe('planRejected()', () => {
        it('should transition to PLANNING and emit plan:rejected with feedback', () => {
            engine._setState(EngineState.PLAN_REVIEW);
            // Set initial prompt so it's available for re-planning
            controller.planRequest('Build a REST API');
            jest.clearAllMocks();
            engine._setState(EngineState.PLAN_REVIEW);
            // Mock transition to return valid state
            engine.transition.mockReturnValue(EngineState.PLANNING);

            controller.planRejected('Add authentication support');

            expect(engine.transition).toHaveBeenCalledWith(EngineEvent.PLAN_REJECTED);
            expect(engine.emitUIMessage).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: 'PLAN_STATUS',
                    payload: expect.objectContaining({ status: 'generating' }),
                })
            );
            expect(engine.emit).toHaveBeenCalledWith(
                'plan:rejected',
                'Build a REST API',
                'Add authentication support'
            );
        });

        it('should not emit events when PLAN_REJECTED transition fails', () => {
            engine.transition.mockReturnValue(null);

            controller.planRejected('feedback');

            expect(engine.emit).not.toHaveBeenCalled();
            expect(engine.emitUIMessage).not.toHaveBeenCalled();
        });
    });

    // ─────────────────────────────────────────────────────────────────────
    //  planRetryParse
    // ─────────────────────────────────────────────────────────────────────

    describe('planRetryParse()', () => {
        it('should emit plan:retryParse from PLANNING state', () => {
            engine._setState(EngineState.PLANNING);

            controller.planRetryParse();

            expect(engine.emit).toHaveBeenCalledWith('plan:retryParse');
        });

        it('should emit plan:retryParse from IDLE state', () => {
            engine._setState(EngineState.IDLE);

            controller.planRetryParse();

            expect(engine.emit).toHaveBeenCalledWith('plan:retryParse');
        });

        it('should reject planRetryParse from EXECUTING_WORKER', () => {
            engine._setState(EngineState.EXECUTING_WORKER);

            controller.planRetryParse();

            expect(engine.emit).not.toHaveBeenCalled();
        });

        it('should reject planRetryParse from COMPLETED', () => {
            engine._setState(EngineState.COMPLETED);

            controller.planRetryParse();

            expect(engine.emit).not.toHaveBeenCalled();
        });

        it('should reject planRetryParse from PLAN_REVIEW', () => {
            engine._setState(EngineState.PLAN_REVIEW);

            controller.planRetryParse();

            expect(engine.emit).not.toHaveBeenCalled();
        });
    });

    // ─────────────────────────────────────────────────────────────────────
    //  reset
    // ─────────────────────────────────────────────────────────────────────

    describe('reset()', () => {
        it('should clear plan draft and prompt', () => {
            controller.planRequest('Some prompt');
            const draft = makeDraftRunbook();
            controller.planGenerated(draft, []);

            expect(controller.getPlanDraft()).not.toBeNull();
            expect(controller.getPlanPrompt()).toBe('Some prompt');

            controller.reset();

            expect(controller.getPlanDraft()).toBeNull();
            expect(controller.getPlanPrompt()).toBe('');
        });
    });

    // ─────────────────────────────────────────────────────────────────────
    //  Full lifecycle integration
    // ─────────────────────────────────────────────────────────────────────

    describe('Full plan lifecycle', () => {
        it('should complete: request → generate → approve flow', async () => {
            const sm = makeMockStateManager(makeDraftRunbook());
            engine.getStateManager.mockReturnValue(sm);

            // 1. User submits prompt
            controller.planRequest('Build a REST API');
            expect(engine.transition).toHaveBeenCalledWith(EngineEvent.PLAN_REQUEST);

            // 2. Planner produces draft
            const draft = makeDraftRunbook();
            controller.planGenerated(draft, ['src/api.ts']);
            expect(engine.transition).toHaveBeenCalledWith(EngineEvent.PLAN_GENERATED);
            expect(controller.getPlanDraft()).toBe(draft);

            // 3. User approves
            await controller.planApproved();
            expect(sm.saveRunbook).toHaveBeenCalledWith(draft, expect.any(String));
            expect(engine.transition).toHaveBeenCalledWith(EngineEvent.PLAN_APPROVED);
        });

        it('should complete: request → generate → reject → regenerate → approve flow', async () => {
            const sm = makeMockStateManager(makeDraftRunbook());
            engine.getStateManager.mockReturnValue(sm);

            // 1. Request
            controller.planRequest('Build a REST API');

            // 2. Generate
            controller.planGenerated(makeDraftRunbook(), []);

            // 3. Reject
            controller.planRejected('Add auth');
            expect(engine.transition).toHaveBeenCalledWith(EngineEvent.PLAN_REJECTED);

            // 4. Regenerate (agent produces a new draft)
            const newDraft = { ...makeDraftRunbook(), project_id: 'revised-plan' } as Runbook;
            controller.planGenerated(newDraft, ['src/auth.ts']);
            expect(controller.getPlanDraft()?.project_id).toBe('revised-plan');

            // 5. Approve
            await controller.planApproved();
            expect(sm.saveRunbook).toHaveBeenCalledWith(newDraft, expect.any(String));
        });
    });
});
