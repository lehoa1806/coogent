// ─────────────────────────────────────────────────────────────────────────────
// src/session/SessionManager.ts — DB-only session management
// ─────────────────────────────────────────────────────────────────────────────

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { type Runbook, type RunbookStatus } from '../types/index.js';
import { StateManager } from '../state/StateManager.js';
import type { ArtifactDB } from '../mcp/ArtifactDB.js';
import { IPC_DIR } from '../constants/paths.js';
import log from '../logger/log.js';
import {
    extractUUIDv7Timestamp,
    formatSessionDirName,
    stripSessionDirPrefix,
} from './session-utils.js';

// Re-export utilities so existing consumers don't break
export { extractUUIDv7Timestamp, formatSessionDirName, stripSessionDirPrefix };

// ═══════════════════════════════════════════════════════════════════════════════
//  Types
// ═══════════════════════════════════════════════════════════════════════════════

/** Compact metadata about a past session shown in the history drawer. */
export interface SessionSummary {
    /** UUIDv7 session ID (directory name). */
    sessionId: string;
    /** From runbook.project_id. */
    projectId: string;
    /** Global status of the runbook at time of read. */
    status: RunbookStatus;
    /** Total number of phases in the runbook. */
    phaseCount: number;
    /** Number of phases with status === 'completed'. */
    completedPhases: number;
    /** Millisecond timestamp extracted from the UUIDv7 session ID. */
    createdAt: number;
    /** First phase prompt, truncated for display. */
    firstPrompt: string;
    /** Whether this is the currently active session. */
    isActive: boolean;
    /** Whether a consolidation report is available for this session. */
    hasConsolidationReport: boolean;
    /** Whether an implementation plan is available for this session. */
    hasImplementationPlan: boolean;
}

/** Shape of a row returned by `SessionRepository.list()`. */
interface SessionRow {
    sessionDirName: string;
    sessionId: string;
    prompt: string;
    createdAt: number;
    runbookJson: string | null;
    status: string | null;
    consolidationReport: string | null;
    consolidationReportJson: string | null;
    implementationPlan: string | null;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SessionManager
// ═══════════════════════════════════════════════════════════════════════════════

const MAX_PROMPT_LENGTH = 120;

/**
 * Manages past Coogent sessions.
 *
 * All session data is read exclusively from the ArtifactDB.
 * The IPC directories on disk are only used for creating new sessions
 * and deleting old ones — never for discovery or listing.
 */
export class SessionManager {
    /** Absolute path to `<storageBase>/ipc/`. */
    private readonly ipcDir: string;

    /** The current active session ID (excluded from history). */
    private currentSessionId: string;

    /** The current session dir name (YYYYMMDD-HHMMSS-<uuid>). */
    private currentSessionDirName: string;

    /** Optional ArtifactDB reference for DB-first session queries. */
    private db?: ArtifactDB;

    constructor(
        storageBase: string,
        currentSessionId: string,
        currentSessionDirName?: string,
        artifactDB?: ArtifactDB,
    ) {
        this.ipcDir = path.join(storageBase, IPC_DIR);
        this.currentSessionId = currentSessionId;
        this.currentSessionDirName = currentSessionDirName ?? currentSessionId;
        if (artifactDB) {
            this.db = artifactDB;
        }
    }

    /**
     * Wire the ArtifactDB for DB-first session listing.
     * After calling this, `listSessions()` queries the DB with IPC fallback.
     *
     * Prefer passing `artifactDB` via the constructor when possible.
     *
     * @deprecated Prefer constructor injection. Three runtime callers remain
     * (`ServiceContainer.switchSession`, `PlannerWiring`, `activation.ts`)
     * that require an ArtifactDB lifecycle refactor to eliminate.
     * TODO: Remove once ArtifactDB is fully constructor-injected.
     */
    public setArtifactDB(db: ArtifactDB): void {
        this.db = db;
    }

    /** Update the active session ID (e.g. after switching sessions). */
    public setCurrentSessionId(id: string, dirName?: string): void {
        this.currentSessionId = id;
        this.currentSessionDirName = dirName ?? id;
    }

