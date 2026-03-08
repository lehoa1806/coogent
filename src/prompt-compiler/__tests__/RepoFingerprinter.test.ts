jest.mock('vscode', () => ({
    commands: { registerCommand: jest.fn() },
    window: { showWarningMessage: jest.fn(), showErrorMessage: jest.fn(), showInformationMessage: jest.fn() },
    workspace: { workspaceFolders: [], fs: { readFile: jest.fn(), stat: jest.fn(), readDirectory: jest.fn() } },
    Uri: { file: jest.fn((p: string) => ({ fsPath: p })), joinPath: jest.fn((_base: any, rel: string) => ({ fsPath: `${_base.fsPath}/${rel}` })) },
    FileType: { File: 1, Directory: 2 },
}), { virtual: true });

import { RepoFingerprinter } from '../RepoFingerprinter.js';
import * as vscode from 'vscode';

// ═══════════════════════════════════════════════════════════════════════════════
//  Test Helpers
// ═══════════════════════════════════════════════════════════════════════════════

const mockFs = vscode.workspace.fs as unknown as {
    readFile: jest.Mock;
    stat: jest.Mock;
    readDirectory: jest.Mock;
};

/** Encode a string into a Uint8Array suitable for readFile mock returns. */
function encode(content: string): Uint8Array {
    return Buffer.from(content, 'utf-8');
}

/**
 * Register mock file system entries.
 *
 * @param files — A map from relative path suffix to file content (string).
 *   The `readFile` mock will match on path suffix. The `stat` mock will
 *   resolve for any registered file and reject for others. `readDirectory`
 *   is set up to return file entries whose names end with specified extensions.
 */
function setupMockFiles(files: Record<string, string>): void {
    mockFs.readFile.mockImplementation(async (uri: { fsPath: string }) => {
        for (const [key, content] of Object.entries(files)) {
            if (uri.fsPath.endsWith(key)) {
                return encode(content);
            }
        }
        throw new Error(`File not found: ${uri.fsPath}`);
    });

    mockFs.stat.mockImplementation(async (uri: { fsPath: string }) => {
        for (const key of Object.keys(files)) {
            if (uri.fsPath.endsWith(key)) {
                return { type: 1 /* FileType.File */ };
            }
        }
        throw new Error(`File not found: ${uri.fsPath}`);
    });

    // readDirectory returns entries whose name matches file basenames
    mockFs.readDirectory.mockImplementation(async () => {
        return Object.keys(files).map(f => {
            const basename = f.split('/').pop()!;
            return [basename, 1 /* FileType.File */];
        });
    });
}

/** Set up empty file system — no files exist. */
function setupEmptyMockFs(): void {
    mockFs.readFile.mockRejectedValue(new Error('File not found'));
    mockFs.stat.mockRejectedValue(new Error('File not found'));
    mockFs.readDirectory.mockResolvedValue([]);
}

/**
 * Register a mock file system with a project in a subdirectory.
 *
 * Sets up:
 *  - Root: no manifest files, one subdirectory named `subdirName`
 *  - Subdir: contains the given `files` (keyed by relative path from subdir)
 *
 * @param subdirName — The child directory name (e.g., 'coogent')
 * @param files — Files within the subdirectory (relative to it)
 */
