// ─────────────────────────────────────────────────────────────────────────────
// src/consolidation/ConsolidationAgent.ts — Final read-only reducer agent
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'fs/promises';
import * as path from 'path';
import type { Runbook } from '../types/index.js';
import type { HandoffReport } from '../context/HandoffExtractor.js';

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
    ): Promise<ConsolidationReport> {
        const phaseResults: ConsolidationReport['phaseResults'] = [];
        const allModifiedFiles = new Set<string>();
        const allDecisions: string[] = [];
        const unresolvedIssues: string[] = [];

        let successfulPhases = 0;
        let failedPhases = 0;
        let skippedPhases = 0;

        for (const phase of runbook.phases) {
            const handoff = await this.loadHandoffFile(sessionDir, phase.id as number);

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

        // ── Summary ──────────────────────────────────────────────────────
        lines.push('# Consolidation Report');
        lines.push('');
        lines.push('## Summary');
        lines.push('');
        lines.push(`- **Project ID:** ${report.projectId}`);
        lines.push(`- **Total Phases:** ${report.totalPhases}`);
        lines.push(`- **Successful:** ${report.successfulPhases}`);
        lines.push(`- **Failed:** ${report.failedPhases}`);
        lines.push(`- **Skipped:** ${report.skippedPhases}`);
        lines.push(`- **Generated At:** ${new Date(report.generatedAt).toISOString()}`);
        lines.push('');

        // ── Phase Results ────────────────────────────────────────────────
        lines.push('## Phase Results');
        lines.push('');

        for (const pr of report.phaseResults) {
            lines.push(`### Phase ${pr.phaseId}`);
            lines.push('');
            lines.push(`- **Status:** ${pr.status}`);

            if (pr.decisions.length > 0) {
                lines.push('- **Decisions:**');
                for (const d of pr.decisions) {
                    lines.push(`  - ${d}`);
                }
            } else {
                lines.push('- **Decisions:** _None_');
            }

            if (pr.modifiedFiles.length > 0) {
                lines.push('- **Modified Files:**');
                for (const f of pr.modifiedFiles) {
                    lines.push(`  - \`${f}\``);
                }
            } else {
                lines.push('- **Modified Files:** _None_');
            }

            lines.push('');
        }

        // ── All Modified Files ───────────────────────────────────────────
        lines.push('## All Modified Files');
        lines.push('');
        if (report.allModifiedFiles.length > 0) {
            for (const f of report.allModifiedFiles) {
                lines.push(`- \`${f}\``);
            }
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
        lines.push('## Unresolved Issues');
        lines.push('');
        if (report.unresolvedIssues.length > 0) {
            for (const issue of report.unresolvedIssues) {
                lines.push(`- ${issue}`);
            }
        } else {
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
    ): Promise<string> {
        const markdown = this.formatAsMarkdown(report);
        await fs.mkdir(sessionDir, { recursive: true });
        const filePath = path.join(sessionDir, 'consolidation-report.md');
        await fs.writeFile(filePath, markdown, 'utf-8');
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
}
