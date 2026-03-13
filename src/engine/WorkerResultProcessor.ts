// ─────────────────────────────────────────────────────────────────────────────
// src/engine/WorkerResultProcessor.ts — Post-run persistence and evaluation
// ─────────────────────────────────────────────────────────────────────────────
// Extracted from EngineWiring wireEngine() worker lifecycle handlers.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { asTimestamp } from '../types/index.js';
import { IPC_RESPONSE_FILE } from '../constants/paths.js';
import { MissionControlPanel } from '../webview/MissionControlPanel.js';
import log from '../logger/log.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Types
// ═══════════════════════════════════════════════════════════════════════════════

/** Canonical error codes for sentinel handoff reasons. */
export type SentinelErrorCode =
    | 'WORKER_TIMEOUT'
    | 'WORKER_CRASH'
    | 'HANDOFF_EXTRACTION_FAILED';

/** Format a sentinel unresolved_issues entry with a canonical code. */
function formatSentinelIssue(code: SentinelErrorCode, phaseId: number, detail?: string): string {
    const suffix = detail ? ` — ${detail}` : '';
    return `${code}: Phase ${phaseId}${suffix}`;
}

/** Minimal interface for the handoff extractor dependency. */
export interface ResultProcessorHandoffExtractor {
    extractHandoff(phaseId: number, output: string): Promise<{
        decisions?: string[];
        modified_files?: string[];
        unresolved_issues?: string[];
        next_steps_context?: string;
        summary?: string;
        rationale?: string;
        remaining_work?: string[];
        constraints?: string[];
        warnings?: string[];
    }>;
    extractImplementationPlan(
        output: string,
        sessionId: string,
        phaseId: string,
    ): string | null;
}

/** Optional enrichment fields for phase handoff submission. */
export interface PhaseHandoffEnrichment {
    summary?: string | undefined;
    rationale?: string | undefined;
    remainingWork?: string[] | undefined;
    constraints?: string[] | undefined;
    warnings?: string[] | undefined;
}

/** Minimal interface for the MCP bridge dependency. */
export interface ResultProcessorMCPBridge {
    submitPhaseHandoff(
        sessionId: string,
        phaseId: string,
        decisions: string[],
        modifiedFiles: string[],
        unresolvedIssues: string[],
        nextStepsContext?: string,
        enrichment?: PhaseHandoffEnrichment,
    ): Promise<void>;
    submitImplementationPlan(
        sessionId: string,
        plan: string,
        phaseId: string,
    ): Promise<void>;
}

/** Minimal interface for MCP server used by the result processor. */
export interface ResultProcessorMCPServer {
    upsertWorkerOutput(taskId: string, phaseId: string, output: string, stderr: string): void;
    upsertPhaseLog(taskId: string, phaseId: string, data: Record<string, unknown>): void;
    forceFlush(): Promise<void>;
}

/** Minimal interface for the engine used by the result processor. */
export interface ResultProcessorEngine {
    getRunbook(): { phases: { id: number; mcpPhaseId?: string; status?: string }[] } | null;
    onWorkerExited(phaseId: number, exitCode: number): Promise<void>;
    onWorkerFailed(phaseId: number, reason: 'timeout' | 'crash'): Promise<void>;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  WorkerResultProcessor
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Handles worker exit events: extracts handoff data, persists worker output,
 * and triggers FSM transitions.
 *
 * Extracted from the `worker:exited`, `worker:timeout`, and `worker:crash`
 * handlers in wireEngine().
 */
export class WorkerResultProcessor {
    constructor(
        private readonly engine: ResultProcessorEngine,
        private readonly getSessionDirName: () => string,
        private readonly mcpServer?: ResultProcessorMCPServer,
        private readonly handoffExtractor?: ResultProcessorHandoffExtractor,
        private readonly mcpBridge?: ResultProcessorMCPBridge,
    ) { }

