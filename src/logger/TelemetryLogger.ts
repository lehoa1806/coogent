// ─────────────────────────────────────────────────────────────────────────────
// src/logger/TelemetryLogger.ts — Append-only JSONL session logging
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { EngineState } from '../types/index.js';
import { getTelemetryLogDir, ENGINE_LOG_FILE } from '../constants/paths.js';
import { SecretsGuard } from '../context/SecretsGuard.js';
import log from './log.js';

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

    constructor(workspaceRoot: string) {
        this.logDir = getTelemetryLogDir(workspaceRoot);
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
            log.error('[TelemetryLogger] Failed to initialize log directory', err);
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
                log.info(`[TelemetryLogger] Rotated old log dir: ${dir}`);
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
        await this.appendEntry(ENGINE_LOG_FILE, {
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
        // SEC: Redact detected secrets before persisting to telemetry logs.
        // SecretsGuard.scan() may warn without blocking — redaction ensures
        // leaked secrets are never written to disk in plain text.
        const sanitizedChunk = SecretsGuard.redact(chunk);

        await this.appendPhaseEntry(phaseId, {
            timestamp: new Date().toISOString(),
            level: stream === 'stderr' ? 'warn' : 'debug',
            category: 'worker',
            message: `[${stream}] ${sanitizedChunk.slice(0, 200)}${sanitizedChunk.length > 200 ? '...' : ''}`,
            data: { stream, chunk: sanitizedChunk },
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
    //  Agent Selection Logging
    // ═══════════════════════════════════════════════════════════════════════════

    /** Log an agent selection event — which agent was chosen and why. */
    async logAgentSelected(
        subtaskId: string,
        agentType: string,
        score: number,
        rationale: string[],
    ): Promise<void> {
        await this.logEngine('info', `Agent selected: ${agentType} for ${subtaskId}`, {
            event: 'agent_selected',
            subtaskId,
            agentType,
            score,
            rationale,
        });
    }

    /** Log a successful prompt compilation event. */
    async logPromptCompiled(
        subtaskId: string,
        promptId: string,
        agentType: string,
    ): Promise<void> {
        await this.logEngine('info', `Prompt compiled: ${promptId} (${agentType})`, {
            event: 'prompt_compiled',
            subtaskId,
            promptId,
            agentType,
        });
    }

    /** Log a prompt validation failure event. */
    async logPromptValidationFailed(
        subtaskId: string,
        promptId: string,
        errors: string[],
    ): Promise<void> {
        await this.logEngine('error', `Prompt validation failed: ${promptId}`, {
            event: 'prompt_validation_failed',
            subtaskId,
            promptId,
            errors,
        });
    }

    /** Log a worker mismatch event — agent type doesn't fit the result. */
    async logWorkerMismatch(
        subtaskId: string,
        agentType: string,
        recommendedReassignment: string | null,
    ): Promise<void> {
        await this.logEngine('warn', `Worker mismatch: ${agentType} for ${subtaskId}`, {
            event: 'worker_mismatch',
            subtaskId,
            agentType,
            recommendedReassignment,
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
            log.error('[TelemetryLogger] Write failed:', err);
        }
    }

    private async appendPhaseEntry(phaseId: number, entry: LogEntry): Promise<void> {
        await this.appendEntry(`phase-${phaseId}.jsonl`, entry);
    }
}
