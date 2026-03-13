// ─────────────────────────────────────────────────────────────────────────────
// stores/vscode.svelte.ts — Svelte 5 Runes global state + VS Code API bridge
//
// Replaces the legacy writable<AppState> store with a $state object.
// Auto-persists to vscodeApi.setState() via $effect.root().
// ─────────────────────────────────────────────────────────────────────────────

import type { AppState, WebviewToHostMessage } from '../types.js';
import { DEFAULT_APP_STATE } from '../types.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  VS Code API Singleton
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The VS Code webview API handle.
 * `acquireVsCodeApi()` is injected by the VS Code webview runtime and MUST
 * be called exactly once.
 */
interface VsCodeApi {
    postMessage(msg: unknown): void;
    getState(): unknown;
    setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscodeApi: VsCodeApi = acquireVsCodeApi();

// ═══════════════════════════════════════════════════════════════════════════════
//  App State ($state)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fields that should NOT be restored from persisted state on startup.
 * These are transient data that should be fetched fresh on demand.
 */
const TRANSIENT_FIELDS: ReadonlySet<keyof AppState> = new Set([
    'consolidationReport',
    'executionPlan',
    'reportModalOpen',
    'error',
    'terminalOutput',
    'phaseOutputs',
]);

/**
 * Hydrate initial state from VS Code's persisted state (survives panel
 * hide/show cycles) and merge with defaults for any missing fields.
 *
 * Transient fields (session history, reports, terminal output) are always
 * reset to defaults so stale data doesn't flash on startup.
 */
function hydrateInitialState(): AppState {
    const persisted = vscodeApi.getState();
    if (persisted && typeof persisted === 'object') {
        const restored = { ...DEFAULT_APP_STATE, ...(persisted as Partial<AppState>) };
        // Reset transient fields to defaults
        for (const key of TRANSIENT_FIELDS) {
            (restored as Record<string, unknown>)[key] = DEFAULT_APP_STATE[key];
        }
        return restored;
    }
    return { ...DEFAULT_APP_STATE };
}

/**
 * The central reactive state object for the entire webview UI.
 * Components import this directly and read/write properties.
 * Svelte 5's fine-grained reactivity tracks individual property access.
 */
export const appState: AppState = $state(hydrateInitialState());

// ═══════════════════════════════════════════════════════════════════════════════
//  Auto-Persistence via $effect.root()
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Module-level effect that persists state to VS Code on every mutation.
 * $effect.root() is required because this runs outside any component context.
 * The returned cleanup function is called by destroyStore() for test teardown.
 */
const _cleanupPersist = $effect.root(() => {
    $effect(() => {
        // Spread to read all top-level properties, triggering reactivity tracking
        const snapshot = { ...appState };
        vscodeApi.setState(snapshot);
    });
});

/** Cancel the auto-persist effect. Only needed for test teardown. */
export function destroyStore(): void {
    _cleanupPersist();
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Send a command message to the Extension Host.
 */
export function postMessage(msg: WebviewToHostMessage): void {
    vscodeApi.postMessage(msg);
}

/**
 * Explicitly persist the current store state. Useful when you want to
 * guarantee persistence at a specific point (e.g., before navigation).
 * In normal usage, the `$effect` auto-persist handles this.
 */
export function persistState(): void {
    vscodeApi.setState({ ...appState });
}

/**
 * Apply a partial patch to the app state (convenience wrapper).
 */
export function patchState(patch: Partial<AppState>): void {
    Object.assign(appState, patch);
}

/**
 * Append text to a phase's accumulated output.
 */
export function appendPhaseOutput(phaseId: number, text: string): void {
    appState.phaseOutputs = {
        ...appState.phaseOutputs,
        [phaseId]: (appState.phaseOutputs[phaseId] || '') + text,
    };
}
