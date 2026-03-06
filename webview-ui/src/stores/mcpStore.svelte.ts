// ─────────────────────────────────────────────────────────────────────────────
// stores/mcpStore.svelte.ts — Svelte 5 Runes factory for MCP resource fetching
//
// Creates reactive $state objects that dispatch MCP_FETCH_RESOURCE IPC messages
// to the Extension Host and resolve responses via requestId-based correlation.
//
// Usage:
//   const plan = createMCPResource<string>('coogent://tasks/.../implementation_plan');
//   plan.state.loading  → true while fetching
//   plan.state.data     → the resolved string/object content
//   plan.state.error    → error message on failure
// ─────────────────────────────────────────────────────────────────────────────

import { postMessage } from './vscode.svelte.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Types
// ═══════════════════════════════════════════════════════════════════════════════

/** The reactive state exposed by each MCP resource handle. */
export interface MCPResourceState<T = unknown> {
    /** Whether a fetch is currently in-flight. */
    loading: boolean;
    /** The resolved resource content, or null if not yet fetched / errored. */
    data: T | null;
    /** Error message from the Extension Host, or null on success. */
    error: string | null;
}

/** Reactive handle returned by createMCPResource(). */
export interface MCPResourceHandle<T = unknown> {
    /** The reactive $state object — read properties directly in templates. */
    readonly state: MCPResourceState<T>;
    /** Re-fetch the resource from the MCP state store. */
    refresh: () => void;
    /** Remove the global message listener (cleanup). */
    destroy: () => void;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Factory
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Generate a short unique request ID.
 * Uses `crypto.randomUUID()` if available, otherwise falls back to timestamp + random.
 */
function generateRequestId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Create a reactive Svelte 5 $state object that fetches an MCP resource by URI.
 *
 * On creation, the handle immediately dispatches an `MCP_FETCH_RESOURCE`
 * IPC message to the Extension Host and listens for the matching
 * `MCP_RESOURCE_DATA` response via the global `message` event.
 *
 * The listener is **self-cleaning**: it removes itself after receiving
 * the correlated response. Call `destroy()` for early cleanup if the
 * component unmounts before a response arrives.
 *
 * @param uri - The `coogent://` URI to fetch (e.g., `coogent://tasks/{id}/implementation_plan`).
 * @returns A handle with `{ state, refresh, destroy }`.
 *
 * @example
 * ```svelte
 * <script>
 *   import { createMCPResource } from '../stores/mcpStore.svelte.js';
 *   const plan = createMCPResource<string>('coogent://tasks/abc/implementation_plan');
 * </script>
 *
 * {#if plan.state.loading}
 *   <p>Loading…</p>
 * {:else if plan.state.error}
 *   <p class="error">{plan.state.error}</p>
 * {:else}
 *   <pre>{plan.state.data}</pre>
 * {/if}
 * ```
 */
export function createMCPResource<T = string>(uri: string): MCPResourceHandle<T> {
    const resourceState: MCPResourceState<T> = $state({
        loading: true,
        data: null,
        error: null,
    });

    /** The currently active request ID. */
    let activeRequestId: string | null = null;

    /** Handle incoming MCP_RESOURCE_DATA messages from the Extension Host. */
    function onMessage(event: MessageEvent): void {
        const msg = event.data;
        if (
            !msg ||
            msg.type !== 'MCP_RESOURCE_DATA' ||
            !msg.payload ||
            msg.payload.requestId !== activeRequestId
        ) {
            return;
        }

        // Response received — clean up the listener
        window.removeEventListener('message', onMessage);
        activeRequestId = null;

        if (msg.payload.error) {
            resourceState.loading = false;
            resourceState.data = null;
            resourceState.error = msg.payload.error;
        } else {
            resourceState.loading = false;
            resourceState.data = msg.payload.data as T;
            resourceState.error = null;
        }
    }

    /** Dispatch a fetch request to the Extension Host. */
    function fetchResource(): void {
        // Clean up any previous pending listener
        if (activeRequestId !== null) {
            window.removeEventListener('message', onMessage);
        }

        activeRequestId = generateRequestId();
        resourceState.loading = true;
        resourceState.data = null;
        resourceState.error = null;

        // Register the response listener
        window.addEventListener('message', onMessage);

        // Dispatch the IPC request
        postMessage({
            type: 'MCP_FETCH_RESOURCE',
            payload: { uri, requestId: activeRequestId },
        });
    }

    /** Clean up the listener without waiting for a response. */
    function destroy(): void {
        if (activeRequestId !== null) {
            window.removeEventListener('message', onMessage);
            activeRequestId = null;
        }
    }

    // Auto-fetch on creation
    fetchResource();

    return { state: resourceState, refresh: fetchResource, destroy };
}
