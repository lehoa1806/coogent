<!-- ─────────────────────────────────────────────────────────────────────── -->
<!--   ChatInput.svelte — Prompt input with suggestion & toolbar           -->
<!--   Sprint 3 refactor: SuggestionPopup + InputToolbar extracted         -->
<!-- ─────────────────────────────────────────────────────────────────────── -->

<script lang="ts">
    import {
        appState,
        postMessage,
        patchState,
    } from "../stores/vscode.svelte.js";
    import type { ConversationMode } from "../types.js";
    import MarkdownRenderer from "./MarkdownRenderer.svelte";
    import SuggestionPopup from "./SuggestionPopup.svelte";
    import InputToolbar from "./InputToolbar.svelte";
    import type { SuggestionItem } from "./SuggestionPopup.svelte";

    let prompt = $state("");
    let textareaEl: HTMLTextAreaElement | undefined = $state(undefined);

    // ── Preview/Raw toggle ──────────────────────────────────────────────
    let inputMode: "raw" | "preview" = $state("raw");

    // ── Suggestion popup state ──────────────────────────────────────────
    let mentionItems = $derived(appState.mentionItems);
    let workflowItems = $derived(appState.workflowItems);

    type SuggestionKind = "mention" | "workflow" | null;

    let suggestionKind: SuggestionKind = $state(null);
    let filteredSuggestions: SuggestionItem[] = $state([]);
    let selectedSuggestionIndex = $state(0);
    let suggestionFilter = $state("");

    // ── Conversation modes ──────────────────────────────────────────────
    const modes: { value: ConversationMode; label: string }[] = [
        { value: "isolated", label: "Isolated" },
        { value: "continuous", label: "Continuous" },
        { value: "smart", label: "Smart" },
    ];

    function handleModeChange(e: Event) {
        const select = e.target as HTMLSelectElement;
        postMessage({
            type: "CMD_SET_CONVERSATION_MODE",
            payload: { mode: select.value as ConversationMode },
        });
    }

    // ── Derived state from engine ───────────────────────────────────────
    let engineState = $derived(appState.engineState);
    let isIdle = $derived(engineState === "IDLE");
    let isPlanning = $derived(engineState === "PLANNING");
    let isErrorPaused = $derived(engineState === "ERROR_PAUSED");
    let isPlanReview = $derived(engineState === "PLAN_REVIEW");

    // Show input in IDLE, ERROR_PAUSED, or PLAN_REVIEW.
    let isVisible = $derived(isIdle || isErrorPaused || isPlanReview);

    let placeholder = $derived(
        isErrorPaused
            ? "Describe how to fix the issue…"
            : isPlanReview
              ? "Provide feedback to revise the plan…"
              : "Ask anything, @ to mention, / for workflows",
    );

    let buttonLabel = $derived(
        isErrorPaused ? "Retry" : isPlanReview ? "Revise" : "Plan",
    );

    let isEmpty = $derived(prompt.trim().length === 0);

    // ── Plan Review approve state ────────────────────────────────────────
    let approveDisabled = $state(false);

    $effect(() => {
        if (isPlanReview) approveDisabled = false;
    });

    function handleApprove() {
        if (approveDisabled) return;
        approveDisabled = true;
        postMessage({ type: "CMD_PLAN_APPROVE" });
    }

    // ── Toolbar actions ─────────────────────────────────────────────────
    function handleUploadFile() {
        postMessage({ type: "CMD_UPLOAD_FILE" });
    }

    function handleUploadImage() {
        postMessage({ type: "CMD_UPLOAD_IMAGE" });
    }

    // ── Submit ──────────────────────────────────────────────────────────
    function handleSubmit() {
        const text = prompt.trim();
        if (!text) return;

        if (isPlanReview) {
            postMessage({
                type: "CMD_PLAN_REJECT",
                payload: { feedback: text },
            });
        } else {
            patchState({ lastPrompt: text });
            postMessage({
                type: "CMD_PLAN_REQUEST",
                payload: { prompt: text },
            });
        }

        prompt = "";
        inputMode = "raw";
        closeSuggestions();
        autoResize();
    }

    // ── Attachment listener ──────────────────────────────────────────────
    $effect(() => {
        function handleAttachment(event: MessageEvent) {
            const msg = event.data;
            if (
                msg?.type === "ATTACHMENT_SELECTED" &&
                Array.isArray(msg.payload?.paths)
            ) {
                const refs = msg.payload.paths
                    .map((p: string) => `@file ${p}`)
                    .join(" ");
                if (refs) {
                    prompt = prompt ? `${prompt} ${refs}` : refs;
                    autoResize();
                    textareaEl?.focus();
                }
            }
        }
        window.addEventListener("message", handleAttachment);
        return () => window.removeEventListener("message", handleAttachment);
    });

    // ── Restore prompt after git pre-flight cancel ──────────────────
    $effect(() => {
        const restored = appState.lastPrompt;
        if (restored) {
            prompt = restored;
            patchState({ lastPrompt: '' });
            autoResize();
        }
    });

    // ── Suggestion logic ────────────────────────────────────────────────
    function detectTrigger() {
        if (!textareaEl) return;

        const val = textareaEl.value;
        const pos = textareaEl.selectionStart ?? 0;

        let triggerStart = -1;
        for (let i = pos - 1; i >= 0; i--) {
            const ch = val[i];
            if (ch === " " || ch === "\n") break;
            if (ch === "@" || ch === "/") {
                if (i === 0 || val[i - 1] === " " || val[i - 1] === "\n") {
                    triggerStart = i;
                }
                break;
            }
        }

        if (triggerStart === -1) {
            closeSuggestions();
            return;
        }

        const trigger = val[triggerStart];
        const filter = val.slice(triggerStart + 1, pos).toLowerCase();
        const kind: SuggestionKind = trigger === "@" ? "mention" : "workflow";
        const pool: SuggestionItem[] =
            kind === "mention" ? mentionItems : workflowItems;

        const matches = pool.filter(
            (item) =>
                item.label.toLowerCase().includes(filter) ||
                item.description.toLowerCase().includes(filter),
        );

        if (matches.length === 0) {
            closeSuggestions();
            return;
        }

        suggestionKind = kind;
        filteredSuggestions = matches;
        suggestionFilter = val.slice(triggerStart, pos);
        selectedSuggestionIndex = 0;
    }

    function closeSuggestions() {
        suggestionKind = null;
        filteredSuggestions = [];
        selectedSuggestionIndex = 0;
        suggestionFilter = "";
    }

    function acceptSuggestion(item: SuggestionItem) {
        if (!textareaEl) return;

        const val = textareaEl.value;
        const pos = textareaEl.selectionStart ?? 0;

        let triggerStart = pos;
        for (let i = pos - 1; i >= 0; i--) {
            const ch = val[i];
            if (ch === "@" || ch === "/") {
                triggerStart = i;
                break;
            }
            if (ch === " " || ch === "\n") break;
        }

        const before = val.slice(0, triggerStart);
        const after = val.slice(pos);
        prompt = before + item.insert + after;

        closeSuggestions();

        requestAnimationFrame(() => {
            if (textareaEl) {
                const newPos = triggerStart + item.insert.length;
                textareaEl.selectionStart = newPos;
                textareaEl.selectionEnd = newPos;
                textareaEl.focus();
            }
        });
    }

    // ── Input handling ──────────────────────────────────────────────────
    function handleKeydown(e: KeyboardEvent) {
        // Toggle preview mode: Ctrl+Shift+P (Cmd+Shift+P on Mac)
        if (
            (e.ctrlKey || e.metaKey) &&
            e.shiftKey &&
            (e.key === "p" || e.key === "P")
        ) {
            e.preventDefault();
            inputMode = inputMode === "raw" ? "preview" : "raw";
            return;
        }

        // Suggestion navigation
        if (suggestionKind) {
            if (e.key === "ArrowDown") {
                e.preventDefault();
                selectedSuggestionIndex = Math.min(
                    selectedSuggestionIndex + 1,
                    filteredSuggestions.length - 1,
                );
                return;
            }
            if (e.key === "ArrowUp") {
                e.preventDefault();
                selectedSuggestionIndex = Math.max(
                    selectedSuggestionIndex - 1,
                    0,
                );
                return;
            }
            if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                acceptSuggestion(filteredSuggestions[selectedSuggestionIndex]);
                return;
            }
            if (e.key === "Escape") {
                e.preventDefault();
                closeSuggestions();
                return;
            }
        }

        // Normal input: Enter sends, Shift+Enter inserts newline
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleSubmit();
        }
    }

    function autoResize() {
        if (!textareaEl) return;
        textareaEl.style.height = "auto";
        textareaEl.style.height = `${Math.min(textareaEl.scrollHeight, 480)}px`;
    }

    function handleInput() {
        autoResize();
        detectTrigger();
    }
