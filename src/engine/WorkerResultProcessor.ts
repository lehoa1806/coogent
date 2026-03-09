// ─────────────────────────────────────────────────────────────────────────────
// src/engine/WorkerResultProcessor.ts — Post-run persistence and evaluation
// ─────────────────────────────────────────────────────────────────────────────
// Extracted from EngineWiring wireEngine() worker lifecycle handlers.

import { asTimestamp } from '../types/index.js';
import { MissionControlPanel } from '../webview/MissionControlPanel.js';
import log from '../logger/log.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Types
// ═══════════════════════════════════════════════════════════════════════════════

/** Minimal interface for the handoff extractor dependency. */
export interface ResultProcessorHandoffExtractor {
    extractHandoff(phaseId: number, output: string): Promise<{
        decisions?: string[];
        modified_files?: string[];
        unresolved_issues?: string[];
    } | null>;
    extractImplementationPlan(
        output: string,
        sessionId: string,
        phaseId: string,
    ): string | null;
}

/** Minimal interface for the MCP bridge dependency. */
export interface ResultProcessorMCPBridge {
    submitPhaseHandoff(
        sessionId: string,
        phaseId: string,
        decisions: string[],
        modifiedFiles: string[],
        unresolvedIssues: string[],
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

        // RACE-FIX: Await handoff extraction + MCP submission BEFORE triggering
        // the engine FSM transition.
        const handoffPromise: Promise<void> = (async () => {
            if (exitCode === 0 && this.handoffExtractor && currentSessionDir) {
                // Persist worker output + stderr to ArtifactDB so it survives session reloads
                if (this.mcpServer && (accumulatedOutput || accumulatedStderr)) {
                    const runbook = this.engine.getRunbook();
                    const phaseObj = runbook?.phases.find(p => p.id === phaseId);
                    const phaseIdStr = phaseObj?.mcpPhaseId;
                    if (phaseIdStr) {
                        this.mcpServer.upsertWorkerOutput(sessionDirName, phaseIdStr, accumulatedOutput, accumulatedStderr);
                    }
                }

                try {
                    const report = await this.handoffExtractor.extractHandoff(phaseId, accumulatedOutput);
                    if (this.mcpBridge && report) {
                        const runbook = this.engine.getRunbook();
                        const phaseObj = runbook?.phases.find(p => p.id === phaseId);
                        const phaseIdStr = phaseObj?.mcpPhaseId;
                        if (!phaseIdStr) {
                            log.warn(`[Coogent] mcpPhaseId missing for phase ${phaseId} — skipping handoff submission.`);
                        } else {
                            await this.mcpBridge.submitPhaseHandoff(
                                sessionDirName,
                                phaseIdStr,
                                report.decisions ?? [],
                                report.modified_files ?? [],
                                report.unresolved_issues ?? []
                            );

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
                if (this.mcpServer) {
                    const rb = this.engine.getRunbook();
                    const pObj = rb?.phases.find(p => p.id === phaseId);
                    if (pObj?.mcpPhaseId) {
                        this.mcpServer.upsertPhaseLog(sessionDirName, pObj.mcpPhaseId, {
                            exitCode: exitCode,
                            completedAt: Date.now(),
                        });
                    }
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
    ): Promise<void> {
        // M3 audit fix: Flush accumulated stdout/stderr to DB before marking failure
        if (this.mcpServer && (accumulatedOutput || accumulatedStderr)) {
            const rb = this.engine.getRunbook();
            const pObj = rb?.phases.find(p => p.id === phaseId);
            if (pObj?.mcpPhaseId) {
                this.mcpServer.upsertWorkerOutput(
                    this.getSessionDirName(),
                    pObj.mcpPhaseId,
                    accumulatedOutput,
                    accumulatedStderr,
                );
            }
        }

        this.engine.onWorkerFailed(phaseId, reason).catch(log.onError);
    }
}
