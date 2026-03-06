<!-- ─────────────────────────────────────────────────────────────────────── -->
<!-- PlanReview.svelte — Plan carousel with approve/reject controls          -->
<!-- ─────────────────────────────────────────────────────────────────────── -->

<script lang="ts">
    import { appState, postMessage, patchState } from "../stores/vscode.js";

    let feedback = $state("");
    let approveDisabled = $state(false);
    let rejectDisabled = $state(false);

    let visible = $derived($appState.engineState === "PLAN_REVIEW");
    let draft = $derived($appState.planDraft);
    let phases = $derived(draft?.phases ?? []);
    let slideIndex = $derived($appState.planSlideIndex);
    let currentPhase = $derived(phases[slideIndex]);

    // Reset button states when entering PLAN_REVIEW
    $effect(() => {
        if (visible) {
            approveDisabled = false;
            rejectDisabled = false;
            feedback = "";
        }
    });

    function prevSlide() {
        if (slideIndex > 0) patchState({ planSlideIndex: slideIndex - 1 });
    }

    function nextSlide() {
        if (slideIndex < phases.length - 1)
            patchState({ planSlideIndex: slideIndex + 1 });
    }

    function handleApprove() {
        if (approveDisabled) return;
        approveDisabled = true;
        postMessage({ type: "CMD_PLAN_APPROVE" });
    }

    function handleReject() {
        if (rejectDisabled) return;
        rejectDisabled = true;
        postMessage({
            type: "CMD_PLAN_REJECT",
            payload: { feedback: feedback.trim() || "Please revise the plan." },
        });
        feedback = "";
    }

    function handleKeydown(e: KeyboardEvent) {
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
                        <span class="plan-card-files">
                            {(currentPhase.context_files || []).length} context files
                        </span>
                    </div>

                    <div class="plan-card-prompt">
                        <pre>{currentPhase.prompt || ""}</pre>
                    </div>

                    {#if currentPhase.context_files && currentPhase.context_files.length > 0}
                        <div class="plan-card-context">
                            {#each currentPhase.context_files as f}
                                <code>{f}</code>
                            {/each}
                        </div>
                    {/if}

                    <div class="plan-card-criteria">
                        <span
                            >Success: <code
                                >{currentPhase.success_criteria ||
                                    "exit_code:0"}</code
                            ></span
                        >
                    </div>
                </div>
            {/if}

            <!-- Actions -->
            <div class="plan-review-actions">
                <button
                    class="primary approve-btn"
                    onclick={handleApprove}
                    disabled={approveDisabled}
                >
                    {approveDisabled ? "✓ Approved" : "✓ Approve"}
                </button>

                <div class="plan-replan-group">
                    <input
                        type="text"
                        class="plan-feedback-input"
                        placeholder="Feedback for revision…"
                        bind:value={feedback}
                    />
                    <button
                        class="danger reject-btn"
                        onclick={handleReject}
                        disabled={rejectDisabled}
                    >
                        {rejectDisabled ? "↻ Revising..." : "↻ Revise Plan"}
                    </button>
                </div>
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
        max-height: 60vh;
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

    .plan-carousel-nav {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 12px;
        padding: 8px 0;
        margin-bottom: 8px;
        border-bottom: 1px solid
            var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
    }

    .plan-carousel-nav button {
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
    }

    .plan-carousel-nav button:hover:not(:disabled) {
        background: color-mix(
            in srgb,
            var(--vscode-focusBorder, #007fd4) 12%,
            transparent
        );
        border-color: var(--vscode-focusBorder, #007fd4);
        color: var(--vscode-focusBorder, #007fd4);
    }

    .plan-carousel-nav button:disabled {
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
        margin-bottom: 6px;
    }

    .phase-id {
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
        font-weight: 700;
    }

    .plan-card-files {
        font-size: 10px;
        color: var(--vscode-disabledForeground);
        font-family: var(--vscode-editor-font-family, monospace);
    }

    .plan-card-prompt {
        font-size: 12px;
        line-height: 1.5;
        margin-bottom: 8px;
    }
    .plan-card-prompt pre {
        white-space: pre-wrap;
        word-wrap: break-word;
        margin: 0;
        font-family: var(--vscode-font-family);
        font-size: 12px;
        background: transparent;
        color: var(--vscode-foreground);
    }

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

    .plan-card-criteria {
        font-size: 10px;
        color: var(--vscode-disabledForeground);
    }
    .plan-card-criteria code {
        font-family: var(--vscode-editor-font-family, monospace);
        color: var(--vscode-descriptionForeground);
    }

    .plan-review-actions {
        display: flex;
        flex-direction: column;
        gap: 8px;
        margin-top: 12px;
        padding: 10px 0 4px;
        border-top: 1px solid
            var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
    }

    .approve-btn {
        font-family: var(--vscode-font-family);
        font-size: 11px;
        font-weight: 600;
        padding: 6px 16px;
        border-radius: 4px;
        border: none;
        cursor: pointer;
        transition: all 0.15s ease;
        background: var(--vscode-testing-iconPassed, #388a34);
        color: var(--vscode-button-foreground, #fff);
    }

    .approve-btn:hover:not(:disabled) {
        filter: brightness(1.15);
    }
    .approve-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }

    .plan-replan-group {
        display: flex;
        gap: 6px;
        align-items: center;
    }

    .plan-feedback-input {
        flex: 1;
        padding: 5px 10px;
        font-family: var(--vscode-font-family);
        font-size: 12px;
        background: var(
            --vscode-input-background,
            var(--vscode-editor-background)
        );
        color: var(--vscode-input-foreground, var(--vscode-foreground));
        border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
        border-radius: 4px;
        transition: border-color 0.15s ease;
    }

    .plan-feedback-input:focus {
        outline: none;
        border-color: var(--vscode-focusBorder, #007fd4);
        box-shadow: 0 0 0 1px var(--vscode-focusBorder, #007fd4);
    }

    .reject-btn {
        font-family: var(--vscode-font-family);
        font-size: 11px;
        font-weight: 600;
        padding: 6px 16px;
        border-radius: 4px;
        border: none;
        cursor: pointer;
        transition: all 0.15s ease;
        background: var(--vscode-editorWarning-foreground, #cca700);
        color: var(--vscode-button-foreground, #fff);
        flex-shrink: 0;
    }

    .reject-btn:hover:not(:disabled) {
        filter: brightness(1.15);
    }
    .reject-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }
</style>
