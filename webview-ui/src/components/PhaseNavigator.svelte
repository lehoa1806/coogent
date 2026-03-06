<!-- ─────────────────────────────────────────────────────────────────────── -->
<!-- PhaseNavigator.svelte — DAG-aware sidebar with phase items              -->
<!-- ─────────────────────────────────────────────────────────────────────── -->

<script lang="ts">
    import { appState, patchState } from "../stores/vscode.js";
    import type { Phase, PhaseStatus } from "../types.js";

    const STATUS_TEXT: Record<string, string> = {
        pending: "Pending",
        ready: "Ready",
        running: "Running",
        completed: "Done",
        failed: "Failed",
        skipped: "Skipped",
    };

    /** Determine if a phase's dependencies are all completed. */
    function isPhaseReady(
        phase: Phase,
        statusMap: Map<number, string>,
    ): boolean {
        if ((phase.status || "pending").toLowerCase() !== "pending")
            return false;
        const deps = phase.depends_on;
        if (!deps || deps.length === 0) return false;
        return deps.every(
            (depId) =>
                (statusMap.get(depId) || "").toLowerCase() === "completed",
        );
    }

    function truncate(text: string, max: number): string {
        if (!text) return "";
        return text.length > max ? text.slice(0, max) + "…" : text;
    }

    function handlePhaseClick(phaseId: number) {
        patchState({ selectedPhaseId: phaseId, userSelectedPhaseId: phaseId });
    }

    // Build a status map reactively
    let statusMap = $derived(
        new Map(
            $appState.phases.map((p) => [
                p.id,
                (p.status || "pending").toLowerCase(),
            ]),
        ),
    );

    // Compute effective statuses
    let phasesWithStatus = $derived(
        $appState.phases.map((phase, index) => {
            const statusKey = (phase.status || "pending").toLowerCase();
            const ready = isPhaseReady(phase, statusMap);
            const effectiveStatus = ready ? "ready" : statusKey;
            return { phase, index, effectiveStatus, ready };
        }),
    );
</script>

<nav class="phase-navigator" aria-label="Phase navigator" role="list">
    <div class="nav-header panel-header">Phase Navigator</div>

    {#each phasesWithStatus as { phase, index, effectiveStatus, ready } (phase.id)}
        {#if index > 0}
            <div class="phase-connector" aria-hidden="true"></div>
        {/if}

        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <div
            class="phase-item"
            class:active={$appState.selectedPhaseId === phase.id}
            class:ready
            data-phase-id={phase.id}
            role="listitem"
            tabindex="0"
            title="Click to view details for Phase {index + 1}"
            onclick={() => handlePhaseClick(phase.id)}
            onkeydown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    handlePhaseClick(phase.id);
                }
            }}
        >
            <span class="phase-number">{index + 1}</span>

            <div class="phase-item-content">
                <span class="phase-prompt-preview" title={phase.prompt || ""}>
                    {truncate(phase.prompt || "", 60)}
                </span>

                {#if phase.depends_on && phase.depends_on.length > 0}
                    <div
                        class="phase-deps-row"
                        aria-label="Depends on phases: {phase.depends_on
                            .map((d) => {
                                const depIdx = $appState.phases.findIndex(
                                    (p) => p.id === d,
                                );
                                return depIdx >= 0 ? depIdx + 1 : d;
                            })
                            .join(', ')}"
                    >
                        {#each phase.depends_on as depId}
                            {@const depIndex = $appState.phases.findIndex(
                                (p) => p.id === depId,
                            )}
                            <span
                                class="dep-badge"
                                title="Depends on Phase {depIndex >= 0
                                    ? depIndex + 1
                                    : depId}"
                            >
                                ← #{depIndex >= 0 ? depIndex + 1 : depId}
                            </span>
                        {/each}
                    </div>
                {/if}
            </div>

            <span
                class="status-pill {effectiveStatus}"
                title="Current status: {STATUS_TEXT[effectiveStatus] ||
                    phase.status}"
            >
                {STATUS_TEXT[effectiveStatus] || phase.status}
            </span>
        </div>
    {/each}
</nav>

