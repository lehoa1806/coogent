// ─────────────────────────────────────────────────────────────────────────────
// src/engine/__tests__/EvaluationOrchestrator.test.ts — F-1 audit fix tests
// ─────────────────────────────────────────────────────────────────────────────
// Verifies that applyVerdictInPlace persists evaluation results to the DB
// in parallel mode (both PASS and FAIL branches).

jest.mock('vscode', () => ({
    commands: { registerCommand: jest.fn() },
    window: { showWarningMessage: jest.fn(), showErrorMessage: jest.fn(), showInformationMessage: jest.fn() },
    workspace: { workspaceFolders: [] },
    Uri: { file: jest.fn() },
}), { virtual: true });

import { EvaluationOrchestrator } from '../EvaluationOrchestrator.js';
import { SelfHealingController } from '../SelfHealing.js';
import { asPhaseId, type Phase } from '../../types/index.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Mock factories
// ═══════════════════════════════════════════════════════════════════════════════

function makeMockEngine() {
    return {
        getRunbook: jest.fn(),
        transition: jest.fn(),
        emit: jest.fn(),
        emitUIMessage: jest.fn(),
        persist: jest.fn().mockResolvedValue(undefined),
        dispatchReadyPhases: jest.fn(),
        getScheduler: jest.fn().mockReturnValue({ isAllDone: jest.fn().mockReturnValue(false) }),
        getStateManager: jest.fn().mockReturnValue({ getSessionDir: () => '/tmp/session' }),
        advanceSchedule: jest.fn(),
        stopStallWatchdog: jest.fn(),
        addHealingTimer: jest.fn(),
        removeHealingTimer: jest.fn(),
    } as any;
}

function makeMockDB() {
    return {
        verdicts: {
            upsertEvaluation: jest.fn(),
        },
    } as any;
}

