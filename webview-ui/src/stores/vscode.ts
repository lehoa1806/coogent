// ─────────────────────────────────────────────────────────────────────────────
// stores/vscode.ts — Svelte writable store + VS Code API bridge
//
// Replaces webview-ui/modules/store.js with a reactive Svelte store.
// Auto-persists to vscode.setState() on every update.
// ─────────────────────────────────────────────────────────────────────────────

import { writable, get } from 'svelte/store';
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
//  App State Store
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Hydrate initial state from VS Code's persisted state (survives panel
 * hide/show cycles) and merge with defaults for any missing fields.
 */
function hydrateInitialState(): AppState {
    const persisted = vscodeApi.getState();
    if (persisted && typeof persisted === 'object') {
        return { ...DEFAULT_APP_STATE, ...(persisted as Partial<AppState>) };
    }
    return { ...DEFAULT_APP_STATE };
}

/**
 * The central reactive store for the entire webview UI.
 * Components subscribe via `$appState` (Svelte auto-subscription syntax).
 */
export const appState = writable<AppState>(hydrateInitialState());

// Auto-persist every store update to VS Code's state API.
// This ensures state survives webview panel visibility toggles.
appState.subscribe((state) => {
    vscodeApi.setState(state);
});

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
 * In normal usage, the `subscribe` auto-persist handles this.
 */
export function persistState(): void {
    vscodeApi.setState(get(appState));
}

/**
 * Apply a partial patch to the app state (convenience wrapper).
 */
export function patchState(patch: Partial<AppState>): void {
    appState.update((current) => ({ ...current, ...patch }));
}

/**
 * Append text to a phase's accumulated output.
 */
export function appendPhaseOutput(phaseId: number, text: string): void {
    appState.update((state) => ({
        ...state,
        phaseOutputs: {
            ...state.phaseOutputs,
            [phaseId]: (state.phaseOutputs[phaseId] || '') + text,
        },
    }));
}
