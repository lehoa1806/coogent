jest.mock('vscode', () => ({
    commands: { registerCommand: jest.fn() },
    window: { showWarningMessage: jest.fn(), showErrorMessage: jest.fn(), showInformationMessage: jest.fn() },
    workspace: { workspaceFolders: [], fs: { readFile: jest.fn(), stat: jest.fn(), readDirectory: jest.fn() } },
    Uri: { file: jest.fn((p: string) => ({ fsPath: p })), joinPath: jest.fn((_base: any, rel: string) => ({ fsPath: `/mock/${rel}` })) },
}), { virtual: true });

jest.mock('fs', () => ({
    readFileSync: jest.fn(),
    existsSync: jest.fn(),
}));

import { PromptCompiler } from '../PromptCompiler.js';
import type { RepoFingerprint } from '../types.js';
import * as fs from 'fs';

// ═══════════════════════════════════════════════════════════════════════════════
//  Mock Setup
// ═══════════════════════════════════════════════════════════════════════════════

const MOCK_SKELETON = '# Orchestration Skeleton\nYou are a planning agent.';
const MOCK_FEATURE_TEMPLATE = '# Feature Implementation\nPlan features step by step.';
const MOCK_BUG_TEMPLATE = '# Bug Fix\nDiagnose and fix the bug.';

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
 * Set up fs mocks so TemplateLoader returns our test content.
 * The TemplateLoader uses fs.readFileSync and fs.existsSync.
 */
function setupFsMocks(options?: { missingTemplate?: boolean }): void {
    (fs.existsSync as jest.Mock).mockImplementation((filePath: string) => {
        if (options?.missingTemplate && filePath.includes('bug-fix.md')) {
            return false;
        }
        return true;
    });

    (fs.readFileSync as jest.Mock).mockImplementation((filePath: string) => {
        if (filePath.includes('orchestration-skeleton.md')) return MOCK_SKELETON;
        if (filePath.includes('bug-fix.md')) return MOCK_BUG_TEMPLATE;
        // Default to feature-implementation template for all others
        return MOCK_FEATURE_TEMPLATE;
    });
}

/**
 * Inject a cached fingerprint to bypass the vscode-dependent RepoFingerprinter.
 */
function injectFingerprint(compiler: PromptCompiler, fp: RepoFingerprint): void {
    (compiler as any).cachedFingerprint = fp;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PromptCompiler Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('PromptCompiler', () => {
    let compiler: PromptCompiler;

    beforeEach(() => {
        jest.clearAllMocks();
        setupFsMocks();
        compiler = new PromptCompiler('/tmp/test-workspace');
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
    //  Missing template fallback
    // ─────────────────────────────────────────────────────────────────────────

    it('should handle missing template gracefully (falls back to feature-implementation)', async () => {
        setupFsMocks({ missingTemplate: true });

        // "bug" keyword triggers bug_fix classification, but the bug-fix.md template is missing
        const result = await compiler.compile('Fix the broken bug');

        // Should still compile successfully by falling back
        expect(result.text).toContain(MOCK_FEATURE_TEMPLATE);
        expect(result.manifest.taskFamily).toBe('bug_fix');
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
