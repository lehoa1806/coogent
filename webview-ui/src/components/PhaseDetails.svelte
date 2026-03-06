<!-- ─────────────────────────────────────────────────────────────────────── -->
<!-- PhaseDetails.svelte — Selected phase detail panel                       -->
<!-- ─────────────────────────────────────────────────────────────────────── -->

<script lang="ts">
    import { appState, postMessage } from "../stores/vscode.js";
    import {
        createMCPResource,
        type MCPResourceStore,
        type MCPResourceState,
    } from "../stores/mcpStore.js";
    import type { Phase } from "../types.js";
    import MarkdownRenderer from "./MarkdownRenderer.svelte";
    import ViewModeTabs from "./ViewModeTabs.svelte";

    /** Toggle state for prompt view */
    let promptMode: "preview" | "raw" = $state("preview");

    /** Toggle state for worker output view */
    let outputMode: "preview" | "raw" = $state("raw");

    /** Toggle state for MCP artifacts section */
    let showMCPArtifacts = $state(false);

    /** Original prompt the user submitted */
    let lastPrompt = $derived($appState.lastPrompt ?? "");

    let selectedPhase = $derived(
        $appState.phases.find((p) => p.id === $appState.selectedPhaseId) as
            | Phase
            | undefined,
    );

    let phaseIndex = $derived(
        selectedPhase ? $appState.phases.indexOf(selectedPhase) : -1,
    );
    let phaseNumber = $derived(phaseIndex >= 0 ? phaseIndex + 1 : 0);

    let phaseOutput = $derived(
        selectedPhase ? $appState.phaseOutputs[selectedPhase.id] || "" : "",
    );

    let tokenBudget = $derived(
        selectedPhase
            ? $appState.phaseTokenBudgets[selectedPhase.id]
            : undefined,
    );

    let tokenPct = $derived(
        tokenBudget
            ? Math.min(100, (tokenBudget.totalTokens / tokenBudget.limit) * 100)
            : 0,
    );

    let tokenColorClass = $derived(
        tokenPct > 90 ? "over" : tokenPct > 70 ? "warn" : "",
    );

    // ── Per-phase elapsed time ───────────────────────────────────────────────────
    let _phaseTimerInterval: ReturnType<typeof setInterval> | null = null;
    let liveElapsedMs = $state(0);

    $effect(() => {
        const phase = selectedPhase;
        if (!phase) {
            if (_phaseTimerInterval) {
                clearInterval(_phaseTimerInterval);
                _phaseTimerInterval = null;
            }
            liveElapsedMs = 0;
            return;
        }

        const frozen = $appState.phaseElapsedMs[phase.id];
        if (frozen != null && frozen > 0) {
            // Phase completed/failed: show frozen time
            if (_phaseTimerInterval) {
                clearInterval(_phaseTimerInterval);
                _phaseTimerInterval = null;
            }
            liveElapsedMs = frozen;
            return;
        }

        const startMs = $appState.phaseStartTimes[phase.id];
        if (startMs && phase.status === "running") {
            // Phase is running: tick live
            liveElapsedMs = Date.now() - startMs;
            if (!_phaseTimerInterval) {
                _phaseTimerInterval = setInterval(() => {
                    liveElapsedMs = Date.now() - startMs;
                }, 500);
            }
        } else {
            if (_phaseTimerInterval) {
                clearInterval(_phaseTimerInterval);
                _phaseTimerInterval = null;
            }
            liveElapsedMs = 0;
        }

        return () => {
            if (_phaseTimerInterval) {
                clearInterval(_phaseTimerInterval);
                _phaseTimerInterval = null;
            }
        };
    });

    function formatPhaseElapsed(ms: number): string {
        if (ms <= 0) return "";
        const totalSec = Math.floor(ms / 1000);
        const m = Math.floor(totalSec / 60);
        const s = totalSec % 60;
        return m > 0 ? `${m}m ${s}s` : `${s}s`;
    }

    /** Find phases that depend on this phase (reverse lookup). */
    let dependents = $derived(
        selectedPhase
            ? $appState.phases.filter(
                  (p) =>
                      p.depends_on && p.depends_on.includes(selectedPhase!.id),
              )
            : [],
    );

    // ── MCP resource fetching ────────────────────────────────────────────
    let handoffStore: MCPResourceStore<object> | null = $state(null);
    let phasePlanStore: MCPResourceStore<string> | null = $state(null);

    // Parent handoff stores (Fix 6)
    let _parentHandoffStores: MCPResourceStore<object>[] = [];
    let parentHandoffs: Record<number, MCPResourceState<object>> = $state({});

    // Derived state piped from store subscriptions (avoids $-subscribing to null)
    let handoffData: MCPResourceState<object> = $state({
        loading: false,
        data: null,
        error: null,
    });
    let planData: MCPResourceState<string> = $state({
        loading: false,
        data: null,
        error: null,
    });

    /**
     * Semantic-equality guard variables for the MCP resource $effect below.
     * Persist across effect re-runs so we can skip store teardown/recreation
     * when appState object-reference churn gives selectedPhase a new reference
     * with identical meaningful fields (id, status, mcpPhaseId, masterTaskId).
     */
    let _mcpLastPhaseId: number | undefined;
    let _mcpLastStatus: string | undefined;
    let _mcpLastMcpPhaseId: string | undefined;
    let _mcpLastMasterTaskId: string | undefined;

    /**
     * Regex matching the strict MCP masterTaskId format: YYYYMMDD-HHMMSS-<uuid>.
     * Human-readable project_id slugs (e.g. "coogent-context-management-audit")
     * must NOT be used to build coogent:// URIs — they fail parseResourceURI and
     * produce "Unknown or malformed resource URI" errors in Mission Control.
     */
    const MCP_MASTER_TASK_ID_RE =
        /^\d{8}-\d{6}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

    /**
     * Reactively create MCP resource stores when a completed phase is selected
     * and a valid projectId (masterTaskId) is available.
     *
     * Guard: skip teardown + recreation when only the phase object _reference_
     * changed (due to spread in messageHandler.ts) but the meaningful fields
     * (id, status, mcpPhaseId, masterTaskId) are identical. Without this guard
     * every PHASE_OUTPUT / TOKEN_BUDGET / LOG_ENTRY message would restart the
     * stores and fire a burst of duplicate MCP_FETCH_RESOURCE IPC calls.
     */
    $effect(() => {
        const masterTaskId = $appState.masterTaskId;
        const newPhaseId = selectedPhase?.id;
        const newStatus = selectedPhase?.status;
        const newMcpPhaseId = selectedPhase?.mcpPhaseId;

        // Bail out early — nothing semantically changed, keep existing stores.
        if (
            newPhaseId === _mcpLastPhaseId &&
            newStatus === _mcpLastStatus &&
            newMcpPhaseId === _mcpLastMcpPhaseId &&
            masterTaskId === _mcpLastMasterTaskId
        ) {
            return;
        }

        // Record the new key values before any async work.
        _mcpLastPhaseId = newPhaseId;
        _mcpLastStatus = newStatus;
        _mcpLastMcpPhaseId = newMcpPhaseId;
        _mcpLastMasterTaskId = masterTaskId;

        // Clean up previous stores
        handoffStore?.destroy();
        phasePlanStore?.destroy();
        handoffStore = null;
        phasePlanStore = null;
        handoffData = { loading: false, data: null, error: null };
        planData = { loading: false, data: null, error: null };

        if (
            selectedPhase &&
            masterTaskId &&
            MCP_MASTER_TASK_ID_RE.test(masterTaskId) && // guard: reject slugs like "coogent-context-management-audit"
            selectedPhase.status === "completed" &&
            selectedPhase.mcpPhaseId
        ) {
            const phaseIdStr = selectedPhase.mcpPhaseId;
            handoffStore = createMCPResource<object>(
                `coogent://tasks/${masterTaskId}/phases/${phaseIdStr}/handoff`,
            );
            phasePlanStore = createMCPResource<string>(
                `coogent://tasks/${masterTaskId}/phases/${phaseIdStr}/implementation_plan`,
            );

            // Pipe store values into local reactive vars
            handoffStore.subscribe((v) => {
                handoffData = v;
            });
            phasePlanStore.subscribe((v) => {
                planData = v;
            });
        }

        // -- Parent handoff stores (Fix 6) --
        _parentHandoffStores.forEach((s) => s.destroy());
        _parentHandoffStores = [];
        parentHandoffs = {};

        if (
            selectedPhase &&
            masterTaskId &&
            MCP_MASTER_TASK_ID_RE.test(masterTaskId) &&
            selectedPhase.depends_on &&
            selectedPhase.depends_on.length > 0
        ) {
            for (const depId of selectedPhase.depends_on) {
                const parentPhase = $appState.phases.find(
                    (p) => p.id === depId,
                );
                if (
                    parentPhase &&
                    parentPhase.status === "completed" &&
                    parentPhase.mcpPhaseId
                ) {
                    const store = createMCPResource<object>(
                        `coogent://tasks/${masterTaskId}/phases/${parentPhase.mcpPhaseId}/handoff`,
                    );
                    _parentHandoffStores.push(store);
                    store.subscribe((v) => {
                        parentHandoffs = { ...parentHandoffs, [depId]: v };
                    });
                }
            }
        }

        return () => {
            handoffStore?.destroy();
            phasePlanStore?.destroy();
            _parentHandoffStores.forEach((s) => s.destroy());
        };
    });

    function getDepLabel(depId: number): string | number {
        const idx = $appState.phases.findIndex((p) => p.id === depId);
        return idx >= 0 ? idx + 1 : depId;
    }

    function handleAction(action: string) {
        if (!selectedPhase) return;
        const phaseId = selectedPhase.id;
        switch (action) {
            case "retry":
                postMessage({ type: "CMD_RETRY", payload: { phaseId } });
                break;
            case "restart":
                postMessage({
                    type: "CMD_RESTART_PHASE",
                    payload: { phaseId },
                });
                break;
            case "skip":
                postMessage({ type: "CMD_SKIP_PHASE", payload: { phaseId } });
                break;
        }
    }

    function truncatePrompt(prompt: string): string {
        if (!prompt) return "";
        return prompt.length > 80 ? prompt.slice(0, 80) + "…" : prompt;
    }
