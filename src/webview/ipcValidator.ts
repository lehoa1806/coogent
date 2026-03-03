// ─────────────────────────────────────────────────────────────────────────────
// src/webview/ipcValidator.ts — Runtime validation for Webview → Host IPC messages
// Extracted for testability without requiring the `vscode` module.
// See 02-review.md § P1-3.
// ─────────────────────────────────────────────────────────────────────────────

import type { WebviewToHostMessage } from '../types/index.js';

const VALID_TYPES_NO_PAYLOAD = new Set(['CMD_START', 'CMD_PAUSE', 'CMD_ABORT', 'CMD_REQUEST_STATE', 'CMD_PLAN_APPROVE', 'CMD_RESET']);
const VALID_TYPES_WITH_PHASEID = new Set(['CMD_RETRY', 'CMD_SKIP_PHASE']);

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
        const payload = msg.payload as Record<string, unknown> | undefined;
        return typeof payload === 'object' && payload !== null && typeof payload.filePath === 'string';
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

    return false;
}
