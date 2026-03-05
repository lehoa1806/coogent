// ─────────────────────────────────────────────────────────────────────────────
// webview-ui/modules/phaseNavigator.js — Phase Navigator sidebar component
// ─────────────────────────────────────────────────────────────────────────────

// @ts-check
/// <reference lib="dom" />

import { setAppState } from './store.js';
import { renderPhaseDetails } from './renderers.js';
import { escapeHtml, truncate } from './utils.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Phase Navigator
// ═══════════════════════════════════════════════════════════════════════════════

/** @type {HTMLElement | null} */
let _navigatorEl = null;

/**
 * Status display text mapping.
 * @type {Record<string, string>}
 */
const STATUS_TEXT = {
    pending: 'Pending',
    running: 'Running',
    completed: 'Done',
    failed: 'Failed',
    skipped: 'Skipped',
};

/**
 * Initialize the Phase Navigator.
 * Finds the `#phase-navigator` DOM element and sets up delegated click
 * listeners. When a phase item is clicked it:
 *   1. Updates `selectedPhaseId` in application state.
 *   2. Calls `renderPhaseDetails(phaseId)` to populate Zone 5.
 *   3. Toggles the `.active` class to highlight the selected item.
 */
export function initPhaseNavigator() {
    _navigatorEl = document.getElementById('phase-navigator');
    if (!_navigatorEl) return;

    // Delegated click — avoids re-binding when the list re-renders
    _navigatorEl.addEventListener('click', (e) => {
        const target = /** @type {HTMLElement} */ (e.target);
        const item = target.closest('.phase-item');
        if (!item) return;

        const phaseId = Number(item.getAttribute('data-phase-id'));
        if (Number.isNaN(phaseId)) return;

        // 1. Persist selection in store
        setAppState({ selectedPhaseId: phaseId });

        // 2. Render the detail panel for this phase
        if (typeof renderPhaseDetails === 'function') {
            renderPhaseDetails(phaseId);
        }

        // 3. Visual highlight — toggle .active on clicked item
        _navigatorEl
            ?.querySelectorAll('.phase-item')
            .forEach((el) => el.classList.remove('active'));
        item.classList.add('active');
    });
}

// escapeHtml and truncate are imported from utils.js

/**
 * Render the full phase list into the `#phase-navigator` container.
 *
 * Each phase item is a `<div class="phase-item" data-phase-id="{id}">` with:
 *   - A `<span class="phase-number">` showing the 1-indexed phase number.
 *   - A `<span class="phase-prompt-preview">` showing the first 60 characters
 *     of the prompt (with ellipsis if truncated).
 *   - A `<span class="status-pill {status}">` showing the human-readable
 *     status text (Pending / Running / Done / Failed).
 *
 * @param {Array<{ id: number, prompt: string, status: string, context_files: string[], success_criteria: string }>} phases
 */
export function renderPhaseList(phases) {
    const container = _navigatorEl || document.getElementById('phase-navigator');
    if (!container) return;

    container.innerHTML = '';

    if (!phases || phases.length === 0) return;

    phases.forEach((phase, index) => {
        const item = document.createElement('div');
        item.className = 'phase-item';
        item.setAttribute('data-phase-id', String(phase.id));
        item.setAttribute('role', 'listitem');
        item.title = `Click to view details for Phase ${index + 1}`;

        // Phase number (1-indexed)
        const numberSpan = document.createElement('span');
        numberSpan.className = 'phase-number';
        numberSpan.textContent = String(index + 1);

        // Prompt preview — first 60 chars with ellipsis
        const previewSpan = document.createElement('span');
        previewSpan.className = 'phase-prompt-preview';
        previewSpan.textContent = truncate(phase.prompt || '', 60);
        previewSpan.title = escapeHtml(phase.prompt || '');

        // Status pill
        const statusSpan = document.createElement('span');
        const statusKey = (phase.status || 'pending').toLowerCase();
        statusSpan.className = `status-pill ${statusKey}`;
        statusSpan.textContent = STATUS_TEXT[statusKey] || phase.status;
        statusSpan.title = `Current status: ${STATUS_TEXT[statusKey] || phase.status}`;

        item.appendChild(numberSpan);
        item.appendChild(previewSpan);
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
    const container = _navigatorEl || document.getElementById('phase-navigator');
    if (!container) return;

    const item = container.querySelector(`.phase-item[data-phase-id="${phaseId}"]`);
    if (!item) return;

    const pill = item.querySelector('.status-pill');
    if (!pill) return;

    const statusKey = (status || 'pending').toLowerCase();
    pill.className = `status-pill ${statusKey}`;
    pill.textContent = STATUS_TEXT[statusKey] || status;
}
