<!-- ─────────────────────────────────────────────────────────────────────── -->
<!-- GlobalHeader.svelte — Title bar with state badge and quick actions      -->
<!-- ─────────────────────────────────────────────────────────────────────── -->

<script lang="ts">
    import { appState, postMessage, patchState } from "../stores/vscode.js";
    import type { EngineState } from "../types.js";
    import { DEFAULT_APP_STATE } from "../types.js";

    /** Props — callback replaces createEventDispatcher */
    let { ontogglehistory }: { ontogglehistory?: () => void } = $props();

    /** Map engine state → badge CSS modifier. */
    function badgeClass(state: EngineState): string {
        if (state === "COMPLETED") return "badge-completed";
        if (state === "ERROR_PAUSED") return "badge-error";
        if (state === "EXECUTING_WORKER" || state === "EVALUATING")
            return "badge-running";
        if (state === "PLANNING") return "badge-planning";
        if (state === "PLAN_REVIEW") return "badge-review";
        return "badge-idle";
    }

    function handleNewChat() {
        patchState({ ...DEFAULT_APP_STATE });
        postMessage({ type: "CMD_RESET" });
    }

    function handleHistoryToggle() {
        ontogglehistory?.();
        postMessage({ type: "CMD_LIST_SESSIONS" });
    }

    let canNewChat = $derived(
        $appState.engineState === "IDLE" ||
            $appState.engineState === "READY" ||
            $appState.engineState === "COMPLETED" ||
            $appState.engineState === "ERROR_PAUSED",
    );
</script>

<header class="header">
    {#if canNewChat}
        <button class="btn-new-chat" onclick={handleNewChat}>+ New Chat</button>
    {/if}

    <h1>Coogent Mission Control</h1>

    <span class="badge {badgeClass($appState.engineState)}">
        {$appState.engineState}
    </span>

    <span class="header-spacer"></span>

    <button class="btn-history" onclick={handleHistoryToggle}>📂 History</button
    >
</header>

<style>
    .header {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 16px;
        border-bottom: 1px solid
            var(
                --vscode-contrastBorder,
                var(--vscode-panel-border, rgba(128, 128, 128, 0.35))
            );
        background: var(
            --vscode-titleBar-activeBackground,
            var(--vscode-sideBar-background, var(--vscode-editor-background))
        );
        flex-shrink: 0;
        z-index: 10;
        position: sticky;
        top: 0;
    }

    h1 {
        font-size: 13px;
        font-weight: 600;
        letter-spacing: -0.01em;
        color: var(
            --vscode-titleBar-activeForeground,
            var(--vscode-foreground)
        );
        white-space: nowrap;
        margin: 0;
    }

    .header-spacer {
        flex: 1;
    }

    .btn-new-chat {
        background: var(
            --vscode-button-background,
            var(--vscode-focusBorder, #007fd4)
        );
        color: var(--vscode-button-foreground, #fff);
        border: none;
        font-size: 11px;
        padding: 4px 12px;
        border-radius: 4px;
        cursor: pointer;
        font-weight: 600;
        font-family: var(--vscode-font-family);
        white-space: nowrap;
        transition: background 0.15s ease;
    }

    .btn-new-chat:hover {
        background: var(--vscode-button-hoverBackground);
    }

    .btn-history {
        background: var(
            --vscode-button-secondaryBackground,
            var(--vscode-editorWidget-background)
        );
        color: var(
            --vscode-button-secondaryForeground,
            var(--vscode-foreground)
        );
        border: 1px solid
            var(
                --vscode-panel-border,
                var(--vscode-widget-border, rgba(128, 128, 128, 0.35))
            );
        font-size: 11px;
        padding: 4px 10px;
        border-radius: 4px;
        cursor: pointer;
        font-weight: 600;
        font-family: var(--vscode-font-family);
        white-space: nowrap;
        line-height: 1.3;
        transition: all 0.15s ease;
    }

    .btn-history:hover {
        background: var(--vscode-button-secondaryHoverBackground);
        color: var(--vscode-foreground);
    }

    /* ── Status Badges ──────────────────────────────────────────────────── */
    .badge {
        font-size: 10px;
        padding: 2px 8px;
        border-radius: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        white-space: nowrap;
    }

    .badge-idle {
        background: var(
            --vscode-editorWidget-background,
            var(--vscode-editor-background)
        );
        color: var(--vscode-descriptionForeground, var(--vscode-foreground));
        border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
    }

    .badge-running {
        background: color-mix(
            in srgb,
            var(--vscode-focusBorder, #007fd4) 12%,
            transparent
        );
        color: var(--vscode-focusBorder, #007fd4);
        border: 1px solid
            color-mix(
                in srgb,
                var(--vscode-focusBorder, #007fd4) 30%,
                transparent
            );
        animation: badge-pulse 2s ease-in-out infinite;
    }

    .badge-completed {
        background: color-mix(
            in srgb,
            var(--vscode-charts-green, #3fb950) 10%,
            transparent
        );
        color: var(--vscode-charts-green, #3fb950);
        border: 1px solid
            color-mix(
                in srgb,
                var(--vscode-charts-green, #3fb950) 30%,
                transparent
            );
    }

    .badge-error {
        background: color-mix(
            in srgb,
            var(--vscode-errorForeground, #f85149) 10%,
            transparent
        );
        color: var(--vscode-errorForeground, #f85149);
        border: 1px solid
            color-mix(
                in srgb,
                var(--vscode-errorForeground, #f85149) 30%,
                transparent
            );
    }

    .badge-planning {
        background: color-mix(
            in srgb,
            var(--vscode-charts-purple, #a78bfa) 12%,
            transparent
        );
        color: var(--vscode-charts-purple, #a78bfa);
        border: 1px solid
            color-mix(
                in srgb,
                var(--vscode-charts-purple, #a78bfa) 30%,
                transparent
            );
        animation: badge-pulse 2s ease-in-out infinite;
    }

    .badge-review {
        background: color-mix(
            in srgb,
            var(--vscode-editorWarning-foreground, #d29922) 10%,
            transparent
        );
        color: var(--vscode-editorWarning-foreground, #d29922);
        border: 1px solid
            color-mix(
                in srgb,
                var(--vscode-editorWarning-foreground, #d29922) 30%,
                transparent
            );
    }

    @keyframes badge-pulse {
        0%,
        100% {
            opacity: 1;
        }
        50% {
            opacity: 0.6;
        }
    }
</style>
