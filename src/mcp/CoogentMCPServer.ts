// ─────────────────────────────────────────────────────────────────────────────
// src/mcp/CoogentMCPServer.ts — Core MCP Server with persistent SQLite store
// ─────────────────────────────────────────────────────────────────────────────
// Sprint 2 refactor: Handler registration and tool implementations are now
// delegated to MCPResourceHandler, MCPToolHandler, and MCPValidator.
// This file retains the public API surface, lifecycle, and event wiring.

import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
    URI_MASTER_TASK_REGEX,
    URI_PHASE_ID_REGEX,
    type TaskState,
    type PhaseHandoff,
    type ParsedResourceURI,
} from './types.js';
import { ArtifactDB } from './ArtifactDB.js';
import { ArtifactDBBackup } from './ArtifactDBBackup.js';
import { MCPResourceHandler } from './MCPResourceHandler.js';
import { MCPToolHandler } from './MCPToolHandler.js';
import { MCPPromptHandler } from './MCPPromptHandler.js';
import {
    type SamplingProvider,
    NoopSamplingProvider,
    MCPSamplingProvider,
} from './SamplingProvider.js';
import { PluginLoader } from './PluginLoader.js';
import { DATABASE_FILE } from '../constants/paths.js';
import log from '../logger/log.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Type-safe event map for CoogentMCPServer
// ═══════════════════════════════════════════════════════════════════════════════

export interface CoogentMCPServerEvents {
    phaseCompleted: [handoff: PhaseHandoff];
}

// ═══════════════════════════════════════════════════════════════════════════════
//  URI Parsing Helpers
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Parse a `coogent://` URI into its constituent parts.
 *
 * Supported URI formats:
 *   coogent://tasks/{masterTaskId}/summary
 *   coogent://tasks/{masterTaskId}/implementation_plan
 *   coogent://tasks/{masterTaskId}/consolidation_report
 *   coogent://tasks/{masterTaskId}/phases/{phaseId}/implementation_plan
 *   coogent://tasks/{masterTaskId}/phases/{phaseId}/handoff
 *
 * @returns `null` if the URI is malformed or unrecognised.
 */
