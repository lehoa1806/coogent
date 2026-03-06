// ─────────────────────────────────────────────────────────────────────────────
// src/webview/ipcValidator.ts — Runtime validation for Webview → Host IPC messages
// Extracted for testability without requiring the `vscode` module.
// See 02-review.md § P1-3.
// ─────────────────────────────────────────────────────────────────────────────

import type { WebviewToHostMessage } from '../types/index.js';

const VALID_TYPES_NO_PAYLOAD = new Set(['CMD_START', 'CMD_ABORT', 'CMD_REQUEST_STATE', 'CMD_PLAN_APPROVE', 'CMD_PLAN_RETRY_PARSE', 'CMD_RESET', 'CMD_REQUEST_REPORT', 'CMD_REQUEST_PLAN', 'CMD_RESUME_PENDING', 'CMD_UPLOAD_FILE', 'CMD_UPLOAD_IMAGE', 'CMD_LIST_SESSIONS']);
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

    if (msg.type === 'CMD_SET_CONVERSATION_MODE') {
        const payload = msg.payload as Record<string, unknown> | undefined;
        if (typeof payload !== 'object' || payload === null || typeof payload.mode !== 'string') return false;
        return ['isolated', 'continuous', 'smart'].includes(payload.mode as string);
    }

    if (msg.type === 'MCP_FETCH_RESOURCE') {
        const payload = msg.payload as Record<string, unknown> | undefined;
        return typeof payload === 'object' && payload !== null
            && typeof payload.uri === 'string'
            && payload.uri.startsWith('coogent://') // W-9: Validate URI scheme
            && typeof payload.requestId === 'string';
    }

    // Session management messages
    if (msg.type === 'CMD_SEARCH_SESSIONS') {
        const payload = msg.payload as Record<string, unknown> | undefined;
        return typeof payload === 'object' && payload !== null && typeof payload.query === 'string';
    }

    if (msg.type === 'CMD_LOAD_SESSION') {
        const payload = msg.payload as Record<string, unknown> | undefined;
        return typeof payload === 'object' && payload !== null && typeof payload.sessionId === 'string';
    }

    if (msg.type === 'CMD_DELETE_SESSION') {
        const payload = msg.payload as Record<string, unknown> | undefined;
        return typeof payload === 'object' && payload !== null && typeof payload.sessionId === 'string';
    }

    return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// TYPE-02 — Compile-time exhaustiveness guard
//
// This mapped type asserts that every member of `WebviewToHostMessageType`
// is explicitly handled by the validator above (in a Set or if-branch).
// If you add a new message type to `WebviewToHostMessage` but forget to handle
// it here, TypeScript will error on the line below.
//
// How it works: For each type literal K in the union, we associate it with
// `true`. The const below forces instantiation. Any new unhandled type will
// cause:
//   "Type '"CMD_NEW_TYPE"' is not assignable to type 'never'."
// ─────────────────────────────────────────────────────────────────────────────

type _ExhaustiveWebviewMessageTypes = {
    // payload-free commands
    CMD_START: true;
    CMD_ABORT: true;
    CMD_REQUEST_STATE: true;
    CMD_PLAN_APPROVE: true;
    CMD_PLAN_RETRY_PARSE: true;
    CMD_RESET: true;
    CMD_REQUEST_REPORT: true;
    CMD_REQUEST_PLAN: true;
    CMD_RESUME_PENDING: true;
    CMD_UPLOAD_FILE: true;
    CMD_UPLOAD_IMAGE: true;
    CMD_LIST_SESSIONS: true;
    // payload commands
    CMD_RETRY: true;
    CMD_SKIP_PHASE: true;
    CMD_PAUSE_PHASE: true;
    CMD_STOP_PHASE: true;
    CMD_RESTART_PHASE: true;
    CMD_REVIEW_DIFF: true;
    CMD_EDIT_PHASE: true;
    CMD_LOAD_RUNBOOK: true;
    CMD_PLAN_REQUEST: true;
    CMD_PLAN_REJECT: true;
    CMD_PLAN_EDIT_DRAFT: true;
    CMD_SET_CONVERSATION_MODE: true;
    MCP_FETCH_RESOURCE: true;
    CMD_SEARCH_SESSIONS: true;
    CMD_LOAD_SESSION: true;
    CMD_DELETE_SESSION: true;
};

// If this line errors, a new WebviewToHostMessageType is not yet handled above.
// Uses an exported type alias (zero runtime footprint) instead of declare+void to avoid
// Jest ReferenceError: _guard is not defined. Exported symbols are never flagged as unused.
import type { WebviewToHostMessageType } from '../types/index.js';
export type _AssertExhaustive = _ExhaustiveWebviewMessageTypes extends Record<WebviewToHostMessageType, true>
    ? true
    : never;

