<!-- ─────────────────────────────────────────────────────────────────────── -->
<!-- ConversationModeBar.svelte — Isolated/Continuous/Smart toggle          -->
<!-- ─────────────────────────────────────────────────────────────────────── -->

<script lang="ts">
    import { appState, postMessage } from "../stores/vscode.js";
    import type { ConversationMode } from "../types.js";

    const modes: { value: ConversationMode; label: string }[] = [
        { value: "isolated", label: "Isolated" },
        { value: "continuous", label: "Continuous" },
        { value: "smart", label: "Smart" },
    ];

    function handleSelect(mode: ConversationMode) {
        postMessage({ type: "CMD_SET_CONVERSATION_MODE", payload: { mode } });
    }
</script>

<div class="conversation-mode-bar">
    <span class="mode-label">Mode</span>
    {#each modes as { value, label }}
        <button
            class="mode-btn"
            class:active={$appState.conversationMode === value}
            onclick={() => handleSelect(value)}
        >
            {label}
        </button>
    {/each}
</div>

<style>
    .conversation-mode-bar {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 4px 16px;
        border-bottom: 1px solid
            var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
        background: var(
            --vscode-sideBar-background,
            var(--vscode-editor-background)
        );
        flex-shrink: 0;
    }

    .mode-label {
        font-size: 10px;
        font-weight: 600;
        color: var(--vscode-disabledForeground);
        text-transform: uppercase;
        letter-spacing: 0.5px;
        margin-right: 4px;
        white-space: nowrap;
    }

    .mode-btn {
        font-family: var(--vscode-font-family);
        font-size: 10px;
        font-weight: 600;
        padding: 3px 10px;
        border-radius: 4px;
        border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
        background: var(
            --vscode-button-secondaryBackground,
            var(--vscode-editorWidget-background)
        );
        color: var(
            --vscode-button-secondaryForeground,
            var(--vscode-descriptionForeground)
        );
        cursor: pointer;
        transition: all 0.15s ease;
        white-space: nowrap;
        line-height: 1.3;
    }

    .mode-btn:hover {
        background: var(--vscode-button-secondaryHoverBackground);
        color: var(--vscode-foreground);
    }

    .mode-btn.active {
        background: color-mix(
            in srgb,
            var(--vscode-focusBorder, #007fd4) 12%,
            transparent
        );
        color: var(--vscode-focusBorder, #007fd4);
        border-color: color-mix(
            in srgb,
            var(--vscode-focusBorder, #007fd4) 40%,
            transparent
        );
    }
</style>
