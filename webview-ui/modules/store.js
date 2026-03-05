// ─────────────────────────────────────────────────────────────────────────────
// webview-ui/modules/store.js — Central state store with VS Code persistence
// ─────────────────────────────────────────────────────────────────────────────

// @ts-check
/// <reference lib="dom" />

/**
 * @typedef {Object} AppState
 * @property {string} engineState
 * @property {Array<{ id: number, prompt: string, status: string, context_files: string[], success_criteria: string }>} phases
 * @property {number | null} selectedPhaseId
 * @property {string} projectId
 * @property {any} planDraft
 * @property {number} elapsedSeconds
 * @property {number} planSlideIndex
 * @property {Record<number, string>} phaseOutputs
 * @property {string} masterSummary
 * @property {string} implementationPlan
 * @property {Record<number, { totalTokens: number, limit: number, fileCount: number }>} phaseTokenBudgets
 */

/** @type {ReturnType<typeof acquireVsCodeApi>} */
let _vscode;

/** @type {AppState} */
let _state = {
    engineState: 'IDLE',
    phases: [],
    selectedPhaseId: null,
    projectId: '',
    planDraft: null,
    elapsedSeconds: 0,
    planSlideIndex: 0,
    phaseOutputs: {},
    masterSummary: '',
    implementationPlan: '',
    phaseTokenBudgets: {},
};

/** @type {Array<(state: AppState) => void>} */
const _listeners = [];

/**
 * Initialize the store with a vscode API handle.
 * Hydrates state from getState() on first load.
 * @param {ReturnType<typeof acquireVsCodeApi>} vscodeApi
 */
export function initStore(vscodeApi) {
    _vscode = vscodeApi;
    const persisted = _vscode.getState();
    if (persisted && typeof persisted === 'object') {
        _state = { ..._state, ...persisted };
    }
}

/**
 * Get the current state (read-only).
 * @returns {AppState}
 */
export function getAppState() {
    return _state;
}

/**
 * Update state with a partial patch and persist.
 * Notifies all subscribers.
 * @param {Partial<AppState>} patch
 */
export function setAppState(patch) {
    _state = { ..._state, ...patch };
    _vscode.setState(_state);
    for (const fn of _listeners) {
        fn(_state);
    }
}

/**
 * Subscribe to state changes.
 * @param {(state: AppState) => void} listener
 * @returns {() => void} unsubscribe function
 */
export function subscribe(listener) {
    _listeners.push(listener);
    return () => {
        const idx = _listeners.indexOf(listener);
        if (idx >= 0) _listeners.splice(idx, 1);
    };
}

/**
 * Post a message to the Extension Host.
 * @param {{ type: string, payload?: any }} msg
 */
export function postMessage(msg) {
    _vscode.postMessage(msg);
}

/**
 * Append text to a phase's accumulated output and persist.
 * @param {number} phaseId
 * @param {string} text
 */
export function appendPhaseOutput(phaseId, text) {
    const current = _state.phaseOutputs[phaseId] || '';
    setAppState({
        phaseOutputs: { ..._state.phaseOutputs, [phaseId]: current + text },
    });
}
