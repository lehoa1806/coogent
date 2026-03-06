// ─────────────────────────────────────────────────────────────────────────────
// webview-ui/modules/phaseNavigator.js — Phase Navigator sidebar component
// ─────────────────────────────────────────────────────────────────────────────

// @ts-check
/// <reference lib="dom" />

import { setAppState } from './store.js';
import { renderPhaseDetails } from './phaseDetails.js';
import { escapeHtml, truncate } from './utils.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Phase Navigator
// ═══════════════════════════════════════════════════════════════════════════════



/**
 * Status display text mapping.
 * @type {Record<string, string>}
 */
const STATUS_TEXT = {
    pending: 'Pending',
    ready: 'Ready',
    running: 'Running',
    completed: 'Done',
    failed: 'Failed',
    skipped: 'Skipped',
};

/**
 * Highlight a specific phase item in the navigator by toggling the `.active` class.
 * Exported so that both user clicks and auto-selection can keep the highlight in sync.
 * @param {number} phaseId
 */
export function highlightActivePhase(phaseId) {
    const navigatorEl = document.getElementById('phase-navigator');
    if (!navigatorEl) return;

    navigatorEl
        .querySelectorAll('.phase-item')
        .forEach((el) => el.classList.remove('active'));

    const target = navigatorEl.querySelector(`.phase-item[data-phase-id="${phaseId}"]`);
    if (target) target.classList.add('active');
}

/**
 * Initialize the Phase Navigator.
 * Finds the `#phase-navigator` DOM element and sets up delegated click
 * listeners. When a phase item is clicked it:
 *   1. Updates `selectedPhaseId` and `userSelectedPhaseId` in application state.
 *   2. Calls `renderPhaseDetails(phaseId)` to populate Zone 5.
 *   3. Toggles the `.active` class to highlight the selected item.
 */
export function initPhaseNavigator() {
    const navigatorEl = document.getElementById('phase-navigator');
    if (!navigatorEl) return;

    // #89: Ensure ARIA attributes on navigator container
    navigatorEl.setAttribute('aria-label', 'Phase navigator');
    navigatorEl.setAttribute('role', 'list');

    // Delegated click — avoids re-binding when the list re-renders
    navigatorEl.addEventListener('click', (e) => {
        const target = /** @type {HTMLElement} */ (e.target);
        const item = target.closest('.phase-item');
        if (!item) return;

        const phaseId = Number(item.getAttribute('data-phase-id'));
        if (Number.isNaN(phaseId)) return;

        // 1. Persist selection in store — mark as user-initiated so auto-select won't override
        setAppState({ selectedPhaseId: phaseId, userSelectedPhaseId: phaseId });

        // 2. Render the detail panel for this phase
        if (typeof renderPhaseDetails === 'function') {
            renderPhaseDetails(phaseId);
        }

        // 3. Visual highlight — toggle .active on clicked item
        highlightActivePhase(phaseId);
    });
}


/**
 * Determine if a phase is "ready" — all its dependencies are completed
 * and the phase itself is still pending.
 * @param {{ id: number, status: string, depends_on?: number[] }} phase
 * @param {Map<number, string>} statusMap - map of phaseId → status
 * @returns {boolean}
 */
function isPhaseReady(phase, statusMap) {
    if ((phase.status || 'pending').toLowerCase() !== 'pending') return false;
    const deps = phase.depends_on;
    if (!deps || deps.length === 0) return false; // No deps = sequential, not DAG-ready
    return deps.every(depId => (statusMap.get(depId) || '').toLowerCase() === 'completed');
}

/**
 * Render the full phase list into the `#phase-navigator` container.
 *
 * Each phase item is a `<div class="phase-item" data-phase-id="{id}">` with:
 *   - A vertical connector line (pseudo-element via CSS).
 *   - A `<span class="phase-number">` showing the 1-indexed phase number.
 *   - A `<span class="phase-prompt-preview">` showing the first 60 characters
 *     of the prompt (with ellipsis if truncated).
 *   - DAG dependency badges showing upstream phase IDs.
 *   - A `<span class="status-pill {status}">` showing the human-readable
 *     status text (Pending / Ready / Running / Done / Failed).
 *
 * @param {Array<{ id: number, prompt: string, status: string, context_files: string[], success_criteria: string, depends_on?: number[] }>} phases
 */
