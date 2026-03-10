// ─────────────────────────────────────────────────────────────────────────────
// src/session/SessionHistoryService.ts — Unified session history orchestration
// ─────────────────────────────────────────────────────────────────────────────
//
// Consolidates the scattered session history operations (list, search, load,
// delete) that were previously invoked directly from CommandRegistry,
// MissionControlPanel, and SessionManager.  Each method delegates to the
// appropriate service while adding thin coordination logic (e.g. updating the
// active session ID after a successful restore).
// ─────────────────────────────────────────────────────────────────────────────

import { type SessionManager, type SessionSummary, stripSessionDirPrefix } from './SessionManager.js';
import type { SessionRestoreService, SessionRestoreResult } from './SessionRestoreService.js';
import type { SessionDeleteService, SessionDeleteResult } from './SessionDeleteService.js';

import log from '../logger/log.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  SessionHistoryService
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Unified orchestration layer for all session history operations.
 *
 * Usage:
 * ```ts
 * const svc = new SessionHistoryService(sessionMgr, restoreSvc, deleteSvc, mcpServer);
 * const sessions = await svc.listSessions();
 * const result   = await svc.loadSession('20260309-105927-<uuid>');
 * ```
 */
export class SessionHistoryService {
    constructor(
        private readonly sessionManager: SessionManager,
        private readonly restoreService: SessionRestoreService,
        private readonly deleteService: SessionDeleteService,
    ) { }

    // ─────────────────────────────────────────────────────────────────────────
    //  List
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * List all past sessions (DB-first, IPC fallback).
     * Delegates entirely to `SessionManager.listSessions()`.
     */
    async listSessions(): Promise<SessionSummary[]> {
        log.info('[SessionHistoryService] Listing sessions');
        return this.sessionManager.listSessions();
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Search
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Search past sessions by query string.
     * Delegates entirely to `SessionManager.searchSessions()`.
     */
    async searchSessions(query: string): Promise<SessionSummary[]> {
        log.info(`[SessionHistoryService] Searching sessions with query: "${query}"`);
        return this.sessionManager.searchSessions(query);
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Load / Restore
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Restore a persisted session and update the active session pointer.
     *
     * @param sessionDirName  Directory name identifying the session
     *                        (e.g. `20260309-105927-<uuid>`).
     * @returns A `SessionRestoreResult` describing the outcome.
     */
    async loadSession(sessionDirName: string): Promise<SessionRestoreResult> {
        log.info(`[SessionHistoryService] Loading session: ${sessionDirName}`);

        const result = await this.restoreService.restore(sessionDirName);

        if (result.success) {
            // Update the active session pointer so subsequent list/search
            // operations correctly exclude the newly-loaded session.
            const sessionId = stripSessionDirPrefix(sessionDirName);
            this.sessionManager.setCurrentSessionId(sessionId, sessionDirName);
            log.info(`[SessionHistoryService] Active session updated to: ${sessionId}`);
        } else {
            log.warn(
                `[SessionHistoryService] Session restore failed for "${sessionDirName}" — ` +
                `errors: ${result.errors.join('; ')}`,
            );
        }

        return result;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Delete
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Delete a session with full cascade cleanup.
     *
     * @param sessionDirName            The session directory name to delete.
     * @param currentActiveSessionDirName  The currently active session dir name
     *                                     (used to determine if the target is
     *                                     the active session).
     * @returns A `SessionDeleteResult` describing success/failure.
     */
    async deleteSession(
        sessionDirName: string,
        currentActiveSessionDirName: string | undefined,
    ): Promise<SessionDeleteResult> {
        const isActiveSession = sessionDirName === currentActiveSessionDirName;

        log.info(
            `[SessionHistoryService] Deleting session: ${sessionDirName} ` +
            `(active=${isActiveSession})`,
        );

        const result = await this.deleteService.deleteSession(
            sessionDirName,
            isActiveSession,
        );

        if (result.success) {
            log.info(`[SessionHistoryService] Session deleted successfully: ${sessionDirName}`);
        } else {
            log.warn(
                `[SessionHistoryService] Session delete completed with errors for "${sessionDirName}" — ` +
                `errors: ${result.errors.join('; ')}`,
            );
        }

        return result;
    }
}
