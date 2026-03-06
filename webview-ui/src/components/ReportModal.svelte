<!-- ─────────────────────────────────────────────────────────────────────── -->
<!-- ReportModal.svelte — Overlay modal for report / plan display           -->
<!--                                                                        -->
<!-- Fetches content via MCP resource stores when a projectId is available,  -->
<!-- with fallback to monolithic appState for backward compatibility.        -->
<!-- ─────────────────────────────────────────────────────────────────────── -->

<script lang="ts">
    import { appState, patchState } from "../stores/vscode.js";
    import {
        createMCPResource,
        type MCPResourceStore,
        type MCPResourceState,
    } from "../stores/mcpStore.js";
    import MarkdownRenderer from "./MarkdownRenderer.svelte";

    // ── Legacy appState data (pushed via CONSOLIDATION_REPORT / IMPLEMENTATION_PLAN) ──
    let legacyReport = $derived($appState.consolidationReport);
    let legacyPlan = $derived($appState.implementationPlan);

    // ── MCP resource stores ──────────────────────────────────────────────
    let reportStore: MCPResourceStore<string> | null = $state(null);
    let planStore: MCPResourceStore<string> | null = $state(null);

    let reportData: MCPResourceState<string> = $state({
        loading: false,
        data: null,
        error: null,
    });
    let planMcpData: MCPResourceState<string> = $state({
        loading: false,
        data: null,
        error: null,
    });

    /**
     * Determine show/hide from either legacy push data or MCP store data.
     */
    let showReport = $derived(legacyReport != null);
    let showPlan = $derived(legacyPlan != null && !showReport);
    let visible = $derived(showReport || showPlan);
    let title = $derived(
        showReport ? "📊 Consolidation Report" : "📋 Implementation Plan",
    );

    // ── Create MCP stores when modal becomes visible ─────────────────────
    $effect(() => {
        const taskId = $appState.masterTaskId;
        if (visible && taskId) {
            // Create report store on demand
            if (showReport && !reportStore) {
                reportStore = createMCPResource<string>(
                    `coogent://tasks/${taskId}/consolidation_report`,
                );
                reportStore.subscribe((v) => {
                    reportData = v;
                });
            }
            // Create plan store on demand
            if (showPlan && !planStore) {
                planStore = createMCPResource<string>(
                    `coogent://tasks/${taskId}/implementation_plan`,
                );
                planStore.subscribe((v) => {
                    planMcpData = v;
                });
            }
        }

        return () => {
            reportStore?.destroy();
            planStore?.destroy();
        };
    });

    /**
     * Resolved content: prefer MCP data, fallback to legacy appState.
     */
    let resolvedContent = $derived(
        showReport
            ? reportData.data || legacyReport || ""
            : planMcpData.data || legacyPlan || "",
    );

    let isLoading = $derived(
        showReport ? reportData.loading : planMcpData.loading,
    );

    let fetchError = $derived(
        showReport ? reportData.error : planMcpData.error,
    );

    function close() {
        // Clean up MCP stores
        reportStore?.destroy();
        planStore?.destroy();
        reportStore = null;
        planStore = null;
        reportData = { loading: false, data: null, error: null };
        planMcpData = { loading: false, data: null, error: null };

        // Clear legacy appState
        if (showReport) {
            patchState({ consolidationReport: null });
        } else {
            patchState({ implementationPlan: null });
        }
    }

    function handleOverlayClick(e: MouseEvent) {
        if (e.target === e.currentTarget) close();
    }

    function handleKeydown(e: KeyboardEvent) {
        if (e.key === "Escape" && visible) {
            e.preventDefault();
            close();
        }
    }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if visible}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
        class="report-overlay visible"
        onclick={handleOverlayClick}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabindex="-1"
    >
        <div class="report-modal">
            <div class="report-header">
                <h2>{title}</h2>
                <button class="btn-close-modal" onclick={close}>✕</button>
            </div>
            <div class="report-content">
                {#if isLoading}
                    <div class="report-loading">Loading…</div>
                {:else if fetchError && !resolvedContent}
                    <div class="report-error">{fetchError}</div>
                {:else if resolvedContent}
                    <MarkdownRenderer content={resolvedContent} />
                {:else}
                    <div class="report-empty">No content available.</div>
                {/if}
            </div>
        </div>
    </div>
{/if}

<style>
    .report-overlay {
        position: fixed;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        background: color-mix(
            in srgb,
            var(--vscode-widget-shadow, #000) 55%,
            transparent
        );
        backdrop-filter: blur(4px);
        z-index: 200;
        animation: fade-in 0.15s ease-out;
    }

    @keyframes fade-in {
        from {
            opacity: 0;
        }
        to {
            opacity: 1;
        }
    }

    .report-modal {
        width: min(90vw, 700px);
        max-height: 80vh;
        display: flex;
        flex-direction: column;
        background: var(
            --vscode-editor-background,
            var(--vscode-sideBar-background)
        );
        border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
        border-radius: 6px;
        box-shadow: 0 16px 48px
            color-mix(
                in srgb,
                var(--vscode-widget-shadow, #000) 40%,
                transparent
            );
        overflow: hidden;
    }

    .report-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 16px;
        border-bottom: 1px solid
            var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
        flex-shrink: 0;
    }

    .report-header h2 {
        font-size: 14px;
        font-weight: 600;
        color: var(--vscode-foreground);
        margin: 0;
    }

    .btn-close-modal {
        background: transparent;
        border: none;
        color: var(--vscode-descriptionForeground);
        font-size: 16px;
        cursor: pointer;
        padding: 4px 8px;
        border-radius: 4px;
        transition: all 0.15s ease;
        line-height: 1;
    }

    .btn-close-modal:hover {
        color: var(--vscode-foreground);
        background: var(--vscode-editorWidget-background);
    }

    .report-content {
        flex: 1;
        overflow-y: auto;
        padding: 16px;
        font-size: 13px;
        line-height: 1.7;
        color: var(--vscode-foreground);
        word-wrap: break-word;
    }

    .report-loading {
        color: var(--vscode-descriptionForeground);
        font-style: italic;
        padding: 20px 0;
        text-align: center;
    }

    .report-error {
        color: var(--vscode-errorForeground, #f85149);
        padding: 12px;
        font-size: 12px;
    }

    .report-empty {
        color: var(--vscode-disabledForeground);
        font-style: italic;
        text-align: center;
        padding: 20px 0;
    }
</style>
