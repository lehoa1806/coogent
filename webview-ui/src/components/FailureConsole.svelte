<!-- ─────────────────────────────────────────────────────────────────────── -->
<!-- FailureConsole.svelte — Read-only failure console with progressive     -->
<!-- disclosure.  Displays a single FailureConsoleRecord pushed from the    -->
<!-- Extension Host.                                                        -->
<!-- ─────────────────────────────────────────────────────────────────────── -->

<script lang="ts">
    import type { FailureConsoleRecord } from "../stores/failureConsole.svelte.js";
    import { postMessage } from "../stores/vscode.svelte.js";

    // ── Props ────────────────────────────────────────────────────────────
    interface Props {
        record: FailureConsoleRecord;
        ondismiss: () => void;
    }
    let { record, ondismiss }: Props = $props();

    // ── Collapsible section state ────────────────────────────────────────
    let showTimeline = $state(true);
    let showAdvanced = $state(false);
    let showRawJson = $state(false);

    // ── Formatting helpers ───────────────────────────────────────────────

    function formatTimestamp(ms: number): string {
        return new Date(ms).toLocaleTimeString(undefined, {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
        });
    }

    function formatCategory(cat: string): string {
        return cat
            .replace(/_/g, " ")
            .replace(/\b\w/g, (c) => c.toUpperCase());
    }

    function severityColor(
        severity: string,
    ): { border: string; badge: string; badgeBg: string } {
        switch (severity) {
            case "warning":
                return {
                    border:
                        "var(--vscode-editorWarning-foreground, var(--vscode-charts-yellow, #d29922))",
                    badge:
                        "var(--vscode-editorWarning-foreground, var(--vscode-charts-yellow, #d29922))",
                    badgeBg:
                        "color-mix(in srgb, var(--vscode-editorWarning-foreground, var(--vscode-charts-yellow, #d29922)) 12%, transparent)",
                };
            case "recoverable":
                return {
                    border:
                        "var(--vscode-charts-orange, #e3795c)",
                    badge:
                        "var(--vscode-charts-orange, #e3795c)",
                    badgeBg:
                        "color-mix(in srgb, var(--vscode-charts-orange, #e3795c) 12%, transparent)",
                };
            default:
                return {
                    border:
                        "var(--vscode-errorForeground, var(--vscode-charts-red, #f85149))",
                    badge:
                        "var(--vscode-errorForeground, var(--vscode-charts-red, #f85149))",
                    badgeBg:
                        "color-mix(in srgb, var(--vscode-errorForeground, var(--vscode-charts-red, #f85149)) 12%, transparent)",
                };
        }
    }

    function outcomeIcon(outcome: string): string {
        switch (outcome) {
            case "success":
                return "✓";
            case "denied":
                return "⛔";
            default:
                return "✗";
        }
    }

    function truncate(text: string, max: number): string {
        if (text.length <= max) return text;
        return "…" + text.slice(-max);
    }

    // ── Derived values ───────────────────────────────────────────────────
    let colors = $derived(severityColor(record.severity));
    let budgetPct = $derived(
        record.evidence.contextBudget
            ? Math.min(
                  100,
                  (record.evidence.contextBudget.estimatedUsed /
                      record.evidence.contextBudget.tokenLimit) *
                      100,
              )
            : 0,
    );
    let budgetColorClass = $derived(
        budgetPct > 90 ? "over" : budgetPct > 70 ? "warn" : "",
    );
</script>

<!-- ═══════════════════════════════════════════════════════════════════════ -->
<!--  Template                                                              -->
<!-- ═══════════════════════════════════════════════════════════════════════ -->

<div
    class="failure-console-card"
    style="--fc-accent: {colors.border}"
    role="region"
    aria-label="Failure Console"
