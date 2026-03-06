// ─────────────────────────────────────────────────────────────────────────────
// stores/mcpStore.ts — Svelte store factory for on-demand MCP resource fetching
//
// Creates isolated stores that dispatch MCP_FETCH_RESOURCE IPC messages to the
// Extension Host and resolve responses via requestId-based correlation.
//
// Usage:
//   const plan = createMCPResource<string>('coogent://tasks/.../implementation_plan');
//   $plan.loading  → true while fetching
//   $plan.data     → the resolved string/object content
//   $plan.error    → error message on failure
// ─────────────────────────────────────────────────────────────────────────────

import { writable, type Readable } from 'svelte/store';
import { postMessage } from './vscode.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Types
// ═══════════════════════════════════════════════════════════════════════════════

/** The reactive state exposed by each MCP resource store. */
export interface MCPResourceState<T = unknown> {
    /** Whether a fetch is currently in-flight. */
    loading: boolean;
    /** The resolved resource content, or null if not yet fetched / errored. */
    data: T | null;
    /** Error message from the Extension Host, or null on success. */
    error: string | null;
}

/** Extended readable store with a refresh() method for manual re-fetching. */
export interface MCPResourceStore<T = unknown> extends Readable<MCPResourceState<T>> {
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
 * Create a reactive Svelte store that fetches an MCP resource by URI.
 *
 * On creation, the store immediately dispatches an `MCP_FETCH_RESOURCE`
 * IPC message to the Extension Host and listens for the matching
 * `MCP_RESOURCE_DATA` response via the global `message` event.
 *
 * The listener is **self-cleaning**: it removes itself after receiving
 * the correlated response. Call `destroy()` for early cleanup if the
 * component unmounts before a response arrives.
 *
 * @param uri - The `coogent://` URI to fetch (e.g., `coogent://tasks/{id}/implementation_plan`).
 * @returns A readable store with `{ loading, data, error }` plus `refresh()` and `destroy()`.
 *
 * @example
 * ```svelte
 * <script>
 *   import { createMCPResource } from '../stores/mcpStore.js';
 *   const plan = createMCPResource<string>('coogent://tasks/abc/implementation_plan');
 * </script>
 *
 * {#if $plan.loading}
 *   <p>Loading…</p>
 * {:else if $plan.error}
 *   <p class="error">{$plan.error}</p>
 * {:else}
 *   <pre>{$plan.data}</pre>
 * {/if}
 * ```
 */
export function createMCPResource<T = string>(uri: string): MCPResourceStore<T> {
    const { subscribe, set } = writable<MCPResourceState<T>>({
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
            set({ loading: false, data: null, error: msg.payload.error });
        } else {
            set({ loading: false, data: msg.payload.data as T, error: null });
        }
    }

    /** Dispatch a fetch request to the Extension Host. */
    function fetchResource(): void {
        // Clean up any previous pending listener
        if (activeRequestId !== null) {
            window.removeEventListener('message', onMessage);
        }

        activeRequestId = generateRequestId();
        set({ loading: true, data: null, error: null });

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

    return {
        subscribe,
        refresh: fetchResource,
        destroy,
    };
}