<style>
    .phase-navigator {
        width: 220px;
        min-width: 180px;
        border-right: 1px solid
            var(
                --vscode-contrastBorder,
                var(--vscode-panel-border, rgba(128, 128, 128, 0.35))
            );
        background: var(
            --vscode-sideBar-background,
            var(--vscode-editor-background)
        );
        display: flex;
        flex-direction: column;
        overflow-y: auto;
        flex-shrink: 0;
    }

    .nav-header {
        padding: 8px 16px;
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.8px;
        color: var(
            --vscode-sideBarTitle-foreground,
            var(
                --vscode-panelTitle-activeForeground,
                var(--vscode-descriptionForeground)
            )
        );
        font-weight: 700;
        border-bottom: 1px solid
            var(
                --vscode-editorGroup-border,
                var(--vscode-panel-border, rgba(128, 128, 128, 0.35))
            );
        flex-shrink: 0;
        user-select: none;
    }

    .phase-connector {
        width: 2px;
        height: 8px;
        margin: 0 auto;
        background: var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
        border-radius: 1px;
        flex-shrink: 0;
    }

    .phase-item {
        padding: 8px 12px;
        border-radius: 4px;
        cursor: pointer;
        transition: background 0.15s ease;
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 2px 4px;
        font-size: 12px;
        color: var(--vscode-foreground);
    }

    .phase-item:hover {
        background: var(
            --vscode-editorWidget-background,
            var(--vscode-sideBar-background)
        );
    }

    .phase-item.active {
        background: color-mix(
            in srgb,
            var(--vscode-focusBorder, #007fd4) 12%,
            transparent
        );
        color: var(--vscode-focusBorder, #007fd4);
    }

    .phase-item.ready {
        border-left: 3px solid
            var(
                --vscode-editorInfo-foreground,
                var(--vscode-charts-blue, #58a6ff)
            );
        background: color-mix(
            in srgb,
            var(--vscode-editorInfo-foreground, #58a6ff) 10%,
            transparent
        );
    }

    .phase-number {
        font-family: var(
            --vscode-editor-font-family,
            "SFMono-Regular",
            Consolas,
            monospace
        );
        font-size: 10px;
        font-weight: 700;
        color: var(--vscode-disabledForeground, rgba(128, 128, 128, 0.6));
        width: 18px;
        height: 18px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 50%;
        background: var(
            --vscode-editorWidget-background,
            var(--vscode-sideBar-background)
        );
        flex-shrink: 0;
    }

    .phase-item-content {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
        overflow: hidden;
    }

    .phase-prompt-preview {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 11px;
        color: var(--vscode-foreground);
    }

    .phase-deps-row {
        display: flex;
        flex-wrap: wrap;
        gap: 3px;
        align-items: center;
    }

    .dep-badge {
        display: inline-flex;
        align-items: center;
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 9px;
        font-weight: 700;
        padding: 1px 6px;
        border-radius: 4px;
        background: var(
            --vscode-badge-background,
            var(--vscode-editorWidget-background)
        );
        color: var(
            --vscode-badge-foreground,
            var(--vscode-descriptionForeground)
        );
        white-space: nowrap;
        line-height: 1.4;
        letter-spacing: 0.3px;
    }

    .status-pill {
        font-size: 9px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.4px;
        padding: 2px 8px;
        border-radius: 4px;
        min-width: 50px;
        text-align: center;
        line-height: 1.4;
    }

    .status-pill.pending {
        color: var(--vscode-disabledForeground);
        background: var(--vscode-editorWidget-background);
    }
    .status-pill.running {
        color: var(--vscode-focusBorder, #007fd4);
        background: color-mix(
            in srgb,
            var(--vscode-focusBorder, #007fd4) 12%,
            transparent
        );
        animation: pulse 2s ease-in-out infinite;
    }
    .status-pill.completed {
        color: var(--vscode-charts-green, #3fb950);
        background: color-mix(
            in srgb,
            var(--vscode-charts-green, #3fb950) 10%,
            transparent
        );
    }
    .status-pill.failed {
        color: var(--vscode-errorForeground, #f85149);
        background: color-mix(
            in srgb,
            var(--vscode-errorForeground, #f85149) 10%,
            transparent
        );
    }
    .status-pill.skipped {
        color: var(--vscode-editorWarning-foreground, #d29922);
        background: color-mix(
            in srgb,
            var(--vscode-editorWarning-foreground, #d29922) 10%,
            transparent
        );
    }
    .status-pill.ready {
        color: var(--vscode-editorInfo-foreground, #58a6ff);
        background: color-mix(
            in srgb,
            var(--vscode-editorInfo-foreground, #58a6ff) 10%,
            transparent
        );
        animation: pulse 2s ease-in-out infinite;
    }

    @keyframes pulse {
        0%,
        100% {
            opacity: 1;
        }
        50% {
            opacity: 0.6;
        }
    }
</style>
