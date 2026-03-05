// ─────────────────────────────────────────────────────────────────────────────
// src/session/SessionManager.ts — Discovers, searches, and loads past sessions
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Runbook, RunbookStatus } from '../types/index.js';

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
 * UUIDv7 format: `TTTTTTTT-TTTT-7xxx-yxxx-xxxxxxxxxxxx`
 * The first 48 bits (12 hex chars across the first two segments) encode Unix ms.
 */
export function extractUUIDv7Timestamp(uuid: string): number {
    const parts = uuid.split('-');
    if (parts.length < 2) return 0;
    const hex = parts[0] + parts[1]; // 8 + 4 = 12 hex chars = 48 bits
    return parseInt(hex, 16) || 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SessionManager
// ═══════════════════════════════════════════════════════════════════════════════

const RUNBOOK_FILENAME = '.task-runbook.json';
const MAX_PROMPT_LENGTH = 120;

/**
 * Discovers and manages past Coogent sessions.
 *
 * Sessions are stored under `<workspace>/.coogent/ipc/<uuid>/`, each
 * containing a `.task-runbook.json`. This class scans those directories,
 * extracts metadata, and supports full-text search across phase prompts.
 */
export class SessionManager {
    /** Absolute path to `.coogent/ipc/` within the workspace root. */
    private readonly ipcDir: string;

    /** The current active session ID (excluded from history). */
    private currentSessionId: string;

    constructor(workspaceRoot: string, currentSessionId: string) {
        this.ipcDir = path.join(workspaceRoot, '.coogent', 'ipc');
        this.currentSessionId = currentSessionId;
    }

    /** Update the active session ID (e.g. after switching sessions). */
    public setCurrentSessionId(id: string): void {
        this.currentSessionId = id;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Public API
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * List all past sessions, sorted by most recent first.
     * Excludes the currently active session.
     */
    public async listSessions(): Promise<SessionSummary[]> {
        const dirs = await this.discoverSessionDirs();
        const summaries: SessionSummary[] = [];

        for (const dir of dirs) {
            const summary = await this.readSessionSummary(dir);
            if (summary) summaries.push(summary);
        }

        // Sort by createdAt descending (most recent first)
        summaries.sort((a, b) => b.createdAt - a.createdAt);
        return summaries;
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
     */
    public async deepSearchSessions(query: string): Promise<SessionSummary[]> {
        if (!query.trim()) return this.listSessions();

        const dirs = await this.discoverSessionDirs();
        const q = query.toLowerCase();
        const results: SessionSummary[] = [];

        for (const dir of dirs) {
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
     */
    public async getSessionRunbook(sessionId: string): Promise<Runbook | null> {
        const dir = path.join(this.ipcDir, sessionId);
        return this.readRunbook(dir);
    }

    /**
     * Get the absolute session directory path for a given session ID.
     */
    public getSessionDir(sessionId: string): string {
        return path.join(this.ipcDir, sessionId);
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Internals
    // ─────────────────────────────────────────────────────────────────────────

    /** Discover session directories, excluding the current active one. */
    private async discoverSessionDirs(): Promise<string[]> {
        try {
            const entries = await fs.readdir(this.ipcDir, { withFileTypes: true });
            return entries
                .filter(e => e.isDirectory() && e.name !== this.currentSessionId)
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
            return JSON.parse(raw) as Runbook;
        } catch {
            return null;
        }
    }

    /** Read a session directory and extract a summary. */
    private async readSessionSummary(sessionDir: string): Promise<SessionSummary | null> {
        const runbook = await this.readRunbook(sessionDir);
        if (!runbook) return null;

        const sessionId = path.basename(sessionDir);
        return this.runbookToSummary(sessionId, runbook);
    }

    /** Convert a runbook + session ID into a SessionSummary. */
    private runbookToSummary(sessionId: string, runbook: Runbook): SessionSummary {
        const firstPrompt = runbook.phases[0]?.prompt || '(empty)';
        return {
            sessionId,
            projectId: runbook.project_id,
            status: runbook.status,
            phaseCount: runbook.phases.length,
            completedPhases: runbook.phases.filter(p => p.status === 'completed').length,
            createdAt: extractUUIDv7Timestamp(sessionId),
            firstPrompt: firstPrompt.length > MAX_PROMPT_LENGTH
                ? firstPrompt.slice(0, MAX_PROMPT_LENGTH) + '…'
                : firstPrompt,
        };
    }
}
