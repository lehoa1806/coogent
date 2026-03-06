<!-- ─────────────────────────────────────────────────────────────────────── -->
<!-- ChatInput.svelte — Prompt input bar for submitting tasks / feedback     -->
<!-- ─────────────────────────────────────────────────────────────────────── -->

<script lang="ts">
    import { appState, postMessage } from "../stores/vscode.js";

    let prompt = $state("");
    let textareaEl: HTMLTextAreaElement | undefined = $state(undefined);

    // Derived state from engine
    let engineState = $derived($appState.engineState);
    let isIdle = $derived(engineState === "IDLE");
    let isPlanReview = $derived(engineState === "PLAN_REVIEW");
    let isPlanning = $derived(engineState === "PLANNING");
    let isErrorPaused = $derived(engineState === "ERROR_PAUSED");

    // Show the input in IDLE (new task), PLAN_REVIEW (feedback), ERROR_PAUSED (retry)
    let isVisible = $derived(isIdle || isPlanReview || isErrorPaused);

    let placeholder = $derived(
        isPlanReview
            ? "Provide feedback on the plan…"
            : isErrorPaused
              ? "Describe how to fix the issue…"
              : "Describe your task…",
    );

    let buttonLabel = $derived(
        isPlanReview ? "Send Feedback" : isErrorPaused ? "Retry" : "Plan",
    );

    let isEmpty = $derived(prompt.trim().length === 0);

    function handleSubmit() {
        const text = prompt.trim();
        if (!text) return;

        if (isPlanReview) {
            // Reject with feedback so the planner refines the plan
            postMessage({
                type: "CMD_PLAN_REJECT",
                payload: { feedback: text },
            });
        } else {
            // New plan request (IDLE) or re-plan after error
            postMessage({
                type: "CMD_PLAN_REQUEST",
                payload: { prompt: text },
            });
        }

        prompt = "";
        autoResize();
    }

    function handleKeydown(e: KeyboardEvent) {
        // Enter sends, Shift+Enter inserts newline
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleSubmit();
        }
    }

    function autoResize() {
        if (!textareaEl) return;
        textareaEl.style.height = "auto";
        textareaEl.style.height = `${Math.min(textareaEl.scrollHeight, 160)}px`;
    }

    function handleInput() {
        autoResize();
    }
</script>

{#if isVisible}
    <div class="chat-input" class:planning={isPlanning}>
        <div class="input-row">
            <textarea
                bind:this={textareaEl}
                bind:value={prompt}
                {placeholder}
                rows="1"
                onkeydown={handleKeydown}
                oninput={handleInput}
                disabled={isPlanning}
                id="chat-prompt-input"
            ></textarea>
            <button
                class="send-btn"
                onclick={handleSubmit}
                disabled={isEmpty || isPlanning}
                title={buttonLabel}
                id="chat-send-button"
            >
                {#if isPlanning}
                    <span class="spinner-inline"></span>
                {:else}
                    <svg
                        width="16"
                        height="16"
                        viewBox="0 0 16 16"
                        fill="none"
                        xmlns="http://www.w3.org/2000/svg"
                    >
                        <path
                            d="M2.5 8L13.5 8M13.5 8L9 3.5M13.5 8L9 12.5"
                            stroke="currentColor"
                            stroke-width="1.5"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                        />
                    </svg>
                {/if}
            </button>
        </div>
        <div class="hint">
            {#if isPlanReview}
                <span>Describe changes to refine the plan</span>
            {:else if isPlanning}
                <span class="planning-hint">⏳ Generating plan…</span>
            {:else}
                <span
                    ><kbd>Enter</kbd> to send · <kbd>Shift+Enter</kbd> for newline</span
                >
            {/if}
        </div>
    </div>
{/if}

<style>
    .chat-input {
        padding: 8px 12px 6px;
        border-top: 1px solid
            var(
                --vscode-panel-border,
                var(--vscode-widget-border, rgba(128, 128, 128, 0.35))
            );
        background: var(
            --vscode-sideBar-background,
            var(--vscode-editor-background)
        );
        flex-shrink: 0;
        animation: fade-in 0.2s ease-out;
    }

    .input-row {
        display: flex;
        gap: 6px;
        align-items: flex-end;
    }

    textarea {
        flex: 1;
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size, 13px);
        color: var(--vscode-input-foreground, var(--vscode-foreground));
        background: var(
            --vscode-input-background,
            var(--vscode-editorWidget-background)
        );
        border: 1px solid
            var(
                --vscode-input-border,
                var(--vscode-panel-border, rgba(128, 128, 128, 0.35))
            );
        border-radius: 4px;
        padding: 8px 10px;
        resize: none;
        overflow-y: auto;
        min-height: 36px;
        max-height: 160px;
        line-height: 1.45;
        transition: border-color 0.15s ease;
    }

    textarea:focus {
        outline: none;
        border-color: var(--vscode-focusBorder, #007fd4);
    }

    textarea::placeholder {
        color: var(
            --vscode-input-placeholderForeground,
            var(--vscode-descriptionForeground)
        );
    }

    textarea:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }

    .send-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 34px;
        height: 34px;
        flex-shrink: 0;
        border: none;
        border-radius: 4px;
        background: var(
            --vscode-button-background,
            var(--vscode-focusBorder, #007fd4)
        );
        color: var(--vscode-button-foreground, #fff);
        cursor: pointer;
        transition: all 0.15s ease;
    }

    .send-btn:hover:not(:disabled) {
        background: var(--vscode-button-hoverBackground);
    }

    .send-btn:disabled {
        opacity: 0.35;
        cursor: not-allowed;
    }

    .send-btn svg {
        display: block;
    }

    .spinner-inline {
        display: block;
        width: 14px;
        height: 14px;
        border: 2px solid rgba(255, 255, 255, 0.3);
        border-top-color: #fff;
        border-radius: 50%;
        animation: spin 0.7s linear infinite;
    }

    .hint {
        font-size: 10px;
        color: var(--vscode-descriptionForeground, rgba(128, 128, 128, 0.7));
        margin-top: 4px;
        padding-left: 2px;
        user-select: none;
    }

    .hint kbd {
        font-family: var(
            --vscode-editor-font-family,
            "SFMono-Regular",
            Consolas,
            monospace
        );
        font-size: 9px;
        padding: 1px 4px;
        border-radius: 3px;
        border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
        background: var(
            --vscode-editorWidget-background,
            rgba(128, 128, 128, 0.1)
        );
    }

    .planning-hint {
        color: var(--vscode-charts-purple, #a78bfa);
        animation: badge-pulse 2s ease-in-out infinite;
    }
</style>
