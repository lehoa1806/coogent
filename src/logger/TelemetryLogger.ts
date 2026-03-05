// ─────────────────────────────────────────────────────────────────────────────
// src/logger/TelemetryLogger.ts — Append-only JSONL session logging
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { EngineState } from '../types/index.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Log Entry Types
// ═══════════════════════════════════════════════════════════════════════════════

export interface LogEntry {
    /** ISO 8601 timestamp. */
    timestamp: string;
    /** Log level. */
    level: 'info' | 'warn' | 'error' | 'debug';
    /** Event category. */
    category: 'state' | 'phase' | 'worker' | 'context' | 'system';
    /** Human-readable message. */
    message: string;
    /** Optional structured data. */
    data?: Record<string, unknown>;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  TelemetryLogger
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Append-only JSONL logger for audit and debugging.
 *
 * File structure:
 * ```
 * .coogent/logs/
 *   <run_id>/
 *     engine.jsonl       — state transitions and commands
 *     phase-<id>.jsonl   — per-phase prompts, output, and results
 * ```
 *
 * Entries are written as newline-delimited JSON (JSONL) for easy parsing.
 * All writes are best-effort — logging failures never block execution.
 */
export class TelemetryLogger {
    private readonly logDir: string;
    private runDir: string | null = null;
    private initialized = false;

    constructor(workspaceRoot: string, logDirName = '.coogent/logs') {
        this.logDir = path.join(workspaceRoot, logDirName);
    }

    /**
     * Initialize a new run directory.
     * @param runId Unique run identifier (typically the project_id).
     */
    async initRun(runId: string): Promise<void> {
        this.runDir = path.join(this.logDir, runId);
        try {
            await fs.mkdir(this.runDir, { recursive: true });
            this.initialized = true;
            await this.logEngine('info', `Run initialized: ${runId}`);

            // #48: Enforce rotation — keep max 20 run directories
            await this.enforceRotation(20);
        } catch (err) {
            console.error('[TelemetryLogger] Failed to initialize log directory', err);
        }
    }

    /**
     * Delete oldest run directories if count exceeds maxDirs (#48).
     */
    private async enforceRotation(maxDirs: number): Promise<void> {
        try {
            const entries = await fs.readdir(this.logDir, { withFileTypes: true });
            const dirs = entries.filter(e => e.isDirectory()).map(e => e.name);
            if (dirs.length <= maxDirs) return;

            // Sort by name (timestamp-based names sort chronologically)
            dirs.sort();
            const toDelete = dirs.slice(0, dirs.length - maxDirs);
            for (const dir of toDelete) {
                await fs.rm(path.join(this.logDir, dir), { recursive: true, force: true });
                console.log(`[TelemetryLogger] Rotated old log dir: ${dir}`);
            }
        } catch {
            // Best-effort — rotation failures are non-fatal
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Engine Logging
    // ═══════════════════════════════════════════════════════════════════════════

    /** Log a state transition. */
    async logStateTransition(
        from: EngineState,
        to: EngineState,
        event: string
    ): Promise<void> {
        await this.logEngine('info', `${from} → ${to} (${event})`, {
            from,
            to,
            event,
        });
    }

    /** Log an engine-level event. */
    async logEngine(
        level: LogEntry['level'],
        message: string,
        data?: Record<string, unknown>
    ): Promise<void> {
        await this.appendEntry('engine.jsonl', {
            timestamp: new Date().toISOString(),
            level,
            category: 'state',
            message,
            ...(data !== undefined && { data }),
        });
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Phase Logging
    // ═══════════════════════════════════════════════════════════════════════════

    /** Log the start of a phase execution. */
    async logPhaseStart(phaseId: number): Promise<void> {
        await this.appendPhaseEntry(phaseId, {
            timestamp: new Date().toISOString(),
            level: 'info',
            category: 'phase',
            message: `Phase ${phaseId} started`,
            data: { phaseId },
        });
    }

    /** Log the prompt injected into a worker. */
    async logPhasePrompt(phaseId: number, prompt: string): Promise<void> {
        // #49: Truncate prompt at info level to prevent log bloat
        const truncatedPrompt = prompt.length > 500
            ? prompt.slice(0, 500) + `... [truncated, ${prompt.length} chars total]`
            : prompt;
        await this.appendPhaseEntry(phaseId, {
            timestamp: new Date().toISOString(),
            level: 'debug',
            category: 'phase',
            message: 'Prompt injected',
            data: { prompt: truncatedPrompt },
        });
    }

    /** Log worker output (stdout/stderr). */
    async logPhaseOutput(
        phaseId: number,
        stream: 'stdout' | 'stderr',
        chunk: string
    ): Promise<void> {
        await this.appendPhaseEntry(phaseId, {
            timestamp: new Date().toISOString(),
            level: stream === 'stderr' ? 'warn' : 'debug',
            category: 'worker',
            message: `[${stream}] ${chunk.slice(0, 200)}${chunk.length > 200 ? '...' : ''}`,
            data: { stream, chunk },
        });
    }

    /** Log phase completion result. */
    async logPhaseResult(
        phaseId: number,
        exitCode: number,
        passed: boolean,
        durationMs: number
    ): Promise<void> {
        await this.appendPhaseEntry(phaseId, {
            timestamp: new Date().toISOString(),
            level: passed ? 'info' : 'error',
            category: 'phase',
            message: `Phase ${phaseId} ${passed ? 'PASSED' : 'FAILED'} (exit ${exitCode}, ${durationMs}ms)`,
            data: { exitCode, passed, durationMs },
        });
    }

    /** Log context assembly result. */
    async logContextAssembly(
        phaseId: number,
        totalTokens: number,
        limit: number,
        fileCount: number
    ): Promise<void> {
        await this.appendPhaseEntry(phaseId, {
            timestamp: new Date().toISOString(),
            level: 'info',
            category: 'context',
            message: `Context assembled: ${totalTokens}/${limit} tokens, ${fileCount} files`,
            data: { totalTokens, limit, fileCount },
        });
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Internal — Append to JSONL files
    // ═══════════════════════════════════════════════════════════════════════════

    private async appendEntry(filename: string, entry: LogEntry): Promise<void> {
        if (!this.initialized || !this.runDir) return;

        try {
            const filePath = path.join(this.runDir, filename);
            await fs.appendFile(filePath, JSON.stringify(entry) + '\n', 'utf-8');
        } catch (err) {
            // Logging failures are non-fatal — never block execution
            console.error('[TelemetryLogger] Write failed:', err);
        }
    }

    private async appendPhaseEntry(phaseId: number, entry: LogEntry): Promise<void> {
        await this.appendEntry(`phase-${phaseId}.jsonl`, entry);
    }
}
