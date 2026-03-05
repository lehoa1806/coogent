// ─────────────────────────────────────────────────────────────────────────────
// src/context/HandoffExtractor.ts — Semantic Distillation & State Extraction
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'fs/promises';
import * as path from 'path';
import type { Phase, PhaseId } from '../types/index.js';
import log from '../logger/log.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  HandoffReport Interface
// ═══════════════════════════════════════════════════════════════════════════════

export interface HandoffReport {
    phaseId: number;
    decisions: string[];
    modified_files: string[];
    unresolved_issues: string[];
    next_steps_context: string;
    file_contents?: Record<string, string>;
    timestamp: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  HandoffExtractor
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Implements Semantic Distillation and State Extraction for Phase 4
 * of the 5-Step DAG Execution Flow.
 *
 * Pipeline:
 * 1. Generate a distillation prompt for the worker agent.
 * 2. Parse the worker's output to extract a structured handoff report.
 * 3. Persist/load handoff reports to/from handoffs/.
 * 4. Build next-phase context from dependent phase handoffs.
 */
export class HandoffExtractor {

    /**
     * Returns a prompt instructing the worker to produce a strict JSON
     * Handoff Report at the end of its output.
     */
    generateDistillationPrompt(phaseId: number): string {
        return [
            `After completing your task for Phase ${phaseId}, you MUST append a JSON block`,
            'at the very end of your output, fenced with ```json and ```, containing exactly',
            'these keys:',
            '',
            '```json',
            '{',
            '  "decisions": ["<string: each key decision you made>"],',
            '  "modified_files": ["<string: relative path of every file you created or modified>"],',
            '  "unresolved_issues": ["<string: anything left incomplete or risky>"],',
            '  "next_steps_context": "<string: what the next phase needs to know>"',
            '}',
            '```',
            '',
            'This JSON block is critical for downstream phases. Do NOT omit any key.',
        ].join('\n');
    }

    /**
     * Parse the worker's output to find the JSON handoff block,
     * extract `modified_files`, read their fresh contents from disk,
     * and return a complete `HandoffReport`.
     */
    async extractHandoff(
        phaseId: number,
        workerOutput: string,
        workspaceRoot: string,
    ): Promise<HandoffReport> {
        const parsed = this.parseHandoffJson(workerOutput);

        if (!parsed) {
            log.warn(
                `[HandoffExtractor] Could not parse handoff JSON from phase ${phaseId}. Returning minimal report.`,
            );
            return {
                phaseId,
                decisions: [],
                modified_files: [],
                unresolved_issues: ['Handoff JSON could not be parsed from worker output'],
                next_steps_context: '',
                timestamp: Date.now(),
            };
        }

        // Read fresh file contents for modified files
        const fileContents: Record<string, string> = {};
        const modFiles = Array.isArray(parsed.modified_files) ? parsed.modified_files as string[] : [];
        for (const relPath of modFiles) {
            const absPath = path.resolve(workspaceRoot, relPath);
            try {
                fileContents[relPath] = await fs.readFile(absPath, 'utf-8');
            } catch {
                log.warn(`[HandoffExtractor] Could not read modified file: ${relPath}`);
            }
        }

        return {
            phaseId,
            decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
            modified_files: Array.isArray(parsed.modified_files) ? parsed.modified_files : [],
            unresolved_issues: Array.isArray(parsed.unresolved_issues) ? parsed.unresolved_issues : [],
            next_steps_context: typeof parsed.next_steps_context === 'string' ? parsed.next_steps_context : '',
            file_contents: fileContents,
            timestamp: Date.now(),
        };
    }

    /**
     * Persist a handoff report as `handoffs/phase-{id}.json`.
     */
    async saveHandoff(
        phaseId: number,
        report: HandoffReport,
        sessionDir: string,
    ): Promise<void> {
        const handoffsDir = path.join(sessionDir, 'handoffs');
        await fs.mkdir(handoffsDir, { recursive: true });
        const filePath = path.join(handoffsDir, `phase-${phaseId}.json`);
        await fs.writeFile(filePath, JSON.stringify(report, null, 2), 'utf-8');
    }

    /**
     * Load a previously saved handoff report, or `null` if not found.
     */
    async loadHandoff(
        phaseId: number,
        sessionDir: string,
    ): Promise<HandoffReport | null> {
        const filePath = path.join(sessionDir, 'handoffs', `phase-${phaseId}.json`);
        try {
            const raw = await fs.readFile(filePath, 'utf-8');
            return JSON.parse(raw) as HandoffReport;
        } catch {
            return null;
        }
    }

    /**
     * For a given phase, load handoff reports from all its `depends_on` phases,
     * read the fresh file contents of modified files, and return a concatenated
     * context string suitable for injection into the next worker.
     */
    async buildNextContext(
        phase: Phase,
        sessionDir: string,
        workspaceRoot: string,
    ): Promise<string> {
        const dependsOn: readonly PhaseId[] = phase.depends_on ?? [];
        if (dependsOn.length === 0) {
            return '';
        }

        const sections: string[] = [];

        for (const depId of dependsOn) {
            const report = await this.loadHandoff(depId, sessionDir);
            if (!report) {
                sections.push(`## Phase ${depId} Handoff\n_No handoff report found._\n`);
                continue;
            }

            const lines: string[] = [
                `## Phase ${depId} Handoff`,
                '',
                '### Decisions',
                ...report.decisions.map(d => `- ${d}`),
                '',
                '### Unresolved Issues',
                ...(report.unresolved_issues.length > 0
                    ? report.unresolved_issues.map(i => `- ${i}`)
                    : ['_None_']),
                '',
                '### Next Steps Context',
                report.next_steps_context || '_None_',
                '',
            ];

            // Include fresh file contents for modified files
            if (report.modified_files.length > 0) {
                lines.push('### Modified Files');
                for (const relPath of report.modified_files) {
                    const absPath = path.resolve(workspaceRoot, relPath);
                    try {
                        const content = await fs.readFile(absPath, 'utf-8');
                        lines.push(`\n<<<FILE: ${relPath}>>>`);
                        lines.push(content);
                        lines.push('<<<END FILE>>>');
                    } catch {
                        lines.push(`\n_Could not read: ${relPath}_`);
                    }
                }
                lines.push('');
            }

            sections.push(lines.join('\n'));
        }

        return sections.join('\n---\n\n');
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Private helpers
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Attempt to extract a JSON handoff block from worker output.
     * Looks for the last ```json ... ``` fenced block.
     */
    private parseHandoffJson(output: string): Record<string, unknown> | null {
        // Try fenced JSON blocks (last one wins)
        const fencedRegex = /```json\s*\n([\s\S]*?)```/g;
        let lastMatch: string | null = null;
        let match: RegExpExecArray | null;
        while ((match = fencedRegex.exec(output)) !== null) {
            lastMatch = match[1];
        }

        if (lastMatch) {
            try {
                return JSON.parse(lastMatch.trim());
            } catch {
                // Fall through to raw JSON attempt
            }
        }

        // Fallback: try to find a raw JSON object with the expected keys
        const rawRegex = /\{[\s\S]*?"decisions"[\s\S]*?"modified_files"[\s\S]*?\}/g;
        let lastRawMatch: string | null = null;
        while ((match = rawRegex.exec(output)) !== null) {
            lastRawMatch = match[0];
        }

        if (lastRawMatch) {
            try {
                return JSON.parse(lastRawMatch);
            } catch {
                // Could not parse
            }
        }

        return null;
    }
}
