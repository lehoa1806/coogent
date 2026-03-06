// ─────────────────────────────────────────────────────────────────────────────
// src/mcp/CoogentMCPServer.ts — Core MCP Server with persistent SQLite store
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
    ListResourcesRequestSchema,
    ReadResourceRequestSchema,
    ListToolsRequestSchema,
    CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type {
    TaskState,
    PhaseHandoff,
    ParsedResourceURI,
} from './types.js';
import {
    MASTER_TASK_ID_PATTERN,
    PHASE_ID_PATTERN,
    URI_MASTER_TASK_REGEX,
    URI_PHASE_ID_REGEX,
    RESOURCE_URIS,
    MCP_TOOLS,
} from './types.js';
import { ArtifactDB } from './ArtifactDB.js';
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
 * Resources (read-only):
 *   - coogent://tasks/{masterTaskId}/summary
 *   - coogent://tasks/{masterTaskId}/implementation_plan
 *   - coogent://tasks/{masterTaskId}/consolidation_report
 *   - coogent://tasks/{masterTaskId}/phases/{phaseId}/implementation_plan
 *   - coogent://tasks/{masterTaskId}/phases/{phaseId}/handoff
 *
 * Tools (mutating):
 *   - submit_implementation_plan
 *   - submit_phase_handoff
 *   - submit_consolidation_report
 *   - get_modified_file_content
 */
export class CoogentMCPServer {
    // ── Persistent Store ─────────────────────────────────────────────────
    private db!: ArtifactDB;
    private readonly server: Server;
    private readonly emitter = new EventEmitter();
    private readonly workspaceRoot: string;

