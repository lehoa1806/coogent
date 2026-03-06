// ─────────────────────────────────────────────────────────────────────────────
// src/mcp/CoogentMCPServer.ts — Core MCP Server with in-memory state store
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
    PhaseArtifacts,
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
//  CoogentMCPServer
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Core MCP Server that manages all DAG state in-memory and exposes it
 * via MCP Resources (read) and MCP Tools (mutate).
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
    // ── State Store ──────────────────────────────────────────────────────
    private readonly store = new Map<string, TaskState>();
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
    //  Public API
    // ═══════════════════════════════════════════════════════════════════════

    /** Get the underlying MCP `Server` instance for transport wiring. */
    getServer(): Server {
        return this.server;
    }

    /** Get the full task state for internal use (e.g., from the engine). */
    getTaskState(masterTaskId: string): TaskState | undefined {
        return this.store.get(masterTaskId);
    }

    /**
     * Remove a task from the in-memory store (B-4 fix).
     * Call this on session reset to prevent unbounded memory growth.
     */
    purgeTask(masterTaskId: string): void {
        this.store.delete(masterTaskId);
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
    //  State Store Helpers
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Get or lazily create a `TaskState` entry for the given masterTaskId.
     */
    private getOrCreateTask(masterTaskId: string): TaskState {
        let task = this.store.get(masterTaskId);
        if (!task) {
            task = {
                masterTaskId,
                phases: new Map<string, PhaseArtifacts>(),
            };
            this.store.set(masterTaskId, task);
        }
        return task;
    }

    /**
     * Get or lazily create a `PhaseArtifacts` entry within a task.
     */
    private getPhaseArtifacts(masterTaskId: string, phaseId: string): PhaseArtifacts {
        const task = this.getOrCreateTask(masterTaskId);
        let phase = task.phases.get(phaseId);
        if (!phase) {
            phase = {};
            task.phases.set(phaseId, phase);
        }
        return phase;
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

            for (const [taskId, task] of this.store) {
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

                // Phase-level resources
                for (const [phaseId] of task.phases) {
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

            const task = this.store.get(parsed.masterTaskId);
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
                        content = phase.implementationPlan ?? '';
                        break;
                    case 'handoff':
                        content = phase.handoff
                            ? JSON.stringify(phase.handoff, null, 2)
                            : '';
                        break;
                    default:
                        throw new Error(`Unknown phase resource: ${parsed.resource}`);
                }
            } else {
                // Task-level resource
                switch (parsed.resource) {
                    case 'summary':
                        content = task.summary ?? '';
                        break;
                    case 'implementation_plan':
                        content = task.implementationPlan ?? '';
                        break;
                    case 'consolidation_report':
                        content = task.consolidationReport ?? '';
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
                                decisions: {
                                    type: 'array',
                                    items: { type: 'string' },
                                    description: 'Key decisions made during this phase.',
                                },
                                modified_files: {
                                    type: 'array',
                                    items: { type: 'string' },
                                    description:
                                        'Relative paths to files created or modified.',
                                },
                                blockers: {
                                    type: 'array',
                                    items: { type: 'string' },
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
            // Phase-level plan
            const phase = this.getPhaseArtifacts(masterTaskId, phaseId);
            phase.implementationPlan = markdownContent;
            log.info(
                `[CoogentMCPServer] Phase implementation plan saved: ${masterTaskId} / ${phaseId}`
            );
        } else {
            // Master-level plan
            const task = this.getOrCreateTask(masterTaskId);
            task.implementationPlan = markdownContent;
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
        const decisions = this.validateStringArray(args['decisions'], 'decisions');
        const modifiedFiles = this.validateStringArray(args['modified_files'], 'modified_files');
        const blockers = this.validateStringArray(args['blockers'], 'blockers');

        const handoff: PhaseHandoff = {
            phaseId,
            masterTaskId,
            decisions,
            modifiedFiles,
            blockers,
            completedAt: Date.now(),
        };

        const phase = this.getPhaseArtifacts(masterTaskId, phaseId);
        phase.handoff = handoff;

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

        const task = this.getOrCreateTask(masterTaskId);
        task.consolidationReport = markdownContent;

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

        // B-2: Resolve symlinks before boundary check to prevent symlink-based path traversal
        let resolved: string;
        let realWorkspaceRoot: string;
        try {
            resolved = await fs.realpath(path.resolve(this.workspaceRoot, filePath));
            realWorkspaceRoot = await fs.realpath(this.workspaceRoot);
        } catch {
            throw new Error(`Cannot resolve path: "${filePath}"`);
        }
        if (!resolved.startsWith(realWorkspaceRoot + path.sep) && resolved !== realWorkspaceRoot) {
            throw new Error(
                `Path traversal detected: "${filePath}" resolves outside the workspace root.`
            );
        }

        try {
            const content = await fs.readFile(resolved, 'utf-8');
            log.info(
                `[CoogentMCPServer] File read: ${filePath} (task=${masterTaskId}, phase=${phaseId})`
            );
            return {
                content: [{ type: 'text', text: content }],
            };
        } catch (err: unknown) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code === 'ENOENT') {
                throw new Error(`File not found: ${filePath}`);
            }
            throw new Error(
                `Failed to read file ${filePath}: ${(err as Error).message}`
            );
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

    private validateStringArray(value: unknown, fieldName: string): string[] {
        if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
            throw new Error(
                `Invalid ${fieldName}: expected an array of strings, got ${typeof value}.`
            );
        }
        return value as string[];
    }
}
