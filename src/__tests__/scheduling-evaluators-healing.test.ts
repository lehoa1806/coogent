// ─────────────────────────────────────────────────────────────────────────────
// scheduling-evaluators-healing.test.ts — Unit tests for DAG Scheduler,
// Phase Evaluators, SelfHealingController, TokenPruner, and FileResolver
// ─────────────────────────────────────────────────────────────────────────────

import { Scheduler } from '../engine/Scheduler';
import { SelfHealingController } from '../engine/SelfHealing';
import {
    ExitCodeEvaluator,
    RegexOutputEvaluator,
    EvaluatorRegistry,
} from '../evaluators/CompilerEvaluator';
import { TokenPruner, PrunableEntry } from '../context/TokenPruner';
import { ExplicitFileResolver } from '../context/FileResolver';
import type { Phase } from '../types/index';
import { asPhaseId } from '../types/index';
import { CharRatioEncoder } from '../context/ContextScoper';

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
            expect(order.indexOf(0)).toBeLessThan(order.indexOf(1));
            expect(order.indexOf(1)).toBeLessThan(order.indexOf(2));
        });
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Evaluator Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('ExitCodeEvaluator — exit code matching', () => {
    const evaluator = new ExitCodeEvaluator();

    it('passes when exit code matches criteria', async () => {
        expect(await evaluator.evaluate('exit_code:0', 0, '', '')).toBe(true);
    });

    it('fails when exit code does not match', async () => {
        expect(await evaluator.evaluate('exit_code:0', 1, '', '')).toBe(false);
    });

    it('defaults to exit code 0 for unknown criteria', async () => {
        expect(await evaluator.evaluate('unknown', 0, '', '')).toBe(true);
        expect(await evaluator.evaluate('unknown', 1, '', '')).toBe(false);
    });
});

describe('RegexOutputEvaluator — stdout/stderr pattern matching', () => {
    const evaluator = new RegexOutputEvaluator();

    it('passes when regex matches output', async () => {
        expect(
            await evaluator.evaluate('regex:Tests Passed', 0, 'All Tests Passed!', '')
        ).toBe(true);
    });

    it('fails when regex does not match', async () => {
        expect(
            await evaluator.evaluate('regex:Tests Passed', 0, 'Build failed', '')
        ).toBe(false);
    });

    it('fails when regex_fail pattern is found', async () => {
        expect(
            await evaluator.evaluate('regex_fail:ERROR', 0, '', 'ERROR: something broke')
        ).toBe(false);
    });
});

describe('EvaluatorRegistry — evaluator type resolution', () => {
    const registry = new EvaluatorRegistry('/tmp');

    it('returns exit_code evaluator by default', () => {
        expect(registry.get().type).toBe('exit_code');
    });

    it('returns the correct evaluator by type', () => {
        expect(registry.get('regex').type).toBe('regex');
        expect(registry.get('toolchain').type).toBe('toolchain');
        expect(registry.get('test_suite').type).toBe('test_suite');
    });

    it('falls back to exit_code for undefined type', () => {
        expect(registry.get(undefined).type).toBe('exit_code');
    });
});

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
