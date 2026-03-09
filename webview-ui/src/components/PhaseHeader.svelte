<!-- ─────────────────────────────────────────────────────────────────────── -->
<!-- PhaseHeader.svelte — Phase title and elapsed time badge              -->
<!-- ─────────────────────────────────────────────────────────────────────── -->

<script lang="ts">
    import type { Phase } from "../types.js";

    interface Props {
        selectedPhase: Phase;
        phaseNumber: number;
        liveElapsedMs: number;
    }

    let { selectedPhase, phaseNumber, liveElapsedMs }: Props = $props();

    function truncatePrompt(prompt: string): string {
        if (!prompt) return "";
        return prompt.length > 80 ? prompt.slice(0, 80) + "…" : prompt;
    }

    function formatPhaseElapsed(ms: number): string {
        if (ms <= 0) return "";
        const totalSec = Math.floor(ms / 1000);
        const m = Math.floor(totalSec / 60);
        const s = totalSec % 60;
        return m > 0 ? `${m}m ${s}s` : `${s}s`;
    }
</script>

<div class="phase-title-row">
    <h3>Phase {phaseNumber}: {truncatePrompt(selectedPhase.prompt)}</h3>
    {#if liveElapsedMs > 0}
        <span
            class="phase-elapsed-badge"
            class:running={selectedPhase.status === "running"}
        >
            ⏱ {formatPhaseElapsed(liveElapsedMs)}
        </span>
    {/if}
</div>

<style>
    .phase-title-row {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
    }

    h3 {
        font-size: 13px;
        font-weight: 600;
        margin: 0;
        color: var(--vscode-foreground);
    }

    .phase-elapsed-badge {
        font-size: 10px;
        font-family: var(--vscode-editor-font-family, monospace);
        font-weight: 600;
        padding: 2px 8px;
        border-radius: 10px;
        color: var(--vscode-descriptionForeground);
        background: var(--vscode-editorWidget-background);
        border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.3));
        white-space: nowrap;
    }

    .phase-elapsed-badge.running {
        color: var(--vscode-focusBorder, #007fd4);
        background: color-mix(
            in srgb,
            var(--vscode-focusBorder, #007fd4) 10%,
            transparent
        );
        border-color: color-mix(
            in srgb,
            var(--vscode-focusBorder, #007fd4) 30%,
            transparent
        );
        animation: elapsed-pulse 2s ease-in-out infinite;
    }

    @keyframes elapsed-pulse {
        0%,
        100% {
            opacity: 1;
        }
        50% {
            opacity: 0.65;
        }
    }
</style>
