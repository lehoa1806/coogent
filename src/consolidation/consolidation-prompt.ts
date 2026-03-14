// ─────────────────────────────────────────────────────────────────────────────
// src/consolidation/consolidation-prompt.ts — Prompt template for ADK-based consolidation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the system prompt for the consolidation agent worker.
 *
 * The worker will:
 *   1. Read all phase handoffs from MCP via `mcp_coogent_get_phase_handoff`
 *   2. Compile a comprehensive consolidation report in Markdown
 *   3. Submit the report via `mcp_coogent_submit_consolidation_report`
 *   4. Write or update documentation files in the repository
 */
export function buildConsolidationPrompt(opts: {
    masterTaskId: string;
    projectId: string;
    summary: string;
    phases: Array<{ id: number; mcpPhaseId?: string | undefined; status: string; context_summary?: string | undefined }>;
    workspaceRoot: string;
}): string {
    const { masterTaskId, projectId, summary, phases, workspaceRoot } = opts;

    // Build the list of phases with their MCP phase IDs for handoff retrieval
    const phaseList = phases
        .map(p => {
            const statusIcon = p.status === 'completed' ? '✅' : p.status === 'failed' ? '❌' : '⏭️';
            const mcpId = p.mcpPhaseId ? `mcpPhaseId=\`${p.mcpPhaseId}\`` : '_no mcpPhaseId_';
            const ctx = p.context_summary ? ` — ${p.context_summary}` : '';
            return `- Phase ${p.id} ${statusIcon} (${p.status}): ${mcpId}${ctx}`;
        })
        .join('\n');

    // Filter phases that have an MCP phase ID (can be read via handoff tool)
    const readablePhases = phases.filter(p => p.mcpPhaseId);
    const handoffSteps = readablePhases
        .map(p =>
            `   - Call \`mcp_coogent_get_phase_handoff\` with masterTaskId=\`${masterTaskId}\`, phaseId=\`${p.mcpPhaseId}\``,
        )
        .join('\n');

    const sections: string[] = [
        `## Task`,
        ``,
        `You are a **Consolidation Agent**. Your job is to:`,
        `1. Read all phase handoffs from the MCP state store`,
        `2. Produce a comprehensive consolidation report in Markdown`,
        `3. Submit the report to MCP via \`mcp_coogent_submit_consolidation_report\``,
        `4. Write or update documentation in the repository to reflect the changes made`,
        ``,
        `### Project Context`,
        ``,
        `- **Project ID:** ${projectId}`,
        `- **Master Task ID:** ${masterTaskId}`,
        `- **Summary:** ${summary || '_No summary provided_'}`,
        `- **Workspace Root:** ${workspaceRoot}`,
        `- **Total Phases:** ${phases.length}`,
        ``,
        `### Phase List`,
        ``,
        phaseList || '_No phases_',
        ``,
        `### Step 1: Read Phase Handoffs`,
        ``,
        `Use \`mcp_coogent_get_phase_handoff\` to read the handoff data for each phase that has an mcpPhaseId.`,
        `Each handoff contains: decisions, modified files, blockers/unresolved issues, and next_steps_context.`,
        ``,
        ...(handoffSteps
            ? [handoffSteps]
            : ['   _No phases with mcpPhaseId available — report will note that no handoff data was found._']),
        ``,
        `### Step 2: Compile Consolidation Report`,
        ``,
        `Create a structured Markdown report with these sections:`,
        ``,
        `1. **Title** — \`# Walkthrough\``,
        `2. **Summary Table** — project name, total/successful/failed/skipped phases, generation timestamp`,
        `3. **Phase Results** — for each phase: status, decisions made, files modified`,
        `4. **All Modified Files** — deduplicated list of all files changed across all phases`,
        `5. **Decisions Made** — aggregated list of all decisions`,
        `6. **Unresolved Issues** — any blockers or issues remaining from any phase`,
        ``,
        `### Step 3: Submit Report to MCP`,
        ``,
        `Call \`mcp_coogent_submit_consolidation_report\` with:`,
        `- \`masterTaskId\`: \`${masterTaskId}\``,
        `- \`markdown_content\`: the full Markdown report from Step 2`,
        ``,
        `### Step 4: Update Documentation`,
        ``,
        `Based on the decisions and file changes from all phases:`,
        `- If a CHANGELOG.md exists in the workspace, append an entry summarizing the changes`,
        `- If architecture documentation exists (e.g., docs/, README.md), update it to reflect any architectural decisions`,
        `- Create new documentation files if significant new features or patterns were introduced`,
        `- Ensure all documentation accurately reflects the current state of the codebase`,
        ``,
        `> **Important:** Only update docs that are relevant. Do not create unnecessary documentation.`,
        `> Use \`view_file\` to check if files exist before attempting to update them.`,
    ];

    return sections.join('\n');
}
