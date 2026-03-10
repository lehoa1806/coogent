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
//  Multi-Repo Result Types
// ═══════════════════════════════════════════════════════════════════════════════

/** Aggregate preflight result across all repositories in the workspace. */
export interface MultiRepoPreFlightResult {
    /** True only if every repository has a clean working tree. */
    allClean: boolean;
    /** Per-repository preflight details. */
    results: Array<{
        repoRoot: string;
        clean: boolean;
        currentBranch: string;
        message: string;
    }>;
}

/** Aggregate sandbox creation/cleanup result across all repositories. */
export interface MultiRepoSandboxResult {
    /** True only if the operation succeeded for every repository. */
    success: boolean;
    /** Per-repository operation details. */
    results: Array<{
        repoRoot: string;
        success: boolean;
        branchName?: string;
        previousBranch?: string;
        message: string;
    }>;
    /** Human-readable summary message. */
    message: string;
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
     * Acquire the built-in Git extension and locate the best-matching
     * repository for this manager's workspace root.
     *
     * Uses a best-match strategy: the repo whose root is the longest
     * prefix of (or equal to) the workspace root is preferred. If no
     * prefix match is found, checks whether the workspace root is a
     * parent of any repo root (common when the VS Code workspace is
     * opened at a parent directory). Falls back to the sole available
     * repo in single-repo workspaces.
     *
     * @throws If the Git extension is not installed, not active, or no
     *         repository can be matched to the workspace root.
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

        const repository = this.findBestRepository(api.repositories);

        if (!repository) {
            throw new Error(
                `No Git repository found for workspace root: ${this.workspaceRoot}. ` +
                'Ensure the workspace is inside a Git-initialized directory.'
            );
        }

