<!-- ─────────────────────────────────────────────────────────────────────── -->
<!-- PhaseHeader.svelte — Phase title, elapsed time badge, original prompt  -->
<!-- ─────────────────────────────────────────────────────────────────────── -->

<script lang="ts">
    import type { Phase } from "../types.js";

    interface Props {
        selectedPhase: Phase;
        phaseNumber: number;
        lastPrompt: string;
        liveElapsedMs: number;
    }

    let { selectedPhase, phaseNumber, lastPrompt, liveElapsedMs }: Props =
        $props();

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

<!-- Persistent original prompt (collapsible) -->
{#if lastPrompt}
    <details class="original-prompt-details">
        <summary class="original-prompt-summary">
            <span class="summary-icon">💬</span>
            Your original prompt
        </summary>
        <div class="original-prompt-body">
            <p>{lastPrompt}</p>
        </div>
    </details>
{/if}

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

    /* ── Original prompt collapsible ────────────────────────────────── */

    .original-prompt-details {
        margin-bottom: 4px;
        border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.25));
        border-radius: 5px;
        overflow: hidden;
        background: var(--vscode-editorWidget-background);
    }

    .original-prompt-summary {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 12px;
        font-size: 11px;
        font-weight: 600;
        color: var(--vscode-descriptionForeground);
        cursor: pointer;
        user-select: none;
        list-style: none;
    }

    .original-prompt-summary::-webkit-details-marker {
        display: none;
    }

    .original-prompt-summary::before {
        content: "›";
        font-size: 14px;
        transition: transform 0.15s ease;
        color: var(--vscode-descriptionForeground);
        line-height: 1;
    }

    details[open] .original-prompt-summary::before {
        transform: rotate(90deg);
    }

    .summary-icon {
        font-size: 12px;
    }

    .original-prompt-body {
        padding: 10px 14px;
        border-top: 1px solid
            var(--vscode-panel-border, rgba(128, 128, 128, 0.2));
    }

    .original-prompt-body p {
        margin: 0;
        font-size: 12px;
        line-height: 1.6;
        color: var(--vscode-foreground);
        white-space: pre-wrap;
        word-wrap: break-word;
    }
</style>
