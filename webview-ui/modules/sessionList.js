// ─────────────────────────────────────────────────────────────────────────────
// webview-ui/modules/sessionList.js — Session history drawer rendering
// ─────────────────────────────────────────────────────────────────────────────

// @ts-check
/// <reference lib="dom" />

import { postMessage } from './store.js';
import { escapeHtml, formatRelativeTime } from './utils.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Session List
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Render the session list in the history drawer.
 * Uses #history-list and #history-drawer from the HTML template.
 * @param {Array<{ sessionId: string, projectId: string, status: string, phaseCount: number, completedPhases: number, createdAt: number, firstPrompt: string }>} sessions
 */
export function renderSessionList(sessions) {
    const $historyList = document.getElementById('history-list');
    const $historyDrawer = document.getElementById('history-drawer');
    if (!$historyList) return;
    $historyList.innerHTML = '';

    if (!sessions || sessions.length === 0) {
        $historyList.innerHTML = '<div class="empty-sessions">No past sessions found</div>';
        return;
    }

    sessions.forEach(s => {
        const item = document.createElement('div');
        item.className = 'session-item';
        item.setAttribute('role', 'listitem');
        item.dataset.sessionId = s.sessionId;
        item.title = `Click to restore session: ${s.projectId || 'Untitled'} (${s.status})`;

        const statusClass = s.status === 'completed' ? 'completed' :
            s.status === 'running' ? 'running' :
                s.status === 'paused_error' ? 'error' : 'idle';

        item.innerHTML = `
            <div class="session-item-header">
                <span class="session-project">${escapeHtml(s.projectId || 'Untitled')}</span>
                <span class="session-status-pill ${statusClass}">${s.status}</span>
            </div>
            <div class="session-item-prompt">${escapeHtml(s.firstPrompt)}</div>
            <div class="session-item-meta">
                <span>${s.completedPhases}/${s.phaseCount} phases</span>
                <span>${formatRelativeTime(s.createdAt)}</span>
            </div>
        `;

        item.addEventListener('click', () => {
            postMessage({ type: 'CMD_LOAD_SESSION', payload: { sessionId: s.sessionId } });
            // Close drawer and restore main layout (controls + app-body were hidden when drawer opened)
            if ($historyDrawer) $historyDrawer.style.display = 'none';
            const $controls = document.getElementById('controls');
            const $appBody = document.querySelector('.app-body');
            if ($controls) $controls.style.display = 'flex';
            if ($appBody) /** @type {HTMLElement} */ ($appBody).style.display = 'flex';
        });

        $historyList.appendChild(item);
    });
}
