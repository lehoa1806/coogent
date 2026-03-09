// ─────────────────────────────────────────────────────────────────────────────
// src/planner/RunbookParser.ts — Runbook JSON extraction and validation
// ─────────────────────────────────────────────────────────────────────────────

import { asPhaseId, type Runbook } from '../types/index.js';
import log from '../logger/log.js';

/**
 * Extracts and validates a Runbook from raw LLM output.
 *
 * Parsing strategies (in order):
 * 1. Fenced ```json code block
 * 2. Raw JSON object containing a `"phases"` array
 */
export class RunbookParser {
    /**
     * Attempt to parse a Runbook from raw agent output.
     * @param output Raw text output from the planner LLM.
     * @returns A validated Runbook, or `null` if parsing/validation fails.
     */
    parse(output: string): Runbook | null {
        // Strategy 1: Look for ```json ... ``` fenced code block
        // #44: Use non-greedy pattern to avoid over-capturing
        const fencedMatch = output.match(/```json\s*\n([\s\S]*?)\n```/);
        if (fencedMatch) {
            try {
                return this.validateRunbook(JSON.parse(fencedMatch[1]));
            } catch { /* fall through */ }
        }

        // Strategy 2: Look for raw JSON object { ... } — non-greedy (#44)
        const jsonMatch = output.match(/\{[\s\S]*?"phases"\s*:\s*\[[\s\S]*?\]\s*[\s\S]*?\}/);
        if (jsonMatch) {
            try {
                return this.validateRunbook(JSON.parse(jsonMatch[0]));
            } catch { /* fall through */ }
        }

        return null;
    }

    /**
     * Validate that parsed JSON has the minimum required Runbook shape.
     * #43: Also validates depends_on refs and checks for duplicate phase IDs.
     */
    private validateRunbook(obj: unknown): Runbook | null {
        if (!obj || typeof obj !== 'object') return null;
        const r = obj as Record<string, unknown>;

        if (typeof r.project_id !== 'string') return null;
        if (!Array.isArray(r.phases) || r.phases.length === 0) return null;

        // Validate each phase has required fields
        const seenIds = new Set<number>();
        for (const p of r.phases) {
            if (typeof p !== 'object' || p === null) return null;
            const phase = p as Record<string, unknown>;
            if (typeof phase.id !== 'number') return null;
            if (typeof phase.prompt !== 'string') return null;
            if (!Array.isArray(phase.context_files)) return null;
            if (typeof phase.success_criteria !== 'string') return null;

            // #43: Check for duplicate phase IDs
            if (seenIds.has(phase.id as number)) {
                log.warn(`[RunbookParser] Duplicate phase ID: ${phase.id}`);
                return null;
            }
            seenIds.add(phase.id as number);
        }

        // #43: Validate depends_on references
        for (const p of r.phases) {
            const phase = p as Record<string, unknown>;
            if (Array.isArray(phase.depends_on)) {
                for (const dep of phase.depends_on) {
                    if (typeof dep !== 'number' || !seenIds.has(dep)) {
                        log.warn(`[RunbookParser] Invalid depends_on reference: phase ${phase.id} depends on non-existent phase ${dep}`);
                        return null;
                    }
                }
            }
        }

        // Ensure default fields
        return {
            project_id: r.project_id as string,
            status: 'idle',
            current_phase: (r.phases as Array<Record<string, unknown>>).length > 0
                ? ((r.phases as Array<Record<string, unknown>>)[0] as Record<string, unknown>).id as number
                : 1,
            ...(typeof r.summary === 'string' ? { summary: r.summary } : {}),
            ...(typeof r.implementation_plan === 'string' ? { implementation_plan: r.implementation_plan } : {}),
            phases: (r.phases as Array<Record<string, unknown>>).map((p, i) => ({
                id: asPhaseId(typeof p.id === 'number' ? p.id : i),
                status: 'pending' as const,
                prompt: p.prompt as string,
                context_files: p.context_files as string[],
                success_criteria: (p.success_criteria as string) || 'exit_code:0',
                ...(Array.isArray(p.depends_on) ? { depends_on: (p.depends_on as number[]).map(asPhaseId) } : {}),
                ...(typeof p.context_summary === 'string' ? { context_summary: p.context_summary } : {}),
            })),
        };
    }
}
