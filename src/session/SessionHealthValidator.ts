// ─────────────────────────────────────────────────────────────────────────────
// src/session/SessionHealthValidator.ts — Pre-load session health checks
// ─────────────────────────────────────────────────────────────────────────────
//
// Validates whether a persisted session has the required backing state to
// be safely loaded.  Checks three layers:
//   1. Metadata existence in ArtifactDB  (SessionRepository)
//   2. Session directory existence on disk
//   3. Runbook availability  (file on disk OR `runbook_json` in tasks table)
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ArtifactDB } from '../mcp/ArtifactDB.js';
import { getSessionDir, RUNBOOK_FILE } from '../constants/paths.js';
import log from '../logger/log.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Types
// ═══════════════════════════════════════════════════════════════════════════════

export type SessionHealthStatus = 'healthy' | 'degraded' | 'invalid';

export interface SessionHealthResult {
    status: SessionHealthStatus;
    sessionDirName: string;
    hasMetadata: boolean;
    hasSnapshot: boolean;
    hasRunbookInDB: boolean;
    errors: string[];
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SessionHealthValidator
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Validates whether a session is safe to load by checking the three
 * persistence layers (DB metadata, disk snapshot, DB runbook).
 */
export class SessionHealthValidator {
    constructor(
        private readonly artifactDB: ArtifactDB,
        private readonly storageBase: string,
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

        // ── 2. Session directory / snapshot check ────────────────────────
        const sessionDir = getSessionDir(this.storageBase, sessionDirName);
        const hasSnapshot = fs.existsSync(sessionDir);

        if (!hasSnapshot) {
            errors.push(`Session directory does not exist: ${sessionDir}`);
        }

        // ── 3. Runbook availability ──────────────────────────────────────
        //    Accept either on-disk runbook file OR a runbook_json in the DB.
        const runbookPath = path.join(sessionDir, RUNBOOK_FILE);
        const hasRunbookOnDisk = hasSnapshot && fs.existsSync(runbookPath);
        const hasRunbookInDB = meta?.runbookJson != null && meta.runbookJson !== '';

        if (!hasRunbookOnDisk && !hasRunbookInDB) {
            errors.push(`No runbook found (checked disk: ${runbookPath}, DB runbook_json: absent)`);
        }

        // ── Derive status ────────────────────────────────────────────────
        let status: SessionHealthStatus;

        if (!hasMetadata) {
            status = 'invalid';
        } else if (hasRunbookOnDisk || hasRunbookInDB) {
            status = 'healthy';
        } else {
            status = 'degraded';
        }

        const result: SessionHealthResult = {
            status,
            sessionDirName,
            hasMetadata,
            hasSnapshot,
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
