// ─────────────────────────────────────────────────────────────────────────────
// src/consolidation/ConsolidationAgent.ts — Final read-only reducer agent
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'fs/promises';
import * as path from 'path';
import type { Runbook } from '../types/index.js';
import type { HandoffReport } from '../context/HandoffExtractor.js';
import type { MCPClientBridge } from '../mcp/MCPClientBridge.js';
import { RESOURCE_URIS } from '../mcp/types.js';
import log from '../logger/log.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  ConsolidationReport Interface
// ═══════════════════════════════════════════════════════════════════════════════

export interface ConsolidationReport {
    projectId: string;
    totalPhases: number;
    successfulPhases: number;
    failedPhases: number;
    skippedPhases: number;
    allModifiedFiles: string[];
    allDecisions: string[];
    unresolvedIssues: string[];
    phaseResults: Array<{
        phaseId: number;
        status: string;
        decisions: string[];
        modifiedFiles: string[];
    }>;
    generatedAt: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ConsolidationAgent
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Implements Phase 5 of the 5-Step DAG Execution Flow.
 *
 * Reads handoffs from the MCP state store, aggregates decisions,
 * modified files, and unresolved issues, and produces a structured report.
 *
 * Sprint 4: File-based fallback removed — MCP/DB is the authoritative source.
 */
export class ConsolidationAgent {

    /**
     * Generate a full consolidation report by reading every handoff file
     * referenced in the runbook.
     */
    async generateReport(
        _sessionDir: string,
        runbook: Runbook,
        mcpBridge?: MCPClientBridge,
        masterTaskId?: string,
    ): Promise<ConsolidationReport> {
        const phaseResults: ConsolidationReport['phaseResults'] = [];
        const allModifiedFiles = new Set<string>();
        const allDecisions: string[] = [];
        const unresolvedIssues: string[] = [];

        let successfulPhases = 0;
        let failedPhases = 0;
        let skippedPhases = 0;

        for (const phase of runbook.phases) {
            // MCP-only handoff read (Sprint 4: file fallback removed)
            let handoff: HandoffReport | null = null;
            if (mcpBridge && masterTaskId && phase.mcpPhaseId) {
                handoff = await this.loadHandoffFromMCP(mcpBridge, masterTaskId, phase.mcpPhaseId);
            }

            if (handoff) {
                const decisions = Array.isArray(handoff.decisions) ? handoff.decisions : [];
                const modifiedFiles = Array.isArray(handoff.modified_files) ? handoff.modified_files : [];

                phaseResults.push({
                    phaseId: phase.id as number,
                    status: phase.status,
                    decisions,
                    modifiedFiles,
                });

                for (const f of modifiedFiles) {
                    allModifiedFiles.add(f);
                }
                allDecisions.push(...decisions);

                if (Array.isArray(handoff.unresolved_issues)) {
                    unresolvedIssues.push(...handoff.unresolved_issues);
                }

                if (phase.status === 'completed') {
                    successfulPhases++;
                } else if (phase.status === 'failed') {
                    failedPhases++;
                } else {
                    skippedPhases++;
                }
            } else {
                // No handoff file — treat as skipped
                phaseResults.push({
                    phaseId: phase.id as number,
                    status: phase.status,
                    decisions: [],
                    modifiedFiles: [],
                });
                skippedPhases++;
            }
        }

        return {
            projectId: runbook.project_id,
            totalPhases: runbook.phases.length,
            successfulPhases,
            failedPhases,
            skippedPhases,
            allModifiedFiles: [...allModifiedFiles],
            allDecisions,
            unresolvedIssues,
            phaseResults,
            generatedAt: Date.now(),
        };
    }

    /**
     * Convert a ConsolidationReport into a human-readable Markdown document.
     */
    formatAsMarkdown(report: ConsolidationReport): string {
        const lines: string[] = [];
        const ts = new Date(report.generatedAt).toISOString();

        // ── Title ──────────────────────────────────────────────────────
        lines.push('# Walkthrough');
        lines.push('');

        // ── Summary Table ──────────────────────────────────────────────
        lines.push('## Summary');
        lines.push('');
        lines.push('| Metric | Value |');
        lines.push('|--------|-------|');
        lines.push(`| **Project** | ${report.projectId} |`);
        lines.push(`| **Total Phases** | ${report.totalPhases} |`);
        lines.push(`| **Successful** | ${report.successfulPhases} |`);
        lines.push(`| **Failed** | ${report.failedPhases} |`);
        lines.push(`| **Skipped** | ${report.skippedPhases} |`);
        lines.push(`| **Generated** | ${ts} |`);
        lines.push('');

        // ── Overall Status Alert ─────────────────────────────────────
        if (report.failedPhases > 0) {
            lines.push('> [!WARNING]');
            lines.push(`> ${report.failedPhases} phase(s) failed during execution. Review the phase results below for details.`);
        } else if (report.successfulPhases === report.totalPhases && report.totalPhases > 0) {
            lines.push('> [!NOTE]');
            lines.push('> All phases completed successfully.');
        }
        lines.push('');

        // ── Phase Results ────────────────────────────────────────────────
        lines.push('## Phase Results');
        lines.push('');

        for (const pr of report.phaseResults) {
            const icon = pr.status === 'completed' ? '✅' : pr.status === 'failed' ? '❌' : '⏭️';
            lines.push(`### ${icon} Phase ${pr.phaseId}`);
            lines.push('');
            lines.push(`**Status:** ${pr.status}`);
            lines.push('');

            if (pr.decisions.length > 0) {
                lines.push('**Decisions:**');
                for (const d of pr.decisions) {
                    lines.push(`- ${d}`);
                }
            } else {
                lines.push('**Decisions:** _None_');
            }
            lines.push('');

            if (pr.modifiedFiles.length > 0) {
                lines.push('**Modified Files:**');
                lines.push('');
                lines.push('```diff');
                for (const f of pr.modifiedFiles) {
                    lines.push(`+ ${f}`);
                }
                lines.push('```');
            } else {
                lines.push('**Modified Files:** _None_');
            }

            lines.push('');
            lines.push('---');
            lines.push('');
        }

        // ── All Modified Files ───────────────────────────────────────────
        lines.push('## All Modified Files');
        lines.push('');
        if (report.allModifiedFiles.length > 0) {
            lines.push('```diff');
            for (const f of report.allModifiedFiles) {
                lines.push(`+ ${f}`);
            }
            lines.push('```');
        } else {
            lines.push('_No files were modified._');
        }
        lines.push('');

        // ── Decisions Made ───────────────────────────────────────────────
        lines.push('## Decisions Made');
        lines.push('');
        if (report.allDecisions.length > 0) {
            for (const d of report.allDecisions) {
                lines.push(`- ${d}`);
            }
        } else {
            lines.push('_No decisions recorded._');
        }
        lines.push('');

        // ── Unresolved Issues ────────────────────────────────────────────
        if (report.unresolvedIssues.length > 0) {
            lines.push('## Unresolved Issues');
            lines.push('');
            lines.push('> [!CAUTION]');
            lines.push('> The following issues were not resolved during execution:');
            lines.push('');
            for (const issue of report.unresolvedIssues) {
                lines.push(`- ${issue}`);
            }
        } else {
            lines.push('## Unresolved Issues');
            lines.push('');
            lines.push('_No unresolved issues._');
        }
        lines.push('');

        return lines.join('\n');
    }