>
    <!-- ── Header ────────────────────────────────────────────────────── -->
    <div class="fc-header">
        <div class="fc-header-left">
            <span
                class="fc-severity-badge"
                style="color:{colors.badge};background:{colors.badgeBg};border:1px solid color-mix(in srgb, {colors.badge} 30%, transparent)"
            >
                {record.severity.replace("_", " ")}
            </span>
            <span class="fc-category-badge">{formatCategory(record.category)}</span>
            {#if record.phaseId}
                <span class="fc-meta-chip">Phase {record.phaseId}</span>
            {/if}
            {#if record.workerId}
                <span class="fc-meta-chip">Worker {record.workerId}</span>
            {/if}
        </div>
        <div class="fc-header-right">
            <span class="fc-scope-badge">{record.scope}</span>
            <span class="fc-timestamp">{formatTimestamp(record.createdAt)}</span>
            <button class="fc-dismiss-btn" onclick={ondismiss} aria-label="Dismiss failure console">✕</button>
        </div>
    </div>

    <!-- ── Summary ───────────────────────────────────────────────────── -->
    <div class="fc-body">
        <div class="fc-summary">
            <div class="fc-summary-row">
                <span class="fc-label">What happened</span>
                <p class="fc-message">{record.message}</p>
            </div>
            <div class="fc-summary-meta">
                <div class="fc-summary-row fc-inline">
                    <span class="fc-label">Category</span>
                    <span class="fc-value">{formatCategory(record.category)}</span>
                </div>
                <div class="fc-summary-row fc-inline">
                    <span class="fc-label">Scope</span>
                    <span class="fc-value">{record.scope}</span>
                </div>
            </div>
        </div>

        <!-- ── Suggested Actions ──────────────────────────────────── -->
        {#if record.suggestedActions && record.suggestedActions.length > 0}
            <div class="fc-actions-section">
                <span class="fc-label">Suggested Actions</span>
                <div class="fc-actions-list">
                    {#each record.suggestedActions as suggestion}
                        <div class="fc-action-item">
                            <div class="fc-action-row">
                                <button
                                    class="fc-action-btn"
                                    disabled={suggestion.availability === 'disabled'}
                                    title={suggestion.availability === 'disabled' ? (suggestion.disabledReason ?? 'Action unavailable') : suggestion.title}
                                    onclick={() => {
                                        postMessage({
                                            type: 'CMD_RECOVERY_ACTION',
                                            payload: {
                                                failureRecordId: record.id,
                                                action: suggestion.action,
                                                suggestedByModel: true,
                                            },
                                        });
                                    }}
                                >
                                    {suggestion.title}
                                </button>
                                <span
                                    class="fc-confidence-badge"
                                    class:fc-confidence-high={suggestion.confidence === 'high'}
                                    class:fc-confidence-medium={suggestion.confidence === 'medium'}
                                    class:fc-confidence-low={suggestion.confidence === 'low'}
                                >
                                    {suggestion.confidence}
                                </span>
                            </div>
                            <p class="fc-action-rationale">{suggestion.rationale}</p>
                        </div>
                    {/each}
                </div>
            </div>
        {/if}

        <!-- ── Timeline Block (collapsible, expanded by default) ──── -->
        <button
            class="fc-section-toggle"
            onclick={() => (showTimeline = !showTimeline)}
            aria-expanded={showTimeline}
        >
            <span class="fc-chevron" class:open={showTimeline}>▶</span>
            Timeline & Evidence
        </button>

        {#if showTimeline}
            <div class="fc-section-body">
                <!-- Tool actions timeline -->
                {#if record.evidence.toolActions && record.evidence.toolActions.length > 0}
                    <div class="fc-subsection">
                        <span class="fc-label">Tool Actions</span>
                        <div class="fc-timeline">
                            {#each record.evidence.toolActions as action}
                                <div class="fc-timeline-item" class:fc-item-failure={action.outcome === 'failure'} class:fc-item-denied={action.outcome === 'denied'}>
                                    <span class="fc-timeline-icon">{outcomeIcon(action.outcome)}</span>
                                    <span class="fc-timeline-tool">{action.toolId}</span>
                                    <span class="fc-timeline-outcome">{action.outcome}</span>
                                    <span class="fc-timeline-time">{formatTimestamp(action.timestamp)}</span>
                                </div>
                            {/each}
                        </div>
                    </div>
                {/if}

                <!-- Context budget -->
                {#if record.evidence.contextBudget}
                    <div class="fc-subsection">
                        <span class="fc-label">Context Budget</span>
                        <div class="fc-budget-bar">
                            <div
                                class="fc-budget-fill {budgetColorClass}"
                                style="width:{budgetPct}%"
                            ></div>
                            <span class="fc-budget-label">
                                {record.evidence.contextBudget.estimatedUsed.toLocaleString()} / {record.evidence.contextBudget.tokenLimit.toLocaleString()}
                                tokens ({Math.round(budgetPct)}%)
                            </span>
                        </div>
                    </div>
                {/if}

                <!-- Success criteria -->
                {#if record.evidence.successCriteria && record.evidence.successCriteria.length > 0}
                    <div class="fc-subsection">
                        <span class="fc-label">Success Criteria</span>
                        <ul class="fc-criteria-list">
                            {#each record.evidence.successCriteria as criterion}
                                <li>{criterion}</li>
                            {/each}
                        </ul>
                    </div>
                {/if}
            </div>
        {/if}

        <!-- ── Advanced Details (collapsible, collapsed by default) ── -->
        <button
            class="fc-section-toggle"
            onclick={() => (showAdvanced = !showAdvanced)}
            aria-expanded={showAdvanced}
        >
            <span class="fc-chevron" class:open={showAdvanced}>▶</span>
            Advanced Details
        </button>

        {#if showAdvanced}
            <div class="fc-section-body">
                <!-- Latest error text -->
                {#if record.evidence.latestErrorText}
                    <div class="fc-subsection">
                        <span class="fc-label">Latest Error</span>
                        <pre class="fc-pre">{record.evidence.latestErrorText}</pre>
                    </div>
                {/if}

                <!-- Latest worker output (truncated to last 2000 chars) -->
                {#if record.evidence.latestWorkerOutput}
                    <div class="fc-subsection">
                        <span class="fc-label">Latest Worker Output</span>
                        <pre class="fc-pre">{truncate(record.evidence.latestWorkerOutput, 2000)}</pre>
                    </div>
                {/if}

                <!-- Context budget details -->
                {#if record.evidence.contextBudget}
                    <div class="fc-subsection">
                        <span class="fc-label">Context Budget Details</span>
                        <div class="fc-kv-grid">
                            <span class="fc-kv-key">Token Limit</span>
                            <span class="fc-kv-val">{record.evidence.contextBudget.tokenLimit.toLocaleString()}</span>
                            <span class="fc-kv-key">Estimated Used</span>
                            <span class="fc-kv-val">{record.evidence.contextBudget.estimatedUsed.toLocaleString()}</span>
                            <span class="fc-kv-key">Remaining</span>
                            <span class="fc-kv-val">{record.evidence.contextBudget.remaining.toLocaleString()}</span>
                        </div>
                    </div>
                {/if}

                <!-- Raw JSON toggle -->
                <div class="fc-subsection">
                    <button
                        class="fc-raw-toggle"
                        onclick={() => (showRawJson = !showRawJson)}
                    >
                        {showRawJson ? "Hide" : "Show"} Raw JSON
                    </button>
                    {#if showRawJson}
                        <pre class="fc-pre fc-raw-json">{JSON.stringify(record, null, 2)}</pre>
                    {/if}
                </div>
            </div>
        {/if}
    </div>
</div>

<!-- ═══════════════════════════════════════════════════════════════════════ -->
<!--  Styles                                                                -->
<!-- ═══════════════════════════════════════════════════════════════════════ -->

<style>
    /* ── Card container ──────────────────────────────────────────────── */
    .failure-console-card {
        background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
        border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
        border-left: 3px solid var(--fc-accent);
        border-radius: 6px;
        overflow: hidden;
        animation: fc-slide-up 0.25s ease-out;
    }

    @keyframes fc-slide-up {
        from { opacity: 0; transform: translateY(12px); }
        to   { opacity: 1; transform: translateY(0); }
    }

    /* ── Header ──────────────────────────────────────────────────────── */
    .fc-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 8px 12px;
        border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
        background: var(--vscode-panel-background, var(--vscode-sideBar-background, var(--vscode-editor-background)));
        flex-wrap: wrap;
    }

    .fc-header-left,
    .fc-header-right {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
    }

    .fc-severity-badge {
        font-size: 9px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.4px;
        padding: 2px 8px;
        border-radius: 10px;
        white-space: nowrap;
    }

    .fc-category-badge {
        font-size: 9px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.3px;
        padding: 2px 8px;
        border-radius: 4px;
        background: var(--vscode-badge-background, color-mix(in srgb, var(--vscode-foreground) 10%, transparent));
        color: var(--vscode-badge-foreground, var(--vscode-foreground));
        white-space: nowrap;
    }

    .fc-meta-chip {
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 10px;
        padding: 1px 6px;
        border-radius: 4px;
        background: color-mix(in srgb, var(--vscode-charts-purple, #a78bfa) 10%, transparent);
        color: var(--vscode-charts-purple, #a78bfa);
        white-space: nowrap;
    }

    .fc-scope-badge {
        font-size: 9px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.3px;
        padding: 2px 6px;
        border-radius: 4px;
        background: color-mix(in srgb, var(--vscode-editorInfo-foreground, #58a6ff) 10%, transparent);
        color: var(--vscode-editorInfo-foreground, #58a6ff);
        white-space: nowrap;
    }

    .fc-timestamp {
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 10px;
        color: var(--vscode-descriptionForeground);
    }

    .fc-dismiss-btn {
        background: transparent;
        border: none;
        color: var(--vscode-descriptionForeground);
        font-size: 14px;
        cursor: pointer;
        padding: 2px 6px;
        border-radius: 4px;
        transition: all 0.15s ease;
        line-height: 1;
    }

    .fc-dismiss-btn:hover {
        color: var(--vscode-foreground);
        background: var(--vscode-editorWidget-background);
    }

    /* ── Body ─────────────────────────────────────────────────────────── */
    .fc-body {
        max-height: 60vh;
        overflow-y: auto;
    }

    /* ── Summary ──────────────────────────────────────────────────────── */
    .fc-summary {
        padding: 10px 12px;
        border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
    }

    .fc-summary-row {
        margin-bottom: 6px;
    }

    .fc-summary-row:last-child {
        margin-bottom: 0;
    }

    .fc-summary-row.fc-inline {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 2px;
    }

    .fc-summary-meta {
        margin-top: 8px;
    }

    .fc-label {
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.8px;
        color: var(--vscode-sideBarTitle-foreground, var(--vscode-descriptionForeground));
        font-weight: 700;
        display: block;
        margin-bottom: 2px;
    }

    .fc-inline .fc-label {
        display: inline;
        margin-bottom: 0;
    }

    .fc-message {
        font-size: 12px;
        line-height: 1.5;
        color: var(--vscode-foreground);
        margin: 2px 0 0 0;
    }

    .fc-value {
        font-size: 12px;
        color: var(--vscode-foreground);
    }

    /* ── Collapsible Section Toggle ───────────────────────────────────── */
    .fc-section-toggle {
        display: flex;
        align-items: center;
        gap: 6px;
        width: 100%;
        padding: 6px 12px;
        border: none;
        border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
        background: var(--vscode-panel-background, var(--vscode-sideBar-background, var(--vscode-editor-background)));
        color: var(--vscode-foreground);
        font-family: var(--vscode-font-family);
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
        text-align: left;
        transition: background 0.15s ease;
    }

    .fc-section-toggle:hover {
        background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
    }

    .fc-chevron {
        font-size: 8px;
        transition: transform 0.15s ease;
        display: inline-block;
    }

    .fc-chevron.open {
        transform: rotate(90deg);
    }

    .fc-section-body {
        padding: 8px 12px;
        border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
    }

    /* ── Subsections ──────────────────────────────────────────────────── */
    .fc-subsection {
        margin-bottom: 10px;
    }

    .fc-subsection:last-child {
        margin-bottom: 0;
    }

    /* ── Timeline ─────────────────────────────────────────────────────── */
    .fc-timeline {
        display: flex;
        flex-direction: column;
        gap: 3px;
    }

    .fc-timeline-item {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 3px 6px;
        border-radius: 4px;
        font-size: 11px;
        background: var(--vscode-editor-background);
    }

    .fc-timeline-item.fc-item-failure {
        background: color-mix(in srgb, var(--vscode-errorForeground, #f85149) 6%, transparent);
    }

    .fc-timeline-item.fc-item-denied {
        background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #d29922) 6%, transparent);
    }

    .fc-timeline-icon {
        font-size: 10px;
        width: 14px;
        text-align: center;
        flex-shrink: 0;
    }

    .fc-timeline-tool {
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 10px;
        color: var(--vscode-foreground);
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .fc-timeline-outcome {
        font-size: 9px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.3px;
        color: var(--vscode-descriptionForeground);
    }

    .fc-timeline-time {
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 10px;
        color: var(--vscode-descriptionForeground);
        flex-shrink: 0;
    }

    /* ── Budget Bar ───────────────────────────────────────────────────── */
    .fc-budget-bar {
        position: relative;
        height: 18px;
        background: var(--vscode-editor-background);
        border-radius: 4px;
        overflow: hidden;
        margin-top: 4px;
    }

    .fc-budget-fill {
        height: 100%;
        border-radius: 4px;
        background: var(--vscode-focusBorder, #007fd4);
        transition: width 0.4s ease;
    }

    .fc-budget-fill.warn {
        background: var(--vscode-editorWarning-foreground, #d29922);
    }

    .fc-budget-fill.over {
        background: var(--vscode-errorForeground, #f85149);
    }

    .fc-budget-label {
        position: absolute;
        top: 50%;
        left: 6px;
        transform: translateY(-50%);
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 9px;
        color: var(--vscode-foreground);
        white-space: nowrap;
    }

    /* ── Criteria List ────────────────────────────────────────────────── */
    .fc-criteria-list {
        margin: 4px 0 0 16px;
        padding: 0;
        font-size: 11px;
        color: var(--vscode-foreground);
        line-height: 1.5;
    }

    .fc-criteria-list li {
        margin-bottom: 2px;
    }

    /* ── Pre blocks ───────────────────────────────────────────────────── */
    .fc-pre {
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: var(--vscode-editor-font-size, 12px);
        line-height: 1.5;
        color: var(--vscode-terminal-foreground, var(--vscode-foreground));
        white-space: pre-wrap;
        word-break: break-all;
        background: var(--vscode-terminal-background, var(--vscode-editor-background));
        border-radius: 4px;
        padding: 8px;
        margin: 4px 0 0 0;
        max-height: 200px;
        overflow-y: auto;
        border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
    }

    .fc-raw-json {
        max-height: 300px;
        font-size: 10px;
    }

    /* ── Key-Value Grid ───────────────────────────────────────────────── */
    .fc-kv-grid {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 2px 12px;
        margin-top: 4px;
        font-size: 11px;
    }

    .fc-kv-key {
        color: var(--vscode-descriptionForeground);
        font-weight: 600;
    }

    .fc-kv-val {
        font-family: var(--vscode-editor-font-family, monospace);
        color: var(--vscode-foreground);
    }

    /* ── Raw JSON toggle button ───────────────────────────────────────── */
    .fc-raw-toggle {
        font-family: var(--vscode-font-family);
        font-size: 10px;
        padding: 2px 8px;
        border-radius: 4px;
        border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
        background: var(--vscode-button-secondaryBackground, var(--vscode-editorWidget-background));
        color: var(--vscode-descriptionForeground);
        cursor: pointer;
        transition: all 0.15s ease;
    }

    .fc-raw-toggle:hover {
        background: var(--vscode-button-secondaryHoverBackground, var(--vscode-sideBar-background));
        color: var(--vscode-foreground);
    }

    /* ── Suggested Actions ────────────────────────────────────────── */
    .fc-actions-section {
        padding: 10px 12px;
        border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
    }

    .fc-actions-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
        margin-top: 6px;
    }

    .fc-action-item {
        background: var(--vscode-editor-background);
        border-radius: 4px;
        padding: 8px 10px;
        border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
    }

    .fc-action-row {
        display: flex;
        align-items: center;
        gap: 8px;
    }

    .fc-action-btn {
        font-family: var(--vscode-font-family);
        font-size: 11px;
        font-weight: 600;
        padding: 4px 12px;
        border-radius: 4px;
        border: 1px solid var(--vscode-button-border, transparent);
        background: var(--vscode-button-secondaryBackground, color-mix(in srgb, var(--vscode-foreground) 10%, transparent));
        color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
        cursor: pointer;
        transition: all 0.15s ease;
        white-space: nowrap;
    }

    .fc-action-btn:hover:not(:disabled) {
        background: var(--vscode-button-secondaryHoverBackground, color-mix(in srgb, var(--vscode-foreground) 16%, transparent));
    }

    .fc-action-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }

    .fc-confidence-badge {
        font-size: 9px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.4px;
        padding: 2px 6px;
        border-radius: 10px;
        white-space: nowrap;
    }

    .fc-confidence-high {
        color: var(--vscode-charts-green, #3fb950);
        background: color-mix(in srgb, var(--vscode-charts-green, #3fb950) 12%, transparent);
        border: 1px solid color-mix(in srgb, var(--vscode-charts-green, #3fb950) 30%, transparent);
    }

    .fc-confidence-medium {
        color: var(--vscode-charts-yellow, #d29922);
        background: color-mix(in srgb, var(--vscode-charts-yellow, #d29922) 12%, transparent);
        border: 1px solid color-mix(in srgb, var(--vscode-charts-yellow, #d29922) 30%, transparent);
    }

    .fc-confidence-low {
        color: var(--vscode-descriptionForeground, #8b949e);
        background: color-mix(in srgb, var(--vscode-descriptionForeground, #8b949e) 10%, transparent);
        border: 1px solid color-mix(in srgb, var(--vscode-descriptionForeground, #8b949e) 20%, transparent);
    }

    .fc-action-rationale {
        font-size: 11px;
        line-height: 1.4;
        color: var(--vscode-descriptionForeground);
        margin: 4px 0 0 0;
    }
</style>
