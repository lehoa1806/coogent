<!-- ─────────────────────────────────────────────────────────────────────── -->
<!-- ExecutionControls.svelte — Load, Start, Pause, Abort + elapsed timer   -->
<!-- ─────────────────────────────────────────────────────────────────────── -->

<script lang="ts">
    import { appState, postMessage } from "../stores/vscode.js";

    let timerInterval: ReturnType<typeof setInterval> | null = $state(null);
    let displaySeconds = $state(0);

    function formatTime(seconds: number): string {
        const m = Math.floor(seconds / 60);
        const s = seconds % 60;
        return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    }

    let isReady = $derived($appState.engineState === "READY");
    let isRunning = $derived(
        $appState.engineState === "EXECUTING_WORKER" ||
            $appState.engineState === "EVALUATING",
    );
    let isIdle = $derived($appState.engineState === "IDLE");
    let isCompleted = $derived($appState.engineState === "COMPLETED");
    let isError = $derived($appState.engineState === "ERROR_PAUSED");

    // Timer management
    $effect(() => {
        if (isRunning && !timerInterval) {
            timerInterval = setInterval(() => {
                displaySeconds++;
            }, 1000);
        } else if (!isRunning && timerInterval) {
            clearInterval(timerInterval);
            timerInterval = null;
        }
        if (isIdle) {
            displaySeconds = 0;
        }

        return () => {
            if (timerInterval) {
                clearInterval(timerInterval);
                timerInterval = null;
            }
        };
    });

    function handleStart() {
        postMessage({ type: "CMD_START" });
    }
    function handlePause() {
        postMessage({ type: "CMD_PAUSE" });
    }
    function handleAbort() {
        postMessage({ type: "CMD_ABORT" });
    }
    function handleViewReport() {
        postMessage({ type: "CMD_REQUEST_REPORT" });
    }
    function handleViewPlan() {
        postMessage({ type: "CMD_REQUEST_PLAN" });
    }
</script>

<div class="controls">
    <button class="primary" disabled={!isReady} onclick={handleStart}>
        ▶ Start
    </button>
    <button disabled={!isRunning} onclick={handlePause}>⏸ Pause</button>
    <button
        class="danger"
        disabled={isIdle || isCompleted}
        onclick={handleAbort}
    >
        ⏹ Abort
    </button>

    <span class="elapsed-time">{formatTime(displaySeconds)}</span>

    <span class="controls-spacer"></span>

    {#if isCompleted}
        <button class="btn-icon" onclick={handleViewReport} title="View Report"
            >📊</button
        >
    {/if}
    {#if !isIdle}
        <button class="btn-icon" onclick={handleViewPlan} title="View Plan"
            >📋</button
        >
    {/if}
</div>

<style>
    .controls {
        display: flex;
        gap: 6px;
        padding: 6px 16px;
        border-bottom: 1px solid
            var(
                --vscode-panel-border,
                var(--vscode-widget-border, rgba(128, 128, 128, 0.35))
            );
        background: var(
            --vscode-sideBar-background,
            var(--vscode-editor-background)
        );
        flex-shrink: 0;
        align-items: center;
    }

    button {
        font-family: var(--vscode-font-family);
        font-size: 11px;
        font-weight: 600;
        padding: 4px 12px;
        border-radius: 4px;
        border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
        background: var(
            --vscode-button-secondaryBackground,
            var(--vscode-editorWidget-background)
        );
        color: var(
            --vscode-button-secondaryForeground,
            var(--vscode-foreground)
        );
        cursor: pointer;
        transition: all 0.15s ease;
        white-space: nowrap;
    }

    button:hover {
        background: var(--vscode-button-secondaryHoverBackground);
    }

    button:disabled {
        opacity: 0.35;
        cursor: not-allowed;
        pointer-events: none;
    }

    button.primary {
        background: var(
            --vscode-button-background,
            var(--vscode-focusBorder, #007fd4)
        );
        color: var(--vscode-button-foreground, #fff);
        border-color: transparent;
    }

    button.primary:hover {
        background: var(--vscode-button-hoverBackground);
    }

    button.danger {
        border-color: color-mix(
            in srgb,
            var(--vscode-errorForeground, #f85149) 30%,
            transparent
        );
        color: var(--vscode-errorForeground, #f85149);
        background: color-mix(
            in srgb,
            var(--vscode-errorForeground, #f85149) 10%,
            transparent
        );
    }

    button.danger:hover {
        background: color-mix(
            in srgb,
            var(--vscode-errorForeground, #f85149) 15%,
            transparent
        );
    }

    .elapsed-time {
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
        font-family: var(--vscode-editor-font-family, monospace);
        font-weight: 600;
        margin-left: 4px;
    }

    .controls-spacer {
        flex: 1;
    }

    .btn-icon {
        background: transparent;
        border: none;
        color: var(--vscode-descriptionForeground);
        cursor: pointer;
        padding: 4px 6px;
        border-radius: 4px;
        transition: all 0.15s ease;
        font-size: 14px;
        line-height: 1;
    }

    .btn-icon:hover {
        color: var(--vscode-foreground);
        background: var(--vscode-editorWidget-background);
    }
</style>
