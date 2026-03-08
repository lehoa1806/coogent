// ─────────────────────────────────────────────────────────────────────────────
// mcpStore.test.ts — Integration tests for createMCPResource()
//
// Tests the correlation-based MCP resource fetching mechanism that the
// webview uses to pull data from the Extension Host via requestId-matched
// IPC round-trips (MCP_FETCH_RESOURCE → MCP_RESOURCE_DATA).
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, afterEach } from 'vitest';
import { postedMessages } from './setup.js';
import { createMCPResource } from '../stores/mcpStore.svelte.js';
import type { MCPResourceHandle } from '../stores/mcpStore.svelte.js';

/** Simulate the Extension Host responding with MCP_RESOURCE_DATA. */
function simulateResponse(requestId: string, data: unknown, error?: string): void {
    const event = new MessageEvent('message', {
        data: {
            type: 'MCP_RESOURCE_DATA',
            payload: { requestId, data, error },
        },
    });
    window.dispatchEvent(event);
}

/** Extract the requestId from the last posted MCP_FETCH_RESOURCE message. */
function getLastRequestId(): string {
    const fetchMsg = postedMessages
        .filter((m: any) => m.type === 'MCP_FETCH_RESOURCE')
        .at(-1) as any;
    if (!fetchMsg) throw new Error('No MCP_FETCH_RESOURCE message found');
    return fetchMsg.payload.requestId;
}

describe('createMCPResource()', () => {
    let handle: MCPResourceHandle<string> | null = null;

    afterEach(() => {
        handle?.destroy();
        handle = null;
    });

    it('dispatches MCP_FETCH_RESOURCE on creation with correct uri', () => {
        handle = createMCPResource<string>('coogent://tasks/abc/plan');

        const fetchMsg = postedMessages.find(
            (m: any) => m.type === 'MCP_FETCH_RESOURCE',
        ) as any;
        expect(fetchMsg).toBeDefined();
        expect(fetchMsg.payload.uri).toBe('coogent://tasks/abc/plan');
        expect(fetchMsg.payload.requestId).toBeTruthy();
    });

    it('starts in loading state', () => {
        handle = createMCPResource<string>('coogent://tasks/abc/plan');

        expect(handle.state.loading).toBe(true);
        expect(handle.state.data).toBeNull();
        expect(handle.state.error).toBeNull();
    });

    it('resolves state.data on correlated response', () => {
        handle = createMCPResource<string>('coogent://tasks/abc/plan');
        const requestId = getLastRequestId();

        simulateResponse(requestId, 'Hello, world!');

        expect(handle.state.loading).toBe(false);
        expect(handle.state.data).toBe('Hello, world!');
        expect(handle.state.error).toBeNull();
    });

    it('sets state.error on error response', () => {
        handle = createMCPResource<string>('coogent://tasks/abc/plan');
        const requestId = getLastRequestId();

        simulateResponse(requestId, null, 'Resource not found');

        expect(handle.state.loading).toBe(false);
        expect(handle.state.data).toBeNull();
        expect(handle.state.error).toBe('Resource not found');
    });

    it('ignores responses with wrong requestId', () => {
        handle = createMCPResource<string>('coogent://tasks/abc/plan');

        simulateResponse('wrong-request-id', 'Should be ignored');

        // Should still be loading because the right response hasn't arrived
        expect(handle.state.loading).toBe(true);
        expect(handle.state.data).toBeNull();
    });

    it('refresh() re-dispatches a new fetch with a new requestId', () => {
        handle = createMCPResource<string>('coogent://tasks/abc/plan');
        const firstRequestId = getLastRequestId();

        // Resolve the first request
        simulateResponse(firstRequestId, 'v1');
        expect(handle.state.data).toBe('v1');

        // Refresh
        handle.refresh();

        const secondRequestId = getLastRequestId();
        expect(secondRequestId).not.toBe(firstRequestId);
        expect(handle.state.loading).toBe(true);

        // Resolve the second request
        simulateResponse(secondRequestId, 'v2');
        expect(handle.state.data).toBe('v2');
    });

    it('destroy() cleans up without crashing on subsequent messages', () => {
        handle = createMCPResource<string>('coogent://tasks/abc/plan');
        const requestId = getLastRequestId();

        handle.destroy();

        // Dispatching a response after destroy should not crash or update state
        expect(() => simulateResponse(requestId, 'too late')).not.toThrow();
        expect(handle.state.loading).toBe(true); // Stopped before resolution
    });
});