</script>

<div class="phase-details">
    {#if selectedPhase}
        <!-- Persistent original prompt (collapsible) -->
        {#if lastPrompt}
            <details class="original-prompt-details">
                <summary class="original-prompt-summary">
                    <span class="summary-icon">💬</span>
                    Your original prompt
                </summary>
                <div class="original-prompt-body">
                    <p>{lastPrompt}</p>
                </div>
            </details>
        {/if}

        <div class="phase-title-row">
            <h3>Phase {phaseNumber}: {truncatePrompt(selectedPhase.prompt)}</h3>
            {#if liveElapsedMs > 0}
                <span
                    class="phase-elapsed-badge"
                    class:running={selectedPhase.status === "running"}
                >
                    ⏱ {formatPhaseElapsed(liveElapsedMs)}
                </span>
            {/if}
        </div>

        <!-- Prompt -->
        <div class="phase-detail-section">
            <div class="section-header-row">
                <h4>Prompt</h4>
                <ViewModeTabs
                    value={promptMode}
                    onchange={(m) => (promptMode = m)}
                />
            </div>
            {#if promptMode === "raw"}
                <pre class="phase-prompt-full">{selectedPhase.prompt ||
                        ""}</pre>
            {:else}
                <div class="phase-prompt-rendered">
                    <MarkdownRenderer content={selectedPhase.prompt || ""} />
                </div>
            {/if}
        </div>

        <!-- Context Files -->
        <div class="phase-detail-section">
            <h4>Context Files</h4>
            <div class="phase-context-files">
                {#each selectedPhase.context_files as file}
                    <span class="file-chip">{file}</span>
                {/each}
            </div>
        </div>

        <!-- Dependencies -->
        {#if selectedPhase.depends_on && selectedPhase.depends_on.length > 0}
            <div class="phase-detail-section">
                <h4>Dependencies</h4>
                <div class="phase-deps-row">
                    {#each selectedPhase.depends_on as depId}
                        <span class="dep-badge">#{getDepLabel(depId)}</span>
                    {/each}
                </div>
            </div>
        {/if}

        <!-- Dependents -->
        {#if dependents.length > 0}
            <div class="phase-detail-section">
                <h4>Dependents</h4>
                <div class="phase-deps-row">
                    {#each dependents as dep}
                        <span class="dep-badge dependent"
                            >#{getDepLabel(dep.id)}</span
                        >
                    {/each}
                </div>
            </div>
        {/if}

        <!-- Context Summary -->
        {#if selectedPhase.context_summary}
            <div class="phase-detail-section">
                <h4>Context Summary</h4>
                <div class="phase-context-summary">
                    {selectedPhase.context_summary}
                </div>
            </div>
        {/if}

        <!-- Action Buttons -->
        {#if selectedPhase.status === "failed"}
            <div class="phase-actions-bar">
                <button
                    class="phase-action-btn retry"
                    onclick={() => handleAction("retry")}>↻ Retry</button
                >
                <button
                    class="phase-action-btn restart"
                    onclick={() => handleAction("restart")}>🔄 Restart</button
                >
                <button
                    class="phase-action-btn skip"
                    onclick={() => handleAction("skip")}>⏭ Skip</button
                >
            </div>
        {:else if selectedPhase.status === "completed"}
            <div class="phase-actions-bar">
                <button
                    class="phase-action-btn restart"
                    onclick={() => handleAction("restart")}>🔄 Restart</button
                >
            </div>
        {/if}

        <!-- ═══ MCP Artifacts (completed phases only) ═══════════════════════ -->
        {#if selectedPhase.status === "completed" && (handoffStore || phasePlanStore)}
            <div class="phase-detail-section mcp-artifacts-section">
                <button
                    class="mcp-artifacts-toggle"
                    onclick={() => (showMCPArtifacts = !showMCPArtifacts)}
                    aria-expanded={showMCPArtifacts}
                >
                    <span class="toggle-icon"
                        >{showMCPArtifacts ? "▾" : "▸"}</span
                    >
                    <h4>Artifacts</h4>
                </button>

                {#if showMCPArtifacts}
                    <!-- Phase-level Implementation Plan -->
                    {#if phasePlanStore}
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
                                <div class="mcp-empty">
                                    No phase plan recorded.
                                </div>
                            {/if}
                        </div>
                    {/if}

                    <!-- Phase Handoff -->
                    {#if handoffStore}
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
                                        <span class="handoff-label"
                                            >Decisions</span
                                        >
                                        <ul class="handoff-list">
                                            {#each handoff.decisions as decision}
                                                <li>{decision}</li>
                                            {/each}
                                        </ul>
                                    </div>
                                {/if}
                                {#if Array.isArray(handoff.modifiedFiles) && handoff.modifiedFiles.length > 0}
                                    <div class="handoff-group">
                                        <span class="handoff-label"
                                            >Modified Files</span
                                        >
                                        <div class="handoff-files">
                                            {#each handoff.modifiedFiles as file}
                                                <span class="file-chip"
                                                    >{file}</span
                                                >
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
                                <div class="mcp-empty">
                                    No handoff data recorded.
                                </div>
                            {/if}
                        </div>
                    {/if}
                {/if}
            </div>
        {/if}

        <!-- Token Budget -->
        {#if tokenBudget}
            <div class="phase-detail-section">
                <h4>Token Budget</h4>
                <div class="token-bar">
                    <div
                        class="token-fill {tokenColorClass}"
                        style="width:{tokenPct}%"
                    ></div>
                    <span class="token-label">
                        {tokenBudget.totalTokens.toLocaleString()} / {tokenBudget.limit.toLocaleString()}
                        tokens ({Math.round(tokenPct)}%) · {tokenBudget.fileCount}
                        files
                    </span>
                </div>
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
                                    typeof rawH === "string"
                                        ? JSON.parse(rawH)
                                        : rawH
                                ) as Record<string, unknown>}
                                {#if Array.isArray(h.decisions) && h.decisions.length > 0}
                                    <div class="handoff-group">
                                        <span class="handoff-label"
                                            >Decisions</span
                                        >
                                        <ul class="handoff-list">
                                            {#each h.decisions as decision}
                                                <li>{decision}</li>
                                            {/each}
                                        </ul>
                                    </div>
                                {/if}
                                {#if Array.isArray(h.modifiedFiles) && h.modifiedFiles.length > 0}
                                    <div class="handoff-group">
                                        <span class="handoff-label"
                                            >Modified Files</span
                                        >
                                        <div class="handoff-files">
                                            {#each h.modifiedFiles as file}
                                                <span class="file-chip"
                                                    >{file}</span
                                                >
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

        <!-- Worker Output -->
        <div class="phase-detail-section">
            <h4>Worker Output</h4>
            {#if phaseOutput}
                <div class="output-mode-row">
                    <ViewModeTabs
                        value={outputMode}
                        onchange={(m) => (outputMode = m)}
                    />
                </div>
                {#if outputMode === "raw"}
                    <pre class="phase-output-section">{phaseOutput}</pre>
                {:else}
                    <div class="phase-output-rendered">
                        <MarkdownRenderer content={phaseOutput} />
                    </div>
                {/if}
            {:else if selectedPhase.status === "pending"}
                <pre class="phase-output-section"><span
                        class="output-placeholder"
                        >Waiting for execution...</span
                    ></pre>
            {:else}
                <pre class="phase-output-section"><span
                        class="output-placeholder">No output recorded.</span
                    ></pre>
            {/if}
        </div>
    {:else}
        <div class="phase-details-placeholder">
            Select a phase from the navigator.
        </div>
    {/if}
</div>

<style>
    .phase-details {
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 12px;
        flex: 1;
        overflow-y: auto;
        min-height: 0;
        min-width: 0;
        background: var(--vscode-editor-background);
        border: 1px solid var(--vscode-contrastBorder, transparent);
    }

    h3 {
        font-size: 13px;
        font-weight: 600;
        margin: 0;
        color: var(--vscode-foreground);
    }

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

    .phase-prompt-full {
        font-size: 12px;
        line-height: 1.6;
        color: var(--vscode-foreground);
        white-space: pre-wrap;
        word-wrap: break-word;
        background: var(
            --vscode-editorWidget-background,
            var(--vscode-sideBar-background)
        );
        padding: 10px 12px;
        border-radius: 4px;
        border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
        font-family: var(--vscode-font-family);
        margin: 0;
        max-height: min(420px, 50vh);
        overflow-y: auto;
    }

    .phase-context-files {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
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

    .phase-deps-row {
        display: flex;
        flex-wrap: wrap;
        gap: 3px;
        align-items: center;
    }

    .dep-badge {
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 9px;
        font-weight: 700;
        padding: 1px 6px;
        border-radius: 4px;
        background: var(--vscode-badge-background);
        color: var(--vscode-badge-foreground);
        white-space: nowrap;
    }

    .dep-badge.dependent {
        background: color-mix(
            in srgb,
            var(--vscode-editorInfo-foreground, #58a6ff) 10%,
            transparent
        );
        color: var(--vscode-editorInfo-foreground, #58a6ff);
    }

    .phase-context-summary {
        font-size: 12px;
        color: var(--vscode-descriptionForeground);
        line-height: 1.5;
        background: var(--vscode-editorWidget-background);
        border-radius: 4px;
        padding: 8px 10px;
        white-space: pre-wrap;
    }

    .section-header-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 6px;
    }

    .section-header-row h4 {
        margin-bottom: 0;
    }

    /* ── Original prompt collapsible ────────────────────────────────── */

    .original-prompt-details {
        margin-bottom: 4px;
        border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.25));
        border-radius: 5px;
        overflow: hidden;
        background: var(--vscode-editorWidget-background);
    }

    .original-prompt-summary {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 12px;
        font-size: 11px;
        font-weight: 600;
        color: var(--vscode-descriptionForeground);
        cursor: pointer;
        user-select: none;
        list-style: none;
    }

    .original-prompt-summary::-webkit-details-marker {
        display: none;
    }

    .original-prompt-summary::before {
        content: "›";
        font-size: 14px;
        transition: transform 0.15s ease;
        color: var(--vscode-descriptionForeground);
        line-height: 1;
    }

    details[open] .original-prompt-summary::before {
        transform: rotate(90deg);
    }

    .summary-icon {
        font-size: 12px;
    }

    .original-prompt-body {
        padding: 10px 14px;
        border-top: 1px solid
            var(--vscode-panel-border, rgba(128, 128, 128, 0.2));
    }

    .original-prompt-body p {
        margin: 0;
        font-size: 12px;
        line-height: 1.6;
        color: var(--vscode-foreground);
        white-space: pre-wrap;
        word-wrap: break-word;
    }

    /* ── Output mode row ─────────────────────────────────────────────── */

    .output-mode-row {
        display: flex;
        justify-content: flex-end;
        padding: 4px 0;
    }

    .phase-prompt-rendered {
        font-size: 13px;
        line-height: 1.6;
        color: var(--vscode-editor-foreground);
        padding: 10px 12px;
        background: var(
            --vscode-editorWidget-background,
            var(--vscode-sideBar-background)
        );
        border-radius: 4px;
        border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
        word-wrap: break-word;
        max-height: min(420px, 50vh);
        overflow-y: auto;
    }

    .phase-actions-bar {
        display: flex;
        gap: 8px;
        padding-top: 12px;
        margin-top: 4px;
        border-top: 1px solid
            var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
        flex-wrap: wrap;
    }

    .phase-action-btn {
        font-family: var(--vscode-font-family);
        font-size: 11px;
        font-weight: 600;
        padding: 5px 14px;
        border-radius: 4px;
        border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
        background: var(--vscode-editorWidget-background);
        color: var(--vscode-foreground);
        cursor: pointer;
        transition: all 0.15s ease;
    }

    .phase-action-btn:hover {
        filter: brightness(1.15);
    }

    .phase-action-btn.retry {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground, #fff);
        border-color: transparent;
    }

    .phase-action-btn.restart {
        background: color-mix(
            in srgb,
            var(--vscode-editorWarning-foreground, #cca700) 15%,
            transparent
        );
        color: var(--vscode-editorWarning-foreground, #cca700);
    }

    .phase-action-btn.skip {
        background: transparent;
        color: var(--vscode-descriptionForeground);
    }

    .token-bar {
        position: relative;
        height: 20px;
        background: var(--vscode-editorWidget-background);
        border-radius: 4px;
        overflow: hidden;
    }

    .token-fill {
        height: 100%;
        border-radius: 4px;
        background: var(--vscode-focusBorder, #007fd4);
        transition: width 0.4s ease;
    }

    .token-fill.warn {
        background: var(--vscode-editorWarning-foreground, #d29922);
    }
    .token-fill.over {
        background: var(--vscode-errorForeground, #f85149);
    }

    .token-label {
        position: absolute;
        top: 50%;
        left: 8px;
        transform: translateY(-50%);
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 10px;
        color: var(--vscode-foreground);
    }

    /* ── Toggle buttons: now provided by ViewModeTabs.svelte ────────── */

    .phase-output-section {
        flex: 1;
        min-height: 120px;
        overflow-y: auto;
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: var(--vscode-editor-font-size, 13px);
        line-height: 1.6;
        color: var(
            --vscode-terminal-foreground,
            var(--vscode-descriptionForeground)
        );
        white-space: pre-wrap;
        word-break: break-all;
        background: var(
            --vscode-terminal-background,
            var(--vscode-editor-background)
        );
        border-radius: 4px;
        padding: 8px;
        margin: 0;
    }

    .phase-output-rendered {
        flex: 1;
        min-height: 120px;
        overflow-y: auto;
        font-size: 13px;
        line-height: 1.6;
        color: var(--vscode-editor-foreground);
        padding: 8px 12px;
        word-wrap: break-word;
    }

    /* ── Phase title row with elapsed badge ─────────────────────────── */

    .phase-title-row {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
    }

    .phase-elapsed-badge {
        font-size: 10px;
        font-family: var(--vscode-editor-font-family, monospace);
        font-weight: 600;
        padding: 2px 8px;
        border-radius: 10px;
        color: var(--vscode-descriptionForeground);
        background: var(--vscode-editorWidget-background);
        border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.3));
        white-space: nowrap;
    }

    .phase-elapsed-badge.running {
        color: var(--vscode-focusBorder, #007fd4);
        background: color-mix(
            in srgb,
            var(--vscode-focusBorder, #007fd4) 10%,
            transparent
        );
        border-color: color-mix(
            in srgb,
            var(--vscode-focusBorder, #007fd4) 30%,
            transparent
        );
        animation: elapsed-pulse 2s ease-in-out infinite;
    }

    @keyframes elapsed-pulse {
        0%,
        100% {
            opacity: 1;
        }
        50% {
            opacity: 0.65;
        }
    }

    .output-placeholder {
        color: var(--vscode-disabledForeground);
        font-style: italic;
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

    .phase-details-placeholder {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 40px 16px;
        color: var(--vscode-disabledForeground);
        font-size: 12px;
        text-align: center;
    }
</style>
