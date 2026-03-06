<!-- ─────────────────────────────────────────────────────────────────────── -->
<!-- PhaseHandoff.svelte — MCP artifacts, handoff data, parent handoffs     -->
<!-- ─────────────────────────────────────────────────────────────────────── -->

<script lang="ts">
    import type { Phase } from "../types.js";
    import type { MCPResourceState } from "../stores/mcpStore.svelte.js";
    import MarkdownRenderer from "./MarkdownRenderer.svelte";

    interface Props {
        selectedPhase: Phase;
        handoffData: MCPResourceState<object>;
        planData: MCPResourceState<string>;
        parentHandoffs: Record<number, MCPResourceState<object>>;
        showMCPArtifacts: boolean;
        hasHandoffStore: boolean;
        hasPlanStore: boolean;
        getDepLabel: (depId: number) => string | number;
    }

    let {
        selectedPhase,
        handoffData,
        planData,
        parentHandoffs,
        showMCPArtifacts = $bindable(),
        hasHandoffStore,
        hasPlanStore,
        getDepLabel,
    }: Props = $props();
</script>

<!-- ═══ MCP Artifacts (completed phases only) ═══════════════════════ -->
{#if selectedPhase.status === "completed" && (hasHandoffStore || hasPlanStore)}
    <div class="phase-detail-section mcp-artifacts-section">
        <button
            class="mcp-artifacts-toggle"
            onclick={() => (showMCPArtifacts = !showMCPArtifacts)}
            aria-expanded={showMCPArtifacts}
        >
            <span class="toggle-icon">{showMCPArtifacts ? "▾" : "▸"}</span>
            <h4>Artifacts</h4>
        </button>

        {#if showMCPArtifacts}
            <!-- Phase-level Implementation Plan -->
            {#if hasPlanStore}
                <div class="mcp-artifact-block">
                    <h5>Phase Implementation Plan</h5>
                    {#if planData.loading}
                        <div class="mcp-loading">Loading plan…</div>
                    {:else if planData.error}
                        <div class="mcp-error">
                            {planData.error}
                        </div>
                    {:else if planData.data}
                        <div class="mcp-rendered-content">
                            <MarkdownRenderer content={planData.data} />
                        </div>
                    {:else}
                        <div class="mcp-empty">No phase plan recorded.</div>
                    {/if}
                </div>
            {/if}

            <!-- Phase Handoff -->
            {#if hasHandoffStore}
                <div class="mcp-artifact-block">
                    <h5>Phase Handoff</h5>
                    {#if handoffData.loading}
                        <div class="mcp-loading">Loading handoff…</div>
                    {:else if handoffData.error}
                        <div class="mcp-error">
                            {handoffData.error}
                        </div>
                    {:else if handoffData.data}
                        {@const rawHandoff = handoffData.data}
                        {@const handoff = (
                            typeof rawHandoff === "string"
                                ? JSON.parse(rawHandoff)
                                : rawHandoff
                        ) as Record<string, unknown>}
                        {#if Array.isArray(handoff.decisions) && handoff.decisions.length > 0}
                            <div class="handoff-group">
                                <span class="handoff-label">Decisions</span>
                                <ul class="handoff-list">
                                    {#each handoff.decisions as decision}
                                        <li>{decision}</li>
                                    {/each}
                                </ul>
                            </div>
                        {/if}
                        {#if Array.isArray(handoff.modifiedFiles) && handoff.modifiedFiles.length > 0}
                            <div class="handoff-group">
                                <span class="handoff-label">Modified Files</span
                                >
                                <div class="handoff-files">
                                    {#each handoff.modifiedFiles as file}
                                        <span class="file-chip">{file}</span>
                                    {/each}
                                </div>
                            </div>
                        {/if}
                        {#if Array.isArray(handoff.blockers) && handoff.blockers.length > 0}
                            <div class="handoff-group">
                                <span class="handoff-label blockers"
                                    >Blockers</span
                                >
                                <ul class="handoff-list blockers">
                                    {#each handoff.blockers as blocker}
                                        <li>{blocker}</li>
                                    {/each}
                                </ul>
                            </div>
                        {/if}
                        {#if (!Array.isArray(handoff.decisions) || handoff.decisions.length === 0) && (!Array.isArray(handoff.modifiedFiles) || handoff.modifiedFiles.length === 0) && (!Array.isArray(handoff.blockers) || handoff.blockers.length === 0)}
                            <div class="mcp-empty">
                                Handoff recorded with no details.
                            </div>
                        {/if}
                    {:else}
                        <div class="mcp-empty">No handoff data recorded.</div>
                    {/if}
                </div>
            {/if}
        {/if}
    </div>
{/if}

<!-- Parent Handoff Context (from completed dependencies) -->
{#if selectedPhase.depends_on && selectedPhase.depends_on.length > 0}
    {@const completedParents = selectedPhase.depends_on.filter(
        (depId) => parentHandoffs[depId],
    )}
    {#if completedParents.length > 0}
        <div class="phase-detail-section parent-handoff-section">
            <h4>Parent Handoff Context</h4>
            {#each completedParents as depId}
                {@const pd = parentHandoffs[depId]}
                <div class="parent-handoff-block">
                    <span class="parent-handoff-label"
                        >Phase #{getDepLabel(depId)}</span
                    >
                    {#if pd.loading}
                        <div class="mcp-loading">Loading…</div>
                    {:else if pd.error}
                        <div class="mcp-error">{pd.error}</div>
                    {:else if pd.data}
                        {@const rawH = pd.data}
                        {@const h = (
                            typeof rawH === "string" ? JSON.parse(rawH) : rawH
                        ) as Record<string, unknown>}
                        {#if Array.isArray(h.decisions) && h.decisions.length > 0}
                            <div class="handoff-group">
                                <span class="handoff-label">Decisions</span>
                                <ul class="handoff-list">
                                    {#each h.decisions as decision}
                                        <li>{decision}</li>
                                    {/each}
                                </ul>
                            </div>
                        {/if}
                        {#if Array.isArray(h.modifiedFiles) && h.modifiedFiles.length > 0}
                            <div class="handoff-group">
                                <span class="handoff-label">Modified Files</span
                                >
                                <div class="handoff-files">
                                    {#each h.modifiedFiles as file}
                                        <span class="file-chip">{file}</span>
                                    {/each}
                                </div>
                            </div>
                        {/if}
                        {#if Array.isArray(h.blockers) && h.blockers.length > 0}
                            <div class="handoff-group">
                                <span class="handoff-label blockers"
                                    >Blockers</span
                                >
                                <ul class="handoff-list blockers">
                                    {#each h.blockers as blocker}
                                        <li>{blocker}</li>
                                    {/each}
                                </ul>
                            </div>
                        {/if}
                    {:else}
                        <div class="mcp-empty">No handoff data.</div>
                    {/if}
                </div>
            {/each}
        </div>
    {/if}
{/if}

<style>
    .phase-detail-section {
        margin-bottom: 16px;
    }

    .phase-detail-section h4 {
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.8px;
        color: var(
            --vscode-sideBarTitle-foreground,
            var(--vscode-disabledForeground)
        );
        font-weight: 700;
        margin-bottom: 6px;
    }

    .file-chip {
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 10px;
        padding: 2px 8px;
        background: color-mix(
            in srgb,
            var(--vscode-charts-purple, #a78bfa) 12%,
            transparent
        );
        border-radius: 4px;
        color: var(--vscode-charts-purple, #a78bfa);
        white-space: nowrap;
        max-width: 200px;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    /* ── MCP Artifacts Section ─────────────────────────────────────────── */

    .mcp-artifacts-section {
        border-top: 1px solid
            var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
        padding-top: 12px;
    }

    .mcp-artifacts-toggle {
        display: flex;
        align-items: center;
        gap: 6px;
        background: none;
        border: none;
        padding: 0;
        cursor: pointer;
        color: var(--vscode-foreground);
        width: 100%;
        text-align: left;
    }

    .mcp-artifacts-toggle h4 {
        margin: 0;
    }

    .toggle-icon {
        font-size: 12px;
        width: 14px;
        text-align: center;
        color: var(--vscode-descriptionForeground);
    }

    .mcp-artifact-block {
        margin-top: 10px;
        padding: 10px 12px;
        background: var(
            --vscode-editorWidget-background,
            var(--vscode-sideBar-background)
        );
        border-radius: 4px;
        border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
    }

    .mcp-artifact-block h5 {
        font-size: 11px;
        font-weight: 600;
        color: var(--vscode-foreground);
        margin: 0 0 8px;
    }

    .mcp-loading {
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
        font-style: italic;
        padding: 4px 0;
    }

    .mcp-error {
        font-size: 11px;
        color: var(--vscode-errorForeground, #f85149);
        padding: 4px 0;
    }

    .mcp-empty {
        font-size: 11px;
        color: var(--vscode-disabledForeground);
        font-style: italic;
        padding: 4px 0;
    }

    .mcp-rendered-content {
        font-size: 13px;
        line-height: 1.6;
        color: var(--vscode-editor-foreground);
        word-wrap: break-word;
        max-height: 300px;
        overflow-y: auto;
    }

    .handoff-group {
        margin-bottom: 8px;
    }

    .handoff-group:last-child {
        margin-bottom: 0;
    }

    .handoff-label {
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: var(--vscode-descriptionForeground);
        display: block;
        margin-bottom: 4px;
    }

    .handoff-label.blockers {
        color: var(--vscode-editorWarning-foreground, #cca700);
    }

    .handoff-list {
        margin: 0;
        padding-left: 18px;
        font-size: 12px;
        line-height: 1.5;
        color: var(--vscode-foreground);
    }

    .handoff-list.blockers li {
        color: var(--vscode-editorWarning-foreground, #cca700);
    }

    .handoff-files {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
    }

    /* ── Parent Handoff Context ──────────────────────────────────────── */

    .parent-handoff-section {
        border-left: 3px solid
            color-mix(
                in srgb,
                var(--vscode-editorInfo-foreground, #58a6ff) 40%,
                transparent
            );
        padding-left: 12px;
    }

    .parent-handoff-block {
        margin-bottom: 10px;
        padding: 8px 10px;
        background: var(
            --vscode-editorWidget-background,
            var(--vscode-sideBar-background)
        );
        border-radius: 4px;
        border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.25));
    }

    .parent-handoff-block:last-child {
        margin-bottom: 0;
    }

    .parent-handoff-label {
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 10px;
        font-weight: 700;
        color: var(--vscode-editorInfo-foreground, #58a6ff);
        display: block;
        margin-bottom: 6px;
    }
</style>