    constructor(workspaceRoot: string) {
        this.workspaceRoot = workspaceRoot;

        this.server = new Server(
            { name: 'coogent-mcp-server', version: '0.1.0' },
            {
                capabilities: {
                    resources: {},
                    tools: {},
                },
            }
        );

        this.registerResourceHandlers();
        this.registerToolHandlers();

        log.info('[CoogentMCPServer] Initialised with workspace root:', workspaceRoot);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Async Initialisation — MUST be called after construction
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Initialise the persistent SQLite store. Must be called after construction
     * and before any tool/resource calls.
     *
     * @param sessionDir Absolute path to the session directory
     *        (e.g. `/workspace/.coogent/ipc/20260307-000104-<uuid>`).
     *        The database file will be created at `<sessionDir>/artifacts.db`.
     */
    async init(sessionDir: string): Promise<void> {
        this.db = await ArtifactDB.create(path.join(sessionDir, 'artifacts.db'));
        log.info('[CoogentMCPServer] ArtifactDB initialised at:', path.join(sessionDir, 'artifacts.db'));
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Lifecycle
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Flush pending writes and release the SQLite database handle.
     * Call on extension deactivation or session switch.
     */
    dispose(): void {
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

    /** Get the full task state for internal use (e.g., from the engine). */
    getTaskState(masterTaskId: string): TaskState | undefined {
        return this.db.getTask(masterTaskId);
    }

    /**
     * Remove a task from the persistent store (B-4 fix).
     * Call this on session reset to prevent unbounded storage growth.
     */
    purgeTask(masterTaskId: string): void {
        this.db.deleteTask(masterTaskId);
        log.info(`[CoogentMCPServer] Purged task: ${masterTaskId}`);
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

    // ═══════════════════════════════════════════════════════════════════════
    //  Resource Handlers
    // ═══════════════════════════════════════════════════════════════════════

    private registerResourceHandlers(): void {
        // ── ListResourcesRequest ─────────────────────────────────────────
        this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
            const resources: Array<{
                uri: string;
                name: string;
                mimeType: string;
            }> = [];

            const taskIds = this.db.listTaskIds();
            for (const taskId of taskIds) {
                // Task-level resources
                resources.push({
                    uri: RESOURCE_URIS.taskSummary(taskId),
                    name: `Task ${taskId} — Summary`,
                    mimeType: 'text/plain',
                });
                resources.push({
                    uri: RESOURCE_URIS.taskPlan(taskId),
                    name: `Task ${taskId} — Implementation Plan`,
                    mimeType: 'text/markdown',
                });
                resources.push({
                    uri: RESOURCE_URIS.taskReport(taskId),
                    name: `Task ${taskId} — Consolidation Report`,
                    mimeType: 'text/markdown',
                });

                // Phase-level resources — lightweight query avoids full task deserialization
                const phaseIds = this.db.listPhaseIds(taskId);
                for (const phaseId of phaseIds) {
                    resources.push({
                        uri: RESOURCE_URIS.phasePlan(taskId, phaseId),
                        name: `Phase ${phaseId} — Implementation Plan`,
                        mimeType: 'text/markdown',
                    });
                    resources.push({
                        uri: RESOURCE_URIS.phaseHandoff(taskId, phaseId),
                        name: `Phase ${phaseId} — Handoff`,
                        mimeType: 'application/json',
                    });
                }
            }

            return { resources };
        });

        // ── ReadResourceRequest ──────────────────────────────────────────
        this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
            const uri = request.params.uri;
            const parsed = parseResourceURI(uri);

            if (!parsed) {
                throw new Error(`Unknown or malformed resource URI: ${uri}`);
            }

            const task = this.db.getTask(parsed.masterTaskId);
            if (!task) {
                throw new Error(`Task not found: ${parsed.masterTaskId}`);
            }

            let content: string;

            if (parsed.phaseId) {
                // Phase-level resource
                const phase = task.phases.get(parsed.phaseId);
                if (!phase) {
                    throw new Error(
                        `Phase not found: ${parsed.phaseId} in task ${parsed.masterTaskId}`
                    );
                }

                switch (parsed.resource) {
                    case 'implementation_plan':
                        if (!phase.implementationPlan) {
                            throw new Error(
                                `Resource not yet available: implementation plan has not been submitted for phase ${parsed.phaseId} of task ${parsed.masterTaskId}.`
                            );
                        }
                        content = phase.implementationPlan;
                        break;
                    case 'handoff':
                        if (!phase.handoff) {
                            throw new Error(
                                `Resource not yet available: handoff has not been submitted for phase ${parsed.phaseId} of task ${parsed.masterTaskId}.`
                            );
                        }
                        content = JSON.stringify(phase.handoff, null, 2);
                        break;
                    default:
                        throw new Error(`Unknown phase resource: ${parsed.resource}`);
                }
            } else {
                // Task-level resource
                switch (parsed.resource) {
                    case 'summary':
                        if (!task.summary) {
                            throw new Error(
                                `Resource not yet available: summary has not been set for task ${parsed.masterTaskId}.`
                            );
                        }
                        content = task.summary;
                        break;
                    case 'implementation_plan':
                        if (!task.implementationPlan) {
                            throw new Error(
                                `Resource not yet available: implementation plan has not been submitted for task ${parsed.masterTaskId}.`
                            );
                        }
                        content = task.implementationPlan;
                        break;
                    case 'consolidation_report':
                        if (!task.consolidationReport) {
                            throw new Error(
                                `Resource not yet available: consolidation report has not been submitted for task ${parsed.masterTaskId}.`
                            );
                        }
                        content = task.consolidationReport;
                        break;
                    default:
                        throw new Error(`Unknown task resource: ${parsed.resource}`);
                }
            }

            return {
                contents: [
                    {
                        uri,
                        text: content,
                        mimeType: parsed.resource === 'handoff'
                            ? 'application/json'
                            : parsed.resource === 'summary'
                                ? 'text/plain'
                                : 'text/markdown',
                    },
                ],
            };
        });
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Tool Handlers
    // ═══════════════════════════════════════════════════════════════════════

    private registerToolHandlers(): void {
        // ── ListToolsRequest ─────────────────────────────────────────────
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            return {
                tools: [
                    {
                        name: MCP_TOOLS.SUBMIT_IMPLEMENTATION_PLAN,
                        description:
                            'Submit an implementation plan (Markdown) at the master-task or phase level.',
                        inputSchema: {
                            type: 'object' as const,
                            required: ['masterTaskId', 'markdown_content'],
                            properties: {
                                masterTaskId: {
                                    type: 'string',
                                    description:
                                        'Master task ID in YYYYMMDD-HHMMSS-<uuid> format.',
                                    pattern: MASTER_TASK_ID_PATTERN.source,
                                },
                                phaseId: {
                                    type: 'string',
                                    description:
                                        'Optional phase ID in phase-<index>-<uuid> format. If provided, saves the plan at the phase level.',
                                    pattern: PHASE_ID_PATTERN.source,
                                },
                                markdown_content: {
                                    type: 'string',
                                    description:
                                        'Markdown content of the implementation plan.',
                                },
                            },
                        },
                    },
                    {
                        name: MCP_TOOLS.SUBMIT_PHASE_HANDOFF,
                        description:
                            'Submit the handoff data for a completed phase. Marks the phase as complete.',
                        inputSchema: {
                            type: 'object' as const,
                            required: [
                                'masterTaskId',
                                'phaseId',
                                'decisions',
                                'modified_files',
                                'blockers',
                            ],
                            properties: {
                                masterTaskId: {
                                    type: 'string',
                                    description:
                                        'Master task ID in YYYYMMDD-HHMMSS-<uuid> format.',
                                    pattern: MASTER_TASK_ID_PATTERN.source,
                                },
                                phaseId: {
                                    type: 'string',
                                    description:
                                        'Phase ID in phase-<index>-<uuid> format.',
                                    pattern: PHASE_ID_PATTERN.source,
                                },
                                // D-1: maxLength + maxItems guard on free-text string arrays
                                decisions: {
                                    type: 'array',
                                    items: { type: 'string', maxLength: 500 },
                                    maxItems: 50,
                                    description: 'Key decisions made during this phase.',
                                },
                                // D-2: path pattern enforces that items are relative file paths
                                modified_files: {
                                    type: 'array',
                                    items: {
                                        type: 'string',
                                        pattern: '^[\\w\\-./]+$',
                                        maxLength: 260,
                                    },
                                    maxItems: 200,
                                    description:
                                        'Relative paths to files created or modified.',
                                },
                                // D-1: maxLength + maxItems guard on free-text string arrays
                                blockers: {
                                    type: 'array',
                                    items: { type: 'string', maxLength: 500 },
                                    maxItems: 20,
                                    description:
                                        'Unresolved issues or blockers encountered.',
                                },
                            },
                        },
                    },
                    {
                        name: MCP_TOOLS.SUBMIT_CONSOLIDATION_REPORT,
                        description:
                            'Submit the final consolidation report (Markdown) for a master task.',
                        inputSchema: {
                            type: 'object' as const,
                            required: ['masterTaskId', 'markdown_content'],
                            properties: {
                                masterTaskId: {
                                    type: 'string',
                                    description:
                                        'Master task ID in YYYYMMDD-HHMMSS-<uuid> format.',
                                    pattern: MASTER_TASK_ID_PATTERN.source,
                                },
                                markdown_content: {
                                    type: 'string',
                                    description:
                                        'Markdown content of the consolidation report.',
                                },
                            },
                        },
                    },
                    {
                        name: MCP_TOOLS.GET_MODIFIED_FILE_CONTENT,
                        description:
                            'Read the content of a file from the workspace, identified by its relative path.',
                        inputSchema: {
                            type: 'object' as const,
                            required: ['masterTaskId', 'phaseId', 'file_path'],
                            properties: {
                                masterTaskId: {
                                    type: 'string',
                                    description:
                                        'Master task ID in YYYYMMDD-HHMMSS-<uuid> format.',
                                    pattern: MASTER_TASK_ID_PATTERN.source,
                                },
                                phaseId: {
                                    type: 'string',
                                    description:
                                        'Phase ID in phase-<index>-<uuid> format.',
                                    pattern: PHASE_ID_PATTERN.source,
                                },
                                file_path: {
                                    type: 'string',
                                    description:
                                        'Relative path to the file within the workspace.',
                                },
                            },
                        },
                    },
                ],
            };
        });

