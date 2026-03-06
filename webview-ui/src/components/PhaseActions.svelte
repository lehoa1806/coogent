<!-- ─────────────────────────────────────────────────────────────────────── -->
<!-- PhaseActions.svelte — Retry / Restart / Skip action buttons            -->
<!-- ─────────────────────────────────────────────────────────────────────── -->

<script lang="ts">
    import { postMessage } from "../stores/vscode.svelte.js";
    import type { Phase } from "../types.js";

    interface Props {
        selectedPhase: Phase;
    }

    let { selectedPhase }: Props = $props();

    function handleAction(action: string) {
        if (!selectedPhase) return;
        const phaseId = selectedPhase.id;
        switch (action) {
            case "retry":
                postMessage({ type: "CMD_RETRY", payload: { phaseId } });
                break;
            case "restart":
                postMessage({
                    type: "CMD_RESTART_PHASE",
                    payload: { phaseId },
                });
                break;
            case "skip":
                postMessage({ type: "CMD_SKIP_PHASE", payload: { phaseId } });
                break;
        }
    }
</script>

{#if selectedPhase.status === "failed"}
    <div class="phase-actions-bar">
        <button
            class="phase-action-btn retry"
            onclick={() => handleAction("retry")}>↻ Retry</button
        >
        <button
            class="phase-action-btn restart"
            onclick={() => handleAction("restart")}>🔄 Restart</button
        >
        <button
            class="phase-action-btn skip"
            onclick={() => handleAction("skip")}>⏭ Skip</button
        >
    </div>
{:else if selectedPhase.status === "completed"}
    <div class="phase-actions-bar">
        <button
            class="phase-action-btn restart"
            onclick={() => handleAction("restart")}>🔄 Restart</button
        >
    </div>
{/if}

<style>
    .phase-actions-bar {
        display: flex;
        gap: 8px;
        padding-top: 12px;
        margin-top: 4px;
        border-top: 1px solid
            var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
        flex-wrap: wrap;
    }

    .phase-action-btn {
        font-family: var(--vscode-font-family);
        font-size: 11px;
        font-weight: 600;
        padding: 5px 14px;
        border-radius: 4px;
        border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
        background: var(--vscode-editorWidget-background);
        color: var(--vscode-foreground);
        cursor: pointer;
        transition: all 0.15s ease;
    }

    .phase-action-btn:hover {
        filter: brightness(1.15);
    }

    .phase-action-btn.retry {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground, #fff);
        border-color: transparent;
    }

    .phase-action-btn.restart {
        background: color-mix(
            in srgb,
            var(--vscode-editorWarning-foreground, #cca700) 15%,
            transparent
        );
        color: var(--vscode-editorWarning-foreground, #cca700);
    }

    .phase-action-btn.skip {
        background: transparent;
        color: var(--vscode-descriptionForeground);
    }
</style>
