// ─────────────────────────────────────────────────────────────────────────────
// webview-ui/modules/timer.js — Elapsed timer with store persistence
// ─────────────────────────────────────────────────────────────────────────────

// @ts-check

import { getAppState, setAppState } from './store.js';

/** @type {ReturnType<typeof setInterval> | null} */
let _interval = null;

/**
 * Start the elapsed timer (idempotent — no-op if already running).
 */
export function startTimer() {
    if (_interval) return;
    _interval = setInterval(() => {
        const s = getAppState().elapsedSeconds + 1;
        setAppState({ elapsedSeconds: s });
        renderElapsed(s);
    }, 1000);
}

/**
 * Stop the elapsed timer (idempotent).
 */
export function stopTimer() {
    if (_interval) {
        clearInterval(_interval);
        _interval = null;
    }
}

/**
 * Reset the elapsed timer to 00:00.
 */
export function resetTimer() {
    stopTimer();
    setAppState({ elapsedSeconds: 0 });
    renderElapsed(0);
}

/**
 * Render the elapsed time into the DOM.
 * @param {number} seconds
 */
export function renderElapsed(seconds) {
    const el = document.getElementById('elapsed-time');
    if (!el) return;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    el.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Initialize timer display from persisted state.
 */
export function initTimer() {
    renderElapsed(getAppState().elapsedSeconds);
}
