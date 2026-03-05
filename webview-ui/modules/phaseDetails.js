// ─────────────────────────────────────────────────────────────────────────────
// webview-ui/modules/phaseDetails.js — Phase Details panel renderer
//
// Extracted from renderers.js to break the circular dependency:
//   renderers.js → phaseNavigator.js → renderers.js
// Now: renderers.js → phaseNavigator.js → phaseDetails.js
// ─────────────────────────────────────────────────────────────────────────────

// @ts-check
/// <reference lib="dom" />

import { getAppState, postMessage } from './store.js';
import { escapeHtml, formatDuration } from './utils.js';
import { createMarkdownContainer, attachMarkdownToggleHandlers, renderMermaidBlocks } from './markdown.js';

/**
 * Build the action buttons HTML for a phase based on its status.
 * - failed  → Retry + Restart + Skip
 * - completed → Restart only
 * - other   → nothing
 * @param {{ id: number, status: string }} phase
 * @returns {string}
 */
function buildActionButtons(phase) {
    const status = (phase.status || '').toLowerCase();

    if (status === 'failed') {
        return `
            <div class="phase-actions-bar">
                <button class="phase-action-btn retry" data-action="retry" data-phase-id="${phase.id}"
                        title="Re-run this phase (keeps error context for self-healing)">↻ Retry</button>
                <button class="phase-action-btn restart" data-action="restart" data-phase-id="${phase.id}"
                        title="Reset and re-run from scratch (clears attempt history)">🔄 Restart</button>
                <button class="phase-action-btn skip" data-action="skip" data-phase-id="${phase.id}"
                        title="Skip this phase and move to the next one">⏭ Skip</button>
            </div>
        `;
    }

    if (status === 'completed') {
        return `
            <div class="phase-actions-bar">
                <button class="phase-action-btn restart" data-action="restart" data-phase-id="${phase.id}"
                        title="Reset and re-run from scratch">🔄 Restart</button>
            </div>
        `;
    }

    return '';
}

/**
 * Build the dependencies section HTML for a phase.
 * Shows which phases this phase depends on (`depends_on`).
 * @param {{ id: number, depends_on?: number[] }} phase
 * @param {Array<{ id: number, prompt: string }>} allPhases
 * @returns {string}
 */
function buildDependenciesSection(phase, allPhases) {
    const deps = phase.depends_on;
    if (!deps || deps.length === 0) return '';

    const badges = deps.map(depId => {
        const depIndex = allPhases.findIndex(p => p.id === depId);
        const label = depIndex >= 0 ? depIndex + 1 : depId;
        const depPhase = allPhases.find(p => p.id === depId);
        const tooltip = depPhase ? escapeHtml(depPhase.prompt || '').slice(0, 60) : '';
        return `<span class="dep-badge" title="Phase ${label}: ${tooltip}">#${label}</span>`;
    }).join('');

    return `
        <div class="phase-detail-section">
            <h4>Dependencies</h4>
            <div class="phase-deps-row">${badges}</div>
        </div>
    `;
}

/**
 * Build the dependents section HTML for a phase.
 * Shows which phases depend on this phase (reverse-lookup).
 * @param {{ id: number }} phase
 * @param {Array<{ id: number, prompt: string, depends_on?: number[] }>} allPhases
 * @returns {string}
 */
function buildDependentsSection(phase, allPhases) {
    const dependents = allPhases.filter(
        p => p.depends_on && p.depends_on.includes(phase.id)
    );
    if (dependents.length === 0) return '';

    const badges = dependents.map(dep => {
        const depIndex = allPhases.findIndex(p => p.id === dep.id);
        const label = depIndex >= 0 ? depIndex + 1 : dep.id;
        const tooltip = escapeHtml(dep.prompt || '').slice(0, 60);
        return `<span class="dep-badge dependent" title="Phase ${label}: ${tooltip}">#${label}</span>`;
    }).join('');

    return `
        <div class="phase-detail-section">
            <h4>Dependents</h4>
            <div class="phase-dependents-row">${badges}</div>
        </div>
    `;
}

/**
 * Attach click handlers to action buttons inside a container.
 * Uses event delegation on the `.phase-actions-bar` element.
 * @param {HTMLElement} container
 */
function attachActionHandlers(container) {
    const bar = container.querySelector('.phase-actions-bar');
    if (!bar) return;

    bar.addEventListener('click', (e) => {
        const btn = /** @type {HTMLElement} */ (e.target).closest('.phase-action-btn');
        if (!btn) return;

        const action = btn.getAttribute('data-action');
        const phaseId = Number(btn.getAttribute('data-phase-id'));
        if (Number.isNaN(phaseId)) return;

        switch (action) {
            case 'retry':
                postMessage({ type: 'CMD_RETRY', payload: { phaseId } });
                break;
            case 'restart':
                postMessage({ type: 'CMD_RESTART_PHASE', payload: { phaseId } });
                break;
            case 'skip':
                postMessage({ type: 'CMD_SKIP_PHASE', payload: { phaseId } });
                break;
        }
    });
}

/**
 * Build the Previous Context / Handoff Data section.
 * Shows a compact summary of what was handed off from completed dependency phases.
 * @param {{ id: number, depends_on?: number[] }} phase
 * @param {Array<{ id: number, prompt: string, status: string }>} allPhases
 * @returns {string}
 */
