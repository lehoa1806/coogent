jest.mock('../templates.js', () => ({
    ORCHESTRATION_SKELETON: `# Orchestration Skeleton
## System Role
You are a planning agent.
## DAG Rules
Each phase must form a valid DAG.
## Worker Contract
Workers receive isolated phase contracts.`,

    FEATURE_IMPLEMENTATION: `# Feature Implementation
## Planning Approach
Break the feature into incremental phases.
## Verification
Ensure tests pass after each phase.`,

    BUG_FIX: `# Bug Fix
## Diagnosis
Identify the root cause before proposing a fix.
## Verification
Write a regression test.`,

    REFACTOR: '# Refactor\nRefactor template content.',
    MIGRATION: '# Migration\nMigration template content.',
    DOCUMENTATION_SYNTHESIS: '# Documentation Synthesis\nDocumentation template content.',
    REPO_ANALYSIS: '# Repo Analysis\nRepo analysis template content.',
    REVIEW_ONLY: '# Review Only\nReview template content.',
}));

import { TemplateLoader } from '../TemplateLoader.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  TemplateLoader Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('TemplateLoader', () => {
    let loader: TemplateLoader;

    beforeEach(() => {
        loader = new TemplateLoader();
    });

    // ─────────────────────────────────────────────────────────────────────────
    //  Orchestration skeleton
    // ─────────────────────────────────────────────────────────────────────────

    it('should load orchestration skeleton successfully', () => {
        const skeleton = loader.loadSkeleton();

        expect(skeleton).toContain('# Orchestration Skeleton');
        expect(skeleton).toContain('You are a planning agent.');
    });

    // ─────────────────────────────────────────────────────────────────────────
    //  Task-family template loading
    // ─────────────────────────────────────────────────────────────────────────

    it('should load feature-implementation template', () => {
        const template = loader.loadTemplate('feature_implementation');

        expect(template).toContain('# Feature Implementation');
    });

    it('should load bug-fix template', () => {
        const template = loader.loadTemplate('bug_fix');

        expect(template).toContain('# Bug Fix');
    });

    it('should load all defined task families', () => {
        const families = [
            'feature_implementation',
            'bug_fix',
            'refactor',
            'migration',
            'documentation_synthesis',
            'repo_analysis',
            'review_only',
        ] as const;

        for (const family of families) {
            const template = loader.loadTemplate(family);
            expect(template).toBeTruthy();
            expect(template.length).toBeGreaterThan(0);
        }
    });

    // ─────────────────────────────────────────────────────────────────────────
    //  Section header content verification
    // ─────────────────────────────────────────────────────────────────────────

    it('should contain expected section headers in loaded templates', () => {
        const skeleton = loader.loadSkeleton();
        const featureTemplate = loader.loadTemplate('feature_implementation');

        // Skeleton should have structural section headers
        expect(skeleton).toContain('## System Role');
        expect(skeleton).toContain('## DAG Rules');
        expect(skeleton).toContain('## Worker Contract');

        // Feature template should have planning-oriented headers
        expect(featureTemplate).toContain('## Planning Approach');
        expect(featureTemplate).toContain('## Verification');
    });
});
