<!-- ─────────────────────────────────────────────────────────────────────── -->
<!-- PlanReview.svelte — Plan carousel with View-All modal & Preview/Raw   -->
<!-- ─────────────────────────────────────────────────────────────────────── -->

<script lang="ts">
    import { appState, patchState } from "../stores/vscode.svelte.js";
    import MarkdownRenderer from "./MarkdownRenderer.svelte";
    import ViewModeTabs from "./ViewModeTabs.svelte";

    let {
        showPlanModal = false,
        onclosePlanModal,
    }: {
        /** When true the View-All modal is shown regardless of PLAN_REVIEW state. */
        showPlanModal?: boolean;
        /** Callback so parent can reset its showPlanModal state when the modal closes. */
        onclosePlanModal?: () => void;
    } = $props();

    let visible = $derived(appState.engineState === "PLAN_REVIEW");
    let draft = $derived(appState.planDraft);
    let phases = $derived(draft?.phases ?? []);
    let slideIndex = $derived(appState.planSlideIndex);
    let currentPhase = $derived(phases[slideIndex]);

    /** Original prompt the user submitted before planning started */
    let originalPrompt = $derived(appState.lastPrompt ?? "");

    // ── View-All modal ───────────────────────────────────────────────────
    // showAllModal is true when locally toggled OR externally forced via prop
    let _showAllLocal = $state(false);
    let showAllModal = $derived(_showAllLocal || showPlanModal);

    function openAllModal() {
        _showAllLocal = true;
    }
    function closeAllModal() {
        _showAllLocal = false;
        onclosePlanModal?.();
    }

    /**
     * BUG FIX: Close the View-All modal whenever we leave PLAN_REVIEW state.
     * Without this, the overlay (position:fixed; inset:0; z-index:200) stays
     * mounted as an invisible full-screen blocker over the execution view,
     * making the entire UI appear inaccessible.
     */
    $effect(() => {
        if (!visible) closeAllModal();
    });

    // ── Preview / Raw per-slide (main carousel) ──────────────────────────
    let promptViewMode: "preview" | "raw" = $state("preview");

    // Reset view mode whenever the user advances to a different slide
    $effect(() => {
        slideIndex; // reactive dependency
        promptViewMode = "preview";
    });

    // ── Preview / Raw per-phase in View-All modal ────────────────────────
    // Map from phase index → view mode so each phase retains its own state
    let modalViewModes: Record<number, "preview" | "raw"> = $state({});

    function getModalMode(i: number): "preview" | "raw" {
        return modalViewModes[i] ?? "preview";
    }
    function setModalMode(i: number, mode: "preview" | "raw") {
        modalViewModes = { ...modalViewModes, [i]: mode };
    }

    // ── All Phases modal tab ─────────────────────────────────────────────
    let modalTab: "prompt" | "plan" = $state("plan");
    /** Preview/Raw toggle for the Original Prompt tab in the View-All modal */
    let modalPromptViewMode: "preview" | "raw" = $state("preview");

    // ── Carousel nav ─────────────────────────────────────────────────────
    function prevSlide() {
        if (slideIndex > 0) patchState({ planSlideIndex: slideIndex - 1 });
    }

    function nextSlide() {
        if (slideIndex < phases.length - 1)
            patchState({ planSlideIndex: slideIndex + 1 });
    }

    function handleKeydown(e: KeyboardEvent) {
        if (showAllModal) {
            if (e.key === "Escape") {
                e.preventDefault();
                closeAllModal();
            }
            return;
        }
        if (!visible || phases.length === 0) return;
        if (e.key === "ArrowLeft") {
            e.preventDefault();
            prevSlide();
        }
        if (e.key === "ArrowRight") {
            e.preventDefault();
            nextSlide();
        }
    }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if visible && draft}
    <div class="plan-review-panel panel">
        <div class="panel-header">Plan Review</div>

        <div class="plan-review-area">
            <!-- Project header -->
            <div class="plan-project-id">
                Project: {draft.project_id || "untitled"} · {phases.length} phases
            </div>

            <!-- Carousel nav -->
            {#if phases.length > 0}
                <div class="plan-carousel-nav">
                    <button onclick={prevSlide} disabled={slideIndex === 0}
                        >‹</button
                    >
                    <span class="plan-carousel-label">
                        Phase {slideIndex + 1} / {phases.length}
                    </span>
                    <button
                        onclick={nextSlide}
                        disabled={slideIndex === phases.length - 1}>›</button
                    >
                </div>
            {/if}

            <!-- Current slide card -->
            {#if currentPhase}
                <div class="plan-review-card">
                    <div class="plan-card-header">
                        <span class="phase-id">#{currentPhase.id}</span>
                        <ViewModeTabs
                            value={promptViewMode}
                            onchange={(m) => (promptViewMode = m)}
                        />
                        <span class="plan-card-files">
                            {(currentPhase.context_files || []).length} context files
                        </span>
                    </div>

                    <div class="plan-card-prompt">
                        {#if promptViewMode === "preview"}
                            <MarkdownRenderer
                                content={currentPhase.prompt || ""}
                            />
                        {:else}
                            <pre>{currentPhase.prompt || ""}</pre>
                        {/if}
                    </div>

                    {#if currentPhase.context_files && currentPhase.context_files.length > 0}
                        <div class="plan-card-context">
                            {#each currentPhase.context_files as f}
                                <code>{f}</code>
                            {/each}
                        </div>
                    {/if}
                </div>
            {/if}
        </div>
    </div>
{/if}

<!-- ── View-All Modal ──────────────────────────────────────────────────── -->
{#if showAllModal}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
        class="all-phases-overlay"
        onclick={(e) => {
            if (e.target === e.currentTarget) closeAllModal();
        }}
        role="dialog"
        aria-modal="true"
        aria-label="All Phases"
        tabindex="-1"
    >
        <div class="all-phases-modal">
            <div class="all-phases-header">
                <h2>All Phases — {draft?.project_id || "untitled"}</h2>
                <button class="btn-close-modal" onclick={closeAllModal}
                    >✕</button
                >
            </div>

            <!-- Tab bar -->
            <div class="modal-tab-bar">
                <button
                    class="modal-tab"
                    class:active={modalTab === "prompt"}
                    onclick={() => (modalTab = "prompt")}
                    >Original Prompt</button
                >
                <button
                    class="modal-tab"
                    class:active={modalTab === "plan"}
                    onclick={() => (modalTab = "plan")}
                    >Implementation Plan</button
                >
            </div>

            <div class="all-phases-content">
                {#if modalTab === "prompt"}
                    <!-- Original Prompt tab -->
                    {#if originalPrompt}
                        <div class="modal-prompt-body">
                            <div class="modal-prompt-header">
                                <ViewModeTabs
                                    value={modalPromptViewMode}
                                    onchange={(m) => (modalPromptViewMode = m)}
                                />
                            </div>
                            {#if modalPromptViewMode === "preview"}
                                <MarkdownRenderer content={originalPrompt} />
                            {:else}
                                <p>{originalPrompt}</p>
                            {/if}
                        </div>
                    {:else}
                        <div class="modal-prompt-empty">
                            No prompt recorded.
                        </div>
                    {/if}
                {:else}
                    <!-- Implementation Plan tab (phase cards) -->
                    {#each phases as phase, i}
                        <div class="phase-block">
                            <div class="phase-block-header">
                                <span class="phase-block-id">#{phase.id}</span>
                                <span class="phase-block-num"
                                    >Phase {i + 1}</span
                                >
                                {#if phase.context_files && phase.context_files.length > 0}
                                    <span class="phase-block-files"
                                        >{phase.context_files.length} files</span
                                    >
                                {/if}
                                <div class="modal-tabs-wrapper">
                                    <ViewModeTabs
                                        value={getModalMode(i)}
                                        onchange={(m) => setModalMode(i, m)}
                                    />
                                </div>
                            </div>
                            <div class="phase-block-prompt">
                                {#if getModalMode(i) === "preview"}
                                    <MarkdownRenderer
                                        content={phase.prompt || ""}
                                    />
                                {:else}
                                    <pre>{phase.prompt || ""}</pre>
                                {/if}
                            </div>
                            {#if phase.context_files && phase.context_files.length > 0}
                                <div class="plan-card-context">
                                    {#each phase.context_files as f}
                                        <code>{f}</code>
                                    {/each}
                                </div>
                            {/if}
                        </div>
                        {#if i < phases.length - 1}
                            <div class="phase-divider"></div>
                        {/if}
                    {/each}
                {/if}
            </div>
        </div>
    </div>
{/if}

<style>
    .plan-review-panel {
        border: 1px solid
            var(
                --vscode-contrastBorder,
                var(--vscode-panel-border, rgba(128, 128, 128, 0.35))
            );
        background: var(
            --vscode-sideBar-background,
            var(--vscode-editor-background)
        );
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
    }

    .panel-header {
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.8px;
        color: var(
            --vscode-sideBarTitle-foreground,
            var(--vscode-descriptionForeground)
        );
        padding: 8px 16px;
        border-bottom: 1px solid
            var(--vscode-editorGroup-border, var(--vscode-panel-border));
        background: var(
            --vscode-panel-background,
            var(--vscode-sideBar-background)
        );
        flex-shrink: 0;
        user-select: none;
    }

    .plan-review-area {
        display: flex;
        flex-direction: column;
        min-height: 0;
        flex: 1;
        overflow-y: auto;
        padding: 16px;
    }

    .plan-project-id {
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
        text-transform: uppercase;
        letter-spacing: 0.5px;
        margin-bottom: 10px;
        font-weight: 600;
    }

    /* ── Carousel nav ───────────────────────────────────────────────── */

    .plan-carousel-nav {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 8px 0;
        margin-bottom: 8px;
        border-bottom: 1px solid
            var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
    }

    .plan-carousel-nav > button {
        background: var(--vscode-editorWidget-background);
        border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
        color: var(--vscode-foreground);
        width: 28px;
        height: 28px;
        border-radius: 50%;
        font-size: 14px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        padding: 0;
        transition: all 0.15s ease;
        flex-shrink: 0;
    }

    .plan-carousel-nav > button:hover:not(:disabled) {
        background: color-mix(
            in srgb,
            var(--vscode-focusBorder, #007fd4) 12%,
            transparent
        );
        border-color: var(--vscode-focusBorder, #007fd4);
        color: var(--vscode-focusBorder, #007fd4);
    }

    .plan-carousel-nav > button:disabled {
        opacity: 0.25;
        cursor: not-allowed;
    }

    .plan-carousel-label {
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 12px;
        font-weight: 600;
        color: var(--vscode-descriptionForeground);
        min-width: 90px;
        text-align: center;
    }

    /* ── Phase card ──────────────────────────────────────────────────── */

    .plan-review-card {
        background: var(--vscode-editorWidget-background);
        border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
        border-radius: 6px;
        padding: 12px 14px;
        margin-bottom: 6px;
        transition: border-color 0.15s ease;
    }

    .plan-review-card:hover {
        border-color: color-mix(
            in srgb,
            var(--vscode-focusBorder, #007fd4) 35%,
            transparent
        );
    }

    .plan-card-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 8px;
        gap: 8px;
    }

    .phase-id {
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
        font-weight: 700;
        flex-shrink: 0;
    }

    .plan-card-files {
        font-size: 10px;
        color: var(--vscode-disabledForeground);
        font-family: var(--vscode-editor-font-family, monospace);
        flex-shrink: 0;
    }

    /* ── Preview / Raw tabs — styling owned by ViewModeTabs.svelte ─── */

    /* ── Prompt body ─────────────────────────────────────────────────── */

    .plan-card-prompt {
        font-size: 12px;
        line-height: 1.5;
        margin-bottom: 8px;
    }

    .plan-card-prompt pre,
    .phase-block-prompt pre {
        white-space: pre-wrap;
        word-wrap: break-word;
        margin: 0;
        font-family: var(--vscode-font-family);
        font-size: 12px;
        background: transparent;
        color: var(--vscode-foreground);
    }

    /* ── Context file chips ──────────────────────────────────────────── */

    .plan-card-context {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        margin-bottom: 6px;
    }

    .plan-card-context code {
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 10px;
        padding: 2px 6px;
        background: color-mix(
            in srgb,
            var(--vscode-charts-purple, #a78bfa) 12%,
            transparent
        );
        border-radius: 4px;
        color: var(--vscode-charts-purple, #a78bfa);
    }

    /* ── View-All overlay ────────────────────────────────────────────── */

    .all-phases-overlay {
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

    .all-phases-modal {
        width: min(92vw, 820px);
        max-height: 85vh;
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

    .all-phases-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 16px;
        border-bottom: 1px solid
            var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
        flex-shrink: 0;
    }

    .all-phases-header h2 {
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

    /* ── Modal tab bar ──────────────────────────────────────────────── */

    .modal-tab-bar {
        display: flex;
        border-bottom: 1px solid
            var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
        flex-shrink: 0;
        padding: 0 16px;
        gap: 0;
    }

    .modal-tab {
        font-family: var(--vscode-font-family);
        font-size: 11px;
        font-weight: 600;
        padding: 8px 14px;
        background: transparent;
        border: none;
        border-bottom: 2px solid transparent;
        color: var(--vscode-descriptionForeground);
        cursor: pointer;
        transition: all 0.15s ease;
    }

    .modal-tab.active {
        color: var(--vscode-focusBorder, #007fd4);
        border-bottom-color: var(--vscode-focusBorder, #007fd4);
    }

    .modal-tab:hover:not(.active) {
        color: var(--vscode-foreground);
    }

    .modal-prompt-body {
        padding: 16px 0;
    }

    .modal-prompt-body p {
        margin: 0;
        font-size: 13px;
        line-height: 1.7;
        color: var(--vscode-foreground);
        white-space: pre-wrap;
        word-wrap: break-word;
    }

    .modal-prompt-header {
        display: flex;
        justify-content: flex-end;
        margin-bottom: 12px;
    }

    .modal-prompt-empty {
        color: var(--vscode-disabledForeground);
        font-style: italic;
        text-align: center;
        padding: 20px 0;
    }

    .all-phases-content {
        flex: 1;
        overflow-y: auto;
        padding: 20px;
    }

    .phase-block {
        margin-bottom: 4px;
    }

    .phase-block-header {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 8px;
        flex-wrap: wrap;
    }

    .phase-block-id {
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 11px;
        font-weight: 700;
        color: var(--vscode-descriptionForeground);
    }

    .phase-block-num {
        font-size: 12px;
        font-weight: 600;
        color: var(--vscode-foreground);
    }

    .phase-block-files {
        font-size: 10px;
        color: var(--vscode-disabledForeground);
        font-family: var(--vscode-editor-font-family, monospace);
        margin-right: auto;
    }

    /* Modal tabs wrapper shifts tab to right side */
    .modal-tabs-wrapper {
        margin-left: auto;
    }

    .phase-block-prompt {
        font-size: 12px;
        line-height: 1.6;
        margin-bottom: 10px;
    }

    .phase-divider {
        height: 1px;
        background: var(--vscode-panel-border, rgba(128, 128, 128, 0.2));
        margin: 18px 0;
    }

    @keyframes fade-in {
        from {
            opacity: 0;
        }
        to {
            opacity: 1;
        }
    }
</style>
