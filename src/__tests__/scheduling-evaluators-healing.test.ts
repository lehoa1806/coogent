// ─────────────────────────────────────────────────────────────────────────────
// scheduling-evaluators-healing.test.ts — Unit tests for DAG Scheduler,
// Phase Evaluators, SelfHealingController, TokenPruner, and FileResolver
// ─────────────────────────────────────────────────────────────────────────────

jest.mock('vscode', () => ({
    workspace: { workspaceFolders: [] },
}), { virtual: true });

import { Scheduler } from '../engine/Scheduler';
import { SelfHealingController } from '../engine/SelfHealing';
import { TokenPruner, PrunableEntry } from '../context/TokenPruner';
import { ExplicitFileResolver } from '../context/FileResolver';
import type { Phase } from '../types/index';
import { asPhaseId } from '../types/index';
import { CharRatioEncoder } from '../context/ContextScoper';
import { EvaluationOrchestrator } from '../engine/EvaluationOrchestrator';

// ═══════════════════════════════════════════════════════════════════════════════
//  Scheduler Tests
// ═══════════════════════════════════════════════════════════════════════════════

type PhaseOverrides = Omit<Partial<Phase>, 'id' | 'depends_on'> & { id: number; depends_on?: number[] };

describe('Scheduler — DAG-aware phase scheduling', () => {
    const scheduler = new Scheduler({ maxConcurrent: 2 });

    const makePhase = (overrides: PhaseOverrides): Phase => ({
        status: 'pending',
        prompt: 'test prompt',
        context_files: [],
        success_criteria: 'exit_code:0',
        ...overrides,
        id: asPhaseId(overrides.id),
        depends_on: overrides.depends_on?.map(d => asPhaseId(d)) ?? [],
    });

    describe('isDAGMode', () => {
        it('returns false when no phase has depends_on', () => {
            const phases = [makePhase({ id: 0 }), makePhase({ id: 1 })];
            expect(scheduler.isDAGMode(phases)).toBe(false);
        });

        it('returns true when at least one phase has depends_on', () => {
            const phases = [
                makePhase({ id: 0 }),
                makePhase({ id: 1, depends_on: [0] }),
            ];
            expect(scheduler.isDAGMode(phases)).toBe(true);
        });
    });

    describe('getReadyPhases — sequential mode', () => {
        it('returns the first pending phase', () => {
            const phases = [
                makePhase({ id: 0, status: 'completed' }),
                makePhase({ id: 1, status: 'pending' }),
                makePhase({ id: 2, status: 'pending' }),
            ];
            const ready = scheduler.getReadyPhases(phases);
            expect(ready).toHaveLength(1);
            expect(ready[0].id).toBe(1);
        });

        it('returns empty when all completed', () => {
            const phases = [
                makePhase({ id: 0, status: 'completed' }),
                makePhase({ id: 1, status: 'completed' }),
            ];
            expect(scheduler.getReadyPhases(phases)).toHaveLength(0);
        });
    });

    describe('getReadyPhases — DAG mode', () => {
        it('returns phases whose deps are satisfied', () => {
            const phases = [
                makePhase({ id: 0, status: 'completed' }),
                makePhase({ id: 1, depends_on: [0], status: 'pending' }),
                makePhase({ id: 2, depends_on: [0], status: 'pending' }),
                makePhase({ id: 3, depends_on: [1, 2], status: 'pending' }),
            ];
            const ready = scheduler.getReadyPhases(phases);
            expect(ready).toHaveLength(2); // maxConcurrent = 2
            expect(ready.map(r => r.id).sort()).toEqual([1, 2]);
        });

        it('blocks phases with unsatisfied deps', () => {
            const phases = [
                makePhase({ id: 0, status: 'pending' }),
                makePhase({ id: 1, depends_on: [0], status: 'pending' }),
            ];
            const ready = scheduler.getReadyPhases(phases);
            expect(ready).toHaveLength(1);
            expect(ready[0].id).toBe(0);
        });

        it('respects maxConcurrent', () => {
            const phases = [
                makePhase({ id: 0, status: 'running' }),
                makePhase({ id: 1, status: 'running' }),
                makePhase({ id: 2, status: 'pending' }),
            ];
            expect(scheduler.getReadyPhases(phases)).toHaveLength(0);
        });
    });

    describe('detectCycles', () => {
        it('returns empty for acyclic DAG', () => {
            const phases = [
                makePhase({ id: 0 }),
                makePhase({ id: 1, depends_on: [0] }),
                makePhase({ id: 2, depends_on: [0, 1] }),
            ];
            expect(scheduler.detectCycles(phases)).toEqual([]);
        });

        it('detects a simple cycle', () => {
            const phases = [
                makePhase({ id: 0, depends_on: [1] }),
                makePhase({ id: 1, depends_on: [0] }),
            ];
            const cycles = scheduler.detectCycles(phases);
            expect(cycles.length).toBeGreaterThan(0);
        });
    });

    describe('getExecutionOrder', () => {
        it('returns topological order', () => {
            const phases = [
                makePhase({ id: 2, depends_on: [0, 1] }),
                makePhase({ id: 0 }),
                makePhase({ id: 1, depends_on: [0] }),
            ];
            const order = scheduler.getExecutionOrder(phases);
            expect(order.indexOf(asPhaseId(0))).toBeLessThan(order.indexOf(asPhaseId(1)));
            expect(order.indexOf(asPhaseId(1))).toBeLessThan(order.indexOf(asPhaseId(2)));
        });
    });
});

