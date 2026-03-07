<!-- ─────────────────────────────────────────────────────────────────────── -->
<!-- WorkerStudio.svelte — Read-only Worker Studio tab showing loaded profiles -->
<!-- ─────────────────────────────────────────────────────────────────────── -->

<script lang="ts">
    import { appState, postMessage } from "../stores/vscode.svelte.js";
    import type { WorkerProfile } from "../types.js";

    // Request workers on mount
    $effect(() => {
        postMessage({ type: "workers:request" });
    });

    let workers: WorkerProfile[] = $derived(appState.workers ?? []);
</script>

<div class="worker-studio">
    <h2 class="studio-header">Loaded Workers ({workers.length})</h2>
    {#if workers.length === 0}
        <div class="empty-state">
            <p>No worker profiles loaded.</p>
        </div>
    {:else}
        {#each workers as worker (worker.id)}
            <div class="worker-card">
                <div class="worker-header">
                    <span class="worker-name">{worker.name}</span>
                    <span class="worker-id">({worker.id})</span>
                </div>
                <p class="worker-desc">{worker.description}</p>
                {#if worker.tags && worker.tags.length > 0}
                    <div class="worker-tags">
                        {#each worker.tags as tag}
                            <span class="tag">{tag}</span>
                        {/each}
                    </div>
                {/if}
            </div>
        {/each}
    {/if}
</div>

<style>
    .worker-studio {
        padding: 1rem;
        overflow-y: auto;
        flex: 1;
    }

    .studio-header {
        font-size: 13px;
        font-weight: 600;
        margin: 0 0 0.75rem 0;
        color: var(--vscode-foreground);
    }

    .empty-state {
        text-align: center;
        padding: 2rem 1rem;
        color: var(--vscode-descriptionForeground);
        font-size: 0.85rem;
    }

    .worker-card {
        background: var(--vscode-editor-background);
        border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
        border-radius: 6px;
        padding: 0.75rem;
        margin-bottom: 0.5rem;
    }

    .worker-header {
        display: flex;
        align-items: baseline;
        gap: 0.5rem;
    }

    .worker-name {
        font-weight: 600;
        font-size: 0.95rem;
        color: var(--vscode-foreground);
    }

    .worker-id {
        color: var(--vscode-descriptionForeground);
        font-size: 0.8rem;
        font-family: var(--vscode-editor-font-family, monospace);
    }

    .worker-desc {
        margin: 0.25rem 0;
        font-size: 0.85rem;
        color: var(--vscode-foreground);
        line-height: 1.4;
    }

    .worker-tags {
        display: flex;
        flex-wrap: wrap;
        gap: 0.25rem;
        margin-top: 0.25rem;
    }

    .tag {
        background: var(--vscode-badge-background);
        color: var(--vscode-badge-foreground);
        padding: 0.1rem 0.4rem;
        border-radius: 3px;
        font-size: 0.75rem;
        font-weight: 500;
    }
</style>
