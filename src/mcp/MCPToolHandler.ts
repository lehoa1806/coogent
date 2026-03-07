// ─────────────────────────────────────────────────────────────────────────────
// src/mcp/MCPToolHandler.ts — MCP Tool handlers (mutating operations)
// ─────────────────────────────────────────────────────────────────────────────
// Extracted from CoogentMCPServer.ts (Sprint 2: MCP Server Decomposition).
// Handles ListTools and CallTool protocol requests.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
    ListToolsRequestSchema,
    CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
    MASTER_TASK_ID_PATTERN,
    PHASE_ID_PATTERN,
    MCP_TOOLS,
} from './types.js';
import type { PhaseHandoff } from './types.js';
import { safeTruncate } from './CoogentMCPServer.js';
import { MCPValidator } from './MCPValidator.js';
import type { ArtifactDB } from './ArtifactDB.js';
import log from '../logger/log.js';

/**
 * Registers MCP Tool handlers (mutating) on a given MCP Server instance.
 *
 * Tools:
 *   - submit_implementation_plan
 *   - submit_phase_handoff
 *   - submit_consolidation_report
 *   - get_modified_file_content
 */
export class MCPToolHandler {
    constructor(
        private readonly server: Server,
        private readonly db: ArtifactDB,
        private readonly workspaceRoot: string,
        private readonly emitter: EventEmitter
    ) { }

    /**
     * Register all tool-related protocol handlers on the MCP server.
     * Must be called once during server initialisation.
     */
    register(): void {
        this.registerListTools();
        this.registerCallTool();
    }

    // ── ListToolsRequest ─────────────────────────────────────────────────

    private registerListTools(): void {
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
                            additionalProperties: false as const, // LF-1 FIX: defense-in-depth
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
                                // MF-2 FIX: pathLike + maxLength for defense-in-depth
                                // parity with submit_phase_handoff's modified_files
                                file_path: {
                                    type: 'string',
                                    description:
                                        'Relative path to the file within the workspace.',
                                    pattern: '^[\\w\\-./]+$',
                                    maxLength: 260,
                                },
                            },
                        },
                    },
                ],
            };
        });
    }

    // ── CallToolRequest ──────────────────────────────────────────────────

    private registerCallTool(): void {
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
        const masterTaskId = MCPValidator.validateMasterTaskId(args['masterTaskId']);
        const markdownContent = MCPValidator.validateString(args['markdown_content'], 'markdown_content');
        const phaseId = args['phaseId'] != null
            ? MCPValidator.validatePhaseId(args['phaseId'])
            : undefined;

        if (phaseId) {
            // Phase-level plan → persist via DB
            this.db.upsertPhasePlan(masterTaskId, phaseId, markdownContent);
            log.info(
                `[MCPToolHandler] Phase implementation plan saved: ${masterTaskId} / ${phaseId}`
            );
        } else {
            // Master-level plan → persist via DB
            this.db.upsertTask(masterTaskId, { implementationPlan: markdownContent });
            log.info(
                `[MCPToolHandler] Master implementation plan saved: ${masterTaskId}`
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
        const masterTaskId = MCPValidator.validateMasterTaskId(args['masterTaskId']);
        const phaseId = MCPValidator.validatePhaseId(args['phaseId']);
        // D-3: Pass enforcement opts so the runtime gate matches the schema declaration.
        const decisions = MCPValidator.validateStringArray(
            args['decisions'], 'decisions',
            { maxItemLength: 500, maxItems: 50 }
        );
        const modifiedFiles = MCPValidator.validateStringArray(
            args['modified_files'], 'modified_files',
            { maxItemLength: 260, maxItems: 200, pathLike: true }
        );
        const blockers = MCPValidator.validateStringArray(
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
            `[MCPToolHandler] Phase handoff saved: ${masterTaskId} / ${phaseId} — ` +
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
        const masterTaskId = MCPValidator.validateMasterTaskId(args['masterTaskId']);
        const markdownContent = MCPValidator.validateString(args['markdown_content'], 'markdown_content');

        // Persist consolidation report to DB
        this.db.upsertTask(masterTaskId, { consolidationReport: markdownContent });

        log.info(
            `[MCPToolHandler] Consolidation report saved: ${masterTaskId}`
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
        const masterTaskId = MCPValidator.validateMasterTaskId(args['masterTaskId']);
        const phaseId = MCPValidator.validatePhaseId(args['phaseId']);
        const filePath = MCPValidator.validateString(args['file_path'], 'file_path');

        // MF-2 FIX: pathLike validation for defense-in-depth parity with
        // submit_phase_handoff's modified_files. The realpath boundary check
        // (below) is the true security gate, but this catches malformed inputs early.
        if (filePath.length > 260) {
            throw new Error('Invalid file_path: exceeds maximum length (260)');
        }
        if (!/^[\w\-./]+$/.test(filePath)) {
            throw new Error('Invalid file_path: contains disallowed characters');
        }

        /**
         * @security R-3 Authorization Gate
         *
         * Verifies the masterTaskId belongs to an active session before
         * performing any file I/O. Prevents IDOR by callers with fabricated but
         * syntactically valid masterTaskId values.
         */
        const task = this.db.getTask(masterTaskId);
        if (!task) {
            log.warn(`[MCPToolHandler] R-3: Unauthorized file read attempt for task ${masterTaskId}.`);
            throw new Error('Unauthorized');
        }

        // B-2: Resolve symlinks before boundary check to prevent symlink-based path traversal
        let resolved: string;
        let realWorkspaceRoot: string;
        try {
            resolved = await fs.realpath(path.resolve(this.workspaceRoot, filePath));
            realWorkspaceRoot = await fs.realpath(this.workspaceRoot);
        } catch {
            log.warn(`[MCPToolHandler] File not found (realpath): ${filePath}`);
            throw new Error('File not found');
        }
        if (!resolved.startsWith(realWorkspaceRoot + path.sep) && resolved !== realWorkspaceRoot) {
            log.warn(`[MCPToolHandler] Path traversal blocked: ${filePath}`);
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
                safeContent = safeTruncate(rawContent, MAX_FILE_CHARS) +
                    `\n\n[TRUNCATED: ${rawContent.length} chars / ~${lineCount} lines total; showing first ${MAX_FILE_CHARS} chars. Re-invoke with a narrower file_path or specific line range.]`;
                log.warn('[MCPToolHandler] File truncated:', filePath, rawContent.length, 'chars');
            } else {
                safeContent = rawContent;
            }
            log.info(
                `[MCPToolHandler] File read: ${filePath} (task=${masterTaskId}, phase=${phaseId})`
            );
            return {
                content: [{ type: 'text', text: safeContent }],
            };
        } catch (err: unknown) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code === 'ENOENT') {
                log.warn(`[MCPToolHandler] File not found (readFile): ${filePath}`);
                throw new Error('File not found');
            }
            log.warn(`[MCPToolHandler] File read error: ${filePath}`, (err as Error).message);
            throw new Error('Failed to read file');
        }
    }
}
