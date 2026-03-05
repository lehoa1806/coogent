// ─────────────────────────────────────────────────────────────────────────────
// webview-ui/main.js — Mission Control entry point
//
// Thin orchestrator that wires together modules and routes messages.
// All business logic lives in the modules/ directory.
// ─────────────────────────────────────────────────────────────────────────────

// @ts-check
/// <reference lib="dom" />

import { initStore, postMessage, getAppState, setAppState, appendPhaseOutput } from './modules/store.js';
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
    showReportModal,
    markdownToHtml,
    renderPhaseDetails,
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

    // #56: Each case body is wrapped in try/catch to prevent individual
    // handler errors from crashing the entire webview message router.
    switch (msg.type) {
        case 'STATE_SNAPSHOT':
            try {
                renderState(msg.payload);
                renderPhaseList(msg.payload.runbook?.phases || []);
                // Hydrate master task section from runbook summary if available
                if (msg.payload.runbook?.summary) {
                    const $masterSection = document.getElementById('master-task-section');
                    const $masterSummary = document.getElementById('master-task-summary');
                    if ($masterSection) $masterSection.style.display = 'block';
                    if ($masterSummary) $masterSummary.textContent = msg.payload.runbook.summary;
                }
            } catch (err) { console.error('[main] STATE_SNAPSHOT handler error:', err); }
            break;

        case 'PHASE_STATUS':
            try {
                updatePhaseStatus(msg.payload.phaseId, msg.payload.status, msg.payload.durationMs);
            } catch (err) { console.error('[main] PHASE_STATUS handler error:', err); }
            break;

        case 'WORKER_OUTPUT':
            try {
                // Global terminal (fallback / debug view)
                appendOutput(msg.payload.chunk, msg.payload.stream);
                // Per-phase store accumulation
                if (msg.payload.phaseId != null) {
                    appendPhaseOutput(msg.payload.phaseId, msg.payload.chunk);
                    // Live-update the phase detail terminal if this phase is selected
                    if (getAppState().selectedPhaseId === msg.payload.phaseId) {
                        const $phaseTerminal = document.getElementById('phase-output-terminal');
                        if ($phaseTerminal) {
                            $phaseTerminal.textContent += msg.payload.chunk;
                        }
                    }
                }
            } catch (err) { console.error('[main] WORKER_OUTPUT handler error:', err); }
            break;

        case 'TOKEN_BUDGET':
            try {
                renderTokenBudget(msg.payload);
                // Store token budget per-phase for Phase Details panel (#BUG-4)
                if (msg.payload.phaseId != null) {
                    const budgets = { ...getAppState().phaseTokenBudgets };
                    budgets[msg.payload.phaseId] = {
                        totalTokens: msg.payload.totalTokens,
                        limit: msg.payload.limit,
                        fileCount: msg.payload.breakdown.length,
                    };
                    setAppState({ phaseTokenBudgets: budgets });
                    // Re-render phase details if this phase is currently selected
                    if (getAppState().selectedPhaseId === msg.payload.phaseId) {
                        renderPhaseDetails(msg.payload.phaseId);
                    }
                }
            } catch (err) { console.error('[main] TOKEN_BUDGET handler error:', err); }
            break;

        case 'ERROR':
            try {
                appendOutput(`[ERROR] ${msg.payload.message}\n`, 'stderr');
                // Show inline banner for GIT_DIRTY errors so the user sees
                // the error even when the terminal is hidden during IDLE.
                if (msg.payload.code === 'GIT_DIRTY') {
                    const $banner = document.getElementById('git-error-banner');
                    if ($banner) {
                        $banner.textContent = msg.payload.message;
                        $banner.style.display = 'block';
                    }
                    // Keep the plan prompt visible so the user sees the error in context
                    const $planPromptSection = document.getElementById('plan-prompt-section');
                    if ($planPromptSection) $planPromptSection.style.display = 'flex';
                }
            } catch (err) { console.error('[main] ERROR handler error:', err); }
            break;

        case 'LOG_ENTRY':
            try {
                appendOutput(
                    `[${msg.payload.level.toUpperCase()}] ${msg.payload.message}\n`,
                    msg.payload.level === 'error' ? 'stderr' : 'stdout'
                );
            } catch (err) { console.error('[main] LOG_ENTRY handler error:', err); }
            break;

        case 'PLAN_DRAFT':
            try {
                renderPlanDraft(msg.payload.draft, msg.payload.fileTree);
            } catch (err) { console.error('[main] PLAN_DRAFT handler error:', err); }
            break;

        case 'PLAN_STATUS':
            try {
                renderPlanStatus(msg.payload.status, msg.payload.message);
                if (msg.payload.status === 'error') {
                    appendOutput(`[PLAN ERROR] ${msg.payload.message || 'Planning failed'}\n`, 'stderr');
                }
            } catch (err) { console.error('[main] PLAN_STATUS handler error:', err); }
            break;

        case 'SESSION_LIST':
        case 'SESSION_SEARCH_RESULTS':
            try {
                renderSessionList(msg.payload.sessions);
            } catch (err) { console.error('[main] SESSION handler error:', err); }
            break;

        case 'CONSOLIDATION_REPORT':
            try {
                showReportModal(msg.payload.report);
                // Also populate the global terminal with the report text
                const $terminalOutput = document.getElementById('output');
                if ($terminalOutput) {
                    $terminalOutput.textContent = msg.payload.report;
                }
                // Ensure terminal panel is visible and styled for reporting
                const $terminalPanel = document.querySelector('.terminal-panel');
                if ($terminalPanel) {
                    /** @type {HTMLElement} */ ($terminalPanel).style.display = '';
                    $terminalPanel.classList.add('reporting');
                }
            } catch (err) { console.error('[main] CONSOLIDATION_REPORT handler error:', err); }
            break;

        case 'CONVERSATION_MODE':
            try {
                updateConversationModeUI(msg.payload.mode);
            } catch (err) { console.error('[main] CONVERSATION_MODE handler error:', err); }
            break;

        case 'PLAN_SUMMARY':
            try {
                setAppState({ masterSummary: msg.payload.summary, implementationPlan: msg.payload.implementationPlan });
                const $masterSection = document.getElementById('master-task-section');
                const $masterSummary = document.getElementById('master-task-summary');
                const $masterPlan = document.getElementById('master-task-plan');
                if ($masterSection) $masterSection.style.display = 'block';
                if ($masterSummary) $masterSummary.textContent = msg.payload.summary;
                // Render implementation plan as HTML (#BUG-2)
                if ($masterPlan && msg.payload.implementationPlan) {
                    $masterPlan.innerHTML = markdownToHtml(msg.payload.implementationPlan);
                }
                // Wire toggle button (idempotent — only attach once)
                const $btnToggle = document.getElementById('btn-toggle-plan');
                if ($btnToggle && $masterPlan && !$btnToggle.dataset.wired) {
                    $btnToggle.dataset.wired = 'true';
                    $btnToggle.style.display = msg.payload.implementationPlan ? 'inline-block' : 'none';
                    $btnToggle.addEventListener('click', () => {
                        $masterPlan.style.display = $masterPlan.style.display === 'none' ? 'block' : 'none';
                    });
                }
            } catch (err) { console.error('[main] PLAN_SUMMARY handler error:', err); }
            break;

        case 'PHASE_OUTPUT':
            try {
                appendPhaseOutput(msg.payload.phaseId, msg.payload.chunk);
                if (getAppState().selectedPhaseId === msg.payload.phaseId) {
                    const $phaseTerminal = document.getElementById('phase-output-terminal');
                    if ($phaseTerminal) {
                        $phaseTerminal.textContent += msg.payload.chunk;
                    }
                }
            } catch (err) { console.error('[main] PHASE_OUTPUT handler error:', err); }
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
