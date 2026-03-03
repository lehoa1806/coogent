// ─────────────────────────────────────────────────────────────────────────────
// webview-ui/main.js — Mission Control frontend logic
// ─────────────────────────────────────────────────────────────────────────────

// @ts-check
/// <reference lib="dom" />

const vscode = acquireVsCodeApi();

// ═══════════════════════════════════════════════════════════════════════════════
//  DOM References
// ═══════════════════════════════════════════════════════════════════════════════

const $ = (/** @type {string} */ sel) => document.getElementById(sel);

const $stateBadge = $('state-badge');
const $phases = $('phases-container');
const $output = $('output');
const $tokenBar = $('token-bar');
const $tokenFill = $('token-fill');
const $tokenLabel = $('token-label');
const $btnLoad = $('btn-load');
const $btnStart = $('btn-start');
const $btnPause = $('btn-pause');
const $btnAbort = $('btn-abort');
const $btnReset = $('btn-reset');
const $btnNewChat = $('btn-new-chat');
const $btnScrollBottom = $('btn-scroll-bottom');

// Planning panel
const $planningPanel = $('planning-panel');
const $planInputArea = $('plan-input-area');
const $planPrompt = $('plan-prompt');
const $btnPlan = $('btn-plan');
const $planSpinner = $('plan-spinner');
const $planSpinnerText = $('plan-spinner-text');
const $planReviewArea = $('plan-review-area');
const $planReviewPhases = $('plan-review-phases');
const $btnPlanApprove = $('btn-plan-approve');
const $btnPlanReject = $('btn-plan-reject');
const $planFeedback = $('plan-feedback');

// Progress sidebar
const $progressRingFill = $('progress-ring-fill');
const $progressLabel = $('progress-label');
const $progressMeta = $('progress-meta');
const $elapsedTime = $('elapsed-time');
const $progressSidebar = $('progress-sidebar');

// ═══════════════════════════════════════════════════════════════════════════════
//  Elapsed Timer
// ═══════════════════════════════════════════════════════════════════════════════

let elapsedInterval = null;
let elapsedSeconds = 0;

function startTimer() {
    if (elapsedInterval) return;
    elapsedInterval = setInterval(() => {
        elapsedSeconds++;
        renderElapsed();
    }, 1000);
}

function stopTimer() {
    if (elapsedInterval) {
        clearInterval(elapsedInterval);
        elapsedInterval = null;
    }
}

function resetTimer() {
    stopTimer();
    elapsedSeconds = 0;
    renderElapsed();
}

function renderElapsed() {
    if (!$elapsedTime) return;
    const m = Math.floor(elapsedSeconds / 60);
    const s = elapsedSeconds % 60;
    $elapsedTime.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Button Handlers
// ═══════════════════════════════════════════════════════════════════════════════

$btnLoad?.addEventListener('click', () => {
    vscode.postMessage({ type: 'CMD_LOAD_RUNBOOK' });
});

$btnStart?.addEventListener('click', () => {
    vscode.postMessage({ type: 'CMD_START' });
});

$btnPause?.addEventListener('click', () => {
    vscode.postMessage({ type: 'CMD_PAUSE' });
});

$btnAbort?.addEventListener('click', () => {
    vscode.postMessage({ type: 'CMD_ABORT' });
});

$btnReset?.addEventListener('click', () => {
    if ($output) $output.textContent = 'Waiting for execution...\n';
    if ($tokenBar) $tokenBar.style.display = 'none';
    resetTimer();
    vscode.postMessage({ type: 'CMD_RESET' });
});

$btnNewChat?.addEventListener('click', () => {
    if ($output) $output.textContent = 'Waiting for execution...\n';
    if ($tokenBar) $tokenBar.style.display = 'none';
    if ($planPrompt) /** @type {HTMLTextAreaElement} */ ($planPrompt).value = '';
    resetTimer();
    vscode.postMessage({ type: 'CMD_RESET' });
});

// Planning buttons
$btnPlan?.addEventListener('click', () => {
    submitPlan();
});

$btnPlanApprove?.addEventListener('click', () => {
    vscode.postMessage({ type: 'CMD_PLAN_APPROVE' });
});

$btnPlanReject?.addEventListener('click', () => {
    const feedback = /** @type {HTMLInputElement} */ ($planFeedback)?.value?.trim() || 'Please try again with a different approach.';
    vscode.postMessage({ type: 'CMD_PLAN_REJECT', payload: { feedback } });
    if ($planFeedback) /** @type {HTMLInputElement} */ ($planFeedback).value = '';
});

// Scroll-to-bottom button
$btnScrollBottom?.addEventListener('click', () => {
    if ($output) $output.scrollTop = $output.scrollHeight;
});

// Terminal scroll detection
$output?.addEventListener('scroll', () => {
    if (!$output || !$btnScrollBottom) return;
    const atBottom = ($output.scrollHeight - $output.scrollTop - $output.clientHeight) < 40;
    $btnScrollBottom.classList.toggle('visible', !atBottom);
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Keyboard Shortcuts
// ═══════════════════════════════════════════════════════════════════════════════

$planPrompt?.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        submitPlan();
    }
});

