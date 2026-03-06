<!-- ─────────────────────────────────────────────────────────────────────── -->
<!-- WorkerTerminal.svelte — Terminal output modal with raw/preview toggle  -->
<!-- ─────────────────────────────────────────────────────────────────────── -->

<script lang="ts">
    import { appState, patchState } from "../stores/vscode.svelte.js";
    import MarkdownRenderer from "./MarkdownRenderer.svelte";
    import ViewModeTabs from "./ViewModeTabs.svelte";

    /** Props */
    let {
        visible = false,
        onClose,
    }: { visible?: boolean; onClose?: () => void } = $props();

    let mode: "raw" | "preview" = $state("raw");
    let outputEl: HTMLPreElement | undefined = $state(undefined);

    // Auto-scroll on new output when user is near the bottom
    $effect(() => {
        // Track terminal output to trigger re-run
        appState.terminalOutput;
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

    function handleClose() {
        onClose?.();
    }

    function handleBackdropClick(e: MouseEvent) {
        // Close only when clicking the backdrop itself, not modal content
        if (e.target === e.currentTarget) {
            handleClose();
        }
    }

    function handleKeydown(e: KeyboardEvent) {
        if (e.key === "Escape") {
            handleClose();
        }
    }

    let isCompleted = $derived(appState.engineState === "COMPLETED");
</script>

{#if visible}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
        class="terminal-backdrop"
        onclick={handleBackdropClick}
        onkeydown={handleKeydown}
        role="dialog"
        aria-modal="true"
        aria-label="Terminal output"
        tabindex="-1"
    >
        <div class="terminal-modal" class:reporting={isCompleted}>
            <div class="terminal-header">
                <h2>
                    {isCompleted
                        ? "📋 Consolidation Report"
                        : "Terminal Output"}
                </h2>
                <div class="terminal-controls">
                    <ViewModeTabs value={mode} onchange={(m) => (mode = m)} />
                    <button
                        class="clear-btn"
                        onclick={clearOutput}
                        title="Delete output">🗑 Delete</button
                    >
                    <button
                        class="close-btn"
                        onclick={handleClose}
                        title="Close terminal">✕</button
                    >
                </div>
            </div>

            {#if mode === "raw"}
                <pre
                    class="terminal-output"
                    bind:this={outputEl}>{appState.terminalOutput ||
                        "Consolidation report will appear here when all phases complete.\n"}</pre>
            {:else}
                <div class="terminal-output rendered">
                    <MarkdownRenderer content={appState.terminalOutput || ""} />
                </div>
            {/if}
        </div>
    </div>
{/if}

<style>
    .terminal-backdrop {
        position: fixed;
        inset: 0;
        z-index: 100;
        background: rgba(0, 0, 0, 0.5);
        display: flex;
        align-items: center;
        justify-content: center;
        animation: fade-in 0.15s ease-out;
    }

    .terminal-modal {
        width: 90%;
        max-width: 900px;
        max-height: 80vh;
        display: flex;
        flex-direction: column;
        border-radius: 8px;
        overflow: hidden;
        background: var(
            --vscode-editor-background,
            var(--vscode-sideBar-background)
        );
        border: 1px solid
            var(
                --vscode-contrastBorder,
                var(--vscode-panel-border, rgba(128, 128, 128, 0.35))
            );
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
        animation: modal-slide-in 0.2s ease-out;
    }

    .terminal-modal.reporting {
        border-left: 3px solid var(--vscode-charts-green, #3fb950);
        background: color-mix(
            in srgb,
            var(--vscode-charts-green, #3fb950) 4%,
            var(--vscode-terminal-background, var(--vscode-editor-background))
        );
    }

    .terminal-modal.reporting h2 {
        color: var(--vscode-charts-green, #3fb950);
    }

    .terminal-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        flex-shrink: 0;
        padding: 10px 16px;
        border-bottom: 1px solid
            var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
    }

    .terminal-header h2 {
        font-size: 12px;
        color: var(--vscode-foreground);
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

    .clear-btn {
        font-family: var(--vscode-font-family);
        font-size: 11px;
        padding: 3px 9px;
        border-radius: 4px;
        border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
        background: transparent;
        color: var(--vscode-descriptionForeground);
        cursor: pointer;
        transition: all 0.15s ease;
        font-weight: 600;
    }

    .clear-btn:hover {
        color: var(--vscode-errorForeground, #f85149);
        background: color-mix(
            in srgb,
            var(--vscode-errorForeground, #f85149) 10%,
            transparent
        );
        border-color: color-mix(
            in srgb,
            var(--vscode-errorForeground, #f85149) 30%,
            transparent
        );
    }

    .close-btn {
        font-family: var(--vscode-font-family);
        font-size: 14px;
        padding: 4px 8px;
        border-radius: 4px;
        border: none;
        background: transparent;
        color: var(--vscode-descriptionForeground);
        cursor: pointer;
        transition: all 0.15s ease;
        margin-left: 4px;
        line-height: 1;
    }

    .close-btn:hover {
        color: var(--vscode-foreground);
        background: var(--vscode-editorWidget-background);
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
        padding: 12px 16px;
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

    @keyframes fade-in {
        from {
            opacity: 0;
        }
        to {
            opacity: 1;
        }
    }

    @keyframes modal-slide-in {
        from {
            transform: translateY(20px);
            opacity: 0;
        }
        to {
            transform: translateY(0);
            opacity: 1;
        }
    }
</style>
