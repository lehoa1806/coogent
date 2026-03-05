// ─────────────────────────────────────────────────────────────────────────────
// src/git/GitSandboxManager.ts — Secure Git sandboxing via native VS Code API
// ─────────────────────────────────────────────────────────────────────────────

import * as vscode from 'vscode';
import type { GitSandboxResult, PreFlightCheckResult, SandboxOptions } from '../types/index.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Local type definitions for the VS Code built-in Git extension API
//  (vscode.git). Defined inline to avoid dependency on @types/vscode-git.
// ═══════════════════════════════════════════════════════════════════════════════

/** Subset of the Git extension's exported API (version 1). */
interface GitExtension {
    getAPI(version: 1): GitAPI;
}

/** Top-level Git API surface. */
interface GitAPI {
    readonly repositories: Repository[];
}

/** A single Git repository tracked by the extension. */
interface Repository {
    readonly rootUri: vscode.Uri;
    readonly state: RepositoryState;
    createBranch(name: string, checkout: boolean): Promise<void>;
    checkout(ref: string): Promise<void>;
    status(): Promise<void>;
}

/** Observable snapshot of a repository's state. */
interface RepositoryState {
    readonly HEAD: { name?: string } | undefined;
    readonly workingTreeChanges: readonly { uri: vscode.Uri }[];
    readonly indexChanges: readonly { uri: vscode.Uri }[];
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Git Sandbox Manager
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Manages Git sandbox branches for Coogent AI orchestration using
 * **exclusively** the native VS Code Git extension API.
 *
 * Responsibilities:
 * - Pre-flight validation of the working tree (clean/dirty check).
 * - Automated sandbox branch creation for AI work isolation.
 * - Post-flight diff review via the native Source Control view.
 * - Branch checkout to return to the user's original branch.
 *
 * **Critical constraint**: No `child_process`, `exec`, `execFile`, or shell
 * commands are used. All operations go through `vscode.extensions.getExtension('vscode.git')`.
 */
export class GitSandboxManager {
    constructor(private readonly workspaceRoot: string) { }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Private Helpers
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Acquire the built-in Git extension and locate the repository matching
     * this manager's workspace root.
     *
     * @throws If the Git extension is not installed, not active, or no
     *         repository is found for the workspace root.
     * @returns An object containing the top-level `api` and the matched `repository`.
     */
    private getGitAPI(): { api: GitAPI; repository: Repository } {
        const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');

        if (!gitExtension) {
            throw new Error(
                'Git extension (vscode.git) is not installed. ' +
                'Please install the built-in Git extension to use sandbox features.'
            );
        }

        if (!gitExtension.isActive) {
            throw new Error(
                'Git extension (vscode.git) is installed but not active. ' +
                'Please ensure Git is enabled in VS Code settings.'
            );
        }

        const api = gitExtension.exports.getAPI(1);

        const repository = api.repositories.find(
            (repo) => repo.rootUri.fsPath === this.workspaceRoot
        );

        if (!repository) {
            throw new Error(
                `No Git repository found for workspace root: ${this.workspaceRoot}. ` +
                'Ensure the workspace is inside a Git-initialized directory.'
            );
        }

        return { api, repository };
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Public API
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Perform a pre-flight check to verify the working tree is clean
     * before entering a sandbox branch.
     *
     * Inspects `workingTreeChanges` and `indexChanges` on the repository
     * state to determine if there are uncommitted modifications.
     *
     * @returns A {@link PreFlightCheckResult} indicating whether the tree
     *          is clean and the current branch name.
     */
    async preFlightCheck(): Promise<PreFlightCheckResult> {
        try {
            const { repository } = this.getGitAPI();

            const currentBranch = repository.state.HEAD?.name ?? 'detached';
            const hasWorkingTreeChanges = repository.state.workingTreeChanges.length > 0;
            const hasIndexChanges = repository.state.indexChanges.length > 0;

            if (hasWorkingTreeChanges || hasIndexChanges) {
                return {
                    clean: false,
                    currentBranch,
                    message:
                        'Working tree is dirty — there are uncommitted changes. ' +
                        'Commit or stash your changes before creating a sandbox branch.',
                };
            }

            return {
                clean: true,
                currentBranch,
                message: 'Working tree is clean. Ready to create a sandbox branch.',
            };
        } catch (err) {
            return {
                clean: false,
                currentBranch: 'unknown',
                message: `Pre-flight check failed: ${(err as Error).message}`,
            };
        }
    }

    /**
     * Create and checkout a new sandbox branch for isolated AI work.
     *
     * The branch name is computed from the provided options:
     * `${branchPrefix}${sanitized-taskSlug}`.
     *
     * @param options - Sandbox configuration including the task slug and
     *                  optional branch prefix (defaults to `'coogent/'`).
     * @returns A {@link GitSandboxResult} with the created branch name and
     *          the previous branch for later restoration.
     * @throws If the working tree is dirty (pre-flight check fails).
     */
    async createSandboxBranch(options: SandboxOptions): Promise<GitSandboxResult> {
        try {
            // Step 1: Pre-flight — working tree must be clean
            const preflight = await this.preFlightCheck();
            if (!preflight.clean) {
                throw new Error(preflight.message);
            }

            // Step 2: Compute sanitized branch name
            const prefix = options.branchPrefix ?? 'coogent/';
            const sanitizedSlug = options.taskSlug
                .replace(/\s+/g, '-')           // spaces → hyphens
                .replace(/[^a-zA-Z0-9\-\/]/g, '') // strip non-alphanumeric (keep - and /)
                .replace(/-{2,}/g, '-')         // collapse consecutive hyphens
                .replace(/^-+|-+$/g, '')        // strip leading/trailing hyphens
                .toLowerCase();
            const branchName = `${prefix}${sanitizedSlug}`;

            // Step 3: Acquire the repository
            const { repository } = this.getGitAPI();
            const previousBranch = repository.state.HEAD?.name ?? 'detached';

            // Step 4: Create and checkout the sandbox branch
            await repository.createBranch(branchName, true);

            // Step 5: Verify checkout succeeded
            if (repository.state.HEAD?.name !== branchName) {
                return {
                    success: false,
                    branchName,
                    previousBranch,
                    message:
                        `Branch "${branchName}" was created but checkout verification failed. ` +
                        `HEAD is on "${repository.state.HEAD?.name ?? 'unknown'}" instead.`,
                };
            }

            return {
                success: true,
                branchName,
                previousBranch,
                message: `Sandbox branch "${branchName}" created and checked out successfully.`,
            };
        } catch (err) {
            return {
                success: false,
                message: `Failed to create sandbox branch: ${(err as Error).message}`,
            };
        }
    }

    /**
     * Open the VS Code Source Control view so the user can review the diff
     * of changes made by the AI worker on the sandbox branch.
     *
     * This refreshes the repository status and opens the SCM panel.
     *
     * @returns A {@link GitSandboxResult} indicating success or failure.
     */
    async openDiffReview(): Promise<GitSandboxResult> {
        try {
            const { repository } = this.getGitAPI();

            // Open the Source Control view
            await vscode.commands.executeCommand('workbench.view.scm');

            // Refresh repository status to ensure the diff reflects current state
            await repository.status();

            return {
                success: true,
                message: 'Source Control view opened for review.',
            };
        } catch (err) {
            return {
                success: false,
                message: `Failed to open diff review: ${(err as Error).message}`,
            };
        }
    }

    /**
     * Checkout the specified branch to return from the sandbox.
     *
     * Typically called with the `previousBranch` value returned from
     * {@link createSandboxBranch} to restore the user's original branch.
     *
     * @param branchName - The branch to checkout (e.g., `'main'`).
     * @returns A {@link GitSandboxResult} indicating success or failure.
     */
    async returnToOriginalBranch(branchName: string): Promise<GitSandboxResult> {
        try {
            const { repository } = this.getGitAPI();

            await repository.checkout(branchName);

            // Verify checkout
            if (repository.state.HEAD?.name !== branchName) {
                return {
                    success: false,
                    branchName,
                    message:
                        `Checkout to "${branchName}" was issued but verification failed. ` +
                        `HEAD is on "${repository.state.HEAD?.name ?? 'unknown'}" instead.`,
                };
            }

            return {
                success: true,
                branchName,
                message: `Returned to branch "${branchName}" successfully.`,
            };
        } catch (err) {
            return {
                success: false,
                message: `Failed to return to branch "${branchName}": ${(err as Error).message}`,
            };
        }
    }

    /**
     * Cleanup method for releasing resources held by the sandbox manager.
     * Currently a no-op placeholder for future resource cleanup (e.g.,
     * event listener disposal, temp file cleanup).
     */
    async dispose(): Promise<void> {
        // Placeholder — reserved for future resource cleanup
    }
}