</script>

{#if isVisible}
    <div class="chat-input" class:planning={isPlanning}>
        <!-- Suggestion popup (extracted) -->
        {#if suggestionKind}
            <SuggestionPopup
                items={filteredSuggestions}
                selectedIndex={selectedSuggestionIndex}
                onaccept={acceptSuggestion}
                onselect={(i) => (selectedSuggestionIndex = i)}
            />
        {/if}

        <!-- Toolbar (extracted) -->
        <InputToolbar
            {inputMode}
            conversationMode={appState.conversationMode}
            {isPlanReview}
            {approveDisabled}
            {modes}
            onmodechange={handleModeChange}
            oninputmodechange={(mode) => (inputMode = mode)}
            onuploadfile={handleUploadFile}
            onuploadimage={handleUploadImage}
            onapprove={handleApprove}
        />

        <!-- Input row -->
        <div class="input-row">
            {#if inputMode === "raw"}
                <textarea
                    bind:this={textareaEl}
                    bind:value={prompt}
                    {placeholder}
                    rows="3"
                    onkeydown={handleKeydown}
                    oninput={handleInput}
                    disabled={isPlanning}
                    id="chat-prompt-input"
                ></textarea>
            {:else}
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
                <div
                    class="preview-pane"
                    onkeydown={handleKeydown}
                    tabindex="0"
                    id="chat-prompt-preview"
                >
                    {#if prompt.trim()}
                        <MarkdownRenderer content={prompt} />
                    {:else}
                        <span class="preview-empty">Nothing to preview</span>
                    {/if}
                </div>
            {/if}
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
            {#if isPlanning}
                <span class="planning-hint">⏳ Generating plan…</span>
            {:else if isPlanReview}
                <span
                    ><kbd>Enter</kbd> to send feedback · <kbd>Shift+Enter</kbd>
                    for newline · or click <strong>Approve</strong> to proceed</span
                >
            {:else}
                <span
                    ><kbd>Enter</kbd> to send · <kbd>Shift+Enter</kbd> for
                    newline · <kbd>@</kbd> mention · <kbd>/</kbd> workflow ·
                    <kbd
                        >{navigator.platform.includes("Mac")
                            ? "⌘"
                            : "Ctrl"}+Shift+P</kbd
                    > preview</span
                >
            {/if}
        </div>
    </div>
{/if}

<style>
    .chat-input {
        padding: 0 12px 6px;
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
        position: relative;
    }

    /* ── Input row ──────────────────────────────────────────────────── */

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
        min-height: 108px;
        max-height: 480px;
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

    /* ── Preview pane ──────────────────────────────────────────────── */

    .preview-pane {
        flex: 1;
        min-height: 108px;
        max-height: 480px;
        overflow-y: auto;
        padding: 8px 10px;
        border: 1px solid
            var(
                --vscode-input-border,
                var(--vscode-panel-border, rgba(128, 128, 128, 0.35))
            );
        border-radius: 4px;
        background: var(
            --vscode-input-background,
            var(--vscode-editorWidget-background)
        );
        font-size: var(--vscode-font-size, 13px);
        line-height: 1.45;
        cursor: default;
    }

    .preview-pane:focus {
        outline: none;
        border-color: var(--vscode-focusBorder, #007fd4);
    }

    .preview-empty {
        color: var(
            --vscode-input-placeholderForeground,
            var(--vscode-descriptionForeground)
        );
        font-style: italic;
    }

    /* ── Hint bar ───────────────────────────────────────────────────── */

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