function buildHandoffContextSection(phase, allPhases) {
    const deps = phase.depends_on;
    if (!deps || deps.length === 0) return '';

    const completedDeps = deps
        .map(depId => allPhases.find(p => p.id === depId))
        .filter(p => p && (p.status || '').toLowerCase() === 'completed');

    if (completedDeps.length === 0) return '';

    const lines = completedDeps.map(dep => {
        const depIndex = allPhases.findIndex(p => p.id === dep.id);
        const label = depIndex >= 0 ? depIndex + 1 : dep.id;
        const snippet = escapeHtml((dep.prompt || '').slice(0, 100));
        return `<div class="handoff-line">Phase #${label} (done): ${snippet}</div>`;
    }).join('');

    return `
        <div class="phase-detail-section">
            <h4>Previous Context</h4>
            <div class="phase-context-summary" id="phase-handoff-context">
                ${lines}
            </div>
        </div>
    `;
}

/**
 * Build the Context Summary section.
 * Shows the AI-generated summary explaining what this phase does and why.
 * @param {{ context_summary?: string }} phase
 * @returns {string}
 */
function buildContextSummarySection(phase) {
    if (!phase.context_summary) return '';

    return `
        <div class="phase-detail-section">
            <h4>Context Summary</h4>
            <div class="phase-context-summary">${escapeHtml(phase.context_summary)}</div>
        </div>
    `;
}

/**
 * Build the Worker Output section — a mini terminal scoped to this phase.
 * Reads accumulated output from `getAppState().phaseOutputs[phaseId]`.
 * Shows a placeholder when the phase is pending and has no output yet.
 * @param {{ id: number, status: string }} phase
 * @returns {string}
 */
function buildWorkerOutputSection(phase) {
    const output = getAppState().phaseOutputs[phase.id];
    const status = (phase.status || '').toLowerCase();
    const hasOutput = typeof output === 'string' && output.length > 0;

    let content;
    if (hasOutput) {
        content = escapeHtml(output);
    } else if (status === 'pending') {
        content = '<span class="output-placeholder">Waiting for execution...</span>';
    } else {
        content = '<span class="output-placeholder">No output recorded.</span>';
    }

    return `
        <div class="phase-detail-section">
            <h4>Worker Output</h4>
            <pre class="phase-output-section" id="phase-output-terminal">${content}</pre>
        </div>
    `;
}

/**
 * Build the Token Budget section for a phase.
 * Reads stored token budget from `getAppState().phaseTokenBudgets[phaseId]`.
 * @param {{ id: number }} phase
 * @returns {string}
 */
function buildTokenBudgetSection(phase) {
    const budget = getAppState().phaseTokenBudgets?.[phase.id];
    if (!budget) return '';

    const pct = Math.min(100, (budget.totalTokens / budget.limit) * 100);
    const colorClass = pct > 90 ? 'over' : pct > 70 ? 'warn' : '';

    return `
        <div class="phase-detail-section">
            <h4>Token Budget</h4>
            <div class="token-bar inline" style="display:block;">
                <div class="token-fill ${colorClass}" style="width:${pct}%;"></div>
                <span class="token-label">${budget.totalTokens.toLocaleString()} / ${budget.limit.toLocaleString()} tokens (${Math.round(pct)}%) · ${budget.fileCount} files</span>
            </div>
        </div>
    `;
}

/**
 * Render the phase details panel (Zone 5).
 * Reads the current state to find the phase with matching id and populates
 * `#phase-details` with prompt, context files, dependencies, dependents,
 * success criteria, contextual action buttons, handoff context, and worker output.
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

    const phaseIndex = phases.indexOf(phase);
    const phaseNumber = phaseIndex >= 0 ? phaseIndex + 1 : phase.id + 1;

    $details.innerHTML = `
        <h3>Phase ${phaseNumber}: ${escapeHtml(promptPreview)}</h3>
        <div class="phase-detail-section">
            <h4>Prompt</h4>
            ${createMarkdownContainer(phase.prompt || '', `phase-prompt-md-${phase.id}`)}
        </div>
        <div class="phase-detail-section">
            <h4>Context Files</h4>
            <div class="phase-context-files">
                ${(phase.context_files || []).map(
        (/** @type {string} */ f) => `<span class="file-chip">${escapeHtml(f)}</span>`
    ).join('')}
            </div>
        </div>
        ${buildDependenciesSection(phase, phases)}
        ${buildDependentsSection(phase, phases)}
        ${buildContextSummarySection(phase)}
        <div class="phase-detail-section">
            <h4>Success Criteria</h4>
            <div class="phase-success-criteria">${escapeHtml(phase.success_criteria || 'exit_code:0')}</div>
        </div>
        ${buildActionButtons(phase)}
        ${buildHandoffContextSection(phase, phases)}
        ${buildTokenBudgetSection(phase)}
        ${buildWorkerOutputSection(phase)}
    `;
    $details.style.display = 'flex';

    // Attach click handlers after innerHTML is set
    attachActionHandlers($details);
    attachMarkdownToggleHandlers($details);
    renderMermaidBlocks();
}
