// ─────────────────────────────────────────────────────────────────────────────
// src/git/GitManager.ts — Automated version control for phase checkpoints
// ─────────────────────────────────────────────────────────────────────────────

import type { GitOperationResult } from '../types/index.js';
import log from '../logger/log.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Git Manager
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Manages automated Git operations for Coogent.
 *
 * Responsibilities:
 * - Snapshot commits after each successful phase.
 * - Clean rollback on phase failure (`git reset --hard`).
 * - Stash/unstash to protect concurrent changes.
 */
export class GitManager {
    private gitRoot: string | undefined;

    constructor(private readonly workspaceRoot: string) { }

    /**
     * Create a snapshot commit after a successful phase.
     * Stages all changes and commits with an Coogent-prefixed message.
     */
    async snapshotCommit(phaseId: number): Promise<GitOperationResult> {
        try {
            // Stage all changes
            await this.gitExec('add', '-A');

            // Check if there are actually changes to commit
            const status = await this.gitExec('status', '--porcelain');
            if (!status.trim()) {
                return {
                    success: true,
                    message: `Phase ${phaseId}: No changes to commit`,
                };
            }

            // Commit with Coogent prefix
            const commitMsg = `coogent: auto-checkpoint phase ${phaseId}`;
            await this.gitExec('commit', '-m', commitMsg);

            // Get the commit hash
            const hash = (await this.gitExec('rev-parse', '--short', 'HEAD')).trim();

            return {
                success: true,
                commitHash: hash,
                message: `Phase ${phaseId}: Committed as ${hash}`,
            };
        } catch (err) {
            return {
                success: false,
                message: `Phase ${phaseId}: Commit failed — ${(err as Error).message}`,
            };
        }
    }

    /**
     * Roll back all uncommitted changes (clean room reset).
     * Used when a phase fails and the user aborts or the self-healer gives up.
     */
    async rollback(): Promise<GitOperationResult> {
        try {
            await this.gitExec('reset', '--hard', 'HEAD');

            // #51: Dry-run to log what would be cleaned
            const dryRun = await this.gitExec('clean', '-fdn');
            if (dryRun.trim()) {
                log.warn(`[GitManager] git clean will remove:\n${dryRun}`);
            }
            await this.gitExec('clean', '-fd');

            return {
                success: true,
                message: 'Rolled back to last committed state',
            };
        } catch (err) {
            return {
                success: false,
                message: `Rollback failed — ${(err as Error).message}`,
            };
        }
    }

    /**
     * Rollback to a specific commit (e.g., the checkpoint before a failed phase).
     */
    async rollbackToCommit(commitHash: string): Promise<GitOperationResult> {
        try {
            await this.gitExec('reset', '--hard', commitHash);

            // #51: Dry-run to log what would be cleaned
            const dryRun = await this.gitExec('clean', '-fdn');
            if (dryRun.trim()) {
                console.warn(`[GitManager] git clean will remove:\n${dryRun}`);
            }
            await this.gitExec('clean', '-fd');

            return {
                success: true,
                commitHash,
                message: `Rolled back to commit ${commitHash}`,
            };
        } catch (err) {
            return {
                success: false,
                message: `Rollback to ${commitHash} failed — ${(err as Error).message}`,
            };
        }
    }

    /**
     * Stash current changes before starting a new phase.
     * Useful for protecting developer's in-progress work.
     */
    async stash(label: string): Promise<GitOperationResult> {
        try {
            // #52: Check if there are changes to stash
            const status = await this.gitExec('status', '--porcelain');
            if (!status.trim()) {
                return {
                    success: true,
                    message: 'Nothing to stash — working tree is clean',
                };
            }

            await this.gitExec('stash', 'push', '-m', `coogent: ${label}`);
            return {
                success: true,
                message: `Stashed changes: ${label}`,
            };
        } catch (err) {
            return {
                success: false,
                message: `Stash failed — ${(err as Error).message}`,
            };
        }
    }

    /**
     * Pop the most recent stash.
     */
    async unstash(): Promise<GitOperationResult> {
        try {
            await this.gitExec('stash', 'pop');
            return {
                success: true,
                message: 'Unstashed changes',
            };
        } catch (err) {
            return {
                success: false,
                message: `Unstash failed — ${(err as Error).message}`,
            };
        }
    }

    /**
     * Check if the workspace is inside a Git repository.
     */
    async isGitRepo(): Promise<boolean> {
        try {
            await this.gitExec('rev-parse', '--git-dir');
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Get the current HEAD commit hash.
     */
    async getCurrentCommit(): Promise<string | null> {
        try {
            return (await this.gitExec('rev-parse', '--short', 'HEAD')).trim();
        } catch {
            return null;
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Private Helpers
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Resolve the actual Git repository root. Uses `git rev-parse --show-toplevel`
     * starting from `workspaceRoot` and caches the result. If detection fails,
     * falls back to `workspaceRoot`.
     */
    private async resolveGitRoot(): Promise<string> {
        if (this.gitRoot) return this.gitRoot;

        try {
            const { execFile } = await import('node:child_process');
            const { promisify } = await import('node:util');
            const execFileAsync = promisify(execFile);

            const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
                cwd: this.workspaceRoot,
                timeout: 10_000,
            });
            this.gitRoot = stdout.trim();
        } catch {
            // Fall back to workspaceRoot — git operations will still try
            this.gitRoot = this.workspaceRoot;
        }
        return this.gitRoot;
    }

    /**
     * Execute a git command using execFile (no shell — prevents injection).
     * Automatically resolves the actual git root for the cwd.
     * See 02-review.md § P1-4.
     */
    private async gitExec(...args: string[]): Promise<string> {
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execFileAsync = promisify(execFile);

        const cwd = await this.resolveGitRoot();

        const { stdout } = await execFileAsync('git', args, {
            cwd,
            timeout: 30_000,
            maxBuffer: 5 * 1024 * 1024,
        });
        return stdout;
    }
}
