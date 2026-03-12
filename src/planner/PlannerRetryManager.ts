// ─────────────────────────────────────────────────────────────────────────────
// src/planner/PlannerRetryManager.ts — Retry/cache logic for planner output
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Runbook } from '../types/index.js';
import { COOGENT_DIR, IPC_DIR, IPC_RESPONSE_FILE, RUNBOOK_FILE } from '../constants/paths.js';
import { RunbookParser } from './RunbookParser.js';
import log from '../logger/log.js';

export interface RetryParseResult {
    success: boolean;
    runbook: Runbook | null;
    /** Status key to emit. */
    statusKey: 'ready' | 'error';
    /** Human-readable status message. */
    statusMessage: string;
    /** Error to emit (only when success=false). */
    error?: Error;
}

/**
 * Manages cached output from timed-out or errored planner sessions,
 * and attempts to re-parse runbooks from that cached data.
 */
export class PlannerRetryManager {
    static readonly MAX_TIMEOUT_OUTPUT_CHARS = 512_000;

    /** Cached accumulated output from the last timeout/error. */
    private lastTimeoutOutput: string | null = null;
    /** Last IPC session directory — used to read response.md from disk. */
    private lastIpcSessionDir: string | null = null;

    private readonly parser: RunbookParser;

    constructor(parser?: RunbookParser) {
        this.parser = parser ?? new RunbookParser();
    }

    /**
     * Cache output from a timed-out or errored session.
     * @param output       Accumulated output text.
     * @param sessionDir   IPC session directory name (for file-based retry).
     */
    cacheOutput(output: string, sessionDir?: string | null): void {
        const hasOutput = output.length > 0;
        this.lastTimeoutOutput = hasOutput
            ? output.slice(-PlannerRetryManager.MAX_TIMEOUT_OUTPUT_CHARS)
            : null;
        if (sessionDir !== undefined) {
            this.lastIpcSessionDir = sessionDir ?? null;
        }
    }

    /**
     * Set the IPC session directory for file-based retry.
     */
    setSessionDir(dir: string | null): void {
        this.lastIpcSessionDir = dir;
    }

    /**
     * Get the current IPC session directory.
     */
    getSessionDir(): string | null {
        return this.lastIpcSessionDir;
    }

    /** Check whether retry parse data is available. */
    hasRetryData(): boolean {
        return (
            (this.lastTimeoutOutput !== null && this.lastTimeoutOutput.trim().length > 0) ||
            this.lastIpcSessionDir !== null
        );
    }

    /** Clear all cached retry state. */
    clear(): void {
        this.lastTimeoutOutput = null;
        this.lastIpcSessionDir = null;
    }

    /**
     * Re-attempt parsing from cached output or from the response file on disk.
     *
     * Strategy:
     *  1. If `lastTimeoutOutput` has content, parse that (vscode.lm streaming path).
     *  2. Otherwise, try reading response.md from the last IPC session directory
     *     (file-based IPC path — the chat agent may have written it after timeout).
     */
    async retryParse(
        workspaceRoot: string,
        masterTaskId?: string,
    ): Promise<RetryParseResult> {
        // Strategy 0: Read .task-runbook.json from disk (canonical runbook location)
        if (masterTaskId) {
            const runbookPath = path.join(workspaceRoot, COOGENT_DIR, IPC_DIR, masterTaskId, RUNBOOK_FILE);
            try {
                const content = await fs.readFile(runbookPath, 'utf-8');
                if (content.trim().length > 0) {
                    log.info(`[PlannerRetryManager] retryParse() — read ${content.length} chars from ${runbookPath}`);
                    const parsed = this.parser.parse(content);
                    if (parsed) {
                        this.clear();
                        return {
                            success: true,
                            runbook: parsed,
                            statusKey: 'ready',
                            statusMessage: 'Plan loaded from .task-runbook.json',
                        };
                    }
                    log.warn(`[PlannerRetryManager] .task-runbook.json exists but failed validation`);
                }
            } catch {
                // File doesn't exist — continue to other strategies
            }
        }

        // Strategy 1: Use cached streaming output (vscode.lm path)
        if (this.lastTimeoutOutput && this.lastTimeoutOutput.trim().length > 0) {
            log.info(`[PlannerRetryManager] retryParse() — parsing ${this.lastTimeoutOutput.length} cached chars`);
            const parsed = this.parser.parse(this.lastTimeoutOutput);
            if (parsed) {
                this.clear();
                return {
                    success: true,
                    runbook: parsed,
                    statusKey: 'ready',
                    statusMessage: 'Plan parsed from cached output',
                };
            }
            // Fall through to Strategy 2 if cached output doesn't parse
        }

        // Strategy 2: Read response.md from disk (file-based IPC path)
        if (this.lastIpcSessionDir) {
            const ipcBase = path.join(workspaceRoot, COOGENT_DIR, IPC_DIR);
            const candidates: string[] = [];

            // Primary: use masterTaskId-nested path
            if (masterTaskId) {
                candidates.push(
                    path.join(ipcBase, masterTaskId, `phase-000-${this.lastIpcSessionDir}`, IPC_RESPONSE_FILE)
                );
            }

            // Fallback: direct session dir (legacy or no masterTaskId)
            candidates.push(
                path.join(ipcBase, this.lastIpcSessionDir, IPC_RESPONSE_FILE),
            );

            for (const responseFile of candidates) {
                try {
                    const content = await fs.readFile(responseFile, 'utf-8');
                    if (content.trim().length > 0) {
                        log.info(`[PlannerRetryManager] retryParse() — read ${content.length} chars from ${responseFile}`);
                        const parsed = this.parser.parse(content);
                        if (parsed) {
                            this.clear();
                            return {
                                success: true,
                                runbook: parsed,
                                statusKey: 'ready',
                                statusMessage: 'Plan loaded from response file',
                            };
                        }
                        // Content exists but didn't parse — report what we found
                        const errorMsg = 'Response file exists but does not contain a valid JSON runbook.\n' +
                            `File: ${responseFile}\nFirst 500 chars:\n${content.slice(0, 500)}`;
                        log.error(`[PlannerRetryManager] retryParse() FAILED: ${errorMsg}`);
                        return {
                            success: false,
                            runbook: null,
                            statusKey: 'error',
                            statusMessage: 'Response file found but failed to parse',
                            error: new Error(errorMsg),
                        };
                    }
                } catch {
                    // File doesn't exist at this path — try next candidate
                }
            }
        }

        // Nothing found
        const msg = this.lastIpcSessionDir
            ? 'No response file found on disk yet. The chat agent may still be writing. Try again in a moment.'
            : 'No cached output or response file to parse — please regenerate the plan.';
        log.warn(`[PlannerRetryManager] retryParse() — ${msg}`);
        return {
            success: false,
            runbook: null,
            statusKey: 'error',
            statusMessage: msg,
            error: new Error(msg),
        };
    }
}
