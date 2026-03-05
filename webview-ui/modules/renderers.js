// ─────────────────────────────────────────────────────────────────────────────
// webview-ui/modules/renderers.js — Core DOM rendering functions
//
// Plan review carousel → planReview.js
// Session history list → sessionList.js
// Shared utilities     → utils.js
// ─────────────────────────────────────────────────────────────────────────────

// @ts-check
/// <reference lib="dom" />

import { getAppState, setAppState, postMessage } from './store.js';
import { startTimer, stopTimer, resetTimer } from './timer.js';
import { renderPhaseList, updatePhaseItemStatus } from './phaseNavigator.js';
import { escapeHtml } from './utils.js';

// Re-export extracted modules for backward compatibility
export { renderPlanDraft, showPlanSlide, getPlanSlideCount, renderPlanStatus } from './planReview.js';
export { renderSessionList } from './sessionList.js';
export { escapeHtml } from './utils.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Map engine state to badge CSS class.
 * @param {string} state
 * @returns {string}
 */
function badgeClass(state) {
    if (state === 'COMPLETED') return 'completed';
    if (state === 'ERROR_PAUSED') return 'error';
    if (state === 'EXECUTING_WORKER' || state === 'EVALUATING') return 'running';
    if (state === 'PLANNING') return 'planning';
    if (state === 'PLAN_REVIEW') return 'review';
    return 'idle';
}

// ═══════════════════════════════════════════════════════════════════════════════
//  State Rendering
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Render a full state snapshot — badges, buttons, panels, sidebar, and phase cards.
 * @param {{ runbook: any, engineState: string }} state
 */
export function renderState(state) {
    const s = state.engineState;
    setAppState({ engineState: s });

    // State badge
    const $stateBadge = document.getElementById('state-badge');
    if ($stateBadge) {
        $stateBadge.textContent = s;
        $stateBadge.className = `badge badge-${badgeClass(s)}`;
    }

    // Panel visibility based on state
    updatePanelVisibility(s);

    // Timer control
    const isRunning = s === 'EXECUTING_WORKER' || s === 'EVALUATING';
    if (isRunning) {
        startTimer();
    } else if (s === 'COMPLETED' || s === 'ERROR_PAUSED' || s === 'IDLE') {
        stopTimer();
    }
    if (s === 'IDLE') {
        resetTimer();
    }

    // Button enable/disable based on state
    updateControlState(s);

    // Dashboard zone 2 — Mission Overview
    renderMissionOverview(state.runbook?.project_id, state.runbook?.phases);

    // Show/hide progress sidebar based on whether we have phases
    const hasPhases = state.runbook?.phases?.length > 0;
    const $progressSidebar = document.getElementById('progress-sidebar');
    if ($progressSidebar) {
        $progressSidebar.style.display = hasPhases ? 'flex' : 'none';
    }

    // Phase cards + progress ring
    if (state.runbook?.phases) {
        setAppState({ phases: state.runbook.phases });

        // Legacy phase cards — only render if backward-compat container exists
        const $phaseList = document.getElementById('phases-container');
        if ($phaseList) {
            renderPhases(state.runbook.phases);
        }

        renderProgressRing(state.runbook.phases);

        // Dashboard zone 3 — Phase Navigator sidebar via phaseNavigator module
        renderPhaseList(state.runbook.phases);

        // Auto-select: prefer first running phase, then first pending, then first
        const phases = state.runbook.phases;
        const runningPhase = phases.find(p => p.status === 'running');
        const pendingPhase = phases.find(p => p.status === 'pending');
        const autoPhase = runningPhase || pendingPhase || phases[0];
        if (autoPhase) {
            setAppState({ selectedPhaseId: autoPhase.id });
            renderPhaseDetails(autoPhase.id);
        }
    }
}

/**
 * Update panel visibility based on engine state.
 * @param {string} state
 */
function updatePanelVisibility(state) {
    // Plan prompt section — visible only in IDLE
    const $planPromptSection = document.getElementById('plan-prompt-section');
    if ($planPromptSection) $planPromptSection.style.display = state === 'IDLE' ? 'flex' : 'none';

    // Plan review panel — visible only in PLAN_REVIEW
    const $planReviewPanel = document.getElementById('plan-review-panel');
    if ($planReviewPanel) $planReviewPanel.style.display = state === 'PLAN_REVIEW' ? 'block' : 'none';

    // Plan status spinner — visible only during PLANNING
    const $planStatus = document.getElementById('plan-status');
    if ($planStatus) $planStatus.style.display = state === 'PLANNING' ? 'flex' : 'none';
}

