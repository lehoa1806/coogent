jest.mock('vscode', () => ({
    extensions: {
        getExtension: jest.fn(),
    },
    commands: {
        executeCommand: jest.fn(),
    },
}), { virtual: true });

import { GitSandboxManager } from '../GitSandboxManager';
import * as vscode from 'vscode';

// ─────────────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Create a mock repository with sensible defaults. */
function createMockRepo(overrides: {
    rootPath: string;
    branch?: string;
    workingTreeChanges?: any[];
    indexChanges?: any[];
}) {
    return {
        rootUri: { fsPath: overrides.rootPath },
        state: {
            workingTreeChanges: overrides.workingTreeChanges ?? [],
            indexChanges: overrides.indexChanges ?? [],
            HEAD: { name: overrides.branch ?? 'main' },
        },
        createBranch: jest.fn(),
        checkout: jest.fn(),
        status: jest.fn(),
    };
}

/** Wire up the vscode.extensions.getExtension mock to return the given repos. */
function setupGitExtension(repos: any[]) {
    const mockGitAPI = { repositories: repos };
    const mockGitExtensionExport = {
        getAPI: jest.fn().mockReturnValue(mockGitAPI),
    };
    (vscode.extensions.getExtension as jest.Mock).mockReturnValue({
        isActive: true,
        exports: mockGitExtensionExport,
    });
    return { mockGitAPI, mockGitExtensionExport };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('GitSandboxManager — Multi-Repo', () => {
    const workspaceRoot = '/test/workspace';
    let manager: GitSandboxManager;

    beforeEach(() => {
        jest.restoreAllMocks();
        (vscode.commands.executeCommand as jest.Mock).mockResolvedValue(undefined);
        manager = new GitSandboxManager(workspaceRoot);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    // ─────────────────────────────────────────────────────────────────────────
    //  preFlightCheckAll
    // ─────────────────────────────────────────────────────────────────────────

    test('preFlightCheckAll — all repos clean', async () => {
        const repo1 = createMockRepo({ rootPath: '/repo/alpha', branch: 'main' });
        const repo2 = createMockRepo({ rootPath: '/repo/beta', branch: 'develop' });
        const repo3 = createMockRepo({ rootPath: '/repo/gamma', branch: 'feature/x' });
        setupGitExtension([repo1, repo2, repo3]);

        const result = await manager.preFlightCheckAll();

        expect(result.allClean).toBe(true);
        expect(result.results).toHaveLength(3);
        result.results.forEach(r => {
            expect(r.clean).toBe(true);
        });
        expect(result.results[0].repoRoot).toBe('/repo/alpha');
        expect(result.results[0].currentBranch).toBe('main');
        expect(result.results[1].repoRoot).toBe('/repo/beta');
        expect(result.results[1].currentBranch).toBe('develop');
        expect(result.results[2].repoRoot).toBe('/repo/gamma');
        expect(result.results[2].currentBranch).toBe('feature/x');
    });

    test('preFlightCheckAll — one repo dirty', async () => {
        const repo1 = createMockRepo({ rootPath: '/repo/alpha' });
        const repo2 = createMockRepo({
            rootPath: '/repo/beta',
            workingTreeChanges: [{ uri: { fsPath: '/repo/beta/dirty.ts' } }],
        });
        const repo3 = createMockRepo({ rootPath: '/repo/gamma' });
        setupGitExtension([repo1, repo2, repo3]);

        const result = await manager.preFlightCheckAll();

        expect(result.allClean).toBe(false);
        expect(result.results).toHaveLength(3);
        expect(result.results[0].clean).toBe(true);
        expect(result.results[1].clean).toBe(false);
        expect(result.results[1].message).toContain('dirty');
        expect(result.results[2].clean).toBe(true);
    });

    // ─────────────────────────────────────────────────────────────────────────
    //  createSandboxBranchAll
    // ─────────────────────────────────────────────────────────────────────────

    test('createSandboxBranchAll — all succeed', async () => {
        const repo1 = createMockRepo({ rootPath: '/repo/alpha', branch: 'main' });
        const repo2 = createMockRepo({ rootPath: '/repo/beta', branch: 'develop' });
        const repo3 = createMockRepo({ rootPath: '/repo/gamma', branch: 'main' });
        const allRepos = [repo1, repo2, repo3];

        // createBranch simulates HEAD being updated
        for (const repo of allRepos) {
            repo.createBranch.mockImplementation(async (name: string) => {
                repo.state.HEAD = { name };
            });
        }

        setupGitExtension(allRepos);

        const result = await manager.createSandboxBranchAll({ taskSlug: 'multi-root-test' });

        expect(result.success).toBe(true);
        expect(result.results).toHaveLength(3);
        result.results.forEach(r => {
            expect(r.success).toBe(true);
            expect(r.branchName).toBe('multi-root-test');
        });
        // Verify consistent naming used for all repos
        expect(repo1.createBranch).toHaveBeenCalledWith('multi-root-test', true);
        expect(repo2.createBranch).toHaveBeenCalledWith('multi-root-test', true);
        expect(repo3.createBranch).toHaveBeenCalledWith('multi-root-test', true);
        // Previous branches are captured
        expect(result.results[0].previousBranch).toBe('main');
        expect(result.results[1].previousBranch).toBe('develop');
        expect(result.results[2].previousBranch).toBe('main');
    });

    test('createSandboxBranchAll — preflight fails (dirty repo)', async () => {
        const repo1 = createMockRepo({ rootPath: '/repo/alpha' });
        const repo2 = createMockRepo({
            rootPath: '/repo/beta',
            indexChanges: [{ uri: { fsPath: '/repo/beta/staged.ts' } }],
        });
        const repo3 = createMockRepo({ rootPath: '/repo/gamma' });
        setupGitExtension([repo1, repo2, repo3]);

        const result = await manager.createSandboxBranchAll({ taskSlug: 'wont-run' });

        expect(result.success).toBe(false);
        // No createBranch should have been called on ANY repo
        expect(repo1.createBranch).not.toHaveBeenCalled();
        expect(repo2.createBranch).not.toHaveBeenCalled();
        expect(repo3.createBranch).not.toHaveBeenCalled();
        expect(result.message).toContain('dirty');
    });

    test('createSandboxBranchAll — partial branch creation failure', async () => {
        const repo1 = createMockRepo({ rootPath: '/repo/alpha', branch: 'main' });
        const repo2 = createMockRepo({ rootPath: '/repo/beta', branch: 'main' });
        const repo3 = createMockRepo({ rootPath: '/repo/gamma', branch: 'main' });
        const allRepos = [repo1, repo2, repo3];

        // Repo 1 succeeds
        repo1.createBranch.mockImplementation(async (name: string) => {
            repo1.state.HEAD = { name };
        });
        // Repo 2 throws
        repo2.createBranch.mockRejectedValue(new Error('Branch already exists'));
        // Repo 3 succeeds
        repo3.createBranch.mockImplementation(async (name: string) => {
            repo3.state.HEAD = { name };
        });

        setupGitExtension(allRepos);

        const result = await manager.createSandboxBranchAll({ taskSlug: 'partial-fail' });

        expect(result.success).toBe(false);
        expect(result.results).toHaveLength(3);
        // Repo 1: succeeded
        expect(result.results[0].success).toBe(true);
        expect(result.results[0].repoRoot).toBe('/repo/alpha');
        // Repo 2: failed
        expect(result.results[1].success).toBe(false);
        expect(result.results[1].repoRoot).toBe('/repo/beta');
        expect(result.results[1].message).toContain('Branch already exists');
        // Repo 3: succeeded (execution continued past failure)
        expect(result.results[2].success).toBe(true);
        expect(result.results[2].repoRoot).toBe('/repo/gamma');
        // Summary reflects partial result
        expect(result.message).toContain('2 succeeded');
        expect(result.message).toContain('1 failed');
    });

    // ─────────────────────────────────────────────────────────────────────────
    //  returnToOriginalBranchAll
    // ─────────────────────────────────────────────────────────────────────────

    test('returnToOriginalBranchAll — all succeed', async () => {
        const repo1 = createMockRepo({ rootPath: '/repo/alpha', branch: 'task' });
        const repo2 = createMockRepo({ rootPath: '/repo/beta', branch: 'task' });
        const repo3 = createMockRepo({ rootPath: '/repo/gamma', branch: 'task' });

        // Simulate checkout updating HEAD
        repo1.checkout.mockImplementation(async (ref: string) => {
            repo1.state.HEAD = { name: ref };
        });
        repo2.checkout.mockImplementation(async (ref: string) => {
            repo2.state.HEAD = { name: ref };
        });
        repo3.checkout.mockImplementation(async (ref: string) => {
            repo3.state.HEAD = { name: ref };
        });

        setupGitExtension([repo1, repo2, repo3]);

        const result = await manager.returnToOriginalBranchAll([
            { repoRoot: '/repo/alpha', branchName: 'main' },
            { repoRoot: '/repo/beta', branchName: 'develop' },
            { repoRoot: '/repo/gamma', branchName: 'feature/y' },
        ]);

        expect(result.success).toBe(true);
        expect(result.results).toHaveLength(3);
        result.results.forEach(r => {
            expect(r.success).toBe(true);
        });
        expect(repo1.checkout).toHaveBeenCalledWith('main');
        expect(repo2.checkout).toHaveBeenCalledWith('develop');
        expect(repo3.checkout).toHaveBeenCalledWith('feature/y');
    });

    // ─────────────────────────────────────────────────────────────────────────
    //  Backward compatibility
    // ─────────────────────────────────────────────────────────────────────────

    test('backward compat — existing preFlightCheck() still works', async () => {
        const singleRepo = createMockRepo({ rootPath: workspaceRoot, branch: 'main' });
        setupGitExtension([singleRepo]);

        const result = await manager.preFlightCheck();

        expect(result.clean).toBe(true);
        expect(result.currentBranch).toBe('main');
        expect(result.message).toContain('clean');
    });
});