export function parseResourceURI(uri: string): ParsedResourceURI | null {
    // Normalise: trim whitespace and trailing slashes
    const cleaned = uri.trim().replace(/\/+$/, '');

    // Must start with the coogent:// scheme
    if (!cleaned.startsWith('coogent://tasks/')) {
        return null;
    }

    // Strip scheme + authority
    const pathPart = cleaned.slice('coogent://tasks/'.length);

    // Extract masterTaskId
    const masterMatch = pathPart.match(URI_MASTER_TASK_REGEX);
    if (!masterMatch) {
        return null;
    }
    const masterTaskId = masterMatch[1];

    // Everything after masterTaskId
    const afterMaster = pathPart.slice(
        pathPart.indexOf(masterTaskId) + masterTaskId.length
    );
    const segments = afterMaster.split('/').filter(Boolean);

    // Task-level resources: coogent://tasks/{id}/summary|implementation_plan|consolidation_report
    if (segments.length === 1) {
        const leaf = segments[0];
        if (leaf === 'summary' || leaf === 'implementation_plan' || leaf === 'consolidation_report') {
            return { masterTaskId, resource: leaf };
        }
        return null;
    }

    // Phase-level resources: coogent://tasks/{id}/phases/{phaseId}/implementation_plan|handoff
    if (segments.length >= 3 && segments[0] === 'phases') {
        const phaseMatch = segments[1].match(URI_PHASE_ID_REGEX);
        if (!phaseMatch) {
            return null;
        }
        const phaseId = phaseMatch[1];
        const leaf = segments[2];
        if (leaf === 'implementation_plan' || leaf === 'handoff') {
            return { masterTaskId, phaseId, resource: leaf };
        }
        return null;
    }

    return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Private Utilities
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * R-2: Truncate a string to at most `limit` UTF-16 code units while avoiding
 * splitting a surrogate pair.
 *
 * JavaScript string indexing is code-unit based (UTF-16). Characters outside
 * the Basic Multilingual Plane (e.g. emoji, supplementary CJK) are encoded as
 * two code units called a surrogate pair. A raw `slice(0, limit)` can cut
 * between the leading surrogate (0xD800–0xDBFF) and its trailing partner
 * (0xDC00–0xDFFF), yielding a lone surrogate. Lone surrogates are ill-formed
 * in UTF-8 / JSON and some runtimes serialize them as U+FFFD replacement chars
 * or throw a serialization error.
 *
 * This function backs up by one code unit when the cut point lands on a leading
 * surrogate to keep surrogate pairs intact.
 *
 * @param s     The source string.
 * @param limit Maximum number of UTF-16 code units to keep.
 * @returns     The safely truncated string (≤ limit code units).
 */
export function safeTruncate(s: string, limit: number): string {
    if (s.length <= limit) return s;
    // If the character at position (limit - 1) is a leading surrogate, back up
    // by one to avoid splitting the pair.
    const c = s.charCodeAt(limit - 1);
    const cutAt = (c >= 0xD800 && c <= 0xDBFF) ? limit - 1 : limit;
    return s.slice(0, cutAt);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  CoogentMCPServer
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Core MCP Server that manages all DAG state via persistent SQLite storage
 * (ArtifactDB) and exposes it via MCP Resources (read) and MCP Tools (mutate).
 *
 * Sprint 2 refactor: Handler registration is delegated to:
 *   - MCPResourceHandler (ListResources, ReadResource)
 *   - MCPToolHandler (ListTools, CallTool, tool implementations)
 *   - MCPValidator (input validation helpers)
 *
 * This class retains:
 *   - Public API surface (getServer, getTaskState, purgeTask, upsertSummary, etc.)
 *   - Lifecycle management (init, dispose)
 *   - Event wiring (phaseCompleted)
 */
export class CoogentMCPServer {
    // ── Persistent Store ─────────────────────────────────────────────────
    private db!: ArtifactDB;
    private readonly server: Server;
    private readonly emitter = new EventEmitter();
    private readonly workspaceRoot: string;
    private pluginLoader: PluginLoader | null = null;
    private backupManager: ArtifactDBBackup | null = null;

    constructor(workspaceRoot: string) {
        this.workspaceRoot = workspaceRoot;

        this.server = new Server(
            { name: 'coogent-mcp-server', version: '0.2.0' },
            {
                capabilities: {
                    resources: {},
                    tools: {},
                    prompts: {},
                },
            }
        );

        log.info('[CoogentMCPServer] Initialised with workspace root:', workspaceRoot);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Async Initialisation — MUST be called after construction
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Initialise the persistent SQLite store. Must be called after construction
     * and before any tool/resource calls.
     *
     * @param coogentDir Absolute path to the `.coogent/` directory.
     *        The database file will be created at `<coogentDir>/artifacts.db`.
     *        Data is keyed by masterTaskId so all sessions share one DB safely.
     * @param workspaceId Tenant identifier for workspace-scoped queries (default: '').
     */
    async init(coogentDir: string, workspaceId: string = ''): Promise<void> {
        const dbPath = path.join(coogentDir, DATABASE_FILE);
        this.db = await ArtifactDB.create(dbPath, workspaceId);

        // Initialise backup manager (default backup dir: <coogentDir>/backups/)
        const backupDir = path.join(coogentDir, 'backups');
        this.backupManager = new ArtifactDBBackup(dbPath, backupDir);
        this.db.setBackupManager(this.backupManager);

        // Register protocol handlers now that DB is ready
        new MCPResourceHandler(this.server, this.db).register();
        new MCPToolHandler(this.server, this.db, this.workspaceRoot, this.emitter).register();
        new MCPPromptHandler(this.server).register();

        // Load plugins (Sprint 5) — fire-and-forget, errors are isolated
        this.pluginLoader = new PluginLoader(this.workspaceRoot);
        try {
            await this.pluginLoader.loadAll({
                server: this.server,
                db: this.db,
                workspaceRoot: this.workspaceRoot,
            });
        } catch (err) {
            log.warn('[CoogentMCPServer] Plugin loading failed:', (err as Error).message);
        }

        log.info('[CoogentMCPServer] ArtifactDB initialised at:', dbPath);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Lifecycle
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Flush pending writes and release the SQLite database handle.
     * Call on extension deactivation or session switch.
     */
    dispose(): void {
        // Deactivate plugins first (Sprint 5)
        this.pluginLoader?.disposeAll().catch((err) => {
            log.warn('[CoogentMCPServer] Plugin dispose error:', (err as Error).message);
        });

        this.db.close();
        log.info('[CoogentMCPServer] ArtifactDB disposed.');
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Public API
    // ═══════════════════════════════════════════════════════════════════════

    /** Get the underlying MCP `Server` instance for transport wiring. */
    getServer(): Server {
        return this.server;
    }

    /** Get the underlying ArtifactDB for direct DB access (e.g., StateManager runbook mirror). */
    getArtifactDB(): ArtifactDB {
        return this.db;
    }

    /**
     * Return a SamplingProvider gated by the `coogent.enableSampling` feature flag.
     *
     * When sampling is enabled AND the connected client advertises sampling
     * capability, this returns an `MCPSamplingProvider`.
     * Otherwise, it returns a `NoopSamplingProvider` so callers can safely
     * fall back to existing (non-sampling) behaviour.
     */
    getSamplingProvider(): SamplingProvider {
        try {
            // Dynamic import to avoid hard dependency on vscode in test environments
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const vscode = require('vscode') as typeof import('vscode');
            const enabled = vscode.workspace
                .getConfiguration('coogent')
                .get<boolean>('enableSampling', false);
            if (enabled) {
                return new MCPSamplingProvider(this.server);
            }
        } catch {
            // vscode module unavailable (unit test environment) — fall through to noop
        }
        return new NoopSamplingProvider();
    }

    /** Get the full task state for internal use (e.g., from the engine). */
    getTaskState(masterTaskId: string): TaskState | undefined {
        return this.db.tasks.get(masterTaskId);
    }

    /**
     * Remove a task from the persistent store (B-4 fix).
     * Call this on session reset to prevent unbounded storage growth.
     */
    purgeTask(masterTaskId: string): void {
        this.db.tasks.delete(masterTaskId);
        log.info(`[CoogentMCPServer] Purged task: ${masterTaskId}`);
    }

    /**
     * Called on CMD_RESET when switching away from a session.
     * No data is deleted — session switching only resets the UI.
     * All task and phase data is preserved in SQLite for historical access.
     */
    purgeTaskKeepSession(masterTaskId: string): void {
        // No data deletion — session switching only resets the UI.
        // All task and phase-level data is preserved for historical browsing.
        log.info(`[CoogentMCPServer] Session switched away from: ${masterTaskId}`);
    }

    /**
     * Persist the user's original prompt as the task summary.
     * Called directly by the extension host (not via MCP tool protocol)
     * to ensure the prompt survives extension restarts.
     */
    upsertSummary(masterTaskId: string, summary: string): void {
        this.db.tasks.upsert(masterTaskId, { summary });
        log.info(`[CoogentMCPServer] Task summary saved: ${masterTaskId}`);
    }

    /**
     * Mark a task as completed with a timestamp.
     * Called by EngineWiring on `run:completed` event.
     */
    setTaskCompleted(masterTaskId: string): void {
        this.db.tasks.upsert(masterTaskId, { completedAt: Date.now() });
        log.info(`[CoogentMCPServer] Task marked completed: ${masterTaskId}`);
    }

    /**
     * Persist accumulated worker output for a phase.
     * Called by EngineWiring on worker exit to survive session loads.
     */
    upsertWorkerOutput(masterTaskId: string, phaseId: string, output: string, stderr: string = ''): void {
        this.db.phases.upsertOutput(masterTaskId, phaseId, output, stderr);
    }

    /**
     * Mark whether an implementation plan is required for a phase.
     * Called by EngineWiring after agent selection resolves the profile.
     */
    setPhasePlanRequired(masterTaskId: string, phaseId: string, required: boolean): void {
        this.db.phases.upsertPlanRequired(masterTaskId, phaseId, required);
    }

    /**
     * Retrieve all persisted worker outputs for a task, keyed by phase_id.
     * Used during session load to hydrate the webview.
     */
    getWorkerOutputs(masterTaskId: string): Record<string, string> {
        return this.db.phases.getOutputs(masterTaskId);
    }

    // ── Session Tracking ─────────────────────────────────────────────────

    /**
     * Persist session metadata to SQLite.
     * Replaces the old `current-session` file approach.
     */
    upsertSession(dirName: string, sessionId: string, prompt: string, createdAt: number): void {
        this.db.sessions.upsert(dirName, sessionId, prompt, createdAt);
    }

    /** Retrieve the most recently created session. */
    getLatestSession(): { dirName: string; sessionId: string; prompt: string; createdAt: number } | undefined {
        return this.db.sessions.getLatest();
    }

    // ── Phase Log Tracking ───────────────────────────────────────────────

    /**
     * Persist a phase execution log (prompt, context, response, timing).
     * Called by EngineWiring on phase start and completion.
     */
    upsertPhaseLog(
        masterTaskId: string,
        phaseId: string,
        fields: {
            prompt?: string;
            requestContext?: string;
            response?: string;
            exitCode?: number;
            startedAt?: number;
            completedAt?: number;
        }
    ): void {
        this.db.phases.upsertLog(masterTaskId, phaseId, fields);
    }

    /** Retrieve a phase execution log. */
    getPhaseLog(
        masterTaskId: string,
        phaseId: string
    ): {
        prompt: string;
        requestContext: string;
        response: string;
        exitCode: number | null;
        startedAt: number;
        completedAt: number | null;
    } | undefined {
        return this.db.phases.getLog(masterTaskId, phaseId);
    }

    /**
     * Register a listener for the `phaseCompleted` event.
     * Fires whenever `submit_phase_handoff` is called successfully.
     */
    onPhaseCompleted(listener: (handoff: PhaseHandoff) => void): void {
        this.emitter.on('phaseCompleted', listener);
    }

    /** Remove a `phaseCompleted` listener. */
    offPhaseCompleted(listener: (handoff: PhaseHandoff) => void): void {
        this.emitter.off('phaseCompleted', listener);
    }

    // ── Backup / Restore ──────────────────────────────────────────────────

    /**
     * Create a snapshot backup of the current database.
     * Delegates to the ArtifactDBBackup instance created during init().
     *
     * @returns Absolute path to the created backup file.
     * @throws If the backup manager has not been initialised (init() not called).
     */
    async createBackup(): Promise<string> {
        if (!this.backupManager) {
            throw new Error('[CoogentMCPServer] Backup manager not initialised. Call init() first.');
        }
        const backupPath = await this.backupManager.createSnapshot();
        await this.backupManager.rotateBackups();
        return backupPath;
    }

    /**
     * Restore the database from a backup file.
     * After restoring, the server should be re-initialised to reload from disk.
     *
     * @param backupPath Absolute path to the backup file.
     * @throws If the backup manager has not been initialised or the backup file is missing.
     */
    async restoreBackup(backupPath: string): Promise<void> {
        if (!this.backupManager) {
            throw new Error('[CoogentMCPServer] Backup manager not initialised. Call init() first.');
        }
        await this.backupManager.restoreFromBackup(backupPath);
    }
}
