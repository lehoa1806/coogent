import { PolicyEngine } from '../PolicyEngine.js';
import type { RepoFingerprint, NormalizedTaskSpec } from '../types.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Test Helpers
// ═══════════════════════════════════════════════════════════════════════════════

function makeFingerprint(overrides?: Partial<RepoFingerprint>): RepoFingerprint {
    return {
        workspaceType: 'single',
        workspaceFolders: ['.'],
        primaryLanguages: ['typescript'],
        keyFrameworks: [],
        packageManager: 'npm',
        testStack: [],
        lintStack: [],
        typecheckStack: [],
        buildStack: [],
        architectureHints: [],
        highRiskSurfaces: [],
        ...overrides,
    };
}

function makeTaskSpec(overrides?: Partial<NormalizedTaskSpec>): NormalizedTaskSpec {
    return {
        objective: 'Do something',
        artifactType: 'code_change',
        taskType: 'feature_implementation',
        scope: { entryPoints: [], allowedFolders: [], forbiddenFolders: [] },
        constraints: [],
        successCriteria: [],
        knownInputs: [],
        missingInformation: [],
        riskFactors: [],
        decompositionHints: [],
        autonomy: { allowReview: true, allowSquad: false, allowReplan: true },
        ...overrides,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PolicyEngine Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('PolicyEngine', () => {
    let engine: PolicyEngine;

    beforeEach(() => {
        engine = new PolicyEngine();
    });

    // ─────────────────────────────────────────────────────────────────────────
    //  multi-root-workspace policy
    // ─────────────────────────────────────────────────────────────────────────

    it('should apply multi-root-workspace policy when workspaceType is multi-root', () => {
        const fp = makeFingerprint({ workspaceType: 'multi-root' });
        const spec = makeTaskSpec();

        const result = engine.evaluate(fp, spec);

        expect(result.appliedPolicies).toContain('multi-root-workspace');
        expect(result.promptBlocks.some(b => b.includes('multi-root-workspace'))).toBe(true);
    });

    it('should not apply multi-root policy for single workspaces', () => {
        const fp = makeFingerprint({ workspaceType: 'single' });
        const spec = makeTaskSpec();

        const result = engine.evaluate(fp, spec);

        expect(result.appliedPolicies).not.toContain('multi-root-workspace');
    });

    // ─────────────────────────────────────────────────────────────────────────
    //  api-compatibility-guard policy
    // ─────────────────────────────────────────────────────────────────────────

    it('should apply api-compatibility-guard when constraints mention API compatibility', () => {
        const fp = makeFingerprint();
        const spec = makeTaskSpec({
            constraints: ['Must maintain backward compatible API'],
        });

        const result = engine.evaluate(fp, spec);

        expect(result.appliedPolicies).toContain('api-compatibility-guard');
    });

    it('should not apply api-compatibility-guard when no API constraints', () => {
        const fp = makeFingerprint();
        const spec = makeTaskSpec({
            constraints: ['Must run fast'],
        });

        const result = engine.evaluate(fp, spec);

        expect(result.appliedPolicies).not.toContain('api-compatibility-guard');
    });

    // ─────────────────────────────────────────────────────────────────────────
    //  minimal-file-scope policy (universal)
    // ─────────────────────────────────────────────────────────────────────────

    it('should always apply minimal-file-scope policy', () => {
        const fp = makeFingerprint();
        const spec = makeTaskSpec();

        const result = engine.evaluate(fp, spec);

        expect(result.appliedPolicies).toContain('minimal-file-scope');
        expect(result.promptBlocks.some(b => b.includes('minimal-file-scope'))).toBe(true);
    });

    // ─────────────────────────────────────────────────────────────────────────
    //  evaluator-preference policy
    // ─────────────────────────────────────────────────────────────────────────

    it('should apply evaluator-preference when testStack is non-empty', () => {
        const fp = makeFingerprint({ testStack: ['jest'] });
        const spec = makeTaskSpec();

        const result = engine.evaluate(fp, spec);

        expect(result.appliedPolicies).toContain('evaluator-preference');
        expect(result.promptBlocks.some(b => b.includes('jest'))).toBe(true);
    });

    it('should not apply evaluator-preference when testStack is empty', () => {
        const fp = makeFingerprint({ testStack: [] });
        const spec = makeTaskSpec();

        const result = engine.evaluate(fp, spec);

        expect(result.appliedPolicies).not.toContain('evaluator-preference');
    });

    // ─────────────────────────────────────────────────────────────────────────
    //  review-for-risky-surfaces policy
    // ─────────────────────────────────────────────────────────────────────────

    it('should apply review-for-risky-surfaces when risk surfaces match scope', () => {
        const fp = makeFingerprint({
            highRiskSurfaces: ['src/auth/login.ts'],
        });
        const spec = makeTaskSpec({
            scope: {
                entryPoints: ['src/auth/login.ts'],
                allowedFolders: ['src/auth'],
                forbiddenFolders: [],
            },
        });

        const result = engine.evaluate(fp, spec);

        expect(result.appliedPolicies).toContain('review-for-risky-surfaces');
    });

    it('should not apply review-for-risky-surfaces when surfaces do not match', () => {
        const fp = makeFingerprint({
            highRiskSurfaces: ['src/auth/login.ts'],
        });
        const spec = makeTaskSpec({
            scope: {
                entryPoints: ['src/utils/helpers.ts'],
                allowedFolders: ['src/utils'],
                forbiddenFolders: [],
            },
        });

        const result = engine.evaluate(fp, spec);

        expect(result.appliedPolicies).not.toContain('review-for-risky-surfaces');
    });

    // ─────────────────────────────────────────────────────────────────────────
    //  no-squad-rule policy
    // ─────────────────────────────────────────────────────────────────────────

    it('should apply no-squad-rule when allowSquad is false', () => {
        const fp = makeFingerprint();
        const spec = makeTaskSpec({
            autonomy: { allowReview: true, allowSquad: false, allowReplan: true },
        });

        const result = engine.evaluate(fp, spec);

        expect(result.appliedPolicies).toContain('no-squad-rule');
    });

    it('should not apply no-squad-rule when allowSquad is true', () => {
        const fp = makeFingerprint();
        const spec = makeTaskSpec({
            autonomy: { allowReview: true, allowSquad: true, allowReplan: true },
        });

        const result = engine.evaluate(fp, spec);

        expect(result.appliedPolicies).not.toContain('no-squad-rule');
    });

    // ─────────────────────────────────────────────────────────────────────────
    //  Result structure
    // ─────────────────────────────────────────────────────────────────────────

    it('should return correct applied policy IDs in result', () => {
        const fp = makeFingerprint({ testStack: ['jest'] });
        const spec = makeTaskSpec();

        const result = engine.evaluate(fp, spec);

        // At minimum: minimal-file-scope (always), evaluator-preference (testStack non-empty),
        // no-squad-rule (allowSquad defaults to false)
        expect(result.appliedPolicies).toContain('minimal-file-scope');
        expect(result.appliedPolicies).toContain('evaluator-preference');
        expect(result.appliedPolicies).toContain('no-squad-rule');
        expect(result.appliedPolicies.length).toBe(result.promptBlocks.length);
    });
});