    /**
     * Process a worker exit (exit code 0 = success).
     * Extracts handoff, persists output, and triggers FSM transition.
     */
    async processWorkerExit(
        phaseId: number,
        exitCode: number,
        accumulatedOutput: string,
        accumulatedStderr: string,
        currentSessionDir: string | undefined,
    ): Promise<void> {
        const sessionDirName = this.getSessionDirName();

        const runbook = this.engine.getRunbook();
        const phaseObj = runbook?.phases.find(p => p.id === phaseId);
        const phaseIdStr = phaseObj?.mcpPhaseId;

        // RACE-FIX: Await handoff extraction + MCP submission BEFORE triggering
        // the engine FSM transition.
        const handoffPromise: Promise<void> = (async () => {
            if (exitCode === 0 && this.handoffExtractor && currentSessionDir) {

                // Persist worker output + stderr to ArtifactDB so it survives session reloads
                if (this.mcpServer && (accumulatedOutput || accumulatedStderr)) {
                    if (phaseIdStr) {
                        this.mcpServer.upsertWorkerOutput(sessionDirName, phaseIdStr, accumulatedOutput, accumulatedStderr);
                    }
                }

                try {
                    const report = await this.handoffExtractor.extractHandoff(phaseId, accumulatedOutput);
                    if (this.mcpBridge && report) {
                        if (!phaseIdStr) {
                            log.warn(`[Coogent] mcpPhaseId missing for phase ${phaseId} — skipping handoff submission.`);
                        } else {
                            await this.mcpBridge.submitPhaseHandoff(
                                sessionDirName,
                                phaseIdStr,
                                report.decisions ?? [],
                                report.modified_files ?? [],
                                report.unresolved_issues ?? [],
                                report.next_steps_context ?? undefined,
                                {
                                    summary: report.summary ?? undefined,
                                    rationale: report.rationale ?? undefined,
                                    remainingWork: report.remaining_work ?? undefined,
                                    constraints: report.constraints ?? undefined,
                                    warnings: report.warnings ?? undefined,
                                },
                            );

                            // Force flush to disk so the stdio MCP server sees
                            // the handoff when the next dependent phase reads it.
                            await this.mcpServer?.forceFlush();

                            // Handoff persisted via MCP tool handler which
                            // validates + persists transactionally. If the
                            // submitPhaseHandoff call above didn't throw,
                            // the write succeeded.

                            // IPC-FIX: Extract and persist implementation plan from worker output.
                            try {
                                const plan = this.handoffExtractor!.extractImplementationPlan(
                                    accumulatedOutput,
                                    sessionDirName,
                                    phaseIdStr,
                                );
                                if (plan) {
                                    await this.mcpBridge.submitImplementationPlan(
                                        sessionDirName,
                                        plan,
                                        phaseIdStr,
                                    );
                                    log.info(
                                        `[EngineWiring] Extracted and persisted implementation plan ` +
                                        `for phase ${phaseId} (${plan.length} chars).`
                                    );
                                    MissionControlPanel.broadcast({
                                        type: 'LOG_ENTRY',
                                        payload: {
                                            timestamp: asTimestamp(),
                                            level: 'info',
                                            message: `📋 Phase ${phaseId}: implementation plan extracted from worker output.`,
                                        },
                                    });
                                }
                            } catch (planErr) {
                                log.warn(
                                    `[EngineWiring] Phase ${phaseId}: implementation plan ` +
                                    `extraction/submission failed:`,
                                    planErr
                                );
                            }
                        }
                    }
                } catch (err) {
                    log.error('[Coogent] Handoff extraction/submission error:', err);
                    // Persist sentinel handoff so downstream phases
                    // know their parent context is degraded rather than completely missing.
                    if (this.mcpBridge && phaseIdStr) {
                        try {
                            await this.mcpBridge.submitPhaseHandoff(
                                sessionDirName,
                                phaseIdStr,
                                [],
                                [],
                                [formatSentinelIssue('HANDOFF_EXTRACTION_FAILED', phaseId, err instanceof Error ? err.message : String(err))],
                                undefined,
                                undefined,
                            );
                            log.info(`[WorkerResultProcessor] Sentinel handoff persisted for phase ${phaseId}.`);
                        } catch (sentinelErr) {
                            log.warn(`[WorkerResultProcessor] Sentinel handoff also failed:`, sentinelErr);
                        }
                    }
                    // LF-6 FIX: Surface handoff failure to the webview
                    MissionControlPanel.broadcast({
                        type: 'LOG_ENTRY',
                        payload: {
                            timestamp: asTimestamp(),
                            level: 'warn',
                            message: `⚠ Phase ${phaseId}: handoff extraction/submission failed — ` +
                                `child phases may start without full parent context. ` +
                                `(${err instanceof Error ? err.message : String(err)})`,
                        },
                    });
                }
            }
        })();

        // Engine FSM transition fires AFTER handoff is persisted (or fails gracefully).
        await handoffPromise
            .then(() => {
                // Persist phase completion to phase_logs
                if (this.mcpServer && phaseIdStr) {
                    this.mcpServer.upsertPhaseLog(sessionDirName, phaseIdStr, {
                        exitCode: exitCode,
                        completedAt: Date.now(),
                    });
                }

                // ── Runtime persistence: worker response.md (FR2) ────────
                // Persist worker accumulated output to the phase's IPC directory.
                if (accumulatedOutput && currentSessionDir && phaseIdStr) {
                    const phaseDir = path.join(currentSessionDir, phaseIdStr);
                    fs.mkdir(phaseDir, { recursive: true })
                        .then(() => fs.writeFile(path.join(phaseDir, IPC_RESPONSE_FILE), accumulatedOutput, 'utf-8'))
                        .then(() => log.info(`[WorkerResultProcessor] Worker response.md persisted for phase ${phaseId}.`))
                        .catch(err => log.warn(`[WorkerResultProcessor] Failed to persist worker response.md for phase ${phaseId} (non-fatal):`, err));
                }

                return this.engine.onWorkerExited(phaseId, exitCode);
            })
            .catch(log.onError);
    }

