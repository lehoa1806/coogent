<!-- ─────────────────────────────────────────────────────────────────────── -->
<!--   InputToolbar.svelte — Extracted from ChatInput (Sprint 3)           -->
<!-- ─────────────────────────────────────────────────────────────────────── -->

<script lang="ts">
    import type { ConversationMode } from "../types.js";
    import ViewModeTabs from "./ViewModeTabs.svelte";

    interface Props {
        inputMode: "raw" | "preview";
        conversationMode: ConversationMode;
        isPlanReview: boolean;
        approveDisabled: boolean;
        modes: { value: ConversationMode; label: string }[];
        onmodechange: (e: Event) => void;
        oninputmodechange: (mode: "raw" | "preview") => void;
        onuploadfile: () => void;
        onuploadimage: () => void;
        onapprove: () => void;
    }

    let {
        inputMode,
        conversationMode,
        isPlanReview,
        approveDisabled,
        modes,
        onmodechange,
        oninputmodechange,
        onuploadfile,
        onuploadimage,
        onapprove,
    }: Props = $props();
</script>

<div class="toolbar-row">
    <div class="toolbar-actions">
        <button
            class="toolbar-btn"
            onclick={onuploadfile}
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
            onclick={onuploadimage}
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
        <ViewModeTabs
            value={inputMode}
            onchange={(mode) => {
                oninputmodechange(mode);
            }}
        />
    </div>

    <span class="toolbar-spacer"></span>

    <!-- Inline conversation mode dropdown (hidden during plan review) -->
    {#if !isPlanReview}
        <select
            class="mode-select"
            value={conversationMode}
            onchange={onmodechange}
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
            onclick={onapprove}
            disabled={approveDisabled}
            title="Approve plan and start execution"
            id="plan-approve-button"
        >
            {approveDisabled ? "✓ Approved" : "✓ Approve"}
        </button>
    {/if}
</div>

<style>
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
</style>