        // ── CallToolRequest ──────────────────────────────────────────────
        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name } = request.params;
            const args = (request.params.arguments ?? {}) as Record<string, unknown>;

            switch (name) {
                case MCP_TOOLS.SUBMIT_IMPLEMENTATION_PLAN:
                    return this.handleSubmitImplementationPlan(args);
                case MCP_TOOLS.SUBMIT_PHASE_HANDOFF:
                    return this.handleSubmitPhaseHandoff(args);
                case MCP_TOOLS.SUBMIT_CONSOLIDATION_REPORT:
                    return this.handleSubmitConsolidationReport(args);
                case MCP_TOOLS.GET_MODIFIED_FILE_CONTENT:
                    return this.handleGetModifiedFileContent(args);
                default:
                    throw new Error(`Unknown tool: ${name}`);
            }
        });
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Tool Implementations
    // ═══════════════════════════════════════════════════════════════════════

    private handleSubmitImplementationPlan(
        args: Record<string, unknown>
    ): { content: Array<{ type: 'text'; text: string }> } {
        const masterTaskId = this.validateMasterTaskId(args['masterTaskId']);
        const markdownContent = this.validateString(args['markdown_content'], 'markdown_content');
        const phaseId = args['phaseId'] != null
            ? this.validatePhaseId(args['phaseId'])
            : undefined;

        if (phaseId) {
            // Phase-level plan → persist via DB
            this.db.upsertPhasePlan(masterTaskId, phaseId, markdownContent);
            log.info(
                `[CoogentMCPServer] Phase implementation plan saved: ${masterTaskId} / ${phaseId}`
            );
        } else {
            // Master-level plan → persist via DB
            this.db.upsertTask(masterTaskId, { implementationPlan: markdownContent });
            log.info(
                `[CoogentMCPServer] Master implementation plan saved: ${masterTaskId}`
            );
        }

        return {
            content: [
                {
                    type: 'text',
                    text: `Implementation plan saved for ${phaseId ? `phase ${phaseId}` : `task ${masterTaskId}`
                        }.`,
                },
            ],
        };
    }

    private handleSubmitPhaseHandoff(
        args: Record<string, unknown>
    ): { content: Array<{ type: 'text'; text: string }> } {
        const masterTaskId = this.validateMasterTaskId(args['masterTaskId']);
        const phaseId = this.validatePhaseId(args['phaseId']);
        // D-3: Pass enforcement opts so the runtime gate matches the schema declaration.
        // The MCP SDK does NOT auto-validate arguments against JSON Schema — this is the
        // only enforcement that actually runs.
        const decisions = this.validateStringArray(
            args['decisions'], 'decisions',
            { maxItemLength: 500, maxItems: 50 }
        );
        const modifiedFiles = this.validateStringArray(
            args['modified_files'], 'modified_files',
            { maxItemLength: 260, maxItems: 200, pathLike: true }
        );
        const blockers = this.validateStringArray(
            args['blockers'], 'blockers',
            { maxItemLength: 500, maxItems: 20 }
        );

        const handoff: PhaseHandoff = {
            phaseId,
            masterTaskId,
            decisions,
            modifiedFiles,
            blockers,
            completedAt: Date.now(),
        };

        // Persist handoff to DB — upsertHandoff ensures parent task/phase rows exist
        this.db.upsertHandoff(handoff);

        log.info(
            `[CoogentMCPServer] Phase handoff saved: ${masterTaskId} / ${phaseId} — ` +
            `${decisions.length} decisions, ${modifiedFiles.length} files, ${blockers.length} blockers`
        );

        // Fire the phaseCompleted event
        this.emitter.emit('phaseCompleted', handoff);

        return {
            content: [
                {
                    type: 'text',
                    text: `Phase handoff saved for ${phaseId}. Phase marked as complete.`,
                },
            ],
        };
    }

    private handleSubmitConsolidationReport(
        args: Record<string, unknown>
    ): { content: Array<{ type: 'text'; text: string }> } {
        const masterTaskId = this.validateMasterTaskId(args['masterTaskId']);
        const markdownContent = this.validateString(args['markdown_content'], 'markdown_content');

        // Persist consolidation report to DB
        this.db.upsertTask(masterTaskId, { consolidationReport: markdownContent });

        log.info(
            `[CoogentMCPServer] Consolidation report saved: ${masterTaskId}`
        );

        return {
            content: [
                {
                    type: 'text',
                    text: `Consolidation report saved for task ${masterTaskId}.`,
                },
            ],
        };
    }

    private async handleGetModifiedFileContent(
        args: Record<string, unknown>
    ): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
        const masterTaskId = this.validateMasterTaskId(args['masterTaskId']);
        const phaseId = this.validatePhaseId(args['phaseId']);
        const filePath = this.validateString(args['file_path'], 'file_path');

        /**
         * @security R-3 Authorization Gate
         *
         * Verifies the masterTaskId belongs to an active session before
         * performing any file I/O. Prevents IDOR by callers with fabricated but
         * syntactically valid masterTaskId values.
         *
         * **V1 (in-process MCP transport):** DB lookup is sufficient
         * because the only caller is the co-located ADK worker process.
         *
         * **Networked transport hardening (pre-V2 checklist):**
         *   1. Replace this DB lookup with a bearer-token or mTLS identity check.
         *   2. Bind tokens to a specific masterTaskId at session creation time.
         *   3. Add per-IP rate limiting on failed auth attempts.
         *   4. Audit-log every rejected request with source IP.
         */
        const task = this.db.getTask(masterTaskId);
        if (!task) {
            log.warn(`[CoogentMCPServer] R-3: Unauthorized file read attempt for task ${masterTaskId}.`);
            throw new Error('Unauthorized');
        }

        // B-2: Resolve symlinks before boundary check to prevent symlink-based path traversal
        let resolved: string;
        let realWorkspaceRoot: string;
        try {
            resolved = await fs.realpath(path.resolve(this.workspaceRoot, filePath));
            realWorkspaceRoot = await fs.realpath(this.workspaceRoot);
        } catch {
            log.warn(`[CoogentMCPServer] File not found (realpath): ${filePath}`);
            throw new Error('File not found');
        }
        if (!resolved.startsWith(realWorkspaceRoot + path.sep) && resolved !== realWorkspaceRoot) {
            log.warn(`[CoogentMCPServer] Path traversal blocked: ${filePath}`);
            throw new Error('Access denied');
        }

        try {
            const rawContent = await fs.readFile(resolved, 'utf-8');
            const MAX_FILE_CHARS = 32_000;
            const isTruncated = rawContent.length > MAX_FILE_CHARS;
            let safeContent: string;
            if (isTruncated) {
                const lineCount = rawContent.split('\n').length;
                // R-2: Use surrogate-pair-safe truncation.
                // rawContent.slice(0, N) is UTF-16 code-unit based. If the Nth code unit
                // is a leading surrogate (0xD800–0xDBFF), the next unit forms the second
                // half of the pair; cutting between them produces a lone surrogate which
                // may be serialized as U+FFFD or cause a JSON encoding error.
                safeContent = safeTruncate(rawContent, MAX_FILE_CHARS) +
                    `\n\n[TRUNCATED: ${rawContent.length} chars / ~${lineCount} lines total; showing first ${MAX_FILE_CHARS} chars. Re-invoke with a narrower file_path or specific line range.]`;
                log.warn('[CoogentMCPServer] File truncated:', filePath, rawContent.length, 'chars');
            } else {
                safeContent = rawContent;
            }
            log.info(
                `[CoogentMCPServer] File read: ${filePath} (task=${masterTaskId}, phase=${phaseId})`
            );
            return {
                content: [{ type: 'text', text: safeContent }],
            };
        } catch (err: unknown) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code === 'ENOENT') {
                log.warn(`[CoogentMCPServer] File not found (readFile): ${filePath}`);
                throw new Error('File not found');
            }
            log.warn(`[CoogentMCPServer] File read error: ${filePath}`, (err as Error).message);
            throw new Error('Failed to read file');
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Input Validation Helpers
    // ═══════════════════════════════════════════════════════════════════════

    private validateMasterTaskId(value: unknown): string {
        if (typeof value !== 'string' || !MASTER_TASK_ID_PATTERN.test(value)) {
            throw new Error(
                `Invalid masterTaskId: expected YYYYMMDD-HHMMSS-<uuid> format, got "${String(value)}".`
            );
        }
        return value;
    }

    private validatePhaseId(value: unknown): string {
        if (typeof value !== 'string' || !PHASE_ID_PATTERN.test(value)) {
            throw new Error(
                `Invalid phaseId: expected phase-<index>-<uuid> format, got "${String(value)}".`
            );
        }
        return value;
    }

    private validateString(value: unknown, fieldName: string): string {
        if (typeof value !== 'string') {
            throw new Error(
                `Invalid ${fieldName}: expected a string, got ${typeof value}.`
            );
        }
        return value;
    }

    /**
     * D-3: Runtime enforcement for string array fields.
     * The MCP SDK does NOT validate `arguments` against the declared JSON Schema,
     * so this is the sole enforcement gate for array constraints.
     */
    private validateStringArray(
        value: unknown,
        fieldName: string,
        opts: {
            maxItemLength?: number;
            maxItems?: number;
            /** If true, each item must match the safe relative-path pattern `^[\w\-./]+$` */
            pathLike?: boolean;
        } = {}
    ): string[] {
        if (!Array.isArray(value)) {
            throw new Error(
                `Invalid ${fieldName}: expected an array, got ${typeof value}.`
            );
        }
        if (opts.maxItems !== undefined && value.length > opts.maxItems) {
            throw new Error(
                `Invalid ${fieldName}: exceeds maxItems (${opts.maxItems}).`
            );
        }
        for (const v of value) {
            if (typeof v !== 'string') {
                throw new Error(
                    `Invalid ${fieldName}: all items must be strings.`
                );
            }
            if (opts.maxItemLength !== undefined && v.length > opts.maxItemLength) {
                throw new Error(
                    `Invalid ${fieldName}: item exceeds maxLength (${opts.maxItemLength} chars).`
                );
            }
            if (opts.pathLike && !/^[\w\-./]+$/.test(v)) {
                throw new Error(
                    `Invalid ${fieldName}: item "${v.slice(0, 60)}" is not a valid relative path.`
                );
            }
        }
        return value as string[];
    }
}
