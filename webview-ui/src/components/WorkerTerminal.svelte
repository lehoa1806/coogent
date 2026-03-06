<!-- ─────────────────────────────────────────────────────────────────────── -->
<!-- WorkerTerminal.svelte — Terminal output with raw/preview toggle         -->
<!-- ─────────────────────────────────────────────────────────────────────── -->

<script lang="ts">
    import { appState, patchState } from "../stores/vscode.js";
    import MarkdownRenderer from "./MarkdownRenderer.svelte";

    let mode: "raw" | "preview" = $state("raw");
    let outputEl: HTMLPreElement | undefined = $state(undefined);
    let panelHeight = $state(200);
    let resizing = $state(false);
    let startY = $state(0);
    let startHeight = $state(0);

    // Auto-scroll on new output when user is near the bottom
    $effect(() => {
        // Track terminal output to trigger re-run
        $appState.terminalOutput;
        if (outputEl && mode === "raw") {
            const atBottom =
                outputEl.scrollHeight -
                    outputEl.scrollTop -
                    outputEl.clientHeight <
                80;
            if (atBottom) {
                outputEl.scrollTop = outputEl.scrollHeight;
            }
        }
    });

    function clearOutput() {
        patchState({ terminalOutput: "" });
    }

    // Drag-resize handlers
    function onMouseDown(e: MouseEvent) {
        e.preventDefault();
        resizing = true;
        startY = e.clientY;
        startHeight = panelHeight;
        window.addEventListener("mousemove", onMouseMove);
        window.addEventListener("mouseup", onMouseUp);
    }

    function onMouseMove(e: MouseEvent) {
        if (!resizing) return;
        const delta = startY - e.clientY;
        const maxH = window.innerHeight * 0.6;
        panelHeight = Math.max(80, Math.min(startHeight + delta, maxH));
    }

    function onMouseUp() {
        resizing = false;
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
    }

    let isCompleted = $derived($appState.engineState === "COMPLETED");
</script>

<!-- Resize handle -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
    class="terminal-resizer"
    onmousedown={onMouseDown}
    role="separator"
    aria-orientation="horizontal"
    tabindex="-1"
></div>

<div
    class="terminal-panel"
    class:reporting={isCompleted}
    style="height:{panelHeight}px"
>
    <div class="terminal-header">
        <h2>{isCompleted ? "📋 Consolidation Report" : "Terminal Output"}</h2>
        <div class="terminal-controls">
            <button
                class="toggle-btn"
                class:active={mode === "preview"}
                onclick={() => (mode = "preview")}
            >
                👁 Preview
            </button>
            <button
                class="toggle-btn"
                class:active={mode === "raw"}
                onclick={() => (mode = "raw")}
            >
                {"{ }"} Raw
            </button>
            <button class="clear-btn" onclick={clearOutput} title="Clear output"
                >✕</button
            >
        </div>
    </div>

    {#if mode === "raw"}
        <pre
            class="terminal-output"
            bind:this={outputEl}>{$appState.terminalOutput ||
                "Consolidation report will appear here when all phases complete.\n"}</pre>
    {:else}
        <div class="terminal-output rendered">
            <MarkdownRenderer content={$appState.terminalOutput || ""} />
        </div>
    {/if}
</div>

<style>
    .terminal-resizer {
        height: 4px;
        background: var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
        cursor: ns-resize;
        flex-shrink: 0;
        transition: background 0.15s;
    }

    .terminal-resizer:hover {
        background: var(--vscode-focusBorder, #007fd4);
    }

    .terminal-panel {
        border-top: 1px solid
            var(--vscode-contrastBorder, var(--vscode-panel-border));
        display: flex;
        flex-direction: column;
        min-height: 120px;
        max-height: 40vh;
        position: relative;
        overflow: hidden;
        flex: none;
    }

    .terminal-panel.reporting {
        border-left: 3px solid var(--vscode-charts-green, #3fb950);
        background: color-mix(
            in srgb,
            var(--vscode-charts-green, #3fb950) 4%,
            var(--vscode-terminal-background, var(--vscode-editor-background))
        );
    }

    .terminal-panel.reporting h2 {
        color: var(--vscode-charts-green, #3fb950);
    }

    .terminal-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        flex-shrink: 0;
        padding: 6px 16px;
    }

    .terminal-header h2 {
        font-size: 10px;
        color: var(--vscode-disabledForeground);
        text-transform: uppercase;
        letter-spacing: 0.8px;
        font-weight: 700;
        margin: 0;
    }

    .terminal-controls {
        display: flex;
        gap: 4px;
        align-items: center;
    }

    .toggle-btn {
        font-family: var(--vscode-font-family);
        font-size: 10px;
        padding: 2px 8px;
        border-radius: 4px;
        border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-disabledForeground);
        cursor: pointer;
        transition: all 0.15s ease;
    }

    .toggle-btn.active {
        background: var(--vscode-focusBorder, #007fd4);
        color: var(--vscode-button-foreground, #fff);
        border-color: var(--vscode-focusBorder, #007fd4);
    }

    .clear-btn {
        font-family: var(--vscode-font-family);
        font-size: 12px;
        padding: 2px 6px;
        border-radius: 4px;
        border: none;
        background: transparent;
        color: var(--vscode-descriptionForeground);
        cursor: pointer;
        transition: all 0.15s ease;
    }

    .clear-btn:hover {
        color: var(--vscode-errorForeground, #f85149);
        background: color-mix(
            in srgb,
            var(--vscode-errorForeground, #f85149) 10%,
            transparent
        );
    }

    .terminal-output {
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: var(--vscode-editor-font-size, 13px);
        line-height: 1.6;
        color: var(
            --vscode-terminal-foreground,
            var(--vscode-descriptionForeground)
        );
        white-space: pre-wrap;
        word-break: break-all;
        flex: 1;
        overflow-y: auto;
        padding: 4px 16px;
        background: var(
            --vscode-terminal-background,
            var(--vscode-editor-background)
        );
        margin: 0;
    }

    .terminal-output.rendered {
        font-family: var(--vscode-font-family);
        font-size: 13px;
        word-break: normal;
        white-space: normal;
        color: var(--vscode-editor-foreground, var(--vscode-foreground));
    }
</style>
