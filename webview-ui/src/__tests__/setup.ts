// ─────────────────────────────────────────────────────────────────────────────
// webview-ui/src/__tests__/setup.ts — Global test setup
//
// Mocks the VS Code webview API (`acquireVsCodeApi`) before any store module
// is imported. This is critical because `vscode.svelte.ts` calls
// `acquireVsCodeApi()` at module scope.
// ─────────────────────────────────────────────────────────────────────────────
import '@testing-library/jest-dom/vitest';

/** Captured calls from the Svelte store to the VS Code host. */
export const postedMessages: unknown[] = [];

/** Last state persisted via `vscodeApi.setState()`. */
export let lastSetState: unknown = undefined;

/** State returned by `vscodeApi.getState()` — set this before importing a store. */
export let mockPersistedState: unknown = undefined;

export function setMockPersistedState(state: unknown): void {
    mockPersistedState = state;
}

function createMockVsCodeApi() {
    return {
        postMessage: (msg: unknown) => {
            postedMessages.push(msg);
        },
        getState: () => mockPersistedState,
        setState: (state: unknown) => {
            lastSetState = state;
        },
    };
}

// Install mock globally before any module calls `acquireVsCodeApi()`
(globalThis as any).acquireVsCodeApi = createMockVsCodeApi;

// Reset captured data between tests
beforeEach(() => {
    postedMessages.length = 0;
    lastSetState = undefined;
});
