// ─────────────────────────────────────────────────────────────────────────────
// handleMCPFetchResource.test.ts — Regression tests for stale task guard
//
// After CMD_RESET, the webview may still have in-flight MCP_FETCH_RESOURCE
// requests for the old (purged) task ID. The guard added to
// handleMCPFetchResource() should reject these with an error response
// instead of forwarding them to the MCP client bridge.
// ─────────────────────────────────────────────────────────────────────────────

import { MissionControlPanel } from '../MissionControlPanel.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Minimal mock construction
//
//  MissionControlPanel has a private constructor, so we can't instantiate it
//  normally. Instead, we create a bare object with the MissionControlPanel
//  prototype and manually wire the fields that handleMCPFetchResource reads:
//    - this.engine.getSessionDirName() → deriveMasterTaskId()
//    - this.panel.webview.postMessage()  → sendToWebview()
//    - this.mcpClientBridge?.readResource()
// ═══════════════════════════════════════════════════════════════════════════════

function createMockPanel(opts: {
    currentSessionDirName?: string;
    mcpClientBridge?: { readResource: jest.Mock } | null;
}) {
    const postMessageMock = jest.fn();

    // Use Object.create to get prototype methods without calling the private constructor
    const instance = Object.create(MissionControlPanel.prototype) as Record<string, any>;

    // Wire private fields the method depends on
    instance.panel = {
        webview: { postMessage: postMessageMock },
    };
    instance.engine = {
        getSessionDirName: jest.fn(() => opts.currentSessionDirName),
    };
    instance.mcpClientBridge = opts.mcpClientBridge ?? undefined;

    return { instance, postMessageMock };
}

describe('MissionControlPanel.handleMCPFetchResource — stale task guard', () => {
    const CURRENT_TASK_ID = '20260310-220000-a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const STALE_TASK_ID = '20260310-200030-c992afc5-cd37-4b50-8a75-f06c30f5b157';

    afterEach(() => {
        // Cleanup static state
        (MissionControlPanel as any).currentPanel = undefined;
    });

    it('rejects MCP_FETCH_RESOURCE when URI task ID differs from current session', () => {
        const readResourceMock = jest.fn();
        const { instance, postMessageMock } = createMockPanel({
            currentSessionDirName: CURRENT_TASK_ID,
            mcpClientBridge: { readResource: readResourceMock },
        });

        // Call the private method via bracket notation
        instance.handleMCPFetchResource(`coogent://tasks/${STALE_TASK_ID}/plan`, 'req-001');

        // Should send an error response, NOT call mcpClientBridge.readResource
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

    it('allows MCP_FETCH_RESOURCE when URI task ID matches current session', () => {
        const readResourceMock = jest.fn().mockResolvedValue('{"plan":"data"}');
        const { instance, postMessageMock } = createMockPanel({
            currentSessionDirName: CURRENT_TASK_ID,
            mcpClientBridge: { readResource: readResourceMock },
        });

        // Set static currentPanel so the .then() handler doesn't bail
        (MissionControlPanel as any).currentPanel = instance;

        instance.handleMCPFetchResource(`coogent://tasks/${CURRENT_TASK_ID}/plan`, 'req-002');

        // Should NOT send a stale-task error — should call mcpClientBridge.readResource
        expect(readResourceMock).toHaveBeenCalledWith(
            `coogent://tasks/${CURRENT_TASK_ID}/plan`,
        );

        // The initial error response for stale task should NOT be present
        const staleErrorCalls = postMessageMock.mock.calls.filter(
            (call: any[]) =>
                call[0]?.type === 'MCP_RESOURCE_DATA' &&
                call[0]?.payload?.error === 'Session has been reset. Resource no longer available.',
        );
        expect(staleErrorCalls).toHaveLength(0);
    });

    it('rejects stale request and does NOT invoke mcpClientBridge at all', () => {
        const readResourceMock = jest.fn();
        const { instance } = createMockPanel({
            currentSessionDirName: CURRENT_TASK_ID,
            mcpClientBridge: { readResource: readResourceMock },
        });

        instance.handleMCPFetchResource(`coogent://tasks/${STALE_TASK_ID}/report`, 'req-003');

        // The critical assertion: mcpClientBridge.readResource must NOT be invoked
        // for stale task IDs — this prevents errors from accessing purged data.
        expect(readResourceMock).not.toHaveBeenCalled();
    });

    it('sends "MCP Client Bridge not available" when no bridge and URI matches', () => {
        const { instance, postMessageMock } = createMockPanel({
            currentSessionDirName: CURRENT_TASK_ID,
            mcpClientBridge: null, // No bridge
        });

        instance.handleMCPFetchResource(`coogent://tasks/${CURRENT_TASK_ID}/plan`, 'req-004');

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