    /** Get the current session dir name (YYYYMMDD-HHMMSS-<uuid>). */
    public getCurrentSessionDirName(): string {
        return this.currentSessionDirName;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Public API
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Create a new session.
     * Generates a UUIDv7 session ID, creates the session directory under
     * `<storageBase>/ipc/YYYYMMDD-HHMMSS-<uuid>/`, and writes metadata JSON.
     * @returns The new session ID.
     */
    public async createSession(_prompt: string): Promise<string> {
        const sessionId = generateUUIDv7();
        const dirName = formatSessionDirName(sessionId);
        const sessionDir = path.join(this.ipcDir, dirName);

        // Create session directory (recursively creates .coogent/ipc/ if needed)
        await fs.mkdir(sessionDir, { recursive: true });

        // Session metadata is persisted via ArtifactDB.upsertSession() —
        // no metadata.json file needed (BL-2 audit fix: removed dead write).

        return sessionId;
    }

    /**
     * Load a StateManager for the specified session.
     * Use this to access the runbook and state for replay/inspection.
     */
    public loadSession(sessionId: string): StateManager {
        const sessionDir = this.getSessionDir(sessionId);
        return new StateManager(sessionDir);
    }

    /**
     * List all sessions, sorted by most recent first.
     * Includes the current session, tagged with `isActive: true`.
     *
     * All data comes exclusively from the ArtifactDB.
     */
    public async listSessions(): Promise<SessionSummary[]> {
        const summaries: SessionSummary[] = [];

        if (!this.db) {
            log.warn('[SessionManager] No ArtifactDB wired — returning empty session list');
            return summaries;
        }

        try {
            const rows: SessionRow[] = this.db.sessions.list();
            for (const row of rows) {
                const isActive = Boolean(
                    (this.currentSessionDirName && row.sessionDirName === this.currentSessionDirName) ||
                    (this.currentSessionId && row.sessionId === this.currentSessionId)
                );

                // Try to build summary from runbook JSON if present
                if (row.runbookJson) {
                    try {
                        const runbook = JSON.parse(row.runbookJson) as Runbook;
                        if (runbook && runbook.project_id && Array.isArray(runbook.phases)) {
                            const summary = this.runbookToSummary(
                                stripSessionDirPrefix(row.sessionDirName),
                                runbook,
                                row.createdAt,
                            );
                            summary.isActive = isActive;
                            summary.hasConsolidationReport = Boolean(row.consolidationReport);
                            summary.hasImplementationPlan = Boolean(row.implementationPlan);
                            summaries.push(summary);
                            continue;
                        }
                    } catch { /* fall through to prompt-only summary */ }
                }

                // Minimal summary from session row (no runbook available yet)
                summaries.push({
                    sessionId: row.sessionId || stripSessionDirPrefix(row.sessionDirName),
                    projectId: row.prompt
                        ? (row.prompt.length > 60 ? row.prompt.slice(0, 60) + '…' : row.prompt)
                        : 'New session',
                    status: (row.status as RunbookStatus) || 'idle',
                    phaseCount: 0,
                    completedPhases: 0,
                    createdAt: row.createdAt,
                    firstPrompt: row.prompt
                        ? (row.prompt.length > MAX_PROMPT_LENGTH
                            ? row.prompt.slice(0, MAX_PROMPT_LENGTH) + '…'
                            : row.prompt)
                        : '(empty)',
                    isActive,
                    hasConsolidationReport: Boolean(row.consolidationReport),
                    hasImplementationPlan: Boolean(row.implementationPlan),
                });
            }
        } catch (err) {
            log.error('[SessionManager] DB listSessions failed:', err);
        }

        // Sort by createdAt descending (most recent first)
        summaries.sort((a, b) => b.createdAt - a.createdAt);

        return summaries;
    }

    /**
     * Delete the oldest sessions that exceed `maxCount`.
     * Keeps the most recent `maxCount` sessions.
     * Uses the DB as the source of truth for session list.
     */
    public async pruneSessions(maxCount: number): Promise<void> {
        if (!this.db) return;

        try {
            const rows = this.db.sessions.list(); // already sorted by createdAt DESC
            if (rows.length <= maxCount) return;

            // Delete oldest (beyond maxCount) — rows are newest-first
            const toDelete = rows.slice(maxCount);
            for (const row of toDelete) {
                try {
                    const dir = path.join(this.ipcDir, row.sessionDirName);
                    await fs.rm(dir, { recursive: true, force: true });
                    this.db.deleteSessionFromDB(row.sessionDirName);
                    log.info(`[SessionManager] Pruned old session: ${row.sessionDirName}`);
                } catch {
                    // Best-effort pruning: individual session deletion may fail
                    // if files are locked or already removed — safe to skip.
                }
            }
        } catch (err) {
            log.warn('[SessionManager] pruneSessions failed:', err);
        }
    }

    /**
     * Search past sessions by query string.
     * Matches against `project_id`, first prompt, and session ID (case-insensitive).
     * All data comes exclusively from the ArtifactDB.
     */
    public async searchSessions(query: string): Promise<SessionSummary[]> {
        if (!query.trim()) return this.listSessions();

        const all = await this.listSessions();
        const q = query.toLowerCase();

        return all.filter(s =>
            s.projectId.toLowerCase().includes(q) ||
            s.firstPrompt.toLowerCase().includes(q) ||
            s.sessionId.toLowerCase().includes(q)
        );
    }

    /**
     * Deep search — also searches across ALL phase prompts for a session.
     * More expensive than `searchSessions()` since it reads full runbooks.
     * All data comes exclusively from the ArtifactDB.
     */
    public async deepSearchSessions(query: string): Promise<SessionSummary[]> {
        if (!query.trim()) return this.listSessions();

        const q = query.toLowerCase();
        const results: SessionSummary[] = [];

        if (!this.db) return results;

        try {
            const rows: SessionRow[] = this.db.sessions.list();
            for (const row of rows) {
                const isActive = Boolean(this.currentSessionDirName && row.sessionDirName === this.currentSessionDirName);

                if (!row.runbookJson) continue;
                try {
                    const runbook = JSON.parse(row.runbookJson) as Runbook;
                    if (!runbook || !runbook.project_id || !Array.isArray(runbook.phases)) continue;

                    const matchesProject = runbook.project_id.toLowerCase().includes(q);
                    const matchesPrompt = runbook.phases.some(p =>
                        p.prompt.toLowerCase().includes(q)
                    );
                    const matchesSessionPrompt = (row.prompt || '').toLowerCase().includes(q);

                    if (matchesProject || matchesPrompt || matchesSessionPrompt) {
                        const summary = this.runbookToSummary(
                            stripSessionDirPrefix(row.sessionDirName),
                            runbook,
                            row.createdAt,
                        );
                        summary.isActive = isActive;
                        results.push(summary);
                    }
                } catch { /* skip malformed runbook */ }
            }
        } catch (err) {
            log.error('[SessionManager] DB deepSearch failed:', err);
        }

        results.sort((a, b) => b.createdAt - a.createdAt);
        return results;
    }

    /**
     * Load the full runbook for a specific session.
     * Reads exclusively from the ArtifactDB.
     */
    public async getSessionRunbook(sessionId: string): Promise<Runbook | null> {
        if (!this.db) return null;

        try {
            // ARCH-2: Use targeted query instead of scanning full list
            const match = this.db.sessions.getBySessionId(sessionId)
                ?? this.db.sessions.getByDirName(sessionId);
            if (match?.runbookJson) {
                const runbook = JSON.parse(match.runbookJson) as Runbook;
                if (runbook && runbook.project_id && Array.isArray(runbook.phases)) {
                    return runbook;
                }
            }
        } catch (err) {
            log.warn('[SessionManager] getSessionRunbook failed:', err);
        }

        return null;
    }

    /**
     * Retrieve the consolidation report for a specific session.
     * Returns both the Markdown and structured JSON representations.
     * Reads exclusively from the ArtifactDB.
     */
    public async getConsolidationReport(
        sessionDirName: string
    ): Promise<{ markdown: string | null; json: string | null } | null> {
        if (!this.db) return null;

        try {
            const result = this.db.sessions.getConsolidationReport(sessionDirName);
            if (!result) return null;
            return {
                markdown: result.markdown,
                json: result.json,
            };
        } catch (err) {
            log.warn('[SessionManager] getConsolidationReport failed:', err);
            return null;
        }
    }

    /**
     * Retrieve the implementation plan for a specific session.
     * Reads exclusively from the ArtifactDB.
     */
    public async getImplementationPlan(
        sessionDirName: string
    ): Promise<string | null> {
        if (!this.db) return null;

        try {
            const result = this.db.sessions.getImplementationPlan(sessionDirName);
            if (result === undefined) return null;
            return result;
        } catch (err) {
            log.warn('[SessionManager] getImplementationPlan failed:', err);
            return null;
        }
    }

    /**
     * Get the absolute session directory path for a given session ID or dir name.
     * Pure path builder — does not scan the filesystem.
     */
    public getSessionDir(sessionIdOrDirName: string): string {
        // If it's already a full dir name (YYYYMMDD-HHMMSS-<uuid>), use directly
        if (/^\d{8}-\d{6}-.+$/.test(sessionIdOrDirName)) {
            return path.join(this.ipcDir, sessionIdOrDirName);
        }

        // ARCH-2: Use targeted query instead of scanning full list
        if (this.db) {
            try {
                const match = this.db.sessions.getBySessionId(sessionIdOrDirName)
                    ?? this.db.sessions.getByDirName(sessionIdOrDirName);
                if (match) {
                    return path.join(this.ipcDir, match.sessionDirName);
                }
            } catch {
                // DB lookup failure is non-fatal — fall through to raw ID path
            }
        }

        // Last resort: use the raw ID as directory name
        return path.join(this.ipcDir, sessionIdOrDirName);
    }

    /**
     * Delete a session directory and all its contents.
     * No-op if the directory doesn't exist.
     */
    public async deleteSession(sessionId: string): Promise<void> {
        const dir = this.getSessionDir(sessionId);
        try {
            await fs.rm(dir, { recursive: true, force: true });
            log.info(`[SessionManager] Deleted session: ${sessionId}`);
        } catch {
            // Best-effort filesystem deletion — fs.rm with force:true
            // already handles most failures; skip to continue with DB cleanup
        }

        // Also remove the corresponding rows from the database
        if (this.db) {
            try {
                const dirName = path.basename(dir);
                this.db.deleteSessionFromDB(dirName);
                log.info(`[SessionManager] Deleted session from DB: ${dirName}`);
            } catch (err) {
                log.warn('[SessionManager] Failed to delete session from DB:', err);
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Internals
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Convert a runbook + session ID into a SessionSummary.
     * If `overrideCreatedAt` is provided, it is used instead of extracting from the UUID.
     */
    private runbookToSummary(sessionId: string, runbook: Runbook, overrideCreatedAt?: number): SessionSummary {
        const firstPrompt = runbook.phases[0]?.prompt || '(empty)';
        return {
            sessionId,
            projectId: runbook.project_id,
            status: runbook.status,
            phaseCount: runbook.phases.length,
            completedPhases: runbook.phases.filter(p => p.status === 'completed').length,
            createdAt: overrideCreatedAt ?? extractUUIDv7Timestamp(sessionId),
            firstPrompt: firstPrompt.length > MAX_PROMPT_LENGTH
                ? firstPrompt.slice(0, MAX_PROMPT_LENGTH) + '…'
                : firstPrompt,
            isActive: false,
            hasConsolidationReport: false,
            hasImplementationPlan: false,
        };
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  UUIDv7 Generation
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Generate a UUIDv7-like identifier.
 * Embeds the current Unix timestamp (ms) in the first 48 bits,
 * sets version nibble to 7, and fills the rest with random bytes.
 */
export function generateUUIDv7(): string {
    const now = Date.now();
    const msHex = now.toString(16).padStart(12, '0');

    // Random bytes for the rest (10 bytes = 20 hex chars)
    const randomBytes = crypto.randomBytes(10);
    const randomHex = randomBytes.toString('hex');

    // UUIDv7 format: TTTTTTTT-TTTT-7xxx-yxxx-xxxxxxxxxxxx
    // T = timestamp, 7 = version, y = variant (8/9/a/b)
    const timeLow = msHex.slice(0, 8);     // 8 hex chars
    const timeMid = msHex.slice(8, 12);    // 4 hex chars
    const randA = '7' + randomHex.slice(0, 3); // version 7 + 3 random
    const variantNibble = (0x8 | (parseInt(randomHex[3], 16) & 0x3)).toString(16);
    const randB = variantNibble + randomHex.slice(4, 7);  // variant + 3 random
    const randC = randomHex.slice(7, 19);  // 12 random hex chars

    return `${timeLow}-${timeMid}-${randA}-${randB}-${randC}`;
}
