// ─────────────────────────────────────────────────────────────────────────────
// src/evaluators/__tests__/CompilerEvaluator.test.ts — Evaluator unit tests (#61)
// ─────────────────────────────────────────────────────────────────────────────

import {
    ExitCodeEvaluator,
    RegexOutputEvaluator,
    ToolchainEvaluator,
    TestSuiteEvaluator,
} from '../CompilerEvaluator.js';

describe('ExitCodeEvaluator', () => {
    const evaluator = new ExitCodeEvaluator();

    it('returns true for matching exit code', async () => {
        expect(await evaluator.evaluate('exit_code:0', 0, '', '')).toBe(true);
        expect(await evaluator.evaluate('exit_code:1', 1, '', '')).toBe(true);
    });

    it('returns false for non-matching exit code', async () => {
        expect(await evaluator.evaluate('exit_code:0', 1, '', '')).toBe(false);
    });

    it('defaults to exit code 0 when criteria does not match format', async () => {
        expect(await evaluator.evaluate('anything', 0, '', '')).toBe(true);
        expect(await evaluator.evaluate('anything', 1, '', '')).toBe(false);
    });
});

describe('RegexOutputEvaluator', () => {
    const evaluator = new RegexOutputEvaluator();

    it('passes when regex matches combined output', async () => {
        expect(await evaluator.evaluate('regex:BUILD OK', 0, 'BUILD OK', '')).toBe(true);
    });

    it('fails when regex_fail pattern is found', async () => {
        expect(await evaluator.evaluate('regex_fail:ERROR', 0, 'ERROR found', '')).toBe(false);
    });

    it('passes when regex_fail pattern is NOT found', async () => {
        expect(await evaluator.evaluate('regex_fail:ERROR', 0, 'all good', '')).toBe(true);
    });

    it('returns false for invalid regex pattern', async () => {
        expect(await evaluator.evaluate('regex:[invalid(', 0, '', '')).toBe(false);
    });

    it('returns false for invalid regex_fail pattern', async () => {
        expect(await evaluator.evaluate('regex_fail:[invalid(', 0, '', '')).toBe(false);
    });
});

describe('ToolchainEvaluator', () => {
    const evaluator = new ToolchainEvaluator('/tmp');

    it('blocks non-whitelisted binaries', async () => {
        expect(await evaluator.evaluate('toolchain:rm -rf /', 0, '', '')).toBe(false);
    });

    it('rejects empty command', async () => {
        expect(await evaluator.evaluate('toolchain:', 0, '', '')).toBe(false);
    });

    it('rejects non-toolchain criteria', async () => {
        expect(await evaluator.evaluate('exit_code:0', 0, '', '')).toBe(false);
    });
});

describe('TestSuiteEvaluator', () => {
    const evaluator = new TestSuiteEvaluator('/tmp');

    it('blocks non-whitelisted binaries', async () => {
        expect(await evaluator.evaluate('test_suite:evilbin --attack', 0, '', '')).toBe(false);
    });

    it('rejects empty command', async () => {
        expect(await evaluator.evaluate('test_suite:', 0, '', '')).toBe(false);
    });

    it('rejects non-test_suite criteria', async () => {
        expect(await evaluator.evaluate('exit_code:0', 0, '', '')).toBe(false);
    });
});
