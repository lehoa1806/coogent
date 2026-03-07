<!-- ─────────────────────────────────────────────────────────────────────── -->
<!--   SuggestionPopup.svelte — Extracted from ChatInput (Sprint 3)        -->
<!-- ─────────────────────────────────────────────────────────────────────── -->

<script lang="ts">
    export interface SuggestionItem {
        label: string;
        description: string;
        insert: string;
    }

    interface Props {
        items: SuggestionItem[];
        selectedIndex: number;
        onaccept: (item: SuggestionItem) => void;
        onselect: (index: number) => void;
    }

    let { items, selectedIndex, onaccept, onselect }: Props = $props();
</script>

{#if items.length > 0}
    <div class="suggestion-popup">
        {#each items as item, i}
            <button
                class="suggestion-item"
                class:selected={i === selectedIndex}
                onmousedown={(e) => {
                    e.preventDefault();
                    onaccept(item);
                }}
                onmouseenter={() => onselect(i)}
            >
                <span class="suggestion-label">{item.label}</span>
                <span class="suggestion-desc">{item.description}</span>
            </button>
        {/each}
    </div>
{/if}

<style>
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
