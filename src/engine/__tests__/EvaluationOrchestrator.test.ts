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
import type { Phase } from '../../types/index.js';
import { asPhaseId } from '../../types/index.js';

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
        upsertEvaluationResult: jest.fn(),
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

        expect(mockDB.upsertEvaluationResult).toHaveBeenCalledTimes(1);
        expect(mockDB.upsertEvaluationResult).toHaveBeenCalledWith(
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

        expect(mockDB.upsertEvaluationResult).toHaveBeenCalledTimes(1);
        expect(mockDB.upsertEvaluationResult).toHaveBeenCalledWith(
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
