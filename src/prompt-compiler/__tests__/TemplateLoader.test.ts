jest.mock('fs', () => ({
    readFileSync: jest.fn(),
    existsSync: jest.fn(),
}));

import { TemplateLoader } from '../TemplateLoader.js';
import * as fs from 'fs';

// ═══════════════════════════════════════════════════════════════════════════════
//  Mock Content
// ═══════════════════════════════════════════════════════════════════════════════

const MOCK_SKELETON = `# Orchestration Skeleton
## System Role
You are a planning agent.
## DAG Rules
Each phase must form a valid DAG.
## Worker Contract
Workers receive isolated phase contracts.`;

const MOCK_FEATURE_TEMPLATE = `# Feature Implementation
## Planning Approach
Break the feature into incremental phases.
## Verification
Ensure tests pass after each phase.`;

const MOCK_BUG_FIX_TEMPLATE = `# Bug Fix
## Diagnosis
Identify the root cause before proposing a fix.
## Verification
Write a regression test.`;

// ═══════════════════════════════════════════════════════════════════════════════
//  Test Helpers
// ═══════════════════════════════════════════════════════════════════════════════

function setupFsMocks(options?: { missingBugFix?: boolean }): void {
    (fs.existsSync as jest.Mock).mockImplementation((filePath: string) => {
        if (options?.missingBugFix && filePath.includes('bug-fix.md')) {
            return false;
        }
        return true;
    });

    (fs.readFileSync as jest.Mock).mockImplementation((filePath: string) => {
        if (filePath.includes('orchestration-skeleton.md')) return MOCK_SKELETON;
        if (filePath.includes('bug-fix.md')) return MOCK_BUG_FIX_TEMPLATE;
        // All other templates return the feature template
        return MOCK_FEATURE_TEMPLATE;
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  TemplateLoader Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('TemplateLoader', () => {
    let loader: TemplateLoader;

    beforeEach(() => {
        jest.clearAllMocks();
        setupFsMocks();
        loader = new TemplateLoader('/tmp/test-templates');
    });

    // ─────────────────────────────────────────────────────────────────────────
    //  Orchestration skeleton
    // ─────────────────────────────────────────────────────────────────────────

    it('should load orchestration skeleton successfully', () => {
        const skeleton = loader.loadSkeleton();

        expect(skeleton).toBe(MOCK_SKELETON);
        expect(fs.readFileSync).toHaveBeenCalledWith(
            expect.stringContaining('orchestration-skeleton.md'),
            'utf-8',
        );
    });

    // ─────────────────────────────────────────────────────────────────────────
    //  Task-family template loading
    // ─────────────────────────────────────────────────────────────────────────

    it('should load feature-implementation template', () => {
        const template = loader.loadTemplate('feature_implementation');

        expect(template).toBe(MOCK_FEATURE_TEMPLATE);
    });

    it('should load bug-fix template', () => {
        const template = loader.loadTemplate('bug_fix');

        expect(template).toBe(MOCK_BUG_FIX_TEMPLATE);
    });

    // ─────────────────────────────────────────────────────────────────────────
    //  Fallback behavior
    // ─────────────────────────────────────────────────────────────────────────

    it('should fall back to feature-implementation when template file is missing', () => {
        setupFsMocks({ missingBugFix: true });

        const template = loader.loadTemplate('bug_fix');

        // Should fall back to feature-implementation content
        expect(template).toBe(MOCK_FEATURE_TEMPLATE);
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
