import { RequirementNormalizer } from '../RequirementNormalizer.js';
import type { RepoFingerprint } from '../types.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Test Helpers
// ═══════════════════════════════════════════════════════════════════════════════

function makeFingerprint(overrides?: Partial<RepoFingerprint>): RepoFingerprint {
    return {
        workspaceType: 'single',
        workspaceFolders: ['.'],
        primaryLanguages: ['typescript'],
        keyFrameworks: ['express'],
        packageManager: 'npm',
        testStack: ['jest'],
        lintStack: ['eslint'],
        typecheckStack: ['tsc'],
        buildStack: ['esbuild'],
        architectureHints: [],
        highRiskSurfaces: [],
        ...overrides,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  RequirementNormalizer Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('RequirementNormalizer', () => {
    let normalizer: RequirementNormalizer;

    beforeEach(() => {
        normalizer = new RequirementNormalizer();
    });

    // ─────────────────────────────────────────────────────────────────────────
    //  Basic normalization
    // ─────────────────────────────────────────────────────────────────────────

    it('should normalize a simple feature request (extracts objective, defaults to feature_implementation)', () => {
        const spec = normalizer.normalize('Add user authentication with JWT');

        expect(spec.objective).toBe('Add user authentication with JWT');
        expect(spec.taskType).toBe('feature_implementation');
        expect(spec.artifactType).toBe('code_change');
        expect(spec.autonomy.allowReview).toBe(true);
        expect(spec.autonomy.allowSquad).toBe(false);
        expect(spec.autonomy.allowReplan).toBe(true);
    });

    // ─────────────────────────────────────────────────────────────────────────
    //  Artifact type detection
    // ─────────────────────────────────────────────────────────────────────────

    it('should detect bug-fix artifact type from keywords like "fix the broken login"', () => {
        const spec = normalizer.normalize('Fix the broken login page');

        expect(spec.artifactType).toBe('code_change');
        expect(spec.taskType).toBe('bug_fix');
    });

    // ─────────────────────────────────────────────────────────────────────────
    //  File path extraction
    // ─────────────────────────────────────────────────────────────────────────

    it('should extract file paths from prompt text (e.g., "modify src/auth/login.ts")', () => {
        const spec = normalizer.normalize('Modify src/auth/login.ts and update src/utils/helpers.ts');

        expect(spec.scope.entryPoints).toContain('src/auth/login.ts');
        expect(spec.scope.entryPoints).toContain('src/utils/helpers.ts');
        expect(spec.scope.allowedFolders).toContain('src/auth');
        expect(spec.scope.allowedFolders).toContain('src/utils');
    });

    // ─────────────────────────────────────────────────────────────────────────
    //  Constraint extraction
    // ─────────────────────────────────────────────────────────────────────────

    it('should extract constraints from "must preserve backward compatibility"', () => {
        const spec = normalizer.normalize('Refactor the auth module. Must preserve backward compatibility.');

        expect(spec.constraints.length).toBeGreaterThan(0);
        expect(spec.constraints.some(c => c.toLowerCase().includes('must preserve backward compatibility'))).toBe(true);
    });

    // ─────────────────────────────────────────────────────────────────────────
    //  Success criteria extraction
    // ─────────────────────────────────────────────────────────────────────────

    it('should extract success criteria from "tests should pass"', () => {
        const spec = normalizer.normalize('Add the new feature. Tests pass after the change.');

        expect(spec.successCriteria.length).toBeGreaterThan(0);
        expect(spec.successCriteria.some(c => c.toLowerCase().includes('tests pass'))).toBe(true);
    });

    // ─────────────────────────────────────────────────────────────────────────
    //  Empty prompt handling
    // ─────────────────────────────────────────────────────────────────────────

    it('should handle empty prompt gracefully', () => {
        const spec = normalizer.normalize('');

        expect(spec.objective).toBe('');
        expect(spec.taskType).toBe('feature_implementation');
        expect(spec.artifactType).toBe('code_change');
        expect(spec.scope.entryPoints).toEqual([]);
        expect(spec.constraints).toEqual([]);
        expect(spec.successCriteria).toEqual([]);
        expect(spec.riskFactors).toEqual([]);
    });

    // ─────────────────────────────────────────────────────────────────────────
    //  Risk factor detection from fingerprint
    // ─────────────────────────────────────────────────────────────────────────

    it('should detect risk factors when fingerprint has high-risk surfaces mentioned in prompt', () => {
        const fingerprint = makeFingerprint({
            highRiskSurfaces: ['database schema', 'public API routes'],
        });

        const spec = normalizer.normalize(
            'Update the database schema and add new public API routes',
            fingerprint,
        );

        expect(spec.riskFactors).toContain('database schema');
        expect(spec.riskFactors).toContain('public API routes');
    });

    it('should not include risk factors when fingerprint surfaces are not mentioned in prompt', () => {
        const fingerprint = makeFingerprint({
            highRiskSurfaces: ['database schema'],
        });

        const spec = normalizer.normalize(
            'Add a new button to the homepage',
            fingerprint,
        );

        expect(spec.riskFactors).toEqual([]);
    });
});
