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

describe('GitSandboxManager', () => {
    let manager: GitSandboxManager;
    const workspaceRoot = '/test/workspace';

    let mockRepository: any;
    let mockGitAPI: any;
    let mockGitExtensionExport: any;

    beforeEach(() => {
        mockRepository = {
            rootUri: { fsPath: workspaceRoot },
            state: {
                workingTreeChanges: [],
                indexChanges: [],
                HEAD: { name: 'main' },
            },
            createBranch: jest.fn(),
            checkout: jest.fn(),
            status: jest.fn(),
        };

        mockGitAPI = {
            repositories: [mockRepository],
        };

        mockGitExtensionExport = {
            getAPI: jest.fn().mockReturnValue(mockGitAPI),
        };

        (vscode.extensions.getExtension as jest.Mock).mockReturnValue({
            isActive: true,
            exports: mockGitExtensionExport,
        });

        (vscode.commands.executeCommand as jest.Mock).mockResolvedValue(undefined);

        manager = new GitSandboxManager(workspaceRoot);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    // ─────────────────────────────────────────────────────────────────────────
    //  preFlightCheck
    // ─────────────────────────────────────────────────────────────────────────

    test('preFlightCheck returns clean when no changes', async () => {
        mockRepository.state.workingTreeChanges = [];
        mockRepository.state.indexChanges = [];

        const result = await manager.preFlightCheck();
        expect(result.clean).toBe(true);
        expect(result.currentBranch).toBe('main');
        expect(result.message).toContain('clean');
    });

    test('preFlightCheck returns dirty when working tree has changes', async () => {
        mockRepository.state.workingTreeChanges = [{ uri: { fsPath: '/test/file.ts' } }];
        mockRepository.state.indexChanges = [];

        const result = await manager.preFlightCheck();
        expect(result.clean).toBe(false);
        expect(result.currentBranch).toBe('main');
        expect(result.message).toContain('dirty');
    });

    test('preFlightCheck returns dirty when index has staged changes', async () => {
        mockRepository.state.workingTreeChanges = [];
        mockRepository.state.indexChanges = [{ uri: { fsPath: '/test/staged.ts' } }];

        const result = await manager.preFlightCheck();
        expect(result.clean).toBe(false);
        expect(result.currentBranch).toBe('main');
        expect(result.message).toContain('dirty');
    });

    // ─────────────────────────────────────────────────────────────────────────
    //  createSandboxBranch
    // ─────────────────────────────────────────────────────────────────────────

    test('createSandboxBranch creates and checks out a coogent/ branch', async () => {
        // Pre-flight is clean (defaults)
        mockRepository.createBranch.mockImplementation(async (name: string) => {
            // Simulate the branch being created and HEAD updated
            mockRepository.state.HEAD = { name };
        });

        const result = await manager.createSandboxBranch({ taskSlug: 'fix-login' });
        expect(result.success).toBe(true);
        expect(result.branchName).toBe('coogent/fix-login');
        expect(result.previousBranch).toBe('main');
        expect(mockRepository.createBranch).toHaveBeenCalledWith('coogent/fix-login', true);
    });

    test('createSandboxBranch throws when working tree is dirty', async () => {
        mockRepository.state.workingTreeChanges = [{ uri: { fsPath: '/test/dirty.ts' } }];

        const result = await manager.createSandboxBranch({ taskSlug: 'some-task' });
        expect(result.success).toBe(false);
        expect(result.message).toContain('dirty');
    });

    test('createSandboxBranch sanitizes task slug', async () => {
        mockRepository.createBranch.mockImplementation(async (name: string) => {
            mockRepository.state.HEAD = { name };
        });

        const result = await manager.createSandboxBranch({
            taskSlug: 'Fix Login Bug!!! @#$%',
        });
        expect(result.success).toBe(true);
        expect(result.branchName).toBe('coogent/fix-login-bug');
        expect(mockRepository.createBranch).toHaveBeenCalledWith('coogent/fix-login-bug', true);
    });

    // ─────────────────────────────────────────────────────────────────────────
    //  openDiffReview
    // ─────────────────────────────────────────────────────────────────────────

    test('openDiffReview opens the Source Control view', async () => {
        const result = await manager.openDiffReview();
        expect(result.success).toBe(true);
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith('workbench.view.scm');
        expect(mockRepository.status).toHaveBeenCalled();
    });

    // ─────────────────────────────────────────────────────────────────────────
    //  returnToOriginalBranch
    // ─────────────────────────────────────────────────────────────────────────

    test('returnToOriginalBranch checks out the given branch', async () => {
        mockRepository.checkout.mockImplementation(async (ref: string) => {
            mockRepository.state.HEAD = { name: ref };
        });

        const result = await manager.returnToOriginalBranch('main');
        expect(result.success).toBe(true);
        expect(result.branchName).toBe('main');
        expect(mockRepository.checkout).toHaveBeenCalledWith('main');
    });

    // ─────────────────────────────────────────────────────────────────────────
    //  Error conditions
    // ─────────────────────────────────────────────────────────────────────────

    test('throws when Git extension is not available', async () => {
        (vscode.extensions.getExtension as jest.Mock).mockReturnValue(undefined);

        const result = await manager.preFlightCheck();
        expect(result.clean).toBe(false);
        expect(result.message).toContain('not installed');
    });

    test('throws when no repository found for workspace', async () => {
        mockGitAPI.repositories = [];

        const result = await manager.preFlightCheck();
        expect(result.clean).toBe(false);
        expect(result.message).toContain('No Git repository found');
    });
});
