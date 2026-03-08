import { TaskClassifier } from '../TaskClassifier.js';
import type { NormalizedTaskSpec } from '../types.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Test Helpers
// ═══════════════════════════════════════════════════════════════════════════════

function makeTaskSpec(overrides?: Partial<NormalizedTaskSpec>): NormalizedTaskSpec {
    return {
        objective: '',
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
//  TaskClassifier Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('TaskClassifier', () => {
    let classifier: TaskClassifier;

    beforeEach(() => {
        classifier = new TaskClassifier();
    });

    it('should classify "fix the login bug" as bug_fix', () => {
        const spec = makeTaskSpec({ objective: 'Fix the login bug' });
        expect(classifier.classify(spec)).toBe('bug_fix');
    });

    it('should classify "refactor the auth module" as refactor', () => {
        const spec = makeTaskSpec({ objective: 'Refactor the auth module' });
        expect(classifier.classify(spec)).toBe('refactor');
    });

    it('should classify "migrate from Express to Fastify" as migration', () => {
        const spec = makeTaskSpec({ objective: 'Migrate from Express to Fastify' });
        expect(classifier.classify(spec)).toBe('migration');
    });

    it('should classify "add user profile feature" as feature_implementation', () => {
        const spec = makeTaskSpec({ objective: 'Add user profile feature' });
        expect(classifier.classify(spec)).toBe('feature_implementation');
    });

    it('should classify "document the API" as documentation_synthesis', () => {
        const spec = makeTaskSpec({ objective: 'Document the API' });
        expect(classifier.classify(spec)).toBe('documentation_synthesis');
    });

    it('should classify "analyze codebase architecture" as repo_analysis', () => {
        const spec = makeTaskSpec({ objective: 'Analyze codebase architecture' });
        expect(classifier.classify(spec)).toBe('repo_analysis');
    });

    it('should classify "review the PR changes" as review_only', () => {
        const spec = makeTaskSpec({ objective: 'Review the PR changes' });
        expect(classifier.classify(spec)).toBe('review_only');
    });

    it('should default to feature_implementation for ambiguous input', () => {
        const spec = makeTaskSpec({ objective: 'Do something with the project' });
        expect(classifier.classify(spec)).toBe('feature_implementation');
    });

    it('should use scoring to resolve multi-keyword prompts', () => {
        // "fix" → bug_fix scores 1; "broken" → bug_fix  scores 2 total;
        // "refactor" → refactor scores 1 only.
        // bug_fix should win by score.
        const spec = makeTaskSpec({
            objective: 'Fix the broken login and refactor the code',
        });
        expect(classifier.classify(spec)).toBe('bug_fix');
    });

    it('should use tie-break priority when scores are equal', () => {
        // "bug" → bug_fix(1), "restructure" → refactor(1)
        // bug_fix has higher priority so it should win
        const spec = makeTaskSpec({
            objective: 'There is a bug, need to restructure',
        });
        expect(classifier.classify(spec)).toBe('bug_fix');
    });

    it('should consider constraints and successCriteria in classification', () => {
        const spec = makeTaskSpec({
            objective: 'Update the module',
            constraints: ['must migrate all legacy code'],
            successCriteria: ['successful migration verified'],
        });
        expect(classifier.classify(spec)).toBe('migration');
    });
});
