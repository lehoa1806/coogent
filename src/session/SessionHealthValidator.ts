// ─────────────────────────────────────────────────────────────────────────────
// src/session/SessionHealthValidator.ts — Pre-load session health checks
// ─────────────────────────────────────────────────────────────────────────────
//
// Validates whether a persisted session has the required backing state to
// be safely loaded.  Checks two layers (DB-only):
//   1. Metadata existence in ArtifactDB  (SessionRepository)
//   2. Runbook availability  (`runbook_json` in tasks table)
//
// No disk checks are performed — the DB is the single source of truth.
// ─────────────────────────────────────────────────────────────────────────────

import type { ArtifactDB } from '../mcp/ArtifactDB.js';
import log from '../logger/log.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Types
// ═══════════════════════════════════════════════════════════════════════════════

export type SessionHealthStatus = 'healthy' | 'degraded' | 'invalid';

export interface SessionHealthResult {
    status: SessionHealthStatus;
    sessionDirName: string;
    hasMetadata: boolean;
    hasRunbookInDB: boolean;
    errors: string[];
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SessionHealthValidator
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Validates whether a session is safe to load by checking the
 * ArtifactDB persistence layers (metadata + runbook).
 *
 * No filesystem checks — the DB is the single source of truth.
 */
export class SessionHealthValidator {
    constructor(
        private readonly artifactDB: ArtifactDB,
    ) { }

    /**
     * Run all health checks for the given session directory name.
     *
     * @param sessionDirName  The directory name that identifies the session
     *                        (doubles as `master_task_id` in the tasks table).
     * @returns A `SessionHealthResult` summarising the session state.
     */
    validate(sessionDirName: string): SessionHealthResult {
        const errors: string[] = [];

        // ── 1. Metadata check ────────────────────────────────────────────
        const sessions = this.artifactDB.sessions.list();
        const meta = sessions.find(s => s.sessionDirName === sessionDirName);
        const hasMetadata = meta !== undefined;

        if (!hasMetadata) {
            errors.push(`No session metadata found in DB for "${sessionDirName}"`);
        }

        // ── 2. Runbook availability ──────────────────────────────────────
        const hasRunbookInDB = meta?.runbookJson != null && meta.runbookJson !== '';

        if (hasMetadata && !hasRunbookInDB) {
            errors.push(`No runbook found in DB for "${sessionDirName}"`);
        }

        // ── Derive status ────────────────────────────────────────────────
        let status: SessionHealthStatus;

        if (!hasMetadata) {
            status = 'invalid';
        } else if (hasRunbookInDB) {
            status = 'healthy';
        } else {
            status = 'degraded';
        }

        const result: SessionHealthResult = {
            status,
            sessionDirName,
            hasMetadata,
            hasRunbookInDB,
            errors,
        };

        // ── Log outcome ──────────────────────────────────────────────────
        if (status === 'healthy') {
            log.info(`[SessionHealthValidator] Session "${sessionDirName}" is healthy`);
        } else if (status === 'degraded') {
            log.warn(`[SessionHealthValidator] Session "${sessionDirName}" is degraded: ${errors.join('; ')}`);
        } else {
            log.error(`[SessionHealthValidator] Session "${sessionDirName}" is invalid: ${errors.join('; ')}`);
        }

        return result;
    }
}
