// ─────────────────────────────────────────────────────────────────────────────
// src/context/HandoffExtractor.ts — Semantic Distillation & State Extraction
// ─────────────────────────────────────────────────────────────────────────────

import type { Phase, PhaseId } from '../types/index.js';
import type { MCPClientBridge } from '../mcp/MCPClientBridge.js';
import type { ArtifactDB } from '../mcp/ArtifactDB.js';
import { z } from 'zod';
import { SecretsGuard } from './SecretsGuard.js';
import log from '../logger/log.js';

// S2-5 (AI-4): Structured handoff JSON schema
const HandoffJsonSchema = z.object({
    decisions: z.array(z.string()).default([]),
    modified_files: z.array(z.string()).default([]),
    unresolved_issues: z.array(z.string()).default([]),
    next_steps_context: z.string().default(''),
});

// ═══════════════════════════════════════════════════════════════════════════════
//  HandoffReport Interface
// ═══════════════════════════════════════════════════════════════════════════════

export interface HandoffReport {
    phaseId: number;
    decisions: string[];
    modified_files: string[];
    unresolved_issues: string[];
    next_steps_context: string;
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
    /** Optional ArtifactDB for DB-first handoff reads. */
    private db: ArtifactDB | undefined;
    /** Master task ID for DB lookups. */
    private masterTaskId: string | undefined;
    /** Phase lookup map: numeric depId → mcpPhaseId string. */
    private phaseIdMap: Map<number, string> = new Map();

    /**
     * Wire the ArtifactDB for DB-first handoff reads.
     * Called from extension.ts after DB initialisation.
     */
    setArtifactDB(db: ArtifactDB, masterTaskId: string): void {
        this.db = db;
        this.masterTaskId = masterTaskId;
    }

    /**
     * Update the phase ID lookup map from the current runbook.
     * Maps numeric phase ID → mcpPhaseId string for DB queries.
     */
    setPhaseIdMap(phases: Array<{ id: number; mcpPhaseId?: string }>): void {
        this.phaseIdMap.clear();
        for (const p of phases) {
            if (p.mcpPhaseId) {
                this.phaseIdMap.set(p.id, p.mcpPhaseId);
            }
        }
    }

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

        // CF-1 FIX: No longer read raw file contents — workers pull via
        // `get_modified_file_content` MCP tool (Pull Model). Only file
        // *paths* are persisted in the handoff report.

        // Redact any secrets that may have leaked into worker output before persisting
        const decisions = (Array.isArray(parsed.decisions) ? parsed.decisions : []).map(
            (d: string) => SecretsGuard.redact(String(d))
        );
        const unresolvedIssues = (Array.isArray(parsed.unresolved_issues) ? parsed.unresolved_issues : []).map(
            (i: string) => SecretsGuard.redact(String(i))
        );
        const nextSteps = typeof parsed.next_steps_context === 'string'
            ? SecretsGuard.redact(parsed.next_steps_context)
            : '';

