// ─────────────────────────────────────────────────────────────────────────────
// webview-ui/modules/controls.js — Button handlers and IPC commands
// ─────────────────────────────────────────────────────────────────────────────

// @ts-check
/// <reference lib="dom" />

import { getAppState, postMessage } from './store.js';
import { clearOutput } from './terminal.js';
import { resetTimer } from './timer.js';
import { showPlanSlide, getPlanSlideCount } from './planReview.js';
import { resetUI } from './renderers.js';


/**
 * Initialize all button event listeners and keyboard shortcuts.
 */
export function initControls() {
    const $ = (/** @type {string} */ id) => document.getElementById(id);

    // ── Execution Controls ──────────────────────────────────────────────────

    $('btn-load')?.addEventListener('click', () => {
        postMessage({ type: 'CMD_LOAD_RUNBOOK' });
    });

    $('btn-start')?.addEventListener('click', () => {
        const btn = $('btn-start');
        if (btn) btn.classList.add('is-loading');
        postMessage({ type: 'CMD_START' });
    });

    $('btn-pause')?.addEventListener('click', () => {
        const btn = $('btn-pause');
        if (btn) btn.classList.add('is-loading');
        postMessage({ type: 'CMD_PAUSE' });
    });

    $('btn-abort')?.addEventListener('click', () => {
        const btn = $('btn-abort');
        if (btn) btn.classList.add('is-loading');
        postMessage({ type: 'CMD_ABORT' });
    });

    $('btn-reset')?.addEventListener('click', () => {
        clearOutput();
        hidTokenBar();
        resetTimer();
        postMessage({ type: 'CMD_RESET' });
    });

    $('btn-new-chat')?.addEventListener('click', () => {
        clearOutput();
        resetTimer();
        resetUI();
        postMessage({ type: 'CMD_RESET' });
    });

    // ── Header Buttons ──────────────────────────────────────────────────────

    $('btn-refresh')?.addEventListener('click', () => {
        postMessage({ type: 'CMD_REQUEST_STATE' });
    });

    // ── History Drawer ──────────────────────────────────────────────────────

    $('btn-history')?.addEventListener('click', () => {
        const drawer = $('history-drawer');
        const controls = $('controls');
        const appBody = document.querySelector('.app-body');
        if (drawer) {
            const isOpen = drawer.style.display !== 'none';
            drawer.style.display = isOpen ? 'none' : 'flex';
            // Hide execution controls and main body when history is open
            if (controls) controls.style.display = isOpen ? 'flex' : 'none';
            if (appBody) /** @type {HTMLElement} */ (appBody).style.display = isOpen ? 'flex' : 'none';
            if (!isOpen) {
                postMessage({ type: 'CMD_LIST_SESSIONS' });
            }
        }
    });

    $('btn-close-history')?.addEventListener('click', () => {
        const drawer = $('history-drawer');
        const controls = $('controls');
        const appBody = document.querySelector('.app-body');
        if (drawer) drawer.style.display = 'none';
        if (controls) controls.style.display = 'flex';
        if (appBody) /** @type {HTMLElement} */ (appBody).style.display = 'flex';
    });

    // ── Session Search (debounced) ──────────────────────────────────────────

    /** @type {ReturnType<typeof setTimeout> | null} */
    let searchTimeout = null;
    $('history-search')?.addEventListener('input', (e) => {
        const query = /** @type {HTMLInputElement} */ (e.target)?.value?.trim();
        if (searchTimeout) clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => {
            if (query) {
                postMessage({ type: 'CMD_SEARCH_SESSIONS', payload: { query } });
            } else {
                postMessage({ type: 'CMD_LIST_SESSIONS' });
            }
        }, 300);
    });

    // ── Planning Controls ───────────────────────────────────────────────────

    $('btn-plan')?.addEventListener('click', () => {
        submitPlan();
    });

    $('btn-plan-approve')?.addEventListener('click', () => {
        if (getAppState().engineState !== 'PLAN_REVIEW') return;
        const btn = /** @type {HTMLButtonElement} */ ($('btn-plan-approve'));
        if (btn?.disabled) return;
        postMessage({ type: 'CMD_PLAN_APPROVE' });
        if (btn) {
            btn.disabled = true;
            btn.textContent = '✓ Approved';
        }
    });

    $('btn-plan-reject')?.addEventListener('click', () => {
        if (getAppState().engineState !== 'PLAN_REVIEW') return;
        const btn = /** @type {HTMLButtonElement} */ ($('btn-plan-reject'));
        if (btn?.disabled) return;
        const $feedback = /** @type {HTMLInputElement} */ ($('plan-feedback'));
        const feedback = $feedback?.value?.trim() || 'Please revise the plan.';
        postMessage({ type: 'CMD_PLAN_REJECT', payload: { feedback } });
        if ($feedback) $feedback.value = '';
        if (btn) {
            btn.disabled = true;
            btn.textContent = '↻ Revising...';
        }
    });

    // ── Carousel Navigation ─────────────────────────────────────────────────

    $('plan-carousel-prev')?.addEventListener('click', () => {
        showPlanSlide(getAppState().planSlideIndex - 1);
    });

    $('plan-carousel-next')?.addEventListener('click', () => {
        showPlanSlide(getAppState().planSlideIndex + 1);
    });

    // ── Keyboard Shortcuts ──────────────────────────────────────────────────

    $('plan-prompt')?.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            submitPlan();
        }
    });

    // Arrow keys for carousel navigation
    document.addEventListener('keydown', (e) => {
        const $planReviewArea = $('plan-review-area');
        if (!$planReviewArea || $planReviewArea.style.display === 'none') return;
        if (getPlanSlideCount() === 0) return;
        if (e.key === 'ArrowLeft') {
            e.preventDefault();
            showPlanSlide(getAppState().planSlideIndex - 1);
        } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            showPlanSlide(getAppState().planSlideIndex + 1);
        }
    });

    // ── Per-Phase Controls ────────────────────────────────────────────────────

    $('btn-phase-pause')?.addEventListener('click', () => {
        const phaseId = Number($('btn-phase-pause')?.dataset?.phaseId);
        if (phaseId) postMessage({ type: 'CMD_PAUSE_PHASE', payload: { phaseId } });
    });

    $('btn-phase-stop')?.addEventListener('click', () => {
        const phaseId = Number($('btn-phase-stop')?.dataset?.phaseId);
        if (phaseId) postMessage({ type: 'CMD_STOP_PHASE', payload: { phaseId } });
    });

    $('btn-phase-restart')?.addEventListener('click', () => {
        const phaseId = Number($('btn-phase-restart')?.dataset?.phaseId);
        if (phaseId) postMessage({ type: 'CMD_RESTART_PHASE', payload: { phaseId } });
    });

    // ── Terminal Clear ────────────────────────────────────────────────────────

    $('btn-clear-output')?.addEventListener('click', () => {
        clearOutput();
    });

    // ── Terminal Resizer ─────────────────────────────────────────────────────
    initResizer();
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Terminal Resizer
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Make the terminal panel resizable by dragging the `.terminal-resizer` element.
 */
