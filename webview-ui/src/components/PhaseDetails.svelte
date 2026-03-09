<!-- ─────────────────────────────────────────────────────────────────────── -->
<!-- PhaseDetails.svelte — Composition root for phase detail panel          -->
<!-- ─────────────────────────────────────────────────────────────────────── -->
<!-- R3 refactor: UI sections delegated to PhaseHeader, PhaseActions,       -->
<!-- and PhaseHandoff sub-components.                                       -->

<script lang="ts">
    import { appState } from "../stores/vscode.svelte.js";
    import {
        createMCPResource,
        type MCPResourceHandle,
        type MCPResourceState,
    } from "../stores/mcpStore.svelte.js";
    import type { Phase } from "../types.js";
    import MarkdownRenderer from "./MarkdownRenderer.svelte";
    import ViewModeTabs from "./ViewModeTabs.svelte";
    import PhaseHeader from "./PhaseHeader.svelte";
    import PhaseActions from "./PhaseActions.svelte";
    import PhaseHandoff from "./PhaseHandoff.svelte";

    /** Toggle state for prompt view */
    let promptMode: "preview" | "raw" = $state("preview");

    /** Toggle state for worker output view */
    let outputMode: "preview" | "raw" = $state("raw");

    /** Toggle state for MCP artifacts section */
    let showMCPArtifacts = $state(false);

    let selectedPhase = $derived(
        appState.phases.find((p) => p.id === appState.selectedPhaseId) as
            | Phase
            | undefined,
    );

    let phaseIndex = $derived(
        selectedPhase ? appState.phases.indexOf(selectedPhase) : -1,
    );
    let phaseNumber = $derived(phaseIndex >= 0 ? phaseIndex + 1 : 0);

    let phaseOutput = $derived(
        selectedPhase ? appState.phaseOutputs[selectedPhase.id] || "" : "",
    );

    let tokenBudget = $derived(
        selectedPhase
            ? appState.phaseTokenBudgets[selectedPhase.id]
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

        const frozen = appState.phaseElapsedMs[phase.id];
        if (frozen != null && frozen > 0) {
            if (_phaseTimerInterval) {
                clearInterval(_phaseTimerInterval);
                _phaseTimerInterval = null;
            }
            liveElapsedMs = frozen;
            return;
        }

        const startMs = appState.phaseStartTimes[phase.id];
        if (startMs && phase.status === "running") {
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

    /** Find phases that depend on this phase (reverse lookup). */
    let dependents = $derived(
        selectedPhase
            ? appState.phases.filter(
                  (p) =>
                      p.depends_on && p.depends_on.includes(selectedPhase!.id),
              )
            : [],
    );

    // ── MCP resource fetching ────────────────────────────────────────────
    let handoffStore: MCPResourceHandle<object> | null = $state(null);
    let phasePlanStore: MCPResourceHandle<string> | null = $state(null);

    // Parent handoff stores
    let _parentHandoffStores: MCPResourceHandle<object>[] = [];
    let parentHandoffs: Record<number, MCPResourceState<object>> = $state({});

    // Derived state piped from store subscriptions
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

    // Semantic-equality guard variables for the MCP resource $effect
    let _mcpLastPhaseId: number | undefined;
    let _mcpLastStatus: string | undefined;
    let _mcpLastMcpPhaseId: string | undefined;
    let _mcpLastMasterTaskId: string | undefined;

    const MCP_MASTER_TASK_ID_RE =
        /^\d{8}-\d{6}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

    $effect(() => {
        const masterTaskId = appState.masterTaskId;
        const newPhaseId = selectedPhase?.id;
        const newStatus = selectedPhase?.status;
        const newMcpPhaseId = selectedPhase?.mcpPhaseId;

        if (
            newPhaseId === _mcpLastPhaseId &&
            newStatus === _mcpLastStatus &&
            newMcpPhaseId === _mcpLastMcpPhaseId &&
            masterTaskId === _mcpLastMasterTaskId
        ) {
            return;
        }

        _mcpLastPhaseId = newPhaseId;
        _mcpLastStatus = newStatus;
        _mcpLastMcpPhaseId = newMcpPhaseId;
        _mcpLastMasterTaskId = masterTaskId;

        handoffStore?.destroy();
        phasePlanStore?.destroy();
        handoffStore = null;
        phasePlanStore = null;
        handoffData = { loading: false, data: null, error: null };
        planData = { loading: false, data: null, error: null };

        if (
            selectedPhase &&
            masterTaskId &&
            MCP_MASTER_TASK_ID_RE.test(masterTaskId) &&
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

            handoffData = handoffStore.state;
            planData = phasePlanStore.state;
        }

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
                const parentPhase = appState.phases.find((p) => p.id === depId);
                if (
                    parentPhase &&
                    parentPhase.status === "completed" &&
                    parentPhase.mcpPhaseId
                ) {
                    const store = createMCPResource<object>(
                        `coogent://tasks/${masterTaskId}/phases/${parentPhase.mcpPhaseId}/handoff`,
                    );
                    _parentHandoffStores.push(store);
                    parentHandoffs = {
                        ...parentHandoffs,
                        [depId]: store.state,
                    };
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
        const idx = appState.phases.findIndex((p) => p.id === depId);
        return idx >= 0 ? idx + 1 : depId;
    }
</script>

<div class="phase-details">
    {#if selectedPhase}
        <!-- Phase Header (title, elapsed badge) -->
        <PhaseHeader {selectedPhase} {phaseNumber} {liveElapsedMs} />

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

        <!-- Action Buttons (retry / restart / skip) -->
        <PhaseActions {selectedPhase} />

        <!-- MCP Artifacts + Handoff Data -->
        <PhaseHandoff
            {selectedPhase}
            {handoffData}
            {planData}
            {parentHandoffs}
            bind:showMCPArtifacts
            hasHandoffStore={!!handoffStore}
            hasPlanStore={!!phasePlanStore}
            {getDepLabel}
        />

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

    .output-mode-row {
        display: flex;
        justify-content: flex-end;
        padding: 4px 0;
    }

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

    .output-placeholder {
        color: var(--vscode-disabledForeground);
        font-style: italic;
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
