// ─────────────────────────────────────────────────────────────────────────────
// handleMCPFetchResource.test.ts — Regression tests for cross-session access
//
// After the stale guard was removed, MCP_FETCH_RESOURCE requests for any
// session (current or historical) should be forwarded to the MCP client bridge
// without rejection.
// ─────────────────────────────────────────────────────────────────────────────

import { routeWebviewMessage, type MessageRouterDeps } from '../messageRouter.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Minimal mock construction via MessageRouterDeps
// ═══════════════════════════════════════════════════════════════════════════════

/** Flush pending microtasks so fire-and-forget promise chains settle. */
const flushPromises = () => new Promise<void>(resolve => setImmediate(resolve));

function createMockDeps(opts: {
    currentSessionDirName?: string;
    mcpClientBridge?: { readResource: jest.Mock } | null;
}): { deps: MessageRouterDeps; postMessageMock: jest.Mock } {
    const postMessageMock = jest.fn();

    const deps: MessageRouterDeps = {
        engine: {
            getSessionDirName: jest.fn(() => opts.currentSessionDirName),
        } as any,
        sendToWebview: postMessageMock,
        isPanelAlive: () => true,
        getSkipSandboxBranch: () => false,
        setSkipSandboxBranch: jest.fn(),
        sessionManager: undefined,
        adkController: undefined,
        preFlightGitCheck: undefined,
        onReset: undefined,
        mcpServer: undefined,
        mcpClientBridge: (opts.mcpClientBridge ?? undefined) as any,
        agentRegistry: undefined,
        coogentDir: undefined,
    };

    return { deps, postMessageMock };
}

describe('routeWebviewMessage — MCP_FETCH_RESOURCE cross-session access', () => {
    const CURRENT_TASK_ID = '20260310-220000-a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const STALE_TASK_ID = '20260310-200030-c992afc5-cd37-4b50-8a75-f06c30f5b157';

    it('allows MCP_FETCH_RESOURCE when URI task ID differs from current session', async () => {
        const readResourceMock = jest.fn().mockResolvedValue('{"plan":"historical-data"}');
        const { deps, postMessageMock } = createMockDeps({
            currentSessionDirName: CURRENT_TASK_ID,
            mcpClientBridge: { readResource: readResourceMock },
        });

        await routeWebviewMessage(
            { type: 'MCP_FETCH_RESOURCE', payload: { uri: `coogent://tasks/${STALE_TASK_ID}/plan`, requestId: 'req-001' } },
            deps
        );
        await flushPromises();

        // readResource should be called with the full (cross-session) URI
        expect(readResourceMock).toHaveBeenCalledWith(
            `coogent://tasks/${STALE_TASK_ID}/plan`,
        );

        // No stale rejection error should be sent
        const staleErrorCalls = postMessageMock.mock.calls.filter(
            (call: any[]) =>
                call[0]?.type === 'MCP_RESOURCE_DATA' &&
                call[0]?.payload?.error === 'Session has been reset. Resource no longer available.',
        );
        expect(staleErrorCalls).toHaveLength(0);
    });

    it('allows MCP_FETCH_RESOURCE when URI task ID matches current session', async () => {
        const readResourceMock = jest.fn().mockResolvedValue('{"plan":"data"}');
        const { deps, postMessageMock } = createMockDeps({
            currentSessionDirName: CURRENT_TASK_ID,
            mcpClientBridge: { readResource: readResourceMock },
        });

        await routeWebviewMessage(
            { type: 'MCP_FETCH_RESOURCE', payload: { uri: `coogent://tasks/${CURRENT_TASK_ID}/plan`, requestId: 'req-002' } },
            deps
        );
        await flushPromises();

        expect(readResourceMock).toHaveBeenCalledWith(
            `coogent://tasks/${CURRENT_TASK_ID}/plan`,
        );

        const staleErrorCalls = postMessageMock.mock.calls.filter(
            (call: any[]) =>
                call[0]?.type === 'MCP_RESOURCE_DATA' &&
                call[0]?.payload?.error === 'Session has been reset. Resource no longer available.',
        );
        expect(staleErrorCalls).toHaveLength(0);
    });

    it('fetches cross-session resource without stale guard rejection', async () => {
        const readResourceMock = jest.fn().mockResolvedValue('{"report":"data"}');
        const { deps, postMessageMock } = createMockDeps({
            currentSessionDirName: CURRENT_TASK_ID,
            mcpClientBridge: { readResource: readResourceMock },
        });

        await routeWebviewMessage(
            { type: 'MCP_FETCH_RESOURCE', payload: { uri: `coogent://tasks/${STALE_TASK_ID}/report`, requestId: 'req-003' } },
            deps
        );
        await flushPromises();

        // readResource should have been called exactly once
        expect(readResourceMock).toHaveBeenCalledTimes(1);

        // The resolved data should be forwarded to the webview via MCP_RESOURCE_DATA
        expect(postMessageMock).toHaveBeenCalledWith({
            type: 'MCP_RESOURCE_DATA',
            payload: {
                requestId: 'req-003',
                data: { report: 'data' },
            },
        });
    });

    it('sends "MCP Client Bridge not available" when no bridge and URI matches', async () => {
        const { deps, postMessageMock } = createMockDeps({
            currentSessionDirName: CURRENT_TASK_ID,
            mcpClientBridge: null,
        });

        await routeWebviewMessage(
            { type: 'MCP_FETCH_RESOURCE', payload: { uri: `coogent://tasks/${CURRENT_TASK_ID}/plan`, requestId: 'req-004' } },
            deps
        );

        expect(postMessageMock).toHaveBeenCalledWith({
            type: 'MCP_RESOURCE_DATA',
            payload: {
                requestId: 'req-004',
                data: '',
                error: 'MCP Client Bridge not available.',
            },
        });
    });
});
