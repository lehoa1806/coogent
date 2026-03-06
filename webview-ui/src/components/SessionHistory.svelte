<!-- ─────────────────────────────────────────────────────────────────────── -->
<!-- SessionHistory.svelte — Slide-in drawer with search and session list   -->
<!-- ─────────────────────────────────────────────────────────────────────── -->

<script lang="ts">
    import { appState, postMessage } from "../stores/vscode.js";

    let {
        visible = false,
        onClose = () => {},
    }: { visible?: boolean; onClose?: () => void } = $props();

    let searchQuery = $state("");
    let searchTimeout: ReturnType<typeof setTimeout> | null = $state(null);

    function handleSearch() {
        if (searchTimeout) clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => {
            if (searchQuery.trim()) {
                postMessage({
                    type: "CMD_SEARCH_SESSIONS",
                    payload: { query: searchQuery.trim() },
                });
            } else {
                postMessage({ type: "CMD_LIST_SESSIONS" });
            }
        }, 300);
    }

    function handleLoad(sessionId: string) {
        postMessage({ type: "CMD_LOAD_SESSION", payload: { sessionId } });
        onClose();
    }

    function handleDelete(e: MouseEvent, sessionId: string) {
        e.stopPropagation();
        postMessage({ type: "CMD_DELETE_SESSION", payload: { sessionId } });
    }

    function formatRelativeTime(timestamp: number): string {
        if (!timestamp) return "";
        const diff = Date.now() - timestamp;
        const seconds = Math.floor(diff / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);
        if (days > 0) return `${days}d ago`;
        if (hours > 0) return `${hours}h ago`;
        if (minutes > 0) return `${minutes}m ago`;
        return "just now";
    }

    function statusClass(status: string): string {
        if (status === "completed") return "completed";
        if (status === "running") return "running";
        if (status === "paused_error") return "error";
        return "idle";
    }

    function handleKeydown(e: KeyboardEvent) {
        if (e.key === "Escape" && visible) {
            e.preventDefault();
            onClose();
        }
    }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if visible}
    <div class="chat-history-drawer">
        <div class="drawer-header">
            <h2>Session History</h2>
            <button class="btn-close-drawer" onclick={onClose}>✕</button>
        </div>

        <div class="drawer-search">
            <input
                type="text"
                class="session-search-input"
                placeholder="Search sessions…"
                bind:value={searchQuery}
                oninput={handleSearch}
            />
        </div>

        <div class="session-list" role="list">
            {#if $appState.sessions.length === 0}
                <div class="empty-sessions">No past sessions found</div>
            {:else}
                {#each $appState.sessions as session (session.id)}
                    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
                    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
                    <div
                        class="session-item"
                        role="listitem"
                        title="Click to restore session: {session.projectId ||
                            'Untitled'} ({session.status})"
                        onclick={() => handleLoad(session.id)}
                        onkeydown={(e) => {
                            if (e.key === "Enter") handleLoad(session.id);
                        }}
                        tabindex="0"
                    >
                        <div class="session-item-header">
                            <span class="session-project">
                                {session.projectId || "Untitled"}
                            </span>
                            <div class="session-item-actions">
                                <span
                                    class="session-status-pill {statusClass(
                                        session.status,
                                    )}"
                                >
                                    {session.status}
                                </span>
                                <button
                                    class="btn-delete-session"
                                    title="Delete this session"
                                    onclick={(e) => handleDelete(e, session.id)}
                                >
                                    🗑
                                </button>
                            </div>
                        </div>
                        {#if session.summary}
                            <div class="session-item-prompt">
                                {session.summary}
                            </div>
                        {/if}
                        <div class="session-item-meta">
                            <span>{session.phaseCount} phases</span>
                            <span>{formatRelativeTime(session.timestamp)}</span>
                        </div>
                    </div>
                {/each}
            {/if}
        </div>
    </div>
{/if}

<style>
    .chat-history-drawer {
        position: fixed;
        top: 0;
        right: 0;
        width: 300px;
        height: 100vh;
        display: flex;
        flex-direction: column;
        background: var(
            --vscode-sideBar-background,
            var(--vscode-editor-background)
        );
        border-left: 1px solid
            var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
        box-shadow: -4px 0 16px
            color-mix(
                in srgb,
                var(--vscode-widget-shadow, #000) 20%,
                transparent
            );
        z-index: 100;
        animation: drawer-slide-in 0.2s ease-out;
    }

    @keyframes drawer-slide-in {
        from {
            transform: translateX(100%);
            opacity: 0;
        }
        to {
            transform: translateX(0);
            opacity: 1;
        }
    }

    .drawer-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 16px;
        border-bottom: 1px solid
            var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
        flex-shrink: 0;
    }

    .drawer-header h2 {
        font-size: 13px;
        font-weight: 600;
        margin: 0;
        color: var(--vscode-foreground);
    }

    .btn-close-drawer {
        background: transparent;
        border: none;
        color: var(--vscode-descriptionForeground);
        font-size: 16px;
        cursor: pointer;
        padding: 4px 8px;
        border-radius: 4px;
        transition: all 0.15s ease;
        line-height: 1;
    }

    .btn-close-drawer:hover {
        color: var(--vscode-foreground);
        background: var(--vscode-editorWidget-background);
    }

    .drawer-search {
        padding: 10px 16px;
        border-bottom: 1px solid
            var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
        flex-shrink: 0;
    }

    .session-search-input {
        width: 100%;
        padding: 6px 10px;
        font-family: var(--vscode-font-family);
        font-size: 12px;
        background: var(
            --vscode-input-background,
            var(--vscode-editor-background)
        );
        color: var(--vscode-input-foreground, var(--vscode-foreground));
        border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
        border-radius: 4px;
        transition: border-color 0.15s ease;
    }

    .session-search-input:focus {
        outline: none;
        border-color: var(--vscode-focusBorder, #007fd4);
        box-shadow: 0 0 0 1px var(--vscode-focusBorder, #007fd4);
    }

    .session-list {
        flex: 1;
        overflow-y: auto;
        padding: 8px;
    }

    .empty-sessions {
        text-align: center;
        color: var(--vscode-disabledForeground);
        padding: 32px 16px;
        font-size: 12px;
    }

    .session-item {
        padding: 10px 12px;
        border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
        border-radius: 6px;
        margin-bottom: 6px;
        cursor: pointer;
        transition: all 0.15s ease;
        background: var(--vscode-editorWidget-background);
    }

    .session-item:hover {
        border-color: color-mix(
            in srgb,
            var(--vscode-focusBorder, #007fd4) 30%,
            transparent
        );
        background: color-mix(
            in srgb,
            var(--vscode-focusBorder, #007fd4) 12%,
            transparent
        );
    }

    .session-item-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 4px;
    }

    .session-project {
        font-size: 12px;
        font-weight: 600;
        color: var(--vscode-foreground);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: 180px;
    }

    .session-item-actions {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-shrink: 0;
    }

    .session-status-pill {
        font-size: 9px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.4px;
        padding: 2px 8px;
        border-radius: 4px;
        min-width: 50px;
        text-align: center;
    }

    .session-status-pill.completed {
        color: var(--vscode-charts-green, #3fb950);
        background: color-mix(
            in srgb,
            var(--vscode-charts-green, #3fb950) 10%,
            transparent
        );
    }
    .session-status-pill.running {
        color: var(--vscode-focusBorder, #007fd4);
        background: color-mix(
            in srgb,
            var(--vscode-focusBorder, #007fd4) 12%,
            transparent
        );
    }
    .session-status-pill.error {
        color: var(--vscode-errorForeground, #f85149);
        background: color-mix(
            in srgb,
            var(--vscode-errorForeground, #f85149) 10%,
            transparent
        );
    }
    .session-status-pill.idle {
        color: var(--vscode-disabledForeground);
        background: var(--vscode-editorWidget-background);
    }

    .session-item-prompt {
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
        line-height: 1.4;
        margin-bottom: 6px;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
    }

    .session-item-meta {
        display: flex;
        justify-content: space-between;
        font-size: 10px;
        color: var(--vscode-disabledForeground);
        font-family: var(--vscode-editor-font-family, monospace);
    }

    .btn-delete-session {
        background: transparent;
        border: none;
        cursor: pointer;
        padding: 2px 4px;
        font-size: 12px;
        border-radius: 4px;
        color: var(--vscode-disabledForeground);
        transition: all 0.15s ease;
        opacity: 0;
        line-height: 1;
    }

    .session-item:hover .btn-delete-session {
        opacity: 1;
    }

    .btn-delete-session:hover {
        color: var(--vscode-errorForeground, #f85149);
        background: color-mix(
            in srgb,
            var(--vscode-errorForeground, #f85149) 10%,
            transparent
        );
    }
</style>
