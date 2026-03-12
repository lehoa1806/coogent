// ─────────────────────────────────────────────────────────────────────────────
// src/state/FileLock.ts — Advisory file lock with stale-PID cleanup
// ─────────────────────────────────────────────────────────────────────────────
// R4 refactor: Extracted from StateManager.ts to isolate file-locking concerns.

import * as fs from 'node:fs/promises';
import log from '../logger/log.js';

/**
 * Advisory file lock using `O_CREAT | O_EXCL` (no exclusive OS-level lock).
 *
 * **Design Note**: This lock only guards against *external* processes
 * (e.g., another VS Code window or a text editor) modifying the runbook
 * file concurrently. In-process write serialization is handled by the
 * caller's async mutex (`writeLock` in StateManager).
 *
 * The 100ms busy-poll is acceptable because contention from external
 * processes is rare and short-lived.
 */
export class FileLock {
    /** Whether we currently hold the file lock. */
    private isLocked = false;

    constructor(private lockPath: string) {}

    /**
     * Update the lock path (for deferred session init).
     */
    public setLockPath(newPath: string): void {
        this.lockPath = newPath;
    }

    /**
     * Acquire an advisory file lock via lockfile (O_CREAT | O_EXCL).
     * @param timeoutMs Maximum wait before throwing (default: 5000ms).
     */
    async acquire(timeoutMs = 5000): Promise<void> {
        // Skip re-acquisition if we already hold the lock (W-3 fix)
        if (this.isLocked) return;
        const deadline = Date.now() + timeoutMs;
        let staleLockCleaned = false;

        while (Date.now() < deadline) {
            try {
                await fs.writeFile(this.lockPath, String(process.pid), { flag: 'wx' });
                this.isLocked = true;
                return;
            } catch (err: unknown) {
                if (isNodeError(err) && err.code === 'EEXIST') {
                    // On first EEXIST, try cleaning stale lock (#32)
                    if (!staleLockCleaned) {
                        await this.cleanStale();
                        staleLockCleaned = true;
                    } else {
                        await sleep(100);
                    }
                    continue;
                }
                throw err;
            }
        }

        throw new Error(
            `[FileLock] Failed to acquire lock within ${timeoutMs}ms. ` +
            `The runbook may be locked by another process.`
        );
    }

    /** Release the exclusive lock. */
    async release(): Promise<void> {
        if (!this.isLocked) return;
        try { await fs.unlink(this.lockPath); } catch { /* best-effort */ }
        this.isLocked = false;
    }

    /**
     * Remove stale lockfiles left by a process that died without releasing.
     * Checks if the PID in the lockfile is still alive; if dead, removes it.
     * See 02-review.md § P0-2.
     */
    async cleanStale(): Promise<void> {
        try {
            const pidStr = await fs.readFile(this.lockPath, 'utf-8');
            const pid = parseInt(pidStr.trim(), 10);

            if (isNaN(pid)) {
                // Corrupt lockfile — remove it unconditionally
                await fs.unlink(this.lockPath).catch(() => { });
                log.info('[FileLock] Removed corrupt lockfile.');
                return;
            }

            try {
                process.kill(pid, 0); // Check if process is alive (signal 0)
                // Process is alive — lock is legitimate, do NOT remove
                log.warn(`[FileLock] Lockfile held by live PID ${pid}.`);
            } catch {
                // Process is dead — lock is stale
                await fs.unlink(this.lockPath).catch(() => { });
                log.info(`[FileLock] Removed stale lockfile (dead PID ${pid}).`);
            }
        } catch (err: unknown) {
            if (isNodeError(err) && err.code === 'ENOENT') {
                return; // No lockfile — nothing to clean
            }
            // Unexpected error — log but don't throw (recovery should proceed)
            log.warn('[FileLock] cleanStale error:', err);
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Utility Functions
// ═══════════════════════════════════════════════════════════════════════════════

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
    return (err instanceof Error && 'code' in err) ||
        (typeof err === 'object' && err !== null && 'code' in err && 'message' in err);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
