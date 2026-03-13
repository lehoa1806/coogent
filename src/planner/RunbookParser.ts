// ─────────────────────────────────────────────────────────────────────────────
// src/planner/RunbookParser.ts — Runbook JSON extraction and validation
// ─────────────────────────────────────────────────────────────────────────────

import { asPhaseId, type Runbook } from '../types/index.js';
import log from '../logger/log.js';

/**
 * Extracts and validates a Runbook from raw LLM output.
 *
 * Parsing strategies (in order):
 * 1. Raw JSON object containing a `"phases"` array
 * 2. Fenced ```json code block (backward-compatible fallback)
 */
export class RunbookParser {
    /**
     * Attempt to parse a Runbook from raw agent output.
     * @param output Raw text output from the planner LLM.
     * @returns A validated Runbook, or `null` if parsing/validation fails.
     */
    parse(output: string): Runbook | null {
        log.info(`[RunbookParser] parse() called with ${output.length} chars`);

        // Strategy 1: Brace-counting extraction of the outermost JSON object.
        // (Replaces the former regex approach which failed on nested brackets — #44)
        const jsonCandidate = this.extractOutermostJson(output);
        if (jsonCandidate) {
            log.info(`[RunbookParser] Strategy 1: extractOutermostJson found ${jsonCandidate.length} chars (first 200: ${jsonCandidate.slice(0, 200)})`);
            try {
                const obj = JSON.parse(jsonCandidate);
                const result = this.validateRunbook(obj);
                if (result) return result;
                log.warn(`[RunbookParser] Strategy 1: JSON parsed OK but validateRunbook rejected it`);
            } catch (err) {
                log.warn(`[RunbookParser] Strategy 1: JSON.parse failed: ${err instanceof Error ? err.message : String(err)}`);
            }

            // Strategy 1b: Attempt JSON repair on the extracted candidate.
            // LLMs often produce trailing commas, unescaped newlines inside
            // string values, or other minor formatting issues.
            try {
                const repaired = this.repairJson(jsonCandidate);
                if (repaired !== jsonCandidate) {
                    log.info('[RunbookParser] Strategy 1b: Attempting parse with repaired JSON');
                    const obj = JSON.parse(repaired);
                    const result = this.validateRunbook(obj);
                    if (result) return result;
                    log.warn(`[RunbookParser] Strategy 1b: repaired JSON parsed but validateRunbook rejected it`);
                }
            } catch (err) {
                log.warn(`[RunbookParser] Strategy 1b: repaired JSON.parse failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        } else {
            log.warn(`[RunbookParser] Strategy 1: extractOutermostJson returned null (no balanced {} found)`);
        }

        // Strategy 2: Look for ```json ... ``` fenced code block (backward-compatible fallback)
        const fencedMatch = output.match(/```json\s*\n([\s\S]*?)\n```/);
        if (fencedMatch) {
            log.info(`[RunbookParser] Strategy 2: fenced JSON block found (${fencedMatch[1].length} chars, first 200: ${fencedMatch[1].slice(0, 200)})`);
            try {
                const obj = JSON.parse(fencedMatch[1]);
                const result = this.validateRunbook(obj);
                if (result) return result;
                log.warn(`[RunbookParser] Strategy 2: fenced JSON parsed but validateRunbook rejected it`);
            } catch (err) {
                log.warn(`[RunbookParser] Strategy 2: fenced JSON.parse failed: ${err instanceof Error ? err.message : String(err)}`);
                // Try repair on fenced content too
                try {
                    const repaired = this.repairJson(fencedMatch[1]);
                    const obj = JSON.parse(repaired);
                    const result = this.validateRunbook(obj);
                    if (result) return result;
                    log.warn(`[RunbookParser] Strategy 2b: repaired fenced JSON parsed but validateRunbook rejected it`);
                } catch (err2) {
                    log.warn(`[RunbookParser] Strategy 2b: repaired fenced JSON.parse failed: ${err2 instanceof Error ? err2.message : String(err2)}`);
                }
            }
        } else {
            log.warn(`[RunbookParser] Strategy 2: no fenced json block found in output`);
        }

        log.error(`[RunbookParser] All strategies exhausted — returning null`);
        return null;
    }

    /**
     * Walk the string character-by-character to extract the outermost `{ ... }`
     * JSON object, correctly handling nested braces and string literals.
     *
     * Why not regex? Regex cannot reliably match balanced brackets in nested
     * JSON (the old non-greedy pattern truncated at the first inner `]`).
     */
    private extractOutermostJson(text: string): string | null {
        const start = text.indexOf('{');
        if (start === -1) return null;

        let depth = 0;
        let inString = false;
        let escape = false;

        for (let i = start; i < text.length; i++) {
            const ch = text[i];

            if (escape) {
                escape = false;
                continue;
            }

            if (ch === '\\' && inString) {
                escape = true;
                continue;
            }

            if (ch === '"') {
                inString = !inString;
                continue;
            }

            if (inString) continue;

            if (ch === '{') {
                depth++;
            } else if (ch === '}') {
                depth--;
                if (depth === 0) {
                    return text.substring(start, i + 1);
                }
            }
        }

        return null; // Unbalanced braces
    }

    /**
     * Attempt to repair common LLM JSON mistakes:
     * 1. Trailing commas before `]` or `}` (e.g., `[1, 2,]`)
     * 2. Literal (unescaped) newlines inside JSON string values
     *
     * Uses a character-level scan to track whether we are inside a string,
     * so repairs only apply where they are structurally appropriate.
     */
    private repairJson(raw: string): string {
        // Pass 1: Fix unescaped literal newlines inside string values.
        // Walk character-by-character, tracking whether we're inside a JSON string.
        const chars: string[] = [];
        let inStr = false;
        let esc = false;

        for (let i = 0; i < raw.length; i++) {
            const ch = raw[i];

            if (esc) {
                esc = false;
                chars.push(ch);
                continue;
            }

            if (ch === '\\' && inStr) {
                esc = true;
                chars.push(ch);
                continue;
            }

            if (ch === '"') {
                inStr = !inStr;
                chars.push(ch);
                continue;
            }

            // If we are inside a string and hit a literal newline, escape it.
            if (inStr && (ch === '\n' || ch === '\r')) {
                if (ch === '\r' && i + 1 < raw.length && raw[i + 1] === '\n') {
                    // \r\n → \\n  (skip the \r, the \n will be caught next iteration)
                    continue;
                }
                chars.push('\\', 'n');
                continue;
            }

            // If we are inside a string and hit a literal tab, escape it.
            if (inStr && ch === '\t') {
                chars.push('\\', 't');
                continue;
            }

            chars.push(ch);
        }

        let repaired = chars.join('');

        // Pass 2: Remove trailing commas before ] or } (outside strings).
        // This regex is safe because Pass 1 already escaped all in-string newlines,
        // so we can safely match structurally.
        repaired = repaired.replace(/,\s*([\]}])/g, '$1');

        return repaired;
    }

    /**
     * Validate that parsed JSON has the minimum required Runbook shape.
     * #43: Also validates depends_on refs and checks for duplicate phase IDs.
     */
    private validateRunbook(obj: unknown): Runbook | null {
        if (!obj || typeof obj !== 'object') {
            log.warn(`[RunbookParser] validateRunbook: not an object (type=${typeof obj})`);
            return null;
        }
        const r = obj as Record<string, unknown>;
        const topKeys = Object.keys(r);
        log.info(`[RunbookParser] validateRunbook: top-level keys = [${topKeys.join(', ')}]`);

        if (typeof r.project_id !== 'string') {
            log.warn(`[RunbookParser] validateRunbook REJECTED: project_id is ${typeof r.project_id} (expected string), value=${JSON.stringify(r.project_id)?.slice(0, 100)}`);
            return null;
        }
        if (!Array.isArray(r.phases) || r.phases.length === 0) {
            log.warn(`[RunbookParser] validateRunbook REJECTED: phases is ${Array.isArray(r.phases) ? `empty array (length=0)` : typeof r.phases}`);
            return null;
        }

        // Validate each phase has required fields
        const seenIds = new Set<number>();
        for (const p of r.phases) {
            if (typeof p !== 'object' || p === null) {
                log.warn(`[RunbookParser] validateRunbook REJECTED: phase entry is not an object`);
                return null;
            }
            const phase = p as Record<string, unknown>;
            if (typeof phase.id !== 'number') {
                log.warn(`[RunbookParser] validateRunbook REJECTED: phase.id is ${typeof phase.id} (expected number), keys=[${Object.keys(phase).join(', ')}]`);
                return null;
            }
            if (typeof phase.prompt !== 'string') {
                log.warn(`[RunbookParser] validateRunbook REJECTED: phase[${phase.id}].prompt is ${typeof phase.prompt} (expected string)`);
                return null;
            }
            if (!Array.isArray(phase.context_files)) {
                log.warn(`[RunbookParser] validateRunbook REJECTED: phase[${phase.id}].context_files is ${typeof phase.context_files} (expected array)`);
                return null;
            }
            if (typeof phase.success_criteria !== 'string') {
                log.warn(`[RunbookParser] validateRunbook REJECTED: phase[${phase.id}].success_criteria is ${typeof phase.success_criteria} (expected string)`);
                return null;
            }

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
            ...(typeof r.execution_plan === 'string' ? { execution_plan: r.execution_plan } : {}),
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
