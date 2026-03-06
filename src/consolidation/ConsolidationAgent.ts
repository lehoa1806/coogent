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
 * Reads all `handoffs/phase-{id}.json` files, aggregates decisions,
 * modified files, and unresolved issues, and produces a structured report.
 */
export class ConsolidationAgent {

    /**
     * Generate a full consolidation report by reading every handoff file
     * referenced in the runbook.
     */
    async generateReport(
        sessionDir: string,
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
            // Try MCP first, then fall back to file-based loading
            let handoff: HandoffReport | null = null;
            if (mcpBridge && masterTaskId) {
                handoff = await this.loadHandoffFromMCP(mcpBridge, masterTaskId, phase.id as number);
            }
            if (!handoff) {
                handoff = await this.loadHandoffFile(sessionDir, phase.id as number);
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
     * Save the formatted Markdown report to `consolidation-report.md`.
     * Returns the file path.
     */
    async saveReport(
        sessionDir: string,
        report: ConsolidationReport,
        mcpBridge?: MCPClientBridge,
        masterTaskId?: string,
    ): Promise<string> {
        const markdown = this.formatAsMarkdown(report);

        // Always write to filesystem
        await fs.mkdir(sessionDir, { recursive: true });
        const filePath = path.join(sessionDir, 'consolidation-report.md');
        await fs.writeFile(filePath, markdown, 'utf-8');

        // Also submit to MCP if bridge is available
        if (mcpBridge && masterTaskId) {
            try {
                await mcpBridge.submitConsolidationReport(masterTaskId, markdown);
                log.info('[ConsolidationAgent] Report submitted to MCP state.');
            } catch (err) {
                log.warn('[ConsolidationAgent] Failed to submit report to MCP:', err);
            }
        }

        return filePath;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Private helpers
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Load a handoff report from `handoffs/phase-{id}.json`,
     * or return `null` if the file does not exist.
     */
    private async loadHandoffFile(
        sessionDir: string,
        phaseId: number,
    ): Promise<HandoffReport | null> {
        const filePath = path.join(
            sessionDir,
            'handoffs',
            `phase-${phaseId}.json`,
        );
        try {
            const raw = await fs.readFile(filePath, 'utf-8');
            return JSON.parse(raw) as HandoffReport;
        } catch {
            return null;
        }
    }

    /**
     * Attempt to read a phase handoff from the MCP server.
     * Maps the MCP `PhaseHandoff` shape (camelCase) to the file-based
     * `HandoffReport` shape (snake_case) for uniform downstream processing.
     *
     * Returns `null` if the resource is empty or the read fails.
     */
    private async loadHandoffFromMCP(
        bridge: MCPClientBridge,
        masterTaskId: string,
        phaseId: number,
    ): Promise<HandoffReport | null> {
        try {
            // Build a phase ID string suitable for MCP URI (e.g., "phase-001-<uuid>")
            // The MCP stores handoffs keyed by phaseId strings, but the consolidation
            // agent works with numeric IDs. We construct a padded prefix to search.
            const paddedPhaseNum = String(phaseId).padStart(3, '0');
            const uri = RESOURCE_URIS.phaseHandoff(masterTaskId, `phase-${paddedPhaseNum}`);
            const handoffJson = await bridge.readResource(uri);

            if (!handoffJson || handoffJson.trim() === '') {
                return null;
            }

            const mcpHandoff = JSON.parse(handoffJson) as Record<string, unknown>;

            // Map MCP PhaseHandoff (camelCase) → file-based HandoffReport (snake_case)
            return {
                phaseId,
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
            log.warn(`[ConsolidationAgent] MCP handoff read failed for phase ${phaseId}:`, err);
            return null;
        }
    }
}
