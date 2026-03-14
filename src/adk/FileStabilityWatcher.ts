// ─────────────────────────────────────────────────────────────────────────────
// src/adk/FileStabilityWatcher.ts — S4-4: Extracted file-stability detector
// ─────────────────────────────────────────────────────────────────────────────
// Watches for a file to appear on disk and stabilize (no size changes for a
// configurable threshold). Uses a dual-path strategy: fs.watch for fast
// detection + polling as a reliable fallback.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { watch, type FSWatcher } from 'node:fs';
import type * as vscode from 'vscode';
import log from '../logger/log.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Configuration Defaults
// ═══════════════════════════════════════════════════════════════════════════════

/** How often to poll for file-stability (ms). */
const DEFAULT_POLL_MS = 1_000;

/** How long the file must remain unchanged to be considered "done" (ms). */
const DEFAULT_STABILITY_THRESHOLD_MS = 1_500;

// ═══════════════════════════════════════════════════════════════════════════════
//  Options
// ═══════════════════════════════════════════════════════════════════════════════

export interface FileStabilityOptions {
    /** Maximum time to wait for the file (ms). */
    timeoutMs: number;
    /** How often to poll for stability (ms). Defaults to 1000. */
    pollMs?: number;
    /** How long the file must remain unchanged (ms). Defaults to 1500. */
    stabilityThresholdMs?: number;
    /** Cancellation token — resolves to null immediately on cancel. */
    cancellationToken?: vscode.CancellationToken;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  FileStabilityWatcher
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Watches for a file to appear and reach a stable state.
 *
 * "Stable" means the file exists, has non-zero content, and its size has not
 * changed for `stabilityThresholdMs` milliseconds.
 *
 * Strategy (dual-path):
 *   1. **fs.watch** — for fast detection of file creation/modification events.
 *   2. **setInterval polling** — reliable fallback since fs.watch can miss events.
 *
 * Returns the file content once stable, or `null` on timeout/cancellation.
 */
export class FileStabilityWatcher {
    /** Active watcher (if any) — cleaned up on resolve. */
    private watcher: FSWatcher | undefined;
    /** Active poll timer (if any) — cleaned up on resolve. */
    private pollTimer: ReturnType<typeof setInterval> | undefined;

    /**
     * Wait for `filePath` to appear and stabilize.
     *
     * @returns File content as UTF-8 string, or `null` on timeout/cancellation.
     */
    async waitForStableFile(
        filePath: string,
        options: FileStabilityOptions,
    ): Promise<string | null> {
        const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
        const stabilityThresholdMs = options.stabilityThresholdMs ?? DEFAULT_STABILITY_THRESHOLD_MS;

        return new Promise<string | null>((resolve) => {
            const dir = path.dirname(filePath);
            const basename = path.basename(filePath);
            let lastSize = -1;
            let lastSizeTime = 0;
            let resolved = false;

            // FIX: Single deferred-recheck timer tracked by cleanup().
            let deferredRecheck: ReturnType<typeof setTimeout> | null = null;

            // FIX: Concurrency guard — prevents concurrent checkStability()
            // calls from racing on lastSize/lastSizeTime shared state.
            let checking = false;

            const cleanup = () => {
                if (this.watcher) {
                    this.watcher.close();
                    this.watcher = undefined;
                }
                if (this.pollTimer) {
                    clearInterval(this.pollTimer);
                    this.pollTimer = undefined;
                }
                if (deferredRecheck) {
                    clearTimeout(deferredRecheck);
                    deferredRecheck = null;
                }
                clearTimeout(timeoutHandle);
            };

            const finish = (result: string | null) => {
                if (resolved) return;
                resolved = true;
                cleanup();
                resolve(result);
            };

            // Timeout handler
            const timeoutHandle = setTimeout(() => {
                log.info(`[FileStabilityWatcher] Timeout after ${options.timeoutMs}ms for ${basename}`);
                finish(null);
            }, options.timeoutMs);

            // Cancellation handler
            if (options.cancellationToken) {
                options.cancellationToken.onCancellationRequested(() => {
                    finish(null);
                });
            }

            // Check if the file is "stable" (written and no longer changing)
            //
            // FIX: Guarded with `checking` flag to prevent concurrent calls
            // from resetting the stability window. When fs.watch + polling
            // both trigger checkStability(), only one runs at a time.
            const checkStability = async () => {
                if (resolved) return;
                if (checking) return;  // FIX: Skip if another check is in flight
                if (options.cancellationToken?.isCancellationRequested) return;

                checking = true;
                try {
                    const stat = await fs.stat(filePath);
                    const size = stat.size;

                    if (size === 0) {
                        // File exists but is empty — agent hasn't written yet
                        lastSize = 0;
                        lastSizeTime = Date.now();
                        return;
                    }

                    if (size !== lastSize) {
                        // File is still being written
                        lastSize = size;
                        lastSizeTime = Date.now();
                        return;
                    }

                    // Size hasn't changed — check if stable long enough
                    if (Date.now() - lastSizeTime >= stabilityThresholdMs) {
                        log.info(`[FileStabilityWatcher] File stable at ${size} bytes: ${basename}`);
                        const content = await fs.readFile(filePath, 'utf-8');
                        if (content.trim().length > 0) {
                            finish(content);
                        }
                        // If empty after stability, keep waiting (agent might rewrite)
                    }
                } catch {
                    // File doesn't exist yet — keep waiting
                } finally {
                    checking = false;
                }
            };

            // Set up fs.watch for fast detection of file creation
            try {
                this.watcher = watch(dir, (_eventType, filename) => {
                    if (filename === basename) {
                        checkStability().catch(() => { });
                        // Schedule a deferred re-check to guarantee the stability
                        // window is fully evaluated even if no poll aligns with it.
                        // FIX: Use the shared `deferredRecheck` variable so cleanup()
                        // can clear it. Previous code used a separate `stabilityTimer`
                        // that leaked on resolve.
                        if (deferredRecheck) clearTimeout(deferredRecheck);
                        deferredRecheck = setTimeout(() => {
                            deferredRecheck = null;
                            checkStability().catch(() => { });
                        }, stabilityThresholdMs + 200);
                    }
                });
            } catch {
                // watch might fail — fall through to polling
                log.info(`[FileStabilityWatcher] fs.watch failed for ${dir}, using polling only`);
            }

            // Poll periodically as a reliable fallback (fs.watch can be unreliable)
            this.pollTimer = setInterval(() => {
                checkStability().catch(() => { });
            }, pollMs);

            // Initial check in case the file already exists
            checkStability().catch(() => { });
        });
    }
}
