import { TaskClassifier } from '../TaskClassifier.js';
import type { NormalizedTaskSpec } from '../types.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Test Helpers
// ═══════════════════════════════════════════════════════════════════════════════

function makeTaskSpec(overrides?: Partial<NormalizedTaskSpec>): NormalizedTaskSpec {
    return {
        rawUserPrompt: '',
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
        const spec = makeTaskSpec({ rawUserPrompt: 'Fix the login bug' });
        expect(classifier.classify(spec)).toBe('bug_fix');
    });

    it('should classify "refactor the auth module" as refactor', () => {
        const spec = makeTaskSpec({ rawUserPrompt: 'Refactor the auth module' });
        expect(classifier.classify(spec)).toBe('refactor');
    });

    it('should classify "migrate from Express to Fastify" as migration', () => {
        const spec = makeTaskSpec({ rawUserPrompt: 'Migrate from Express to Fastify' });
        expect(classifier.classify(spec)).toBe('migration');
    });

    it('should classify "add user profile feature" as feature_implementation', () => {
        const spec = makeTaskSpec({ rawUserPrompt: 'Add user profile feature' });
        expect(classifier.classify(spec)).toBe('feature_implementation');
    });

    it('should classify "document the API" as documentation_synthesis', () => {
        const spec = makeTaskSpec({ rawUserPrompt: 'Document the API' });
        expect(classifier.classify(spec)).toBe('documentation_synthesis');
    });

    it('should classify "analyze codebase architecture" as repo_analysis', () => {
        const spec = makeTaskSpec({ rawUserPrompt: 'Analyze codebase architecture' });
        expect(classifier.classify(spec)).toBe('repo_analysis');
    });

    it('should classify a code review request as review_only', () => {
        const spec = makeTaskSpec({ rawUserPrompt: 'Just review my PR changes' });
        expect(classifier.classify(spec)).toBe('review_only');
    });

    it('should default to feature_implementation for ambiguous input', () => {
        const spec = makeTaskSpec({ rawUserPrompt: 'Do something with the project' });
        expect(classifier.classify(spec)).toBe('feature_implementation');
    });

    it('should use scoring to resolve multi-keyword prompts', () => {
        // "fix" → bug_fix scores 1; "broken" → bug_fix  scores 2 total;
        // "refactor" → refactor scores 1 only.
        // bug_fix should win by score.
        const spec = makeTaskSpec({
            rawUserPrompt: 'Fix the broken login and refactor the code',
        });
        expect(classifier.classify(spec)).toBe('bug_fix');
    });

    it('should use tie-break priority when scores are equal', () => {
        // "bug" → bug_fix(1), "restructure" → refactor(1)
        // bug_fix has higher priority so it should win
        const spec = makeTaskSpec({
            rawUserPrompt: 'There is a bug, need to restructure',
        });
        expect(classifier.classify(spec)).toBe('bug_fix');
    });

    it('should consider constraints and successCriteria in classification', () => {
        const spec = makeTaskSpec({
            rawUserPrompt: 'Update the module',
            constraints: ['must migrate all legacy code'],
            successCriteria: ['successful migration verified'],
        });
        expect(classifier.classify(spec)).toBe('migration');
    });

    // ─────────────────────────────────────────────────────────────────────────
    //  New family classification
    // ─────────────────────────────────────────────────────────────────────────

    it('should classify "write unit tests and add test cases" as testing', () => {
        const spec = makeTaskSpec({ rawUserPrompt: 'Write unit tests and add test cases for auth' });
        expect(classifier.classify(spec)).toBe('testing');
    });

    it('should classify CI/CD pipeline prompt as ci_cd', () => {
        const spec = makeTaskSpec({ rawUserPrompt: 'Set up a CI/CD pipeline with GitHub Actions' });
        expect(classifier.classify(spec)).toBe('ci_cd');
    });

    it('should classify performance optimization prompt as performance', () => {
        const spec = makeTaskSpec({ rawUserPrompt: 'Optimize the slow database queries and reduce latency' });
        expect(classifier.classify(spec)).toBe('performance');
    });

    it('should classify security audit prompt as security_audit', () => {
        const spec = makeTaskSpec({ rawUserPrompt: 'Audit for security vulnerabilities and CVE issues' });
        expect(classifier.classify(spec)).toBe('security_audit');
    });

    it('should classify dependency management prompt as dependency_management', () => {
        const spec = makeTaskSpec({ rawUserPrompt: 'Run npm audit and upgrade outdated packages' });
        expect(classifier.classify(spec)).toBe('dependency_management');
    });

    it('should classify DevOps infra prompt as devops_infra', () => {
        const spec = makeTaskSpec({ rawUserPrompt: 'Set up Docker and Kubernetes infrastructure on AWS' });
        expect(classifier.classify(spec)).toBe('devops_infra');
    });

    it('should use rawUserPrompt for classification when it contains stronger signals', () => {
        const spec = makeTaskSpec({
            rawUserPrompt: 'There is a critical security vulnerability exploit in the auth module',
        });
        expect(classifier.classify(spec)).toBe('security_audit');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Regression: Long review prompts must not misclassify as bug_fix
// ═══════════════════════════════════════════════════════════════════════════════

describe('TaskClassifier — regression: long review prompts', () => {
    let classifier: TaskClassifier;

    beforeEach(() => {
        classifier = new TaskClassifier();
    });

    it('should classify an exhaustive multi-phase review prompt as repo_analysis, not bug_fix', () => {
        const spec = makeTaskSpec({
            rawUserPrompt: `Act as a Principal AI Architect. Perform a comprehensive, evidence-based,
multi-phase review of the provided repository. Analyze README.md, ARCHITECTURE.md.
Evaluate error handling, failure isolation, regression protection.
Produce a drift register table with: Type | Intended Design | Observed Reality | Evidence | Impact | Severity | Recommended Fix.
Review validation, exception handling, retries, idempotency, backoff, timeouts.
Identify critical untested paths, flaky test risks, mocking overuse, weak assertions.
Perform a security audit covering auth, injection vectors, SSRF, XSS/CSRF.
Highlight performance bottlenecks. Assess reliability and recovery.`,
        });
        const family = classifier.classify(spec);
        expect(family).toBe('repo_analysis');
        expect(family).not.toBe('bug_fix');
    });

    it('should classify a security-focused review prompt as repo_analysis when it covers broad analysis', () => {
        const spec = makeTaskSpec({
            rawUserPrompt: `Review the repository for security vulnerabilities, architectural drift,
code quality issues, and testing gaps. Evaluate error paths, failure modes,
and fix recommendations. Produce a comprehensive report.`,
        });
        const family = classifier.classify(spec);
        expect(family).toBe('repo_analysis');
    });
});