/** Submit the plan prompt if non-empty. */
function submitPlan() {
    const prompt = /** @type {HTMLTextAreaElement} */ ($planPrompt)?.value?.trim();
    if (!prompt) return;
    vscode.postMessage({ type: 'CMD_PLAN_REQUEST', payload: { prompt } });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Message Handler — Extension Host → Webview
// ═══════════════════════════════════════════════════════════════════════════════

window.addEventListener('message', (event) => {
    const msg = event.data;

    switch (msg.type) {
        case 'STATE_SNAPSHOT':
            renderState(msg.payload);
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
            appendOutput(`[${msg.payload.level.toUpperCase()}] ${msg.payload.message}\n`, msg.payload.level === 'error' ? 'stderr' : 'stdout');
            break;

        case 'PLAN_DRAFT':
            renderPlanDraft(msg.payload.draft, msg.payload.fileTree);
            break;

        case 'PLAN_STATUS':
            renderPlanStatus(msg.payload.status, msg.payload.message);
            break;
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Renderers
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Render a full state snapshot — badges, buttons, panels, sidebar, and phase cards.
 * @param {{ runbook: any, engineState: string }} state
 */
function renderState(state) {
    const s = state.engineState;

    // State badge
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
    const isReady = s === 'READY';
    const isIdle = s === 'IDLE';
    const isCompleted = s === 'COMPLETED';
    const isError = s === 'ERROR_PAUSED';
    const canNewChat = isIdle || isReady || isCompleted || isError;

    if ($btnStart) $btnStart.disabled = !isReady;
    if ($btnPause) $btnPause.disabled = !isRunning;
    if ($btnAbort) $btnAbort.disabled = isIdle || isCompleted;
    if ($btnNewChat) $btnNewChat.style.display = canNewChat ? 'inline-block' : 'none';
    if ($btnReset) $btnReset.style.display = isCompleted ? 'inline-block' : 'none';

    // Show/hide progress sidebar based on whether we have phases
    const hasPhases = state.runbook?.phases?.length > 0;
    if ($progressSidebar) {
        $progressSidebar.style.display = hasPhases ? 'flex' : 'none';
    }

    // Phase cards + progress ring
    if (state.runbook?.phases) {
        renderPhases(state.runbook.phases);
        renderProgressRing(state.runbook.phases);
    }
}

/**
 * Update panel visibility based on engine state.
 * @param {string} state
 */
function updatePanelVisibility(state) {
    const isPlanningPhase = state === 'IDLE' || state === 'PLANNING' || state === 'PLAN_REVIEW';

    if ($planningPanel) {
        $planningPanel.style.display = isPlanningPhase ? 'block' : 'none';
    }

    if ($planInputArea) {
        $planInputArea.style.display = state === 'IDLE' ? 'block' : 'none';
    }

    if ($planSpinner) {
        $planSpinner.style.display = state === 'PLANNING' ? 'flex' : 'none';
    }

    if ($planReviewArea) {
        $planReviewArea.style.display = state === 'PLAN_REVIEW' ? 'block' : 'none';
    }
}

/**
 * Render the progress ring in the sidebar.
 * @param {Array<{ id: number, status: string }>} phases
 */
function renderProgressRing(phases) {
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

/**
 * Render the plan draft for user review.
 * @param {any} draft
 * @param {string[]} fileTree
 */
function renderPlanDraft(draft, fileTree) {
    if (!$planReviewPhases) return;
    $planReviewPhases.innerHTML = '';

    if (!draft?.phases) return;

    // Project ID header
    const header = document.createElement('div');
    header.className = 'plan-project-id';
    header.textContent = `Project: ${draft.project_id || 'untitled'}`;
    $planReviewPhases.appendChild(header);

    // Render each phase as a review card
    draft.phases.forEach((/** @type {any} */ p) => {
        const card = document.createElement('div');
        card.className = 'plan-review-card';
        card.innerHTML = `
            <div class="plan-card-header">
                <span class="phase-id">#${p.id}</span>
                <span class="plan-card-files">${(p.context_files || []).length} context files</span>
            </div>
            <div class="plan-card-prompt">${escapeHtml(p.prompt)}</div>
            ${(p.context_files || []).length > 0 ? `
            <div class="plan-card-context">
                ${p.context_files.map((/** @type {string} */ f) => `<code>${escapeHtml(f)}</code>`).join(' ')}
            </div>` : ''}
            <div class="plan-card-criteria">
                <span>Success: <code>${escapeHtml(p.success_criteria || 'exit_code:0')}</code></span>
            </div>
        `;
        $planReviewPhases.appendChild(card);
    });
}

/**
 * Update the planning spinner status.
 * @param {'generating' | 'parsing' | 'ready' | 'error'} status
 * @param {string} [message]
 */
function renderPlanStatus(status, message) {
    if ($planSpinnerText && message) {
        $planSpinnerText.textContent = message;
    }

    if (status === 'error') {
        if ($planSpinner) $planSpinner.style.display = 'none';
        if ($planInputArea) $planInputArea.style.display = 'block';
        appendOutput(`[PLAN ERROR] ${message || 'Planning failed'}\n`, 'stderr');
    }
}

/**
 * Render the full phase list as horizontal cards with staggered entry animations.
 * @param {Array<{ id: number, prompt: string, status: string, context_files: string[] }>} phases
 */
function renderPhases(phases) {
    if (!$phases) return;
    $phases.innerHTML = '';

    if (phases.length === 0) {
        $phases.innerHTML = `
            <div class="empty">
                <div class="empty-icon" aria-hidden="true">📋</div>
                <p>No runbook loaded</p>
                <code>.isolated_agent/ipc/&lt;id&gt;/.task-runbook.json</code>
            </div>
        `;
        return;
    }

    phases.forEach((p, index) => {
        const card = document.createElement('div');
        card.className = `phase-card phase-enter ${p.status}`;
        card.dataset.phaseId = String(p.id);
        card.style.animationDelay = `${index * 60}ms`;

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
        `;

        // Right-click context menu for retry/skip on failed phases
        card.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            if (p.status === 'failed') {
                const action = confirm(`Phase #${p.id} failed.\n\nOK = Retry\nCancel = Skip`);
                if (action) {
                    vscode.postMessage({ type: 'CMD_RETRY', payload: { phaseId: p.id } });
                } else {
                    vscode.postMessage({ type: 'CMD_SKIP_PHASE', payload: { phaseId: p.id } });
                }
            }
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
function updatePhaseStatus(phaseId, status, durationMs) {
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

    // Re-render progress ring from current DOM state
    const allCards = $phases.querySelectorAll('.phase-card');
    const phases = Array.from(allCards).map(c => ({
        id: Number(c.dataset.phaseId),
        status: c.querySelector('.phase-status-pill')?.textContent || 'pending',
    }));
    renderProgressRing(phases);
}

/**
 * Append text to the output terminal.
 * @param {string} text
 * @param {'stdout' | 'stderr'} stream
 */
function appendOutput(text, stream) {
    if (!$output) return;

    const span = document.createElement('span');
    if (stream === 'stderr') span.className = 'stderr';
    span.textContent = text;
    $output.appendChild(span);

    // Truncate if over 5000 lines
    const maxNodes = 5000;
    while ($output.childNodes.length > maxNodes) {
        $output.removeChild($output.firstChild);
    }

    // Auto-scroll to bottom (only if user is near bottom)
    const atBottom = ($output.scrollHeight - $output.scrollTop - $output.clientHeight) < 80;
    if (atBottom) {
        $output.scrollTop = $output.scrollHeight;
    }
}

/**
 * Render the token budget progress bar.
 * @param {{ totalTokens: number, limit: number, breakdown: Array<{ path: string, tokens: number }> }} data
 */
function renderTokenBudget(data) {
    if (!$tokenBar || !$tokenFill || !$tokenLabel) return;

    $tokenBar.style.display = 'block';
    const pct = Math.min(100, (data.totalTokens / data.limit) * 100);

    $tokenFill.style.width = `${pct}%`;
    $tokenFill.style.background =
        pct > 90 ? 'var(--error)' :
            pct > 70 ? 'var(--warning)' :
                'linear-gradient(90deg, var(--accent-dim), var(--accent))';

    $tokenLabel.textContent =
        `${data.totalTokens.toLocaleString()} / ${data.limit.toLocaleString()} tokens (${Math.round(pct)}%) · ${data.breakdown.length} files`;
}

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

/**
 * Escape HTML entities to prevent XSS in rendered content.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Initialization
// ═══════════════════════════════════════════════════════════════════════════════

renderElapsed();

// Request initial state snapshot on load
vscode.postMessage({ type: 'CMD_REQUEST_STATE' });
