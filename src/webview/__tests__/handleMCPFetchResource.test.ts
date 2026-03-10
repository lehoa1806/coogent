// ─────────────────────────────────────────────────────────────────────────────
// handleMCPFetchResource.test.ts — Regression tests for stale task guard
//
// After CMD_RESET, the webview may still have in-flight MCP_FETCH_RESOURCE
// requests for the old (purged) task ID. The guard in routeWebviewMessage()
// should reject these with an error response instead of forwarding them to
// the MCP client bridge.
// ─────────────────────────────────────────────────────────────────────────────

import { routeWebviewMessage, type MessageRouterDeps } from '../messageRouter.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Minimal mock construction via MessageRouterDeps
// ═══════════════════════════════════════════════════════════════════════════════

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

describe('routeWebviewMessage — MCP_FETCH_RESOURCE stale task guard', () => {
    const CURRENT_TASK_ID = '20260310-220000-a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const STALE_TASK_ID = '20260310-200030-c992afc5-cd37-4b50-8a75-f06c30f5b157';

    it('rejects MCP_FETCH_RESOURCE when URI task ID differs from current session', async () => {
        const readResourceMock = jest.fn();
        const { deps, postMessageMock } = createMockDeps({
            currentSessionDirName: CURRENT_TASK_ID,
            mcpClientBridge: { readResource: readResourceMock },
        });

        await routeWebviewMessage(
            { type: 'MCP_FETCH_RESOURCE', payload: { uri: `coogent://tasks/${STALE_TASK_ID}/plan`, requestId: 'req-001' } },
            deps
        );

        expect(postMessageMock).toHaveBeenCalledWith({
            type: 'MCP_RESOURCE_DATA',
            payload: {
                requestId: 'req-001',
                data: '',
                error: 'Session has been reset. Resource no longer available.',
            },
        });
        expect(readResourceMock).not.toHaveBeenCalled();
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

    it('rejects stale request and does NOT invoke mcpClientBridge at all', async () => {
        const readResourceMock = jest.fn();
        const { deps } = createMockDeps({
            currentSessionDirName: CURRENT_TASK_ID,
            mcpClientBridge: { readResource: readResourceMock },
        });

        await routeWebviewMessage(
            { type: 'MCP_FETCH_RESOURCE', payload: { uri: `coogent://tasks/${STALE_TASK_ID}/report`, requestId: 'req-003' } },
            deps
        );

        expect(readResourceMock).not.toHaveBeenCalled();
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
