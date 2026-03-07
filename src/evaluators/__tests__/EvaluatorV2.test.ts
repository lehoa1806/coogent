// ─────────────────────────────────────────────────────────────────────────────
// src/evaluators/__tests__/EvaluatorV2.test.ts — V2 evaluator unit tests
// ─────────────────────────────────────────────────────────────────────────────

import { asPhaseId } from '../../types/index.js';
import type { Phase } from '../../types/index.js';
import { ExitCodeEvaluatorV2 } from '../ExitCodeEvaluator.js';
import { RegexEvaluator } from '../RegexEvaluator.js';
import { ToolchainEvaluatorV2 } from '../ToolchainEvaluator.js';
import { TestSuiteEvaluatorV2 } from '../TestSuiteEvaluator.js';
import { EvaluatorRegistryV2 } from '../EvaluatorRegistry.js';

function makePhase(overrides: Partial<Phase> = {}): Phase {
    return {
        id: asPhaseId(1),
        status: 'pending',
        prompt: 'test prompt',
        context_files: [],
        success_criteria: 'exit_code:0',
        ...overrides,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ExitCodeEvaluatorV2
// ═══════════════════════════════════════════════════════════════════════════════

describe('ExitCodeEvaluatorV2', () => {
    const evaluator = new ExitCodeEvaluatorV2();

    it('returns passed: true with reason for matching exit code', async () => {
        const result = await evaluator.evaluate(makePhase(), 0, '', '');
        expect(result.passed).toBe(true);
        expect(result.reason).toContain('0');
    });

    it('returns passed: false with retryPrompt for non-matching exit code', async () => {
        const result = await evaluator.evaluate(
            makePhase(),
            1,
            '',
            'some error output'
        );
        expect(result.passed).toBe(false);
        expect(result.reason).toContain('1');
        expect(result.retryPrompt).toContain('some error output');
    });

    it('defaults to exit_code:0 when criteria format is unrecognized', async () => {
        const phase = makePhase({ success_criteria: 'anything' });
        const pass = await evaluator.evaluate(phase, 0, '', '');
        expect(pass.passed).toBe(true);

        const fail = await evaluator.evaluate(phase, 1, '', 'err');
        expect(fail.passed).toBe(false);
    });

    it('retryPrompt is undefined when stderr is empty', async () => {
        const result = await evaluator.evaluate(makePhase(), 1, '', '');
        expect(result.passed).toBe(false);
        expect(result.retryPrompt).toBeUndefined();
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  RegexEvaluator
// ═══════════════════════════════════════════════════════════════════════════════

describe('RegexEvaluator', () => {
    const evaluator = new RegexEvaluator();

    it('regex: passes when pattern found, includes reason', async () => {
        const phase = makePhase({ success_criteria: 'regex:BUILD OK' });
        const result = await evaluator.evaluate(phase, 0, 'BUILD OK', '');
        expect(result.passed).toBe(true);
        expect(result.reason).toContain('BUILD OK');
    });

    it('regex: fails when pattern NOT found, includes retryPrompt with output', async () => {
        const phase = makePhase({ success_criteria: 'regex:BUILD OK' });
        const result = await evaluator.evaluate(phase, 0, 'compilation error', '');
        expect(result.passed).toBe(false);
        expect(result.retryPrompt).toBeDefined();
        expect(result.retryPrompt).toContain('compilation error');
    });

    it('regex_fail: fails when pattern found, includes match in retryPrompt', async () => {
        const phase = makePhase({ success_criteria: 'regex_fail:ERROR' });
        const result = await evaluator.evaluate(phase, 0, 'ERROR found', '');
        expect(result.passed).toBe(false);
        expect(result.retryPrompt).toBeDefined();
        expect(result.retryPrompt).toContain('ERROR');
    });

    it('regex_fail: passes when pattern NOT found', async () => {
        const phase = makePhase({ success_criteria: 'regex_fail:ERROR' });
        const result = await evaluator.evaluate(phase, 0, 'all good', '');
        expect(result.passed).toBe(true);
    });

    it('invalid regex pattern returns passed: false', async () => {
        const phase = makePhase({ success_criteria: 'regex:[invalid(' });
        const result = await evaluator.evaluate(phase, 0, '', '');
        expect(result.passed).toBe(false);
        expect(result.reason).toContain('Invalid regex');
    });

    it('falls back to exit code when no regex prefix', async () => {
        const phase = makePhase({ success_criteria: 'some_unknown_criteria' });
        const pass = await evaluator.evaluate(phase, 0, '', '');
        expect(pass.passed).toBe(true);

        const fail = await evaluator.evaluate(phase, 1, '', 'error');
        expect(fail.passed).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  ToolchainEvaluatorV2
// ═══════════════════════════════════════════════════════════════════════════════

describe('ToolchainEvaluatorV2', () => {
    const evaluator = new ToolchainEvaluatorV2('/tmp');

    it('blocks non-whitelisted binaries with reason', async () => {
        const phase = makePhase({ success_criteria: 'toolchain:rm -rf /' });
        const result = await evaluator.evaluate(phase, 0, '', '');
        expect(result.passed).toBe(false);
        expect(result.reason).toContain('rm');
        expect(result.reason).toContain('whitelist');
    });

    it('rejects empty command', async () => {
        const phase = makePhase({ success_criteria: 'toolchain:' });
        const result = await evaluator.evaluate(phase, 0, '', '');
        expect(result.passed).toBe(false);
        expect(result.reason).toContain('Empty');
    });

    it('rejects non-toolchain criteria', async () => {
        const phase = makePhase({ success_criteria: 'exit_code:0' });
        const result = await evaluator.evaluate(phase, 0, '', '');
        expect(result.passed).toBe(false);
        expect(result.reason).toContain('toolchain:');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  TestSuiteEvaluatorV2
// ═══════════════════════════════════════════════════════════════════════════════

describe('TestSuiteEvaluatorV2', () => {
    const evaluator = new TestSuiteEvaluatorV2('/tmp');

    it('blocks non-whitelisted binaries with reason', async () => {
        const phase = makePhase({ success_criteria: 'test_suite:evilbin --attack' });
        const result = await evaluator.evaluate(phase, 0, '', '');
        expect(result.passed).toBe(false);
        expect(result.reason).toContain('evilbin');
        expect(result.reason).toContain('whitelist');
    });

    it('rejects empty command', async () => {
        const phase = makePhase({ success_criteria: 'test_suite:' });
        const result = await evaluator.evaluate(phase, 0, '', '');
        expect(result.passed).toBe(false);
        expect(result.reason).toContain('Empty');
    });

    it('rejects non-test_suite criteria', async () => {
        const phase = makePhase({ success_criteria: 'exit_code:0' });
        const result = await evaluator.evaluate(phase, 0, '', '');
        expect(result.passed).toBe(false);
        expect(result.reason).toContain('test_suite:');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  EvaluatorRegistryV2
// ═══════════════════════════════════════════════════════════════════════════════

describe('EvaluatorRegistryV2', () => {
    const registry = new EvaluatorRegistryV2('/tmp');

    it('getEvaluator("exit_code") returns ExitCodeEvaluatorV2', () => {
        const evaluator = registry.getEvaluator('exit_code');
        expect(evaluator).toBeInstanceOf(ExitCodeEvaluatorV2);
    });

    it('getEvaluator("regex") returns RegexEvaluator', () => {
        const evaluator = registry.getEvaluator('regex');
        expect(evaluator).toBeInstanceOf(RegexEvaluator);
    });

    it('getEvaluator("toolchain") returns ToolchainEvaluatorV2', () => {
        const evaluator = registry.getEvaluator('toolchain');
        expect(evaluator).toBeInstanceOf(ToolchainEvaluatorV2);
    });

    it('getEvaluator("test_suite") returns TestSuiteEvaluatorV2', () => {
        const evaluator = registry.getEvaluator('test_suite');
        expect(evaluator).toBeInstanceOf(TestSuiteEvaluatorV2);
    });

    it('getEvaluator(undefined) defaults to ExitCodeEvaluatorV2', () => {
        const evaluator = registry.getEvaluator(undefined);
        expect(evaluator).toBeInstanceOf(ExitCodeEvaluatorV2);
    });

    it('getEvaluator("unknown" as any) defaults to ExitCodeEvaluatorV2', () => {
        const evaluator = registry.getEvaluator('unknown' as any);
        expect(evaluator).toBeInstanceOf(ExitCodeEvaluatorV2);
    });
});
