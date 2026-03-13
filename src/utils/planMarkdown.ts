// ─────────────────────────────────────────────────────────────────────────────
// src/utils/planMarkdown.ts — Execution Plan Markdown builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a walkthrough-style Markdown document from the plan draft.
 * Each phase is listed with a `⏳ Pending` status marker that will be
 * replaced with `✅ Done` by the `phase:checkpoint` handler.
 *
 * N-4: Extracted from extension.ts for testability and SRP.
 */
export function buildImplementationPlanMarkdown(draft: {
    project_id: string;
    summary?: string;
    execution_plan?: string;
    phases: ReadonlyArray<{
        id: number;
        prompt: string;
        context_files?: string[] | readonly string[];
        success_criteria?: string;
        depends_on?: number[] | readonly number[];
    }>;
}): string {
    const lines: string[] = [];

    lines.push(`# Implementation Plan — ${draft.project_id}`);
    lines.push('');
    if (draft.summary) {
        lines.push(`> ${draft.summary}`);
        lines.push('');
    }

    // If the planner already produced a freeform execution plan, include it
    if (draft.execution_plan) {
        lines.push('## Detailed Plan');
        lines.push('');
        lines.push(draft.execution_plan);
        lines.push('');
    }

    lines.push('## Phases');
    lines.push('');
    lines.push('| # | Prompt | Files | Status |');
    lines.push('|---|--------|-------|--------|');

    for (const phase of draft.phases) {
        const id = phase.id;
        // N-5: Escape pipe characters to prevent Markdown table breakage
        const prompt = (phase.prompt || '').replace(/\n/g, ' ').slice(0, 80).replace(/\|/g, '\\|');
        const files = (phase.context_files || []).length;
        lines.push(`| Phase ${id} | ${prompt} | ${files} | ⏳ Pending |`);
    }

    lines.push('');
    lines.push(`_Generated at ${new Date().toISOString()}_`);
    lines.push('');

    return lines.join('\n');
}
