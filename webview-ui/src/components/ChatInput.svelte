<!-- ─────────────────────────────────────────────────────────────────────── -->
<!--   @ mention & / workflow suggestions, file/image actions          -->
<!-- ─────────────────────────────────────────────────────────────────────── -->

<script lang="ts">
    import { appState, postMessage, patchState } from "../stores/vscode.js";
    import type { ConversationMode } from "../types.js";

    let prompt = $state("");
    let textareaEl: HTMLTextAreaElement | undefined = $state(undefined);

    // ── Suggestion popup state ──────────────────────────────────────────
    // Use dynamic suggestions from the store (populated by Extension Host)
    let mentionItems = $derived($appState.mentionItems);
    let workflowItems = $derived($appState.workflowItems);

    type SuggestionKind = "mention" | "workflow" | null;
    interface SuggestionItem {
        label: string;
        description: string;
        insert: string;
    }

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
    let engineState = $derived($appState.engineState);
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

    // Reset approve state when entering PLAN_REVIEW
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
            // Send feedback to revise the plan
            postMessage({
                type: "CMD_PLAN_REJECT",
                payload: { feedback: text },
            });
        } else {
            // Persist prompt for display during PLANNING state
            patchState({ lastPrompt: text });

            // New plan request (IDLE) or re-plan after error
            postMessage({
                type: "CMD_PLAN_REQUEST",
                payload: { prompt: text },
            });
        }

        prompt = "";
        closeSuggestions();
        autoResize();
    }

    // ── Attachment listener ──────────────────────────────────────────────────
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

    // ── Suggestion logic ────────────────────────────────────────────────
    function detectTrigger() {
        if (!textareaEl) return;

        const val = textareaEl.value;
        const pos = textareaEl.selectionStart ?? 0;

        // Walk backward from cursor to find trigger
        let triggerStart = -1;
        for (let i = pos - 1; i >= 0; i--) {
            const ch = val[i];
            if (ch === " " || ch === "\n") break;
            if (ch === "@" || ch === "/") {
                // Must be at start of line or after whitespace
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

        // Find the trigger start
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

        // Restore cursor position after Svelte re-renders
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
        textareaEl.style.height = `${Math.min(textareaEl.scrollHeight, 160)}px`;
    }

    function handleInput() {
        autoResize();
        detectTrigger();
    }
</script>

{#if isVisible}
    <div class="chat-input" class:planning={isPlanning}>
        <!-- Suggestion popup -->
        {#if suggestionKind && filteredSuggestions.length > 0}
            <div class="suggestion-popup">
                {#each filteredSuggestions as item, i}
                    <button
                        class="suggestion-item"
                        class:selected={i === selectedSuggestionIndex}
                        onmousedown={(e) => {
                            e.preventDefault();
                            acceptSuggestion(item);
                        }}
                        onmouseenter={() => (selectedSuggestionIndex = i)}
                    >
                        <span class="suggestion-label">{item.label}</span>
                        <span class="suggestion-desc">{item.description}</span>
                    </button>
                {/each}
            </div>
        {/if}

        <!-- Toolbar row -->
        <div class="toolbar-row">
            <div class="toolbar-actions">
                <button
                    class="toolbar-btn"
                    onclick={handleUploadFile}
                    title="Attach file"
                    id="chat-attach-file"
                >
                    <svg
                        width="14"
                        height="14"
                        viewBox="0 0 16 16"
                        fill="none"
                        xmlns="http://www.w3.org/2000/svg"
                    >
                        <path
                            d="M14 8.5V13.5C14 14.0523 13.5523 14.5 13 14.5H3C2.44772 14.5 2 14.0523 2 13.5V8.5M8 1.5V10.5M8 1.5L11 4.5M8 1.5L5 4.5"
                            stroke="currentColor"
                            stroke-width="1.2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                        />
                    </svg>
                </button>
                <button
                    class="toolbar-btn"
                    onclick={handleUploadImage}
                    title="Attach image"
                    id="chat-attach-image"
                >
                    <svg
                        width="14"
                        height="14"
                        viewBox="0 0 16 16"
                        fill="none"
                        xmlns="http://www.w3.org/2000/svg"
                    >
                        <rect
                            x="1.5"
                            y="2.5"
                            width="13"
                            height="11"
                            rx="1.5"
                            stroke="currentColor"
                            stroke-width="1.2"
                        />
                        <circle
                            cx="5"
                            cy="6"
                            r="1.25"
                            stroke="currentColor"
                            stroke-width="1.2"
                        />
                        <path
                            d="M1.5 11L5 8L8 10.5L11 8L14.5 11"
                            stroke="currentColor"
                            stroke-width="1.2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                        />
                    </svg>
                </button>
            </div>

            <span class="toolbar-spacer"></span>

            <!-- Inline conversation mode dropdown (hidden during plan review) -->
            {#if !isPlanReview}
                <select
                    class="mode-select"
                    value={$appState.conversationMode}
                    onchange={handleModeChange}
                    id="chat-mode-select"
                >
                    {#each modes as { value, label }}
                        <option {value}>{label}</option>
                    {/each}
                </select>
            {/if}

            <!-- Approve button (only during PLAN_REVIEW) -->
            {#if isPlanReview}
                <button
                    class="approve-plan-btn"
                    onclick={handleApprove}
                    disabled={approveDisabled}
                    title="Approve plan and start execution"
                    id="plan-approve-button"
                >
                    {approveDisabled ? "✓ Approved" : "✓ Approve"}
                </button>
            {/if}
        </div>

        <!-- Input row -->
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
                    newline · <kbd>@</kbd> mention · <kbd>/</kbd> workflow</span
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

    /* ── Toolbar ────────────────────────────────────────────────────── */

    .toolbar-row {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 6px 0 4px;
    }

    .toolbar-actions {
        display: flex;
        gap: 2px;
    }

    .toolbar-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        border: none;
        border-radius: 4px;
        background: transparent;
        color: var(--vscode-descriptionForeground);
        cursor: pointer;
        transition: all 0.15s ease;
    }

    .toolbar-btn:hover {
        background: var(
            --vscode-editorWidget-background,
            rgba(128, 128, 128, 0.1)
        );
        color: var(--vscode-foreground);
    }

    .toolbar-btn svg {
        display: block;
    }

    .toolbar-spacer {
        flex: 1;
    }

    /* ── Mode dropdown ──────────────────────────────────────────────── */

    .mode-select {
        font-family: var(--vscode-font-family);
        font-size: 11px;
        font-weight: 600;
        padding: 3px 8px;
        border-radius: 4px;
        border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
        background: var(
            --vscode-dropdown-background,
            var(--vscode-editorWidget-background)
        );
        color: var(--vscode-dropdown-foreground, var(--vscode-foreground));
        cursor: pointer;
        outline: none;
        transition: border-color 0.15s ease;
        appearance: auto;
    }

    .mode-select:hover {
        border-color: var(--vscode-focusBorder, #007fd4);
    }

    .mode-select:focus {
        border-color: var(--vscode-focusBorder, #007fd4);
    }

    /* ── Approve plan button (PLAN_REVIEW only) ─────────────────────── */

    .approve-plan-btn {
        font-family: var(--vscode-font-family);
        font-size: 11px;
        font-weight: 600;
        padding: 4px 14px;
        border-radius: 4px;
        border: none;
        cursor: pointer;
        transition: all 0.15s ease;
        background: var(--vscode-testing-iconPassed, #388a34);
        color: var(--vscode-button-foreground, #fff);
        flex-shrink: 0;
        white-space: nowrap;
    }

    .approve-plan-btn:hover:not(:disabled) {
        filter: brightness(1.15);
    }

    .approve-plan-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
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

    /* ── Suggestion popup ───────────────────────────────────────────── */

    .suggestion-popup {
        position: absolute;
        bottom: 100%;
        left: 12px;
        right: 12px;
        max-height: 180px;
        overflow-y: auto;
        background: var(
            --vscode-editorSuggestWidget-background,
            var(--vscode-editorWidget-background)
        );
        border: 1px solid
            var(
                --vscode-editorSuggestWidget-border,
                var(--vscode-panel-border, rgba(128, 128, 128, 0.35))
            );
        border-radius: 6px;
        box-shadow: 0 4px 12px
            color-mix(
                in srgb,
                var(--vscode-widget-shadow, #000) 20%,
                transparent
            );
        z-index: 100;
        animation: fade-in 0.12s ease-out;
    }

    .suggestion-item {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        padding: 6px 10px;
        border: none;
        background: transparent;
        color: var(--vscode-foreground);
        cursor: pointer;
        font-family: var(--vscode-font-family);
        font-size: 12px;
        text-align: left;
        transition: background 0.1s ease;
    }

    .suggestion-item:first-child {
        border-radius: 6px 6px 0 0;
    }

    .suggestion-item:last-child {
        border-radius: 0 0 6px 6px;
    }

    .suggestion-item:only-child {
        border-radius: 6px;
    }

    .suggestion-item.selected,
    .suggestion-item:hover {
        background: var(
            --vscode-editorSuggestWidget-selectedBackground,
            var(--vscode-list-hoverBackground, rgba(128, 128, 128, 0.12))
        );
    }

    .suggestion-label {
        font-weight: 600;
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 12px;
        color: var(--vscode-foreground);
        white-space: nowrap;
    }

    .suggestion-desc {
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
</style>
