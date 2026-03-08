// ─────────────────────────────────────────────────────────────────────────────
// src/session/SessionManager.ts — Discovers, searches, and loads past sessions
// ─────────────────────────────────────────────────────────────────────────────

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { RUNBOOK_FILENAME } from '../types/index.js';
import type { Runbook, RunbookStatus } from '../types/index.js';
import { StateManager } from '../state/StateManager.js';
import type { ArtifactDB } from '../mcp/ArtifactDB.js';
import { IPC_DIR } from '../constants/paths.js';
import log from '../logger/log.js';

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
}

// ═══════════════════════════════════════════════════════════════════════════════
//  UUIDv7 Timestamp Extraction
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Extract the millisecond timestamp embedded in a UUIDv7.
 * Handles both raw UUIDs and prefixed directory names (YYYYMMDD-HHMMSS-<uuid>).
 * UUIDv7 format: `TTTTTTTT-TTTT-7xxx-yxxx-xxxxxxxxxxxx`
 * The first 48 bits (12 hex chars across the first two segments) encode Unix ms.
 */
export function extractUUIDv7Timestamp(dirNameOrUuid: string): number {
    // Strip YYYYMMDD-HHMMSS- prefix if present (Bug 2)
    const uuid = stripSessionDirPrefix(dirNameOrUuid);
    const parts = uuid.split('-');
    if (parts.length < 2) return 0;
    const hex = parts[0] + parts[1]; // 8 + 4 = 12 hex chars = 48 bits
    return parseInt(hex, 16) || 0;
}

/**
 * Format a session directory name as `YYYYMMDD-HHMMSS-<uuid>` (Bug 2).
 */
export function formatSessionDirName(uuid: string, now = new Date()): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-`
        + `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    return `${ts}-${uuid}`;
}

/** Regex matching the new session dir format: YYYYMMDD-HHMMSS-<uuid> */
const SESSION_DIR_REGEX = /^\d{8}-\d{6}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Strip the `YYYYMMDD-HHMMSS-` prefix from a session directory name to get the raw UUID.
 * Returns the input unchanged if no prefix is present.
 */