        return { api, repository };
    }

    /**
     * Acquire the built-in Git extension and return ALL tracked repositories.
     *
     * @throws If the Git extension is not installed, not active, or has no
     *         repositories.
     * @returns An object containing the top-level `api` and all `repositories`.
     */
    private getAllRepositories(): { api: GitAPI; repositories: Repository[] } {
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

        if (api.repositories.length === 0) {
            throw new Error(
                'No Git repositories found in the workspace. ' +
                'Ensure at least one workspace folder is inside a Git-initialized directory.'
            );
        }

        return { api, repositories: [...api.repositories] };
    }

    /**
     * Find the best-matching repository from the list of available repos.
     *
     * Matching priority:
     * 1. Exact match: `repo.rootUri.fsPath === workspaceRoot`
     * 2. Repo is ancestor of workspace: `workspaceRoot.startsWith(repoRoot + sep)`
     *    → pick the deepest (longest path) match.
     * 3. Workspace is ancestor of repo: `repoRoot.startsWith(workspaceRoot + sep)`
     *    → pick the deepest (longest path) match.
     * 4. Single-repo fallback: if only one repo exists, use it.
     *
     * @param repositories - All repositories known to the Git extension.
     * @returns The best-matching repository, or `undefined` if none found.
     */
    private findBestRepository(repositories: readonly Repository[]): Repository | undefined {
        if (repositories.length === 0) return undefined;

        const wsRoot = this.workspaceRoot;
        const sep = wsRoot.includes('\\') ? '\\' : '/';

        // Priority 1: exact match
        const exact = repositories.find(r => r.rootUri.fsPath === wsRoot);
        if (exact) return exact;

        // Priority 2: repo root is an ancestor of the workspace root
        // (e.g. workspace = /a/b/c, repo = /a/b)
        const ancestors = repositories
            .filter(r => wsRoot.startsWith(r.rootUri.fsPath + sep))
            .sort((a, b) => b.rootUri.fsPath.length - a.rootUri.fsPath.length);
        if (ancestors.length > 0) return ancestors[0];

        // Priority 3: workspace root is an ancestor of a repo root
        // (e.g. workspace = /a, repo = /a/b/c — user opened parent dir)
        const descendants = repositories
            .filter(r => r.rootUri.fsPath.startsWith(wsRoot + sep))
            .sort((a, b) => a.rootUri.fsPath.length - b.rootUri.fsPath.length);
        if (descendants.length > 0) return descendants[0];

        // Priority 4: single-repo fallback
        if (repositories.length === 1) return repositories[0];

        return undefined;
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
     *                  optional branch prefix (defaults to empty string — no prefix).
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
            const prefix = options.branchPrefix ?? '';
            const sanitizedSlug = options.taskSlug
                .replace(/\s+/g, '-')           // spaces → hyphens
                .replace(/[^a-zA-Z0-9\-/]/g, '') // strip non-alphanumeric (keep - and /)
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

    // ═══════════════════════════════════════════════════════════════════════════
    //  Multi-Repo Public API
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Run preflight checks across ALL repositories tracked by the Git extension.
     *
     * @returns A {@link MultiRepoPreFlightResult} with per-repo clean/dirty
     *          status and an aggregate `allClean` flag.
     */
    async preFlightCheckAll(): Promise<MultiRepoPreFlightResult> {
        try {
            const { repositories } = this.getAllRepositories();
            const results: MultiRepoPreFlightResult['results'] = [];

            for (const repo of repositories) {
                const repoRoot = repo.rootUri.fsPath;
                const hasChanges =
                    repo.state.workingTreeChanges.length > 0 ||
                    repo.state.indexChanges.length > 0;

                results.push({
                    repoRoot,
                    clean: !hasChanges,
                    currentBranch: repo.state.HEAD?.name ?? 'detached',
                    message: hasChanges
                        ? 'Working tree is dirty — uncommitted changes present'
                        : 'Clean',
                });
            }

            return {
                allClean: results.every(r => r.clean),
                results,
            };
        } catch (err) {
            return {
                allClean: false,
                results: [{
                    repoRoot: this.workspaceRoot,
                    clean: false,
                    currentBranch: 'unknown',
                    message: `Pre-flight check failed: ${(err as Error).message}`,
                }],
            };
        }
    }

    /**
     * Create and checkout sandbox branches across ALL repositories.
     *
     * Uses a **two-phase commit** approach:
     * 1. Preflight ALL repos — if any is dirty, abort with a clear error
     *    listing all dirty repos.
     * 2. Create sandbox branches across ALL repos. If one fails after others
     *    succeeded, the result clearly reports which succeeded and which failed
     *    (no automatic rollback — the user can inspect and fix).
     *
     * Branch naming is consistent across all repos:
     * `${branchPrefix}${sanitized-taskSlug}`.
     *
     * @param options - Sandbox configuration including the task slug and
     *                  optional branch prefix (defaults to empty string — no prefix).
     * @returns A {@link MultiRepoSandboxResult} with per-repo results.
     */
    async createSandboxBranchAll(options: SandboxOptions): Promise<MultiRepoSandboxResult> {
        try {
            // Phase 1: Preflight ALL repos
            const preflight = await this.preFlightCheckAll();
            if (!preflight.allClean) {
                const dirtyRepos = preflight.results
                    .filter(r => !r.clean)
                    .map(r => `  • ${r.repoRoot}: ${r.message}`)
                    .join('\n');

                return {
                    success: false,
                    results: preflight.results.map(r => ({
                        repoRoot: r.repoRoot,
                        success: false,
                        previousBranch: r.currentBranch,
                        message: r.clean ? 'Clean but aborted due to other dirty repos' : r.message,
                    })),
                    message:
                        `Cannot create sandbox — dirty repositories detected:\n${dirtyRepos}\n` +
                        'Commit or stash all changes before creating sandbox branches.',
                };
            }

            // Phase 2: Create branches across all repos
            const prefix = options.branchPrefix ?? '';
            const sanitizedSlug = options.taskSlug
                .replace(/\s+/g, '-')
                .replace(/[^a-zA-Z0-9\-/]/g, '')
                .replace(/-{2,}/g, '-')
                .replace(/^-+|-+$/g, '')
                .toLowerCase();
            const branchName = `${prefix}${sanitizedSlug}`;

            const { repositories } = this.getAllRepositories();
            const results: MultiRepoSandboxResult['results'] = [];

            for (const repo of repositories) {
                const repoRoot = repo.rootUri.fsPath;
                const previousBranch = repo.state.HEAD?.name ?? 'detached';

                try {
                    await repo.createBranch(branchName, true);

                    // Verify checkout
                    const checkedOut = repo.state.HEAD?.name === branchName;
                    results.push({
                        repoRoot,
                        success: checkedOut,
                        branchName,
                        previousBranch,
                        message: checkedOut
                            ? `Sandbox branch "${branchName}" created and checked out`
                            : `Branch created but checkout verification failed (HEAD: ${repo.state.HEAD?.name ?? 'unknown'})`,
                    });
                } catch (err) {
                    results.push({
                        repoRoot,
                        success: false,
                        branchName,
                        previousBranch,
                        message: `Failed: ${(err as Error).message}`,
                    });
                }
            }

            const allSucceeded = results.every(r => r.success);
            const succeeded = results.filter(r => r.success).length;
            const failed = results.filter(r => !r.success).length;

            return {
                success: allSucceeded,
                results,
                message: allSucceeded
                    ? `Sandbox branch "${branchName}" created across ${succeeded} repositories.`
                    : `Partial sandbox creation: ${succeeded} succeeded, ${failed} failed.`,
            };
        } catch (err) {
            return {
                success: false,
                results: [],
                message: `Failed to create sandbox branches: ${(err as Error).message}`,
            };
        }
    }

    /**
     * Checkout the original branch for each repository.
     *
     * @param branches - Array of `{ repoRoot, branchName }` pairs indicating
     *                   which branch to checkout for each repo root.
     * @returns A {@link MultiRepoSandboxResult} with per-repo results.
     */
    async returnToOriginalBranchAll(
        branches: Array<{ repoRoot: string; branchName: string }>,
    ): Promise<MultiRepoSandboxResult> {
        try {
            const { repositories } = this.getAllRepositories();
            const results: MultiRepoSandboxResult['results'] = [];

            for (const { repoRoot, branchName } of branches) {
                const repo = repositories.find(r => r.rootUri.fsPath === repoRoot);
                if (!repo) {
                    results.push({
                        repoRoot,
                        success: false,
                        branchName,
                        message: `Repository not found for root: ${repoRoot}`,
                    });
                    continue;
                }

                try {
                    await repo.checkout(branchName);

                    const checkedOut = repo.state.HEAD?.name === branchName;
                    results.push({
                        repoRoot,
                        success: checkedOut,
                        branchName,
                        message: checkedOut
                            ? `Returned to branch "${branchName}"`
                            : `Checkout issued but verification failed (HEAD: ${repo.state.HEAD?.name ?? 'unknown'})`,
                    });
                } catch (err) {
                    results.push({
                        repoRoot,
                        success: false,
                        branchName,
                        message: `Failed to checkout "${branchName}": ${(err as Error).message}`,
                    });
                }
            }

            const allSucceeded = results.every(r => r.success);
            return {
                success: allSucceeded,
                results,
                message: allSucceeded
                    ? `All ${results.length} repositories returned to their original branches.`
                    : `Some repositories failed to return to their original branches.`,
            };
        } catch (err) {
            return {
                success: false,
                results: [],
                message: `Failed to return to original branches: ${(err as Error).message}`,
            };
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Lifecycle
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Cleanup method for releasing resources held by the sandbox manager.
     * Currently a no-op placeholder for future resource cleanup (e.g.,
     * event listener disposal, temp file cleanup).
     */
    async dispose(): Promise<void> {
        // Placeholder — reserved for future resource cleanup
    }
}
