// ─────────────────────────────────────────────────────────────────────────────
// webview-ui/main.js — Mission Control entry point
//
// Thin orchestrator that wires together modules and routes messages.
// All business logic lives in the modules/ directory.
// ─────────────────────────────────────────────────────────────────────────────

// @ts-check
/// <reference lib="dom" />

import { initStore, postMessage } from './modules/store.js';
import { initTimer } from './modules/timer.js';
import { initTerminal, appendOutput, renderTokenBudget } from './modules/terminal.js';
import { initControls } from './modules/controls.js';
import { initPhaseNavigator, renderPhaseList } from './modules/phaseNavigator.js';
import {
    renderPlanDraft,
    renderPlanStatus,
} from './modules/planReview.js';
import { renderSessionList } from './modules/sessionList.js';
import {
    renderState,
    updatePhaseStatus,
} from './modules/renderers.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Bootstrap
// ═══════════════════════════════════════════════════════════════════════════════

// 1. Acquire the VS Code API handle (singleton — must be called exactly once)
const vscode = acquireVsCodeApi();

// 2. Initialize the state store and hydrate from persisted state
initStore(vscode);

// 3. Initialize sub-modules
initTimer();
initTerminal();
initControls();
initPhaseNavigator();
initConversationModeToggle();

// ═══════════════════════════════════════════════════════════════════════════════
//  Message Router — Extension Host → Webview
// ═══════════════════════════════════════════════════════════════════════════════

window.addEventListener('message', (event) => {
    const msg = event.data;

    switch (msg.type) {
        case 'STATE_SNAPSHOT':
            renderState(msg.payload);
            renderPhaseList(msg.payload.runbook?.phases || []);
            break;

        case 'PHASE_STATUS':
            updatePhaseStatus(msg.payload.phaseId, msg.payload.status, msg.payload.durationMs);
            break;

        case 'WORKER_OUTPUT':
            appendOutput(msg.payload.chunk, msg.payload.stream);
            break;

        case 'TOKEN_BUDGET':
            renderTokenBudget(msg.payload);
            break;

        case 'ERROR':
            appendOutput(`[ERROR] ${msg.payload.message}\n`, 'stderr');
            break;

        case 'LOG_ENTRY':
            appendOutput(
                `[${msg.payload.level.toUpperCase()}] ${msg.payload.message}\n`,
                msg.payload.level === 'error' ? 'stderr' : 'stdout'
            );
            break;

        case 'PLAN_DRAFT':
            renderPlanDraft(msg.payload.draft, msg.payload.fileTree);
            break;

        case 'PLAN_STATUS':
            renderPlanStatus(msg.payload.status, msg.payload.message);
            if (msg.payload.status === 'error') {
                appendOutput(`[PLAN ERROR] ${msg.payload.message || 'Planning failed'}\n`, 'stderr');
            }
            break;

        case 'SESSION_LIST':
        case 'SESSION_SEARCH_RESULTS':
            renderSessionList(msg.payload.sessions);
            break;

        case 'CONVERSATION_MODE':
            updateConversationModeUI(msg.payload.mode);
            break;
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Request initial state snapshot from the Extension Host
// ═══════════════════════════════════════════════════════════════════════════════

postMessage({ type: 'CMD_REQUEST_STATE' });

// ═══════════════════════════════════════════════════════════════════════════════
//  Conversation Mode Toggle
// ═══════════════════════════════════════════════════════════════════════════════

function initConversationModeToggle() {
    const buttons = document.querySelectorAll('.mode-btn');
    buttons.forEach(btn => {
        btn.addEventListener('click', () => {
            const mode = btn.getAttribute('data-mode');
            if (!mode) return;
            postMessage({ type: 'CMD_SET_CONVERSATION_MODE', payload: { mode } });
            // Optimistic UI update
            updateConversationModeUI(mode);
        });
    });
}

function updateConversationModeUI(activeMode) {
    const buttons = document.querySelectorAll('.mode-btn');
    buttons.forEach(btn => {
        const mode = btn.getAttribute('data-mode');
        btn.classList.toggle('active', mode === activeMode);
    });
}