function initResizer() {
    const resizer = document.getElementById('terminal-resizer');
    if (!resizer) return;

    const terminal = resizer.nextElementSibling;
    if (!terminal) return;

    let startY = 0;
    let startHeight = 0;

    /** @param {MouseEvent} e */
    function onMouseMove(e) {
        const deltaY = startY - e.clientY;
        const maxHeight = window.innerHeight * 0.6;
        const newHeight = Math.max(80, Math.min(startHeight + deltaY, maxHeight));
        /** @type {HTMLElement} */ (terminal).style.height = `${newHeight}px`;
        /** @type {HTMLElement} */ (terminal).style.flex = 'none';
    }

    function onMouseUp() {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
    }

    resizer.addEventListener('mousedown', (e) => {
        e.preventDefault();
        startY = e.clientY;
        startHeight = /** @type {HTMLElement} */ (terminal).offsetHeight;
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Internal helpers
// ═══════════════════════════════════════════════════════════════════════════════

/** Submit the plan prompt if non-empty. */
function submitPlan() {
    const $planPrompt = /** @type {HTMLTextAreaElement} */ (document.getElementById('plan-prompt'));
    const prompt = $planPrompt?.value?.trim();
    if (!prompt) return;
    postMessage({ type: 'CMD_PLAN_REQUEST', payload: { prompt } });
}

/** Hide the token budget bar. */
function hidTokenBar() {
    const $tokenBar = document.getElementById('token-bar');
    if ($tokenBar) $tokenBar.style.display = 'none';
}

/** Clear the plan prompt textarea. */
function clearPlanPrompt() {
    const $planPrompt = /** @type {HTMLTextAreaElement} */ (document.getElementById('plan-prompt'));
    if ($planPrompt) $planPrompt.value = '';
}
