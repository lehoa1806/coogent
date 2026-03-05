// ─────────────────────────────────────────────────────────────────────────────
// src/webview/ipcValidator.ts — Runtime validation for Webview → Host IPC messages
// Extracted for testability without requiring the `vscode` module.
// See 02-review.md § P1-3.
// ─────────────────────────────────────────────────────────────────────────────

import type { WebviewToHostMessage } from '../types/index.js';

const VALID_TYPES_NO_PAYLOAD = new Set(['CMD_START', 'CMD_PAUSE', 'CMD_ABORT', 'CMD_REQUEST_STATE', 'CMD_PLAN_APPROVE', 'CMD_PLAN_RETRY_PARSE', 'CMD_RESET', 'CMD_LIST_SESSIONS', 'CMD_REQUEST_REPORT', 'CMD_REQUEST_PLAN', 'CMD_RESUME_PENDING']);
const VALID_TYPES_WITH_PHASEID = new Set(['CMD_RETRY', 'CMD_SKIP_PHASE', 'CMD_PAUSE_PHASE', 'CMD_STOP_PHASE', 'CMD_RESTART_PHASE', 'CMD_REVIEW_DIFF']);

/**
 * Runtime validation for Webview → Host IPC messages.
 * Ensures the `type` discriminator exists and payload shapes match.
 */
export function isValidWebviewMessage(raw: unknown): raw is WebviewToHostMessage {
    if (typeof raw !== 'object' || raw === null) return false;
    const msg = raw as Record<string, unknown>;
    if (typeof msg.type !== 'string') return false;

    if (VALID_TYPES_NO_PAYLOAD.has(msg.type)) return true;

    if (VALID_TYPES_WITH_PHASEID.has(msg.type)) {
        const payload = msg.payload as Record<string, unknown> | undefined;
        return typeof payload === 'object' && payload !== null && typeof payload.phaseId === 'number';
    }

    if (msg.type === 'CMD_EDIT_PHASE') {
        const payload = msg.payload as Record<string, unknown> | undefined;
        return typeof payload === 'object' && payload !== null
            && typeof payload.phaseId === 'number'
            && typeof payload.patch === 'object' && payload.patch !== null;
    }

    if (msg.type === 'CMD_LOAD_RUNBOOK') {
        // Allow without payload (webview button sends no filePath; Engine.loadRunbook() accepts undefined)
        const payload = msg.payload as Record<string, unknown> | undefined;
        if (!payload) return true;
        return typeof payload === 'object' && typeof payload.filePath === 'string';
    }

    if (msg.type === 'CMD_PLAN_REQUEST') {
        const payload = msg.payload as Record<string, unknown> | undefined;
        return typeof payload === 'object' && payload !== null && typeof payload.prompt === 'string';
    }

    if (msg.type === 'CMD_PLAN_REJECT') {
        const payload = msg.payload as Record<string, unknown> | undefined;
        return typeof payload === 'object' && payload !== null && typeof payload.feedback === 'string';
    }

    if (msg.type === 'CMD_PLAN_EDIT_DRAFT') {
        const payload = msg.payload as Record<string, unknown> | undefined;
        return typeof payload === 'object' && payload !== null && typeof payload.draft === 'object';
    }

    if (msg.type === 'CMD_SEARCH_SESSIONS') {
        const payload = msg.payload as Record<string, unknown> | undefined;
        return typeof payload === 'object' && payload !== null && typeof payload.query === 'string';
    }

    if (msg.type === 'CMD_LOAD_SESSION') {
        const payload = msg.payload as Record<string, unknown> | undefined;
        return typeof payload === 'object' && payload !== null && typeof payload.sessionId === 'string';
    }

    if (msg.type === 'CMD_SET_CONVERSATION_MODE') {
        const payload = msg.payload as Record<string, unknown> | undefined;
        if (typeof payload !== 'object' || payload === null || typeof payload.mode !== 'string') return false;
        return ['isolated', 'continuous', 'smart'].includes(payload.mode as string);
    }

    if (msg.type === 'CMD_DELETE_SESSION') {
        const payload = msg.payload as Record<string, unknown> | undefined;
        return typeof payload === 'object' && payload !== null && typeof payload.sessionId === 'string';
    }

    return false;
}