        return {
            phaseId,
            decisions,
            modified_files: Array.isArray(parsed.modified_files) ? parsed.modified_files : [],
            unresolved_issues: unresolvedIssues,
            next_steps_context: nextSteps,
            timestamp: Date.now(),
        };
    }

    /**
     * Persist a handoff report to the MCP state store.
     *
     * Sprint 4: Removed file fallback — DB is the authoritative source.
     */
    async saveHandoff(
        phaseId: number,
        report: HandoffReport,
        mcpBridge?: MCPClientBridge,
        masterTaskId?: string,
    ): Promise<void> {
        if (mcpBridge && masterTaskId) {
            try {
                const phaseIdStr = `phase-${String(phaseId).padStart(3, '0')}-00000000-0000-0000-0000-000000000000`;
                await mcpBridge.submitPhaseHandoff(
                    masterTaskId,
                    phaseIdStr,
                    report.decisions ?? [],
                    report.modified_files ?? [],
                    report.unresolved_issues ?? [],
                );
                log.info(`[HandoffExtractor] Phase ${phaseId} handoff submitted to MCP state.`);
            } catch (err) {
                log.warn(`[HandoffExtractor] Failed to submit phase ${phaseId} handoff to MCP:`, err);
            }
        } else {
            log.warn(`[HandoffExtractor] No MCP bridge — phase ${phaseId} handoff NOT persisted.`);
        }
    }

    /**
     * For a given phase, load handoff reports from all its `depends_on` phases
     * and return a concatenated context string with metadata + Pull Model
     * file-fetch directives (no raw file content injection).
     *
     * @param workspaceRoot Unused after CF-1 Pull Model fix; kept for API compat.
     */
    async buildNextContext(
        phase: Phase,
    ): Promise<string> {
        const dependsOn: readonly PhaseId[] = phase.depends_on ?? [];
        if (dependsOn.length === 0) {
            return '';
        }

        const sections: string[] = [];

        for (const depId of dependsOn) {
            // S4: DB-first handoff read (Sprint 4: file fallback removed — DB is authoritative)
            let report: HandoffReport | null = null;

            if (this.db && this.masterTaskId) {
                const mcpPhaseId = this.phaseIdMap.get(depId);
                if (mcpPhaseId) {
                    try {
                        const dbHandoff = this.db.handoffs.get(this.masterTaskId, mcpPhaseId);
                        if (dbHandoff) {
                            report = {
                                phaseId: depId,
                                decisions: dbHandoff.decisions,
                                modified_files: dbHandoff.modifiedFiles,
                                unresolved_issues: dbHandoff.blockers,
                                next_steps_context: dbHandoff.nextStepsContext ?? '',
                                timestamp: dbHandoff.completedAt,
                            };
                        }
                    } catch (err) {
                        log.warn(`[HandoffExtractor] DB read failed for phase ${depId}:`, err);
                    }
                }
            }

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

            // CF-1 FIX: Pull Model — emit tool-call directives instead of
            // raw file bytes. Workers fetch content on demand via the MCP
            // `get_modified_file_content` tool, staying within token budget.
            if (report.modified_files.length > 0) {
                lines.push('### Modified Files');
                lines.push('Fetch these files via `get_modified_file_content`:');
                for (const relPath of report.modified_files) {
                    lines.push(`- \`get_modified_file_content\` → \`${relPath}\``);
                }
                lines.push('');
            }

            sections.push(lines.join('\n'));
        }

        return sections.join('\n---\n\n');
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Implementation Plan Extraction (file-IPC fallback)
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Extract an implementation plan from the worker's accumulated output.
     *
     * When the worker runs via file-based IPC (no vscode.lm), it cannot call
     * `submit_implementation_plan` via the in-process MCP server. This method
     * post-processes the worker output to extract the plan for persistence.
     *
     * Extraction heuristics (in priority order):
     *   1. Fenced block: ` ```implementation_plan ... ``` `
     *   2. Heading-based: Content under `## Proposed Changes` or
     *      `## Implementation Plan` headings, up to the handoff JSON block.
     *
     * @param workerOutput  The full accumulated stdout from the worker.
     * @param masterTaskId  Master task ID for dedup check.
     * @param phaseId       MCP phase ID string for dedup check.
     * @returns The plan markdown, or `null` if no plan found or already persisted.
     */
    extractImplementationPlan(
        workerOutput: string,
        masterTaskId?: string,
        phaseId?: string,
    ): string | null {
        // Dedup guard: skip extraction if a plan already exists in ArtifactDB
        if (this.db && masterTaskId && phaseId) {
            try {
                const task = this.db.tasks.get(masterTaskId);
                const phase = task?.phases.get(phaseId);
                if (phase?.implementationPlan) {
                    log.info(
                        `[HandoffExtractor] Implementation plan already exists for ` +
                        `${masterTaskId}/${phaseId} — skipping extraction.`
                    );
                    return null;
                }
            } catch (err) {
                log.warn(`[HandoffExtractor] Dedup check failed:`, err);
                // Continue with extraction — better to duplicate than lose the plan
            }
        }

        // Heuristic 1: Fenced ` ```implementation_plan ``` ` block
        const fencedPlanRegex = /```implementation_plan\s*\n([\s\S]*?)```/g;
        let lastFencedPlan: string | null = null;
        let fencedMatch: RegExpExecArray | null;
        while ((fencedMatch = fencedPlanRegex.exec(workerOutput)) !== null) {
            lastFencedPlan = fencedMatch[1].trim();
        }
        if (lastFencedPlan && lastFencedPlan.length > 100) {
            log.info(
                `[HandoffExtractor] Extracted implementation plan from fenced block ` +
                `(${lastFencedPlan.length} chars).`
            );
            return lastFencedPlan;
        }

        // Heuristic 2: Heading-based extraction
        // Look for ## Proposed Changes or ## Implementation Plan
        const headingPattern = /^(#{1,2}\s+(?:Proposed Changes|Implementation Plan))\s*$/im;
        const headingMatch = headingPattern.exec(workerOutput);
        if (headingMatch) {
            const startIdx = headingMatch.index;

            // End boundary: the handoff JSON block or next top-level section
            // that is NOT part of the plan (e.g. ## Verification, ```json)
            const remainingOutput = workerOutput.slice(startIdx);

            // Find the end: either the handoff JSON fence or a non-plan heading
            const endPatterns = [
                /\n```json\s*\n\s*\{[\s\S]*?"decisions"/,    // handoff JSON block
                /\n#{1,2}\s+(?:Verification|Context from Previous|MCP Context|Task)\b[^\n]*\n/i,
            ];

            let endIdx = remainingOutput.length;
            for (const pattern of endPatterns) {
                const endMatch = pattern.exec(remainingOutput);
                if (endMatch && endMatch.index < endIdx) {
                    endIdx = endMatch.index;
                }
            }

            const plan = remainingOutput.slice(0, endIdx).trim();
            if (plan.length > 100) {
                log.info(
                    `[HandoffExtractor] Extracted implementation plan from heading ` +
                    `"${headingMatch[1]}" (${plan.length} chars).`
                );
                return plan;
            }
        }

        log.debug(`[HandoffExtractor] No implementation plan found in worker output.`);
        return null;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Private helpers
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * S2-5 (AI-4): Parse handoff JSON with Zod validation.
     * Attempts fenced JSON blocks first, then tries raw JSON extraction.
     * Falls back to Zod `.safeParse()` for structural validation.
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
                const raw = JSON.parse(lastMatch.trim());
                const result = HandoffJsonSchema.safeParse(raw);
                if (result.success) {
                    return result.data;
                }
                log.warn(`[HandoffExtractor] Handoff JSON failed Zod validation: ${result.error.message}`);
                // Continue to try raw fallback
            } catch {
                // Fall through to raw JSON attempt
            }
        }

        // S2-5 (AI-4): Fallback — use brace-counting to find balanced JSON objects,
        // then validate with Zod. SEC-3: Requires at least one discriminator key.
        const jsonCandidates = HandoffExtractor.extractBalancedJsonObjects(output);
        for (let i = jsonCandidates.length - 1; i >= 0; i--) {
            try {
                const raw = JSON.parse(jsonCandidates[i]);
                // SEC-3: Require at least one handoff discriminator key
                if (!('decisions' in raw || 'modified_files' in raw || 'unresolved_issues' in raw)) {
                    continue;
                }
                const result = HandoffJsonSchema.safeParse(raw);
                if (result.success) {
                    return result.data;
                }
            } catch {
                // Not valid JSON — try next candidate
            }
        }

        return null;
    }

    /**
     * SEC-3: Extract balanced JSON objects from text using brace-counting.
     * Handles nested objects and skips braces inside string literals.
     * Returns an array of candidate JSON strings.
     */
    private static extractBalancedJsonObjects(text: string): string[] {
        const candidates: string[] = [];
        let i = 0;

        while (i < text.length) {
            if (text[i] !== '{') { i++; continue; }

            // Found an opening brace — count depth
            let depth = 0;
            let inString: '"' | "'" | false = false;
            let escaped = false;
            const start = i;

            for (let j = i; j < text.length; j++) {
                const ch = text[j];

                if (escaped) { escaped = false; continue; }
                if (ch === '\\' && inString) { escaped = true; continue; }

                if (inString) {
                    if (ch === inString) inString = false;
                    continue;
                }

                if (ch === '"' || ch === "'") { inString = ch; continue; }
                if (ch === '{') depth++;
                if (ch === '}') {
                    depth--;
                    if (depth === 0) {
                        candidates.push(text.slice(start, j + 1));
                        i = j + 1;
                        break;
                    }
                }
            }

            // If depth never reached 0, skip this opening brace
            if (depth > 0) { i = start + 1; }
        }

        return candidates;
    }
}