export function stripSessionDirPrefix(dirName: string): string {
    // Prefix format: 8 digits + dash + 6 digits + dash = 16 chars
    const prefixMatch = dirName.match(/^\d{8}-\d{6}-(.+)$/);
    return prefixMatch ? prefixMatch[1] : dirName;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SessionManager
// ═══════════════════════════════════════════════════════════════════════════════

const MAX_SESSIONS = 50;
const MAX_PROMPT_LENGTH = 120;

/**
 * Discovers and manages past Coogent sessions.
 *
 * Sessions are stored under `<storageBase>/ipc/YYYYMMDD-HHMMSS-<uuid>/`,
 * each containing a `.task-runbook.json`. This class scans those directories,
 * extracts metadata, and supports full-text search across phase prompts.
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

    constructor(storageBase: string, currentSessionId: string, currentSessionDirName?: string) {
        this.ipcDir = path.join(storageBase, IPC_DIR);
        this.currentSessionId = currentSessionId;
        this.currentSessionDirName = currentSessionDirName ?? currentSessionId;
    }

    /**
     * Wire the ArtifactDB for DB-first session listing.
     * After calling this, `listSessions()` queries the DB with IPC fallback.
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
     * List all past sessions, sorted by most recent first.
     * Excludes the currently active session.
     *
     * DB-first: queries ArtifactDB if available, falling back to IPC
     * directory scan for legacy sessions not yet in the database.
     */
    public async listSessions(): Promise<SessionSummary[]> {
        const seenDirNames = new Set<string>();
        const summaries: SessionSummary[] = [];

        // ── Primary: DB query ────────────────────────────────────────
        if (this.db) {
            try {
                const rows = this.db.sessions.list();
                for (const row of rows) {
                    // Exclude current active session
                    if (row.sessionDirName === this.currentSessionDirName) continue;
                    if (row.sessionId === this.currentSessionId) continue;

                    seenDirNames.add(row.sessionDirName);

                    // Try to build summary from runbook JSON if present
                    if (row.runbookJson) {
                        try {
                            const runbook = JSON.parse(row.runbookJson) as Runbook;
                            if (runbook && runbook.project_id && Array.isArray(runbook.phases)) {
                                summaries.push(this.runbookToSummary(
                                    stripSessionDirPrefix(row.sessionDirName),
                                    runbook,
                                    row.createdAt,
                                ));
                                continue;
                            }
                        } catch { /* fall through to prompt-only summary */ }
                    }

                    // Minimal summary from session row (no runbook available yet)
                    summaries.push({
                        sessionId: row.sessionId || stripSessionDirPrefix(row.sessionDirName),
                        projectId: '(pending)',
                        status: (row.status as RunbookStatus) || 'idle',
                        phaseCount: 0,
                        completedPhases: 0,
                        createdAt: row.createdAt,
                        firstPrompt: row.prompt
                            ? (row.prompt.length > MAX_PROMPT_LENGTH
                                ? row.prompt.slice(0, MAX_PROMPT_LENGTH) + '…'
                                : row.prompt)
                            : '(empty)',
                    });
                }
            } catch (err) {
                log.warn('[SessionManager] DB listSessions failed, using IPC fallback:', err);
            }
        }

        // ── Fallback: IPC directory scan (legacy sessions not in DB) ──
        const dirs = await this.discoverSessionDirs();
        for (const dir of dirs) {
            const dirName = path.basename(dir);
            if (seenDirNames.has(dirName)) continue; // already from DB
            const summary = await this.readSessionSummary(dir);
            if (summary) summaries.push(summary);
        }

        // Sort by createdAt descending (most recent first)
        summaries.sort((a, b) => b.createdAt - a.createdAt);

        // Prune excess sessions asynchronously (non-blocking)
        this.pruneSessions(MAX_SESSIONS).catch(() => { /* best-effort */ });

        return summaries;
    }

    /**
     * Delete the oldest sessions that exceed `maxCount`.
     * Keeps the most recent `maxCount` sessions.
     */
    public async pruneSessions(maxCount: number): Promise<void> {
        const dirs = await this.discoverSessionDirs();
        if (dirs.length <= maxCount) return;

        // Extract timestamps and sort oldest-first
        const withTimestamp = dirs.map(dir => ({
            dir,
            ts: extractUUIDv7Timestamp(path.basename(dir)),
        }));
        withTimestamp.sort((a, b) => a.ts - b.ts);

        // Delete oldest (beyond maxCount)
        const toDelete = withTimestamp.slice(0, withTimestamp.length - maxCount);
        for (const { dir } of toDelete) {
            try {
                await fs.rm(dir, { recursive: true, force: true });
                log.info(`[SessionManager] Pruned old session: ${path.basename(dir)}`);
            } catch {
                // Best-effort: skip if deletion fails
            }
        }
    }

    /**
     * Search past sessions by query string.
     * Matches against `project_id` and all phase prompts (case-insensitive).
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
     *
     * DB-first: uses DB runbook JSON when available, IPC fallback for legacy sessions.
     */
    public async deepSearchSessions(query: string): Promise<SessionSummary[]> {
        if (!query.trim()) return this.listSessions();

        const q = query.toLowerCase();
        const results: SessionSummary[] = [];
        const seenDirNames = new Set<string>();

        // ── Primary: DB search ───────────────────────────────────────
        if (this.db) {
            try {
                const rows = this.db.sessions.list();
                for (const row of rows) {
                    if (row.sessionDirName === this.currentSessionDirName) continue;
                    seenDirNames.add(row.sessionDirName);

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
                            results.push(this.runbookToSummary(
                                stripSessionDirPrefix(row.sessionDirName),
                                runbook,
                                row.createdAt,
                            ));
                        }
                    } catch { /* skip malformed runbook */ }
                }
            } catch (err) {
                log.warn('[SessionManager] DB deepSearch failed, using IPC fallback:', err);
            }
        }

        // ── Fallback: IPC directory scan (legacy) ────────────────────
        const dirs = await this.discoverSessionDirs();
        for (const dir of dirs) {
            const dirName = path.basename(dir);
            if (seenDirNames.has(dirName)) continue;

            const runbook = await this.readRunbook(dir);
            if (!runbook) continue;

            const sessionId = path.basename(dir);
            const matchesProject = runbook.project_id.toLowerCase().includes(q);
            const matchesPrompt = runbook.phases.some(p =>
                p.prompt.toLowerCase().includes(q)
            );

            if (matchesProject || matchesPrompt) {
                results.push(this.runbookToSummary(sessionId, runbook));
            }
        }

        results.sort((a, b) => b.createdAt - a.createdAt);
        return results;
    }

    /**
     * Load the full runbook for a specific session.
     * DB-first: reads from tasks.runbook_json, IPC fallback.
     */
    public async getSessionRunbook(sessionId: string): Promise<Runbook | null> {
        // Try DB first via session dir name lookup
        if (this.db) {
            try {
                const rows = this.db.sessions.list();
                const match = rows.find(r =>
                    stripSessionDirPrefix(r.sessionDirName) === sessionId ||
                    r.sessionId === sessionId
                );
                if (match?.runbookJson) {
                    const runbook = JSON.parse(match.runbookJson) as Runbook;
                    if (runbook && runbook.project_id && Array.isArray(runbook.phases)) {
                        return runbook;
                    }
                }
            } catch { /* fall through to IPC */ }
        }

        const dir = this.getSessionDir(sessionId);
        return this.readRunbook(dir);
    }

    /**
     * Get the absolute session directory path for a given session ID.
     * Scans the ipcDir for a directory ending in the UUID (handles prefixed names).
     */
    public getSessionDir(sessionId: string): string {
        // Fast path: try prefixed lookup by scanning
        try {
            const entries = require('node:fs').readdirSync(this.ipcDir, { withFileTypes: true });
            for (const e of entries) {
                if (e.isDirectory() && e.name.endsWith(sessionId)) {
                    return path.join(this.ipcDir, e.name);
                }
            }
        } catch {
            // Fall through to default
        }
        return path.join(this.ipcDir, sessionId);
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
            // Best-effort: skip if deletion fails
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Internals
    // ─────────────────────────────────────────────────────────────────────────

    /** Discover session directories, excluding the current active one. */
    private async discoverSessionDirs(): Promise<string[]> {
        // Bug 2: Match new YYYYMMDD-HHMMSS-<uuid> format only
        try {
            const entries = await fs.readdir(this.ipcDir, { withFileTypes: true });
            return entries
                .filter(e => {
                    if (!e.isDirectory()) return false;
                    // Exclude current session (check if dir name ends with current ID)
                    if (e.name === this.currentSessionId || e.name.endsWith(this.currentSessionId)) return false;
                    return SESSION_DIR_REGEX.test(e.name);
                })
                .map(e => path.join(this.ipcDir, e.name));
        } catch {
            // ipc directory may not exist yet
            return [];
        }
    }

    /** Read and parse a runbook from a session directory. */
    private async readRunbook(sessionDir: string): Promise<Runbook | null> {
        const runbookPath = path.join(sessionDir, RUNBOOK_FILENAME);
        try {
            const raw = await fs.readFile(runbookPath, 'utf-8');
            const parsed = JSON.parse(raw);

            // #45: Validate JSON shape instead of blind `as Runbook` cast
            if (!parsed || typeof parsed !== 'object') return null;
            if (typeof parsed.project_id !== 'string') return null;
            if (typeof parsed.status !== 'string') return null;
            if (!Array.isArray(parsed.phases)) return null;

            return parsed as Runbook;
        } catch {
            return null;
        }
    }

    /** Read a session directory and extract a summary. */
    private async readSessionSummary(sessionDir: string): Promise<SessionSummary | null> {
        const runbook = await this.readRunbook(sessionDir);
        if (!runbook) return null;

        const dirName = path.basename(sessionDir);
        // Extract the UUID portion from the directory name
        const sessionId = stripSessionDirPrefix(dirName);
        return this.runbookToSummary(sessionId, runbook);
    }

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