/**
 * Update button enabled/disabled state and visibility.
 * @param {string} s - Engine state string
 */
function updateControlState(s) {
    const $btnStart = document.getElementById('btn-start');
    const $btnPause = document.getElementById('btn-pause');
    const $btnAbort = document.getElementById('btn-abort');
    const $btnNewChat = document.getElementById('btn-new-chat');
    const $btnReset = document.getElementById('btn-reset');

    const isReady = s === 'READY';
    const isRunning = s === 'EXECUTING_WORKER' || s === 'EVALUATING';
    const isIdle = s === 'IDLE';
    const isCompleted = s === 'COMPLETED';
    const isError = s === 'ERROR_PAUSED';
    const canNewChat = isIdle || isReady || isCompleted || isError;

    if ($btnStart) {
        /** @type {HTMLButtonElement} */ ($btnStart).disabled = !isReady;
        $btnStart.classList.remove('is-loading');
    }
    if ($btnPause) {
        /** @type {HTMLButtonElement} */ ($btnPause).disabled = !isRunning;
        $btnPause.classList.remove('is-loading');
    }
    if ($btnAbort) {
        /** @type {HTMLButtonElement} */ ($btnAbort).disabled = isIdle || isCompleted;
        $btnAbort.classList.remove('is-loading');
    }
    if ($btnNewChat) $btnNewChat.style.display = canNewChat ? 'inline-block' : 'none';
    if ($btnReset) $btnReset.style.display = isCompleted ? 'inline-block' : 'none';
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Progress Ring
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Render the progress ring in the sidebar.
 * Computed from the data model, NOT the DOM.
 * @param {Array<{ id: number, status: string }>} phases
 */
export function renderProgressRing(phases) {
    const $progressRingFill = document.getElementById('progress-ring-fill');
    const $progressLabel = document.getElementById('progress-label');
    const $progressMeta = document.getElementById('progress-meta');
    if (!$progressRingFill || !$progressLabel || !$progressMeta) return;

    const total = phases.length;
    const done = phases.filter(p => p.status === 'completed').length;
    const failed = phases.filter(p => p.status === 'failed').length;
    const running = phases.filter(p => p.status === 'running').length;

    // SVG circle math
    const radius = 24;
    const circumference = 2 * Math.PI * radius;
    const pct = total > 0 ? done / total : 0;
    const offset = circumference * (1 - pct);

    $progressRingFill.style.strokeDasharray = `${circumference}`;
    $progressRingFill.style.strokeDashoffset = `${offset}`;
    $progressRingFill.classList.toggle('complete', done === total && total > 0);

    $progressLabel.textContent = `${done}/${total}`;
    $progressMeta.innerHTML = '';

    if (running > 0) {
        $progressMeta.innerHTML += `<div style="color:var(--accent)">${running} running</div>`;
    }
    if (failed > 0) {
        $progressMeta.innerHTML += `<div style="color:var(--error)">${failed} failed</div>`;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Phase Cards
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Render the full phase list as horizontal cards with staggered entry animations.
 * @param {Array<{ id: number, prompt: string, status: string, context_files: string[] }>} phases
 */
export function renderPhases(phases) {
    const $phases = document.getElementById('phases-container');
    if (!$phases) return;
    $phases.innerHTML = '';

    if (phases.length === 0) {
        $phases.innerHTML = `
            <div class="empty">
                <div class="empty-icon" aria-hidden="true">📋</div>
                <p>No runbook loaded</p>
                <code>.coogent/ipc/&lt;id&gt;/.task-runbook.json</code>
            </div>
        `;
        return;
    }

    phases.forEach((p, index) => {
        const card = document.createElement('div');
        card.className = `phase-card phase-enter ${p.status}`;
        card.dataset.phaseId = String(p.id);
        card.style.animationDelay = `${index * 60}ms`;
        card.title = `Phase ${p.id}: ${p.prompt?.slice(0, 80) || 'No prompt'} — Status: ${p.status}`;

        card.innerHTML = `
            <div class="phase-card-header">
                <span class="phase-id">#${p.id}</span>
                <span class="phase-status-pill ${p.status}">${p.status}</span>
            </div>
            <div class="phase-card-prompt" title="${escapeHtml(p.prompt)}">${escapeHtml(p.prompt)}</div>
            <div class="phase-card-footer">
                <span class="phase-file-count">📄 ${p.context_files.length} files</span>
                <span class="phase-duration" data-phase-dur="${p.id}"></span>
            </div>
            <div class="phase-actions">
                <button class="btn-retry" title="Re-run this phase from scratch">↻ Retry</button>
                <button class="btn-skip" title="Skip this phase and move to the next one">⏭ Skip</button>
            </div>
        `;

        // Inline action buttons for failed phases (replaces window.confirm)
        const btnRetry = card.querySelector('.btn-retry');
        const btnSkip = card.querySelector('.btn-skip');
        btnRetry?.addEventListener('click', (e) => {
            e.stopPropagation();
            postMessage({ type: 'CMD_RETRY', payload: { phaseId: p.id } });
        });
        btnSkip?.addEventListener('click', (e) => {
            e.stopPropagation();
            postMessage({ type: 'CMD_SKIP_PHASE', payload: { phaseId: p.id } });
        });

        $phases.appendChild(card);
    });
}

/**
 * Update a single phase card's status without re-rendering all cards.
 * Scrolls the running phase into view.
 * @param {number} phaseId
 * @param {string} status
 * @param {number} [durationMs]
 */
export function updatePhaseStatus(phaseId, status, durationMs) {
    const $phases = document.getElementById('phases-container');
    if (!$phases) return;

    const card = $phases.querySelector(`[data-phase-id="${phaseId}"]`);
    if (card) {
        // Update card class
        card.className = `phase-card ${status}`;

        // Update status pill
        const pill = card.querySelector('.phase-status-pill');
        if (pill) {
            pill.className = `phase-status-pill ${status}`;
            pill.textContent = status;
        }

        // Update duration
        if (durationMs !== undefined) {
            const durEl = card.querySelector(`[data-phase-dur="${phaseId}"]`);
            if (durEl) {
                const secs = (durationMs / 1000).toFixed(1);
                durEl.textContent = `${secs}s`;
            }
        }

        // Auto-scroll to the running card
        if (status === 'running') {
            card.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        }
    }

    // Re-render progress ring from store data (updated via state)
    // Update our local phases array for the progress ring
    const currentPhases = getAppState().phases.map(p =>
        p.id === phaseId ? { ...p, status } : p
    );
    setAppState({ phases: currentPhases });
    renderProgressRing(currentPhases);

    // Update Phase Navigator sidebar item via phaseNavigator module
    updatePhaseItemStatus(phaseId, status);

    // If the updated phase is the currently selected phase, re-render details
    const selectedId = getAppState().selectedPhaseId;
    if (selectedId === phaseId) {
        renderPhaseDetails(phaseId);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Dashboard Zones — Mission Overview, Phase Details
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Render the mission overview bar (Zone 2).
 * @param {string} [projectId]
 * @param {Array<{ id: number, status: string }>} [phases]
 */
export function renderMissionOverview(projectId, phases) {
    const $overview = document.getElementById('mission-overview');
    const $title = document.getElementById('mission-title');
    const $progress = document.getElementById('mission-progress');
    if (!$overview) return;

    if ($title) $title.textContent = projectId || 'Untitled Mission';

    if (phases && phases.length > 0) {
        const completed = phases.filter(p => p.status === 'completed').length;
        if ($progress) $progress.textContent = `${completed}/${phases.length} phases complete`;
    } else {
        if ($progress) $progress.textContent = 'No phases loaded';
    }

    $overview.style.display = 'block';
}

/**
 * Render the phase details panel (Zone 5).
 * Reads the current state to find the phase with matching id and populates
 * `#phase-details` with prompt, context files, and success criteria.
 * @param {number} phaseId
 */
export function renderPhaseDetails(phaseId) {
    const $details = document.getElementById('phase-details');
    if (!$details) return;

    const phases = getAppState().phases;
    const phase = phases.find(p => p.id === phaseId);

    if (!phase) {
        $details.innerHTML = `<div class="phase-details-placeholder">Select a phase from the navigator.</div>`;
        $details.style.display = 'flex';
        return;
    }

    const promptPreview = phase.prompt
        ? (phase.prompt.length > 80 ? phase.prompt.slice(0, 80) + '…' : phase.prompt)
        : '';

    $details.innerHTML = `
        <h3>Phase ${phase.id + 1}: ${escapeHtml(promptPreview)}</h3>
        <div class="phase-prompt-full">${escapeHtml(phase.prompt || '')}</div>
        <div class="phase-context-files">
            ${(phase.context_files || []).map(
        (/** @type {string} */ f) => `<span class="file-chip">${escapeHtml(f)}</span>`
    ).join('')}
        </div>
        <div class="phase-success-criteria">${escapeHtml(phase.success_criteria || 'exit_code:0')}</div>
    `;
    $details.style.display = 'flex';
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Full UI Reset (New Chat)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Reset the entire UI to the clean IDLE state.
 * Called when the user clicks "+ New Chat" so every section is torn down
 * immediately — before the backend round-trip completes.
 */
export function resetUI() {
    // ── Store ────────────────────────────────────────────────────────────────
    setAppState({
        engineState: 'IDLE',
        phases: [],
        selectedPhaseId: null,
        projectId: '',
        planDraft: null,
        planSlideIndex: 0,
    });

    // ── Zone 1: Header badge ─────────────────────────────────────────────────
    const $stateBadge = document.getElementById('state-badge');
    if ($stateBadge) {
        $stateBadge.textContent = 'IDLE';
        $stateBadge.className = 'badge badge-idle';
    }

    // ── Zone 2: Mission Overview ─────────────────────────────────────────────
    const $overview = document.getElementById('mission-overview');
    const $missionTitle = document.getElementById('mission-title');
    const $missionProgress = document.getElementById('mission-progress');
    if ($overview) $overview.style.display = 'none';
    if ($missionTitle) $missionTitle.textContent = 'No mission loaded';
    if ($missionProgress) $missionProgress.textContent = '';

    // ── Zone 3: Phase Navigator ──────────────────────────────────────────────
    const $phaseNavigator = document.getElementById('phase-navigator');
    if ($phaseNavigator) {
        // Keep the nav-header, clear only the phase items
        const items = $phaseNavigator.querySelectorAll('.phase-item');
        items.forEach(item => item.remove());
    }

    // ── Zone 4: Progress sidebar / ring ──────────────────────────────────────
    const $progressSidebar = document.getElementById('progress-sidebar');
    if ($progressSidebar) $progressSidebar.style.display = 'none';
    renderProgressRing([]);

    // ── Zone 5: Phase Details ────────────────────────────────────────────────
    const $details = document.getElementById('phase-details');
    if ($details) {
        $details.innerHTML = '<p class="placeholder-text">Select a phase from the navigator.</p>';
    }

    // ── Phase Cards (legacy container) ───────────────────────────────────────
    const $phasesContainer = document.getElementById('phases-container');
    if ($phasesContainer) $phasesContainer.innerHTML = '';

    // ── Plan Review Panel ────────────────────────────────────────────────────
    const $planReviewPanel = document.getElementById('plan-review-panel');
    if ($planReviewPanel) $planReviewPanel.style.display = 'none';

    const $planStatus = document.getElementById('plan-status');
    if ($planStatus) {
        $planStatus.style.display = 'none';
        $planStatus.textContent = '';
    }

    const $planCarousel = document.getElementById('plan-carousel');
    if ($planCarousel) $planCarousel.innerHTML = '';

    // ── Plan Prompt Section — make visible (IDLE state) ──────────────────────
    const $planPromptSection = document.getElementById('plan-prompt-section');
    if ($planPromptSection) $planPromptSection.style.display = 'flex';

    const $planPrompt = /** @type {HTMLTextAreaElement} */ (document.getElementById('plan-prompt'));
    if ($planPrompt) $planPrompt.value = '';

    // ── History Drawer — close if open ───────────────────────────────────────
    const $historyDrawer = document.getElementById('history-drawer');
    if ($historyDrawer) $historyDrawer.style.display = 'none';

    // ── Restore main layout (hidden when history drawer was open) ────────────
    const $appBody = document.querySelector('.app-body');
    if ($appBody) /** @type {HTMLElement} */ ($appBody).style.display = 'flex';
    const $controls = document.getElementById('controls');
    if ($controls) $controls.style.display = 'flex';

    // ── Token Bar ────────────────────────────────────────────────────────────
    const $tokenBar = document.getElementById('token-bar');
    if ($tokenBar) $tokenBar.style.display = 'none';

    // ── Control buttons — reset to IDLE state ────────────────────────────────
    updateControlState('IDLE');
}