    /**
     * Submit the consolidation report to the MCP state store.
     *
     * V1 Purification: No longer writes `consolidation-report.md` to disk.
     * The in-memory MCP Server is the single source of truth for artifacts.
     */
    async saveReport(
        sessionDir: string,
        report: ConsolidationReport,
        mcpBridge?: MCPClientBridge,
        masterTaskId?: string,
    ): Promise<void> {
        const markdown = this.formatAsMarkdown(report);

        if (mcpBridge && masterTaskId) {
            await mcpBridge.submitConsolidationReport(masterTaskId, markdown);

            // S6b audit fix: Persist structured ConsolidationReport as JSON
            // so programmatic queries don't need to re-parse Markdown.
            try {
                await mcpBridge.submitConsolidationReportJson(masterTaskId, JSON.stringify(report));
            } catch (err) {
                log.warn('[ConsolidationAgent] Failed to persist structured report JSON (non-fatal):', err);
            }

            log.info('[ConsolidationAgent] Report submitted to MCP state.');
        } else {
            log.warn('[ConsolidationAgent] No MCP bridge available — report NOT persisted.');
        }

        // D1 audit fix: IPC debug clone — consolidation report (best-effort, non-fatal)
        if (sessionDir) {
            const debugDir = path.join(sessionDir, 'debug');
            fs.mkdir(debugDir, { recursive: true })
                .then(() => fs.writeFile(path.join(debugDir, 'consolidation-report.md'), markdown, 'utf-8'))
                .catch(err => log.warn('[ConsolidationAgent] Debug clone (report) failed (non-fatal):', err));
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Private helpers
    // ═══════════════════════════════════════════════════════════════════════════



    /**
     * Attempt to read a phase handoff from the MCP server.
     * Maps the MCP `PhaseHandoff` shape (camelCase) to the file-based
     * `HandoffReport` shape (snake_case) for uniform downstream processing.
     *
     * @param mcpPhaseId  The real compound phase ID (e.g., `phase-001-<uuid>`).
     *                    Must match the key used by `handleSubmitPhaseHandoff()`.
     * Returns `null` if the resource is empty or the read fails.
     */
    private async loadHandoffFromMCP(
        bridge: MCPClientBridge,
        masterTaskId: string,
        mcpPhaseId: string,
    ): Promise<HandoffReport | null> {
        try {
            const uri = RESOURCE_URIS.phaseHandoff(masterTaskId, mcpPhaseId);
            const handoffJson = await bridge.readResource(uri);

            if (!handoffJson || handoffJson.trim() === '') {
                return null;
            }

            const mcpHandoff = JSON.parse(handoffJson) as Record<string, unknown>;

            // Map MCP PhaseHandoff (camelCase) → file-based HandoffReport (snake_case)
            // Extract numeric index from compound ID (e.g., "phase-001-<uuid>" → 1)
            const numericId = parseInt(mcpPhaseId.replace(/^phase-/, '').split('-')[0], 10);
            return {
                phaseId: isNaN(numericId) ? 0 : numericId,
                decisions: Array.isArray(mcpHandoff.decisions) ? mcpHandoff.decisions as string[] : [],
                modified_files: Array.isArray(mcpHandoff.modifiedFiles)
                    ? mcpHandoff.modifiedFiles as string[]
                    : (Array.isArray(mcpHandoff.modified_files) ? mcpHandoff.modified_files as string[] : []),
                unresolved_issues: Array.isArray(mcpHandoff.blockers)
                    ? mcpHandoff.blockers as string[]
                    : (Array.isArray(mcpHandoff.unresolved_issues) ? mcpHandoff.unresolved_issues as string[] : []),
                next_steps_context: typeof mcpHandoff.next_steps_context === 'string'
                    ? mcpHandoff.next_steps_context
                    : '',
                timestamp: typeof mcpHandoff.completedAt === 'number'
                    ? mcpHandoff.completedAt as number
                    : Date.now(),
            };
        } catch (err) {
            log.warn(`[ConsolidationAgent] MCP handoff read failed for phase ${mcpPhaseId}:`, err);
            return null;
        }
    }
}