// V1 Evaluator tests removed — V2 evaluators are tested in EvaluatorV2.test.ts

// ═══════════════════════════════════════════════════════════════════════════════
//  SelfHealingController Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('SelfHealingController — retry logic and exponential backoff', () => {
    let healer: SelfHealingController;

    beforeEach(() => {
        healer = new SelfHealingController({ maxRetries: 3, baseDelayMs: 1000 });
    });

    it('allows retries up to the configured maxRetries limit', () => {
        healer.recordFailure(1, 1, 'error 1');
        expect(healer.canRetry(1)).toBe(true);

        healer.recordFailure(1, 1, 'error 2');
        expect(healer.canRetry(1)).toBe(true);

        healer.recordFailure(1, 1, 'error 3');
        expect(healer.canRetry(1)).toBe(false);
    });

    it('respects per-phase max_retries override', () => {
        const phase: Phase = {
            id: asPhaseId(1), status: 'failed', prompt: 'test',
            context_files: [], success_criteria: 'exit_code:0',
            max_retries: 1,
        };
        healer.recordFailure(1, 1, 'error');
        expect(healer.canRetryWithPhase(phase)).toBe(false);
    });

    it('calculates exponential backoff delay based on attempt count', () => {
        expect(healer.getRetryDelay(1)).toBe(1000); // 0 attempts → base
        healer.recordFailure(1, 1, 'err');
        expect(healer.getRetryDelay(1)).toBe(2000); // 1 attempt → 2x
        healer.recordFailure(1, 1, 'err');
        expect(healer.getRetryDelay(1)).toBe(4000); // 2 attempts → 4x
    });

    it('builds an augmented healing prompt with retry count and error history', () => {
        const phase: Phase = {
            id: asPhaseId(1), status: 'failed', prompt: 'Build the module',
            context_files: [], success_criteria: 'exit_code:0',
        };
        healer.recordFailure(1, 1, 'TypeError: x is not defined');
        const prompt = healer.buildHealingPrompt(phase);

        expect(prompt).toContain('Retry 1/3');
        expect(prompt).toContain('TypeError: x is not defined');
        expect(prompt).toContain('Build the module');
    });

    it('clears all recorded attempts for a given phase', () => {
        healer.recordFailure(1, 1, 'err');
        expect(healer.getAttemptCount(1)).toBe(1);
        healer.clearAttempts(1);
        expect(healer.getAttemptCount(1)).toBe(0);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  TokenPruner Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('TokenPruner — context budget enforcement', () => {
    const encoder = new CharRatioEncoder(4);
    const pruner = new TokenPruner(encoder, 100); // 100 token limit

    const makeEntry = (path: string, content: string, isExplicit: boolean): PrunableEntry => ({
        path,
        content,
        tokenCount: encoder.countTokens(content),
        isExplicit,
    });

    it('skips pruning when within budget', () => {
        const entries = [makeEntry('a.ts', 'const x = 1;', true)];
        const result = pruner.prune(entries);
        expect(result.withinBudget).toBe(true);
        expect(result.prunedCount).toBe(0);
    });

    it('drops discovered files first (largest first)', () => {
        const entries = [
            makeEntry('a.ts', 'x'.repeat(200), true),  // 50 tokens, explicit
            makeEntry('b.ts', 'y'.repeat(400), false), // 100 tokens, discovered
        ];
        const result = pruner.prune(entries);
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0].path).toBe('a.ts');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  FileResolver Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('ExplicitFileResolver — context_files passthrough', () => {
    const resolver = new ExplicitFileResolver();

    it('returns the phase context_files list unmodified', async () => {
        const phase: Phase = {
            id: asPhaseId(0), status: 'pending', prompt: 'test',
            context_files: ['src/a.ts', 'src/b.ts'],
            success_criteria: 'exit_code:0',
        };
        const result = await resolver.resolve(phase, '/workspace');
        expect(result).toEqual(['src/a.ts', 'src/b.ts']);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  F-1 Audit Fix: Parallel-mode evaluation persistence
// ═══════════════════════════════════════════════════════════════════════════════

describe('EvaluationOrchestrator — applyVerdictInPlace persistence (F-1)', () => {
    function createMockEngine(runbook: any) {
        const { EventEmitter } = require('events');
        const engine = new EventEmitter();
        engine.getRunbook = jest.fn().mockReturnValue(runbook);
        engine.getState = jest.fn().mockReturnValue('EXECUTING_WORKER');
        engine.transition = jest.fn();
        engine.persist = jest.fn().mockResolvedValue(undefined);
        engine.emitUIMessage = jest.fn();
        engine.emit = jest.fn();
        engine.getScheduler = jest.fn().mockReturnValue({ isAllDone: jest.fn().mockReturnValue(false) });
        engine.advanceSchedule = jest.fn();
        engine.getStateManager = jest.fn().mockReturnValue({ getSessionDir: jest.fn().mockReturnValue('/tmp') });
        engine.dispatchReadyPhases = jest.fn();
        engine.stopStallWatchdog = jest.fn();
        engine.addHealingTimer = jest.fn();
        engine.removeHealingTimer = jest.fn();
        return engine;
    }

    function createMockHealer() {
        return {
            clearAttempts: jest.fn(),
            recordFailure: jest.fn(),
            canRetry: jest.fn().mockReturnValue(false),
            canRetryWithPhase: jest.fn().mockReturnValue(false),
            getAttemptCount: jest.fn().mockReturnValue(0),
            getRetryDelay: jest.fn().mockReturnValue(1000),
            buildHealingPrompt: jest.fn().mockReturnValue('heal'),
            buildHealingPromptWithContext: jest.fn().mockReturnValue('heal context'),
        };
    }

    it('persists evaluation result to DB when applyVerdictInPlace handles PASS', async () => {
        const phase: Phase = {
            id: asPhaseId(1), status: 'running', prompt: 'build feature',
            context_files: [], success_criteria: 'exit_code:0',
            mcpPhaseId: 'phase-001-test',
        };
        const runbook = { phases: [phase], status: 'running' };
        const mockEngine = createMockEngine(runbook);
        const mockHealer = createMockHealer();
        const mockUpsertEvaluation = jest.fn();
        const mockDb = {
            verdicts: { upsertEvaluation: mockUpsertEvaluation },
        };

        const orchestrator = new EvaluationOrchestrator(
            mockEngine as any,
            mockHealer as any,
            null,
        );
        orchestrator.setArtifactDB(mockDb as any, 'task-001');

        // isLastWorker = false → drives applyVerdictInPlace
        await orchestrator.handleWorkerExited(1, 0, 'stdout', '', false);

        expect(mockUpsertEvaluation).toHaveBeenCalledWith(
            'task-001',
            'phase-001-test',
            expect.objectContaining({
                passed: true,
                reason: expect.any(String),
            }),
        );
    });

    it('persists evaluation result to DB when applyVerdictInPlace handles FAIL', async () => {
        const phase: Phase = {
            id: asPhaseId(1), status: 'running', prompt: 'build feature',
            context_files: [], success_criteria: 'exit_code:0',
            mcpPhaseId: 'phase-001-test',
        };
        const runbook = { phases: [phase], status: 'running' };
        const mockEngine = createMockEngine(runbook);
        const mockHealer = createMockHealer();
        const mockUpsertEvaluation = jest.fn();
        const mockDb = {
            verdicts: { upsertEvaluation: mockUpsertEvaluation },
        };

        const orchestrator = new EvaluationOrchestrator(
            mockEngine as any,
            mockHealer as any,
            null,
        );
        orchestrator.setArtifactDB(mockDb as any, 'task-001');

        // exitCode = 1 → FAIL with exit_code:0 criteria
        // isLastWorker = false → drives applyVerdictInPlace
        await orchestrator.handleWorkerExited(1, 1, '', 'some error', false);

        expect(mockUpsertEvaluation).toHaveBeenCalledWith(
            'task-001',
            'phase-001-test',
            expect.objectContaining({
                passed: false,
                reason: expect.any(String),
            }),
        );
    });
});