    /**
     * Process a worker timeout or crash: flush output and trigger FSM failure.
     */
    async processWorkerFailure(
        phaseId: number,
        reason: 'timeout' | 'crash',
        accumulatedOutput: string,
        accumulatedStderr: string,
        currentSessionDir?: string,
    ): Promise<void> {
        const sessionDirName = this.getSessionDirName();
        const rb = this.engine.getRunbook();
        const phaseObj = rb?.phases.find(p => p.id === phaseId);
        const phaseIdStr = phaseObj?.mcpPhaseId;

        // M3 audit fix: Flush accumulated stdout/stderr to DB before marking failure
        if (this.mcpServer && (accumulatedOutput || accumulatedStderr)) {
            if (phaseIdStr) {
                this.mcpServer.upsertWorkerOutput(
                    sessionDirName,
                    phaseIdStr,
                    accumulatedOutput,
                    accumulatedStderr,
                );
            }
        }

        // Persist a sentinel handoff so downstream phases
        // know their parent timed out or crashed rather than seeing
        // "_No handoff report found._" with zero context.
        if (this.mcpBridge && phaseIdStr) {
            // Best-effort partial modified_files extraction
            // from accumulated output so downstream phases know which files were
            // partially touched before the worker failed.
            let partialFiles: string[] = [];
            if (this.handoffExtractor && accumulatedOutput) {
                try {
                    const partial = await this.handoffExtractor.extractHandoff(phaseId, accumulatedOutput);
                    partialFiles = partial.modified_files ?? [];
                } catch { /* extraction failed — proceed with empty list */ }
            }

            const sentinelCode: SentinelErrorCode = reason === 'timeout' ? 'WORKER_TIMEOUT' : 'WORKER_CRASH';
            try {
                await this.mcpBridge.submitPhaseHandoff(
                    sessionDirName,
                    phaseIdStr,
                    [],
                    partialFiles,
                    [formatSentinelIssue(sentinelCode, phaseId, `${reason === 'timeout' ? 'timed out' : 'crashed'} before producing a handoff report`)],
                    undefined,
                    undefined,
                );
                log.info(`[WorkerResultProcessor] Sentinel handoff persisted for ${reason} phase ${phaseId} (${partialFiles.length} partial files).`);
            } catch (sentinelErr) {
                log.warn(`[WorkerResultProcessor] Sentinel handoff for ${reason} phase ${phaseId} failed:`, sentinelErr);
            }
        }

        // Persist truncated response.md with error marker
        // for crash forensics, matching processWorkerExit file persistence.
        if (accumulatedOutput && currentSessionDir && phaseIdStr) {
            const phaseDir = path.join(currentSessionDir, phaseIdStr);
            const errorHeader = `<!-- WORKER_${reason.toUpperCase()} — phase ${phaseId} -->\n\n`;
            fs.mkdir(phaseDir, { recursive: true })
                .then(() => fs.writeFile(
                    path.join(phaseDir, IPC_RESPONSE_FILE),
                    errorHeader + accumulatedOutput,
                    'utf-8',
                ))
                .then(() => log.info(`[WorkerResultProcessor] Worker response.md (${reason}) persisted for phase ${phaseId}.`))
                .catch(err => log.warn(`[WorkerResultProcessor] Failed to persist ${reason} response.md for phase ${phaseId}:`, err));
        }

        this.engine.onWorkerFailed(phaseId, reason).catch(log.onError);
    }
}
