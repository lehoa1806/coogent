// ─────────────────────────────────────────────────────────────────────────────
// src/session/SessionDeleteService.ts — Controlled cascade delete for sessions
// ─────────────────────────────────────────────────────────────────────────────
//
// Orchestrates the full teardown of a Coogent session:
//   1. Purge active MCP TaskState (if the session is currently active)
//   2. Delete IPC directory + sessions DB row (via SessionManager)
//   3. Purge the tasks DB row + in-memory TaskState map (via CoogentMCPServer)
//
// Each step is best-effort: failures are recorded in `errors[]` but do not
// prevent subsequent steps from executing.
// ─────────────────────────────────────────────────────────────────────────────

import type { CoogentMCPServer } from '../mcp/CoogentMCPServer.js';
import type { SessionManager } from './SessionManager.js';
import log from '../logger/log.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Types
// ═══════════════════════════════════════════════════════════════════════════════

export interface SessionDeleteResult {
    success: boolean;
    sessionDirName: string;
    errors: string[];
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Service
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Controlled cascade delete service.
 *
 * Unlike `SessionManager.deleteSession()` which only removes the IPC directory
 * and the `sessions` DB row, this service also:
 * - Clears active runtime MCP TaskState when the session is currently active
 * - Purges the `tasks` DB row via `CoogentMCPServer.purgeTask`
 *
 * Designed for use by `CommandRegistry` (or any other call-site that needs a
 * complete teardown).
 */
export class SessionDeleteService {
    constructor(
        private readonly mcpServer: CoogentMCPServer,
        private readonly sessionManager: SessionManager,
    ) { }

    /**
     * Delete a session with full cascade cleanup.
     *
     * @param sessionDirName  The session directory name (e.g. `20260309-105927-<uuid>`)
     * @param isActiveSession Whether this session is currently loaded/active
     * @returns A result describing success/failure and any per-step errors
     */
    async deleteSession(
        sessionDirName: string,
        isActiveSession: boolean,
    ): Promise<SessionDeleteResult> {
        const errors: string[] = [];

        log.info(`[SessionDeleteService] Starting cascade delete for session: ${sessionDirName} (active=${isActiveSession})`);

        // Step 1: If this is the active session, clear the in-memory MCP TaskState
        // so the engine doesn't reference stale state.
        if (isActiveSession) {
            try {
                this.mcpServer.purgeTask(sessionDirName);
                log.info(`[SessionDeleteService] Step 1 — Purged active MCP TaskState: ${sessionDirName}`);
            } catch (err) {
                const msg = `Step 1 (purge active TaskState) failed: ${String(err)}`;
                errors.push(msg);
                log.warn(`[SessionDeleteService] ${msg}`);
            }
        }

        // Step 2: Delete the IPC directory and sessions DB row via SessionManager.
        try {
            await this.sessionManager.deleteSession(sessionDirName);
            log.info(`[SessionDeleteService] Step 2 — Deleted IPC dir + sessions DB row: ${sessionDirName}`);
        } catch (err) {
            const msg = `Step 2 (SessionManager.deleteSession) failed: ${String(err)}`;
            errors.push(msg);
            log.warn(`[SessionDeleteService] ${msg}`);
        }

        // Step 3: Purge the tasks DB row and in-memory TaskState map entry.
        // This covers task/phase/handoff/verdict artifacts linked via master_task_id.
        try {
            this.mcpServer.purgeTask(sessionDirName);
            log.info(`[SessionDeleteService] Step 3 — Purged tasks DB row: ${sessionDirName}`);
        } catch (err) {
            const msg = `Step 3 (purgeTask) failed: ${String(err)}`;
            errors.push(msg);
            log.warn(`[SessionDeleteService] ${msg}`);
        }

        const success = errors.length === 0;

        if (success) {
            log.info(`[SessionDeleteService] Cascade delete completed successfully: ${sessionDirName}`);
        } else {
            log.warn(`[SessionDeleteService] Cascade delete completed with ${errors.length} error(s): ${sessionDirName}`);
        }

        return { success, sessionDirName, errors };
    }
}
