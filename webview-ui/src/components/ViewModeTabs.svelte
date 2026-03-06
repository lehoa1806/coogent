<!-- ─────────────────────────────────────────────────────────────────────── -->
<!-- ViewModeTabs.svelte — Reusable Preview / Raw pill-tab pair            -->
<!-- ─────────────────────────────────────────────────────────────────────── -->

<script lang="ts">
    interface Props {
        value: "preview" | "raw";
        onchange: (mode: "preview" | "raw") => void;
    }

    let { value, onchange }: Props = $props();
</script>

<div class="view-mode-tabs">
    <button
        class="tab-btn"
        class:active={value === "preview"}
        onclick={() => onchange("preview")}>Preview</button
    >
    <button
        class="tab-btn"
        class:active={value === "raw"}
        onclick={() => onchange("raw")}>Raw</button
    >
</div>

<style>
    .view-mode-tabs {
        display: flex;
        border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
        border-radius: 4px;
        overflow: hidden;
        flex-shrink: 0;
    }

    .tab-btn {
        font-family: var(--vscode-font-family);
        font-size: 10px;
        font-weight: 600;
        padding: 3px 9px;
        border: none;
        background: transparent;
        color: var(--vscode-descriptionForeground);
        cursor: pointer;
        transition: all 0.12s ease;
        border-right: 1px solid
            var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
    }

    .tab-btn:last-child {
        border-right: none;
    }

    .tab-btn.active {
        background: color-mix(
            in srgb,
            var(--vscode-focusBorder, #007fd4) 15%,
            transparent
        );
        color: var(--vscode-focusBorder, #007fd4);
    }

    .tab-btn:hover:not(.active) {
        background: var(
            --vscode-list-hoverBackground,
            rgba(128, 128, 128, 0.08)
        );
        color: var(--vscode-foreground);
    }
</style>
