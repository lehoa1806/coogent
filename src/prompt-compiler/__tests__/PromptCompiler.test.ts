jest.mock('vscode', () => ({
    commands: { registerCommand: jest.fn() },
    window: { showWarningMessage: jest.fn(), showErrorMessage: jest.fn(), showInformationMessage: jest.fn() },
    workspace: { workspaceFolders: [], fs: { readFile: jest.fn(), stat: jest.fn(), readDirectory: jest.fn() } },
    Uri: { file: jest.fn((p: string) => ({ fsPath: p })), joinPath: jest.fn((_base: any, rel: string) => ({ fsPath: `/mock/${rel}` })) },
}), { virtual: true });

jest.mock('../templates.js', () => ({
    ORCHESTRATION_SKELETON: '# Orchestration Skeleton\nYou are a planning agent.',
    FEATURE_IMPLEMENTATION: '# Feature Implementation\nPlan features step by step.',
    BUG_FIX: '# Bug Fix\nDiagnose and fix the bug.',
    REFACTOR: '# Refactor\nRefactor template.',
    MIGRATION: '# Migration\nMigration template.',
    DOCUMENTATION_SYNTHESIS: '# Documentation\nDocs template.',
    REPO_ANALYSIS: '# Repo Analysis\nAnalysis template.',
    REVIEW_ONLY: '# Review Only\nReview template.',
}));

import { PlannerPromptCompiler } from '../PlannerPromptCompiler.js';
import type { RepoFingerprint } from '../types.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Mock Setup
// ═══════════════════════════════════════════════════════════════════════════════

const MOCK_SKELETON = '# Orchestration Skeleton\nYou are a planning agent.';
const MOCK_FEATURE_TEMPLATE = '# Feature Implementation\nPlan features step by step.';

const MOCK_FINGERPRINT: RepoFingerprint = {
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
};

/**
 * Inject a cached fingerprint to bypass the vscode-dependent RepoFingerprinter.
 */
function injectFingerprint(compiler: PlannerPromptCompiler, fp: RepoFingerprint): void {
    (compiler as any).cachedFingerprint = fp;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PlannerPromptCompiler Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('PlannerPromptCompiler', () => {
    let compiler: PlannerPromptCompiler;

    beforeEach(() => {
        jest.clearAllMocks();
        compiler = new PlannerPromptCompiler('/tmp/test-workspace');
        injectFingerprint(compiler, MOCK_FINGERPRINT);
    });

    // ─────────────────────────────────────────────────────────────────────────
    //  Basic compilation
    // ─────────────────────────────────────────────────────────────────────────

    it('should compile a prompt and return CompiledPrompt with text and manifest', async () => {
        const result = await compiler.compile('Add user authentication');

        expect(result).toHaveProperty('text');
        expect(result).toHaveProperty('manifest');
        expect(typeof result.text).toBe('string');
        expect(result.text.length).toBeGreaterThan(0);
    });

    // ─────────────────────────────────────────────────────────────────────────
    //  Prompt content
    // ─────────────────────────────────────────────────────────────────────────

    it('should contain orchestration skeleton content in compiled prompt', async () => {
        const result = await compiler.compile('Add user authentication');

        expect(result.text).toContain(MOCK_SKELETON);
    });

    it('should contain task-family template content in compiled prompt', async () => {
        const result = await compiler.compile('Add a new profile feature');

        expect(result.text).toContain(MOCK_FEATURE_TEMPLATE);
    });

    it('should contain repo fingerprint section in compiled prompt', async () => {
        const result = await compiler.compile('Add something');

        expect(result.text).toContain('## Repo Profile');
        expect(result.text).toContain('workspace_type: single');
        expect(result.text).toContain('package_manager: npm');
    });

    it('should contain user request section in compiled prompt', async () => {
        const userPrompt = 'Build a REST API for user management';
        const result = await compiler.compile(userPrompt);

        expect(result.text).toContain('## User Request');
        expect(result.text).toContain(userPrompt);
    });

    // ─────────────────────────────────────────────────────────────────────────
    //  Manifest
    // ─────────────────────────────────────────────────────────────────────────

    it('should include correct taskFamily in manifest', async () => {
        const result = await compiler.compile('Fix the login crash');

        expect(result.manifest.taskFamily).toBe('bug_fix');
    });

    it('should include applied policy IDs in manifest', async () => {
        const result = await compiler.compile('Add a feature');

        // minimal-file-scope is always applied
        expect(result.manifest.appliedPolicies).toContain('minimal-file-scope');
        // no-squad-rule is applied because allowSquad defaults to false
        expect(result.manifest.appliedPolicies).toContain('no-squad-rule');
    });

    it('should include timestamp and promptVersion in manifest', async () => {
        const before = Date.now();
        const result = await compiler.compile('Do something');
        const after = Date.now();

        expect(result.manifest.timestamp).toBeGreaterThanOrEqual(before);
        expect(result.manifest.timestamp).toBeLessThanOrEqual(after);
        expect(result.manifest.promptVersion).toBe('1.0.0');
    });

    // ─────────────────────────────────────────────────────────────────────────
    //  Feedback section
    // ─────────────────────────────────────────────────────────────────────────

    it('should include feedback section when feedback is provided', async () => {
        const feedback = 'The previous plan missed error handling for edge cases.';
        const result = await compiler.compile('Improve error handling', { feedback });

        expect(result.text).toContain('## Feedback from Previous Run');
        expect(result.text).toContain(feedback);
    });

    it('should not include feedback section when no feedback is provided', async () => {
        const result = await compiler.compile('Add a feature');

        expect(result.text).not.toContain('## Feedback from Previous Run');
    });
});