export function renderPhaseList(phases) {
    const container = document.getElementById('phase-navigator');
    if (!container) return;

    // Preserve the nav-header element — only remove phase items and connectors.
    // Using innerHTML = '' would destroy the "Phases" header, causing the
    // navigator to appear hidden after a state refresh (#BUG: phases section hidden).
    const itemsToRemove = container.querySelectorAll('.phase-item, .phase-connector');
    itemsToRemove.forEach(el => el.remove());

    // Ensure the nav-header always exists (restore if somehow lost)
    if (!container.querySelector('.nav-header')) {
        const header = document.createElement('div');
        header.className = 'nav-header panel-header';
        header.textContent = 'Phase Navigator';
        container.prepend(header);
    }

    if (!phases || phases.length === 0) return;

    // Build a status map for ready-phase computation
    /** @type {Map<number, string>} */
    const statusMap = new Map();
    phases.forEach(p => statusMap.set(p.id, (p.status || 'pending').toLowerCase()));

    phases.forEach((phase, index) => {
        const item = document.createElement('div');
        const statusKey = (phase.status || 'pending').toLowerCase();
        const ready = isPhaseReady(phase, statusMap);
        const effectiveStatus = ready ? 'ready' : statusKey;

        item.className = `phase-item${ready ? ' ready' : ''}`;
        item.setAttribute('data-phase-id', String(phase.id));
        item.setAttribute('role', 'listitem');
        item.setAttribute('tabindex', '0');
        item.title = `Click to view details for Phase ${index + 1}`;

        // Visual connector between items (not on first)
        if (index > 0) {
            const connector = document.createElement('div');
            connector.className = 'phase-connector';
            connector.setAttribute('aria-hidden', 'true');
            container.appendChild(connector);
        }

        // Phase number (1-indexed)
        const numberSpan = document.createElement('span');
        numberSpan.className = 'phase-number';
        numberSpan.textContent = String(index + 1);

        // Content wrapper for prompt + dep badges
        const contentWrap = document.createElement('div');
        contentWrap.className = 'phase-item-content';

        // Prompt preview — first 60 chars with ellipsis
        const previewSpan = document.createElement('span');
        previewSpan.className = 'phase-prompt-preview';
        previewSpan.textContent = truncate(phase.prompt || '', 60);
        previewSpan.title = escapeHtml(phase.prompt || '');
        contentWrap.appendChild(previewSpan);

        // DAG dependency badges
        const deps = phase.depends_on;
        if (deps && deps.length > 0) {
            const depsRow = document.createElement('div');
            depsRow.className = 'phase-deps-row';
            depsRow.setAttribute('aria-label', `Depends on phases: ${deps.map(d => d + 1).join(', ')}`);
            deps.forEach(depId => {
                const badge = document.createElement('span');
                badge.className = 'dep-badge';
                // Find the 1-indexed position of the dependency
                const depIndex = phases.findIndex(p => p.id === depId);
                badge.textContent = `← #${depIndex >= 0 ? depIndex + 1 : depId}`;
                badge.title = `Depends on Phase ${depIndex >= 0 ? depIndex + 1 : depId}`;
                depsRow.appendChild(badge);
            });
            contentWrap.appendChild(depsRow);
        }

        // Status pill
        const statusSpan = document.createElement('span');
        statusSpan.className = `status-pill ${effectiveStatus}`;
        statusSpan.textContent = STATUS_TEXT[effectiveStatus] || phase.status;
        statusSpan.title = `Current status: ${STATUS_TEXT[effectiveStatus] || phase.status}`;

        item.appendChild(numberSpan);
        item.appendChild(contentWrap);
        item.appendChild(statusSpan);

        container.appendChild(item);
    });
}

/**
 * Update a single phase item's status pill without re-rendering the entire
 * list. Finds the matching `.phase-item` by `data-phase-id` and updates only
 * the `.status-pill` child.
 *
 * @param {number} phaseId
 * @param {string} status
 */
export function updatePhaseItemStatus(phaseId, status) {
    const container = document.getElementById('phase-navigator');
    if (!container) return;

    const item = container.querySelector(`.phase-item[data-phase-id="${phaseId}"]`);
    if (!item) return;

    const pill = item.querySelector('.status-pill');
    if (!pill) return;

    const statusKey = (status || 'pending').toLowerCase();
    pill.className = `status-pill ${statusKey}`;
    pill.textContent = STATUS_TEXT[statusKey] || status;
}