function setupSubdirProject(subdirName: string, files: Record<string, string>): void {
    mockFs.readFile.mockImplementation(async (uri: { fsPath: string }) => {
        for (const [key, content] of Object.entries(files)) {
            // Match e.g. /tmp/test-workspace/coogent/package.json
            if (uri.fsPath.endsWith(`${subdirName}/${key}`)) {
                return encode(content);
            }
        }
        throw new Error(`File not found: ${uri.fsPath}`);
    });

    mockFs.stat.mockImplementation(async (uri: { fsPath: string }) => {
        for (const key of Object.keys(files)) {
            if (uri.fsPath.endsWith(`${subdirName}/${key}`)) {
                return { type: 1 /* FileType.File */ };
            }
        }
        // The subdir itself "exists" as a directory
        if (uri.fsPath.endsWith(subdirName)) {
            return { type: 2 /* FileType.Directory */ };
        }
        throw new Error(`File not found: ${uri.fsPath}`);
    });

    // Root readDirectory returns the subdirectory entry
    mockFs.readDirectory.mockImplementation(async (uri: { fsPath: string }) => {
        // Root listing: return subdirectory as a dir
        if (uri.fsPath.endsWith('test-workspace')) {
            return [[subdirName, 2 /* FileType.Directory */]];
        }
        // Subdir listing: return file entries
        return Object.keys(files).map(f => {
            const basename = f.split('/').pop()!;
            return [basename, 1 /* FileType.File */];
        });
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  RepoFingerprinter Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('RepoFingerprinter', () => {
    let fingerprinter: RepoFingerprinter;

    beforeEach(() => {
        jest.clearAllMocks();
        fingerprinter = new RepoFingerprinter('/tmp/test-workspace');
    });

    // ─────────────────────────────────────────────────────────────────────────
    //  Workspace type detection
    // ─────────────────────────────────────────────────────────────────────────

    it('should detect single workspace type when no monorepo config files exist', async () => {
        setupMockFiles({
            'package.json': JSON.stringify({
                dependencies: { express: '^4.18.0' },
            }),
        });

        const result = await fingerprinter.fingerprint();

        expect(result.workspaceType).toBe('single');
        expect(result.workspaceFolders).toEqual(['.']);
    });

    it('should detect monorepo workspace type when turbo.json exists', async () => {
        setupMockFiles({
            'turbo.json': JSON.stringify({ pipeline: {} }),
            'package.json': JSON.stringify({
                workspaces: ['packages/*', 'apps/*'],
                dependencies: { typescript: '^5.0.0' },
            }),
        });

        const result = await fingerprinter.fingerprint();

        expect(result.workspaceType).toBe('monorepo');
    });

    it('should detect multi-root workspace type when .code-workspace file exists', async () => {
        setupMockFiles({
            'project.code-workspace': JSON.stringify({
                folders: [{ path: 'frontend' }, { path: 'backend' }],
            }),
            'package.json': JSON.stringify({
                dependencies: { react: '^18.0.0' },
            }),
        });

        const result = await fingerprinter.fingerprint();

        expect(result.workspaceType).toBe('multi-root');
    });

    // ─────────────────────────────────────────────────────────────────────────
    //  Test stack detection from package.json devDependencies
    // ─────────────────────────────────────────────────────────────────────────

    it('should extract test stack from package.json devDependencies (jest, vitest)', async () => {
        setupMockFiles({
            'package.json': JSON.stringify({
                devDependencies: {
                    jest: '^29.0.0',
                    vitest: '^1.0.0',
                },
            }),
        });

        const result = await fingerprinter.fingerprint();

        expect(result.testStack).toContain('jest');
        expect(result.testStack).toContain('vitest');
    });

    // ─────────────────────────────────────────────────────────────────────────
    //  Lint stack detection from package.json devDependencies
    // ─────────────────────────────────────────────────────────────────────────

    it('should extract lint stack from package.json devDependencies (eslint, prettier)', async () => {
        setupMockFiles({
            'package.json': JSON.stringify({
                devDependencies: {
                    eslint: '^8.0.0',
                    prettier: '^3.0.0',
                },
            }),
        });

        const result = await fingerprinter.fingerprint();

        expect(result.lintStack).toContain('eslint');
        expect(result.lintStack).toContain('prettier');
    });

    // ─────────────────────────────────────────────────────────────────────────
    //  Build stack detection from package.json devDependencies
    // ─────────────────────────────────────────────────────────────────────────

    it('should extract build stack from package.json devDependencies (esbuild, vite)', async () => {
        setupMockFiles({
            'package.json': JSON.stringify({
                devDependencies: {
                    esbuild: '^0.18.0',
                    vite: '^5.0.0',
                },
            }),
        });

        const result = await fingerprinter.fingerprint();

        expect(result.buildStack).toContain('esbuild');
        expect(result.buildStack).toContain('vite');
    });

    // ─────────────────────────────────────────────────────────────────────────
    //  Typecheck stack detection
    // ─────────────────────────────────────────────────────────────────────────

    it('should detect typecheck stack when tsconfig.json exists', async () => {
        setupMockFiles({
            'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true } }),
            'package.json': JSON.stringify({
                devDependencies: { jest: '^29.0.0' },
            }),
        });

        const result = await fingerprinter.fingerprint();

        expect(result.typecheckStack).toContain('tsc');
    });

    // ─────────────────────────────────────────────────────────────────────────
    //  Sensible defaults when no manifests are found
    // ─────────────────────────────────────────────────────────────────────────

    it('should return sensible defaults when no manifest files are found', async () => {
        setupEmptyMockFs();

        const result = await fingerprinter.fingerprint();

        expect(result.workspaceType).toBe('single');
        expect(result.workspaceFolders).toEqual(['.']);
        expect(result.primaryLanguages).toEqual([]);
        expect(result.keyFrameworks).toEqual([]);
        expect(result.testStack).toEqual([]);
        expect(result.lintStack).toEqual([]);
        expect(result.typecheckStack).toEqual([]);
        expect(result.buildStack).toEqual([]);
        expect(result.architectureHints).toEqual([]);
        expect(result.highRiskSurfaces).toEqual([]);
    });

    // ─────────────────────────────────────────────────────────────────────────
    //  Never throws
    // ─────────────────────────────────────────────────────────────────────────

    it('should never throw — just returns defaults on errors', async () => {
        // Make all fs operations throw unexpected errors
        mockFs.readFile.mockRejectedValue(new Error('UNEXPECTED'));
        mockFs.stat.mockRejectedValue(new Error('UNEXPECTED'));
        mockFs.readDirectory.mockRejectedValue(new Error('UNEXPECTED'));

        const result = await fingerprinter.fingerprint();

        // Should still return a valid fingerprint, not throw
        expect(result).toBeDefined();
        expect(result.workspaceType).toBe('single');
        expect(result.workspaceFolders).toEqual(['.']);
    });

    // ─────────────────────────────────────────────────────────────────────────
    //  Subdirectory project detection
    // ─────────────────────────────────────────────────────────────────────────

    it('should detect a Node project in a subdirectory when root has no manifests', async () => {
        setupSubdirProject('coogent', {
            'package.json': JSON.stringify({
                devDependencies: {
                    typescript: '^5.0.0',
                    vitest: '^1.0.0',
                    eslint: '^8.0.0',
                    esbuild: '^0.18.0',
                },
            }),
        });

        const result = await fingerprinter.fingerprint();

        expect(result.detectedSubdirectory).toBe('coogent');
        expect(result.primaryLanguages).toContain('typescript');
        expect(result.testStack).toContain('vitest');
        expect(result.lintStack).toContain('eslint');
        expect(result.buildStack).toContain('esbuild');
        expect(result.packageManager).not.toBe('unknown');
    });

    it('should NOT set detectedSubdirectory when root has a manifest', async () => {
        setupMockFiles({
            'package.json': JSON.stringify({
                dependencies: { express: '^4.18.0' },
            }),
        });

        const result = await fingerprinter.fingerprint();

        expect(result.detectedSubdirectory).toBeUndefined();
        expect(result.primaryLanguages).toContain('typescript');
    });

    it('should skip hidden directories during subdirectory scanning', async () => {
        // Only .hidden dir has a package.json — should be skipped
        mockFs.readFile.mockRejectedValue(new Error('File not found'));
        mockFs.stat.mockRejectedValue(new Error('File not found'));
        mockFs.readDirectory.mockImplementation(async (uri: { fsPath: string }) => {
            if (uri.fsPath.endsWith('test-workspace')) {
                return [['.hidden', 2 /* FileType.Directory */]];
            }
            return [];
        });

        const result = await fingerprinter.fingerprint();

        // Should NOT have detected the hidden dir
        expect(result.detectedSubdirectory).toBeUndefined();
        expect(result.primaryLanguages).toEqual([]);
    });
});