function makePhase(overrides: Partial<Phase> = {}): Phase {
    return {
        id: asPhaseId(1),
        status: 'running',
        prompt: 'Do the work',
        success_criteria: 'exit_code:0',
        context_files: [],
        mcpPhaseId: 'phase-001-abc',
        ...overrides,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  F-1 Tests: applyVerdictInPlace persistence
// ═══════════════════════════════════════════════════════════════════════════════

describe('EvaluationOrchestrator — F-1 audit fix: parallel mode persistence', () => {
    let engine: ReturnType<typeof makeMockEngine>;
    let healer: SelfHealingController;
    let orchestrator: EvaluationOrchestrator;
    let mockDB: ReturnType<typeof makeMockDB>;

    beforeEach(() => {
        engine = makeMockEngine();
        healer = new SelfHealingController({ maxRetries: 3, baseDelayMs: 1000 });
        orchestrator = new EvaluationOrchestrator(engine, healer, null);
        mockDB = makeMockDB();
        orchestrator.setArtifactDB(mockDB, 'task-001');
    });

    it('applyVerdictInPlace with PASS calls upsertEvaluationResult', async () => {
        const phase = makePhase();
        const runbook = { phases: [phase], status: 'running' };
        engine.getRunbook.mockReturnValue(runbook);

        // handleWorkerExited with isLastWorker=false triggers applyVerdictInPlace
        await orchestrator.handleWorkerExited(phase.id as number, 0, '', '', false);

        expect(mockDB.verdicts.upsertEvaluation).toHaveBeenCalledTimes(1);
        expect(mockDB.verdicts.upsertEvaluation).toHaveBeenCalledWith(
            'task-001',
            'phase-001-abc',
            expect.objectContaining({
                passed: true,
                reason: expect.any(String),
                evaluatedAt: expect.any(Number),
            })
        );
    });

    it('applyVerdictInPlace with FAIL calls upsertEvaluationResult', async () => {
        const phase = makePhase({ success_criteria: 'exit_code:0' });
        const runbook = { phases: [phase], status: 'running' };
        engine.getRunbook.mockReturnValue(runbook);

        // Exit code 1 => FAIL for exit_code:0 criteria
        await orchestrator.handleWorkerExited(phase.id as number, 1, '', 'some error', false);

        expect(mockDB.verdicts.upsertEvaluation).toHaveBeenCalledTimes(1);
        expect(mockDB.verdicts.upsertEvaluation).toHaveBeenCalledWith(
            'task-001',
            'phase-001-abc',
            expect.objectContaining({
                passed: false,
                reason: expect.stringContaining('does not match'),
                evaluatedAt: expect.any(Number),
            })
        );
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  handleWorkerFailed retry tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('EvaluationOrchestrator — handleWorkerFailed retry logic', () => {
    let engine: ReturnType<typeof makeMockEngine>;
    let healer: SelfHealingController;
    let orchestrator: EvaluationOrchestrator;

    beforeEach(() => {
        engine = makeMockEngine();
        healer = new SelfHealingController({ maxRetries: 3, baseDelayMs: 100 });
        orchestrator = new EvaluationOrchestrator(engine, healer, null);
    });

    it('should auto-retry on timeout when retries are available', async () => {
        const phase = makePhase({ max_retries: 2 });
        const runbook = { phases: [phase], status: 'running' };
        engine.getRunbook.mockReturnValue(runbook);

        await orchestrator.handleWorkerFailed(phase, true, 'timeout');

        // Phase should be set to 'pending' for retry, not 'failed'
        expect(phase.status).toBe('pending');
        // Should schedule a healing timer
        expect(engine.addHealingTimer).toHaveBeenCalledTimes(1);
        // Should NOT emit PHASE_STATUS with 'failed'
        expect(engine.emitUIMessage).not.toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'PHASE_STATUS',
                payload: expect.objectContaining({ status: 'failed' }),
            })
        );
        // Should transition to ERROR_PAUSED (via WORKER_TIMEOUT) as intermediate state
        expect(engine.transition).toHaveBeenCalledWith('WORKER_TIMEOUT');
    });

    it('should go to ERROR_PAUSED when max retries exhausted on timeout', async () => {
        const phase = makePhase({ max_retries: 0 });
        const runbook = { phases: [phase], status: 'running' };
        engine.getRunbook.mockReturnValue(runbook);

        await orchestrator.handleWorkerFailed(phase, true, 'timeout');

        // Phase should be failed
        expect(phase.status).toBe('failed');
        // Should NOT schedule a healing timer
        expect(engine.addHealingTimer).not.toHaveBeenCalled();
        // Should transition via WORKER_TIMEOUT
        expect(engine.transition).toHaveBeenCalledWith('WORKER_TIMEOUT');
        // Runbook should be paused
        expect(runbook.status).toBe('paused_error');
    });

    it('should auto-retry on crash when retries are available', async () => {
        const phase = makePhase({ max_retries: 2 });
        const runbook = { phases: [phase], status: 'running' };
        engine.getRunbook.mockReturnValue(runbook);

        await orchestrator.handleWorkerFailed(phase, true, 'crash');

        expect(phase.status).toBe('pending');
        expect(engine.addHealingTimer).toHaveBeenCalledTimes(1);
        expect(engine.transition).toHaveBeenCalledWith('WORKER_CRASH');
    });

    it('should dispatch ready phases when non-last worker fails without retries', async () => {
        const phase = makePhase({ max_retries: 0 });
        const runbook = { phases: [phase], status: 'running' };
        engine.getRunbook.mockReturnValue(runbook);

        await orchestrator.handleWorkerFailed(phase, false, 'crash');

        expect(phase.status).toBe('failed');
        // isLastWorker=false, so should call dispatchReadyPhases instead of transition
        expect(engine.transition).not.toHaveBeenCalled();
        expect(engine.dispatchReadyPhases).toHaveBeenCalled();
    });
});
