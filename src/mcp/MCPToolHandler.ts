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
    type PhaseHandoff,
} from './types.js';
import { safeTruncate } from './CoogentMCPServer.js';
import { MCPValidator } from './MCPValidator.js';
import { validateWorkerOutput } from '../engine/WorkerOutputValidator.js';
import type { ArtifactDB } from './ArtifactDB.js';
import log from '../logger/log.js';
import {
    ERR_MCP_PATH_TRAVERSAL_BLOCKED,
    ERR_WORKER_OUTPUT_VALIDATION_FAILED,
} from '../logger/ErrorCodes.js';
import type { TelemetryLogger } from '../logger/TelemetryLogger.js';

/**
 * Registers MCP Tool handlers (mutating) on a given MCP Server instance.
 *
 * Tools:
 *   - submit_implementation_plan
 *   - submit_phase_handoff
 *   - submit_consolidation_report
 *   - get_modified_file_content
 *   - get_file_slice
 *   - get_phase_handoff
 *   - get_symbol_context
 */
export class MCPToolHandler {
    /** Normalised allowed workspace roots for workspaceFolder validation. */
    private readonly allowedRoots: string[];
    /** Optional telemetry logger for structured boundary events (P2.2). */
    private telemetryLogger?: TelemetryLogger;

    constructor(
        private readonly server: Server,
        private readonly db: ArtifactDB,
        private readonly workspaceRoot: string,
        private readonly emitter: EventEmitter,
        allowedWorkspaceRoots: string[] = [workspaceRoot],
    ) {
        this.allowedRoots = allowedWorkspaceRoots.map(r => path.resolve(r));
    }

    /** Attach a TelemetryLogger for structured boundary event logging. */
    setTelemetryLogger(logger: TelemetryLogger): void {
        this.telemetryLogger = logger;
    }

    /**
     * Validate that a candidate workspace root is within the allowed set.
     * Prevents path traversal via the optional `workspaceFolder` MCP argument.
     */
    private resolveWorkspaceRoot(candidate: string): string {
        const normalised = path.resolve(candidate);
        const isAllowed = this.allowedRoots.some(
            r => normalised === r || normalised.startsWith(r + path.sep)
        );
        if (!isAllowed) {
            throw new Error(
                'Access denied: workspaceFolder is not within the allowed workspace roots.'
            );
        }
        return normalised;
    }

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
                                // M2 audit fix: optional context for downstream phases
                                next_steps_context: {
                                    type: 'string',
                                    maxLength: 4096,
                                    description:
                                        'Optional context or recommendations for downstream phases.',
                                },
                                summary: {
                                    type: 'string',
                                    maxLength: 4096,
                                    description: 'Summary of what was accomplished.',
                                },
                                rationale: {
                                    type: 'string',
                                    maxLength: 4096,
                                    description: 'Rationale for decisions made.',
                                },
                                constraints: {
                                    type: 'array',
                                    items: { type: 'string', maxLength: 500 },
                                    maxItems: 50,
                                    description: 'Constraints discovered during execution.',
                                },
                                remainingWork: {
                                    type: 'array',
                                    items: { type: 'string', maxLength: 500 },
                                    maxItems: 50,
                                    description: 'Remaining work for downstream phases.',
                                },
                                symbolsTouched: {
                                    type: 'array',
                                    items: { type: 'string', maxLength: 500 },
                                    maxItems: 200,
                                    description: 'Symbols modified or created.',
                                },
                                warnings: {
                                    type: 'array',
                                    items: { type: 'string', maxLength: 500 },
                                    maxItems: 50,
                                    description: 'Warnings for downstream consumers.',
                                },
                                workspaceFolder: {
                                    type: 'string',
                                    maxLength: 500,
                                    description: 'Workspace folder this phase operated in.',
                                },
                                changedFilesJson: {
                                    type: 'string',
                                    maxLength: 65536,
                                    description: 'JSON-serialized ChangedFileHandoff array with per-file metadata.',
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
                    // ── Retrieval tools ───────────────────────────────────
                    {
                        name: MCP_TOOLS.GET_FILE_SLICE,
                        description:
                            'Read a specific line range from a file in the workspace.',
                        inputSchema: {
                            type: 'object' as const,
                            required: ['path', 'startLine', 'endLine'],
                            properties: {
                                path: {
                                    type: 'string',
                                    description: 'Relative path to the file within the workspace.',
                                    maxLength: 260,
                                },
                                startLine: {
                                    type: 'number',
                                    description: 'Start line (1-indexed, inclusive).',
                                },
                                endLine: {
                                    type: 'number',
                                    description: 'End line (1-indexed, inclusive).',
                                },
                                workspaceFolder: {
                                    type: 'string',
                                    description: 'Optional workspace folder to resolve path against.',
                                },
                            },
                        },
                    },
                    {
                        name: MCP_TOOLS.GET_PHASE_HANDOFF,
                        description:
                            'Retrieve stored handoff data for a completed phase.',
                        inputSchema: {
                            type: 'object' as const,
                            required: ['phaseId', 'masterTaskId'],
                            properties: {
                                phaseId: {
                                    type: 'string',
                                    description: 'Phase ID in phase-<index>-<uuid> format.',
                                    pattern: PHASE_ID_PATTERN.source,
                                },
                                masterTaskId: {
                                    type: 'string',
                                    description: 'Master task ID in YYYYMMDD-HHMMSS-<uuid> format.',
                                    pattern: MASTER_TASK_ID_PATTERN.source,
                                },
                            },
                        },
                    },
                    {
                        name: MCP_TOOLS.GET_SYMBOL_CONTEXT,
                        description:
                            'Search for a symbol in a file and return surrounding context (best-effort text search).',
                        inputSchema: {
                            type: 'object' as const,
                            required: ['path', 'symbol'],
                            properties: {
                                path: {
                                    type: 'string',
                                    description: 'Relative path to the file within the workspace.',
                                    maxLength: 260,
                                },
                                symbol: {
                                    type: 'string',
                                    description: 'Symbol name to search for.',
                                    maxLength: 200,
                                },
                                workspaceFolder: {
                                    type: 'string',
                                    description: 'Optional workspace folder to resolve path against.',
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
                case MCP_TOOLS.GET_FILE_SLICE:
                    return this.handleGetFileSlice(args);
                case MCP_TOOLS.GET_PHASE_HANDOFF:
                    return this.handleGetPhaseHandoff(args);
                case MCP_TOOLS.GET_SYMBOL_CONTEXT:
                    return this.handleGetSymbolContext(args);
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
        const markdownContent = MCPValidator.validateString(args['markdown_content'], 'markdown_content', 500_000);
        const phaseId = args['phaseId'] != null
            ? MCPValidator.validatePhaseId(args['phaseId'])
            : undefined;

        // P0.1: Validate implementation plan content before persistence
        const planValidation = validateWorkerOutput('implementation_plan', {
            markdown_content: markdownContent,
        });
        if (!planValidation.success) {
            log.warn(
                `[MCPToolHandler] ${planValidation.error.code}: ${planValidation.error.message}`,
            );
            this.telemetryLogger?.logBoundaryEvent(ERR_WORKER_OUTPUT_VALIDATION_FAILED, {
                contractType: 'implementation_plan',
                validationCode: planValidation.error.code,
                message: planValidation.error.message,
            });
            throw new Error(
                `Implementation plan validation failed: ${planValidation.error.message}`
            );
        }

        if (phaseId) {
            // Phase-level plan → persist via DB
            this.db.phases.upsertPlan(masterTaskId, phaseId, markdownContent);
            log.info(
                `[MCPToolHandler] Phase implementation plan saved: ${masterTaskId} / ${phaseId}`
            );
        } else {
            // Master-level plan → persist via DB
            this.db.tasks.upsert(masterTaskId, { implementationPlan: markdownContent });
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

        // M2 audit fix: extract optional next_steps_context
        const nextStepsContext = typeof args['next_steps_context'] === 'string'
            ? args['next_steps_context'].slice(0, 4096)
            : undefined;

        // P7: Extract enrichment fields
        const summary = typeof args['summary'] === 'string'
            ? args['summary'].slice(0, 4096) : undefined;
        const rationale = typeof args['rationale'] === 'string'
            ? args['rationale'].slice(0, 4096) : undefined;
        const constraints = args['constraints'] != null
            ? MCPValidator.validateStringArray(args['constraints'], 'constraints', { maxItemLength: 500, maxItems: 50 })
            : undefined;
        const remainingWork = args['remainingWork'] != null
            ? MCPValidator.validateStringArray(args['remainingWork'], 'remainingWork', { maxItemLength: 500, maxItems: 50 })
            : undefined;
        const symbolsTouched = args['symbolsTouched'] != null
            ? MCPValidator.validateStringArray(args['symbolsTouched'], 'symbolsTouched', { maxItemLength: 500, maxItems: 200 })
            : undefined;
        const warnings = args['warnings'] != null
            ? MCPValidator.validateStringArray(args['warnings'], 'warnings', { maxItemLength: 500, maxItems: 50 })
            : undefined;
        const workspaceFolder = typeof args['workspaceFolder'] === 'string'
            ? args['workspaceFolder'].slice(0, 500) : undefined;
        const changedFilesJson = typeof args['changedFilesJson'] === 'string'
            ? args['changedFilesJson'].slice(0, 65536) : undefined;

        // P0.1: Validate handoff payload before persistence
        const handoffValidation = validateWorkerOutput('phase_handoff', {
            decisions,
            modified_files: modifiedFiles,
            blockers,
            next_steps_context: nextStepsContext,
            summary,
            rationale,
            constraints,
            remainingWork,
            symbolsTouched,
            warnings,
            workspaceFolder,
            changedFilesJson,
        });
        if (!handoffValidation.success) {
            log.warn(
                `[MCPToolHandler] ${handoffValidation.error.code}: ${handoffValidation.error.message}`,
            );
            this.telemetryLogger?.logBoundaryEvent(ERR_WORKER_OUTPUT_VALIDATION_FAILED, {
                contractType: 'phase_handoff',
                validationCode: handoffValidation.error.code,
                message: handoffValidation.error.message,
            });
            throw new Error(
                `Phase handoff validation failed: ${handoffValidation.error.message}`
            );
        }

        const handoff: PhaseHandoff = {
            phaseId,
            masterTaskId,
            decisions,
            modifiedFiles,
            blockers,
            completedAt: Date.now(),
            nextStepsContext,
            summary,
            rationale,
            constraints,
            remainingWork,
            symbolsTouched,
            warnings,
            workspaceFolder,
            changedFilesJson,
        };

        // Persist handoff to DB — upsertHandoff ensures parent task/phase rows exist
        this.db.handoffs.upsert(handoff);

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
        const markdownContent = MCPValidator.validateString(args['markdown_content'], 'markdown_content', 500_000);

        // P0.1: Validate consolidation report content before persistence
        const reportValidation = validateWorkerOutput('consolidation_report', {
            markdown_content: markdownContent,
        });
        if (!reportValidation.success) {
            log.warn(
                `[MCPToolHandler] ${reportValidation.error.code}: ${reportValidation.error.message}`,
            );
            this.telemetryLogger?.logBoundaryEvent(ERR_WORKER_OUTPUT_VALIDATION_FAILED, {
                contractType: 'consolidation_report',
                validationCode: reportValidation.error.code,
                message: reportValidation.error.message,
            });
            throw new Error(
                `Consolidation report validation failed: ${reportValidation.error.message}`
            );
        }

        // Persist consolidation report to DB
        this.db.tasks.upsert(masterTaskId, { consolidationReport: markdownContent });

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
        const task = this.db.tasks.get(masterTaskId);
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
            this.telemetryLogger?.logBoundaryEvent(ERR_MCP_PATH_TRAVERSAL_BLOCKED, {
                filePath,
                resolved,
                workspaceRoot: this.workspaceRoot,
            });
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

    // ═══════════════════════════════════════════════════════════════════════
    //  Retrieval Tool Implementations (P7)
    // ═══════════════════════════════════════════════════════════════════════

    private async handleGetFileSlice(
        args: Record<string, unknown>
    ): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
        const filePath = MCPValidator.validateString(args['path'], 'path');
        const startLine = Number(args['startLine']);
        const endLine = Number(args['endLine']);

        if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
            throw new Error('Invalid line range: startLine and endLine must be positive integers with startLine <= endLine.');
        }

        if (filePath.length > 260 || !/^[\w\-./]+$/.test(filePath)) {
            throw new Error('Invalid path: contains disallowed characters or exceeds maximum length.');
        }

        const rawRoot = typeof args['workspaceFolder'] === 'string'
            ? args['workspaceFolder'] : this.workspaceRoot;
        const root = this.resolveWorkspaceRoot(rawRoot);

        let resolved: string;
        let realRoot: string;
        try {
            resolved = await fs.realpath(path.resolve(root, filePath));
            realRoot = await fs.realpath(root);
        } catch {
            throw new Error('File not found');
        }
        if (!resolved.startsWith(realRoot + path.sep) && resolved !== realRoot) {
            throw new Error('Access denied');
        }

        try {
            const rawContent = await fs.readFile(resolved, 'utf-8');
            const lines = rawContent.split('\n');
            const sliced = lines.slice(startLine - 1, endLine);
            log.info(
                `[MCPToolHandler] File slice read: ${filePath} L${startLine}-${endLine}`
            );
            return {
                content: [{ type: 'text', text: sliced.join('\n') }],
            };
        } catch (err: unknown) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code === 'ENOENT') { throw new Error('File not found'); }
            throw new Error('Failed to read file');
        }
    }

    private handleGetPhaseHandoff(
        args: Record<string, unknown>
    ): { content: Array<{ type: 'text'; text: string }> } {
        const masterTaskId = MCPValidator.validateMasterTaskId(args['masterTaskId']);
        const phaseId = MCPValidator.validatePhaseId(args['phaseId']);

        const handoff = this.db.handoffs.get(masterTaskId, phaseId);
        if (!handoff) {
            return {
                content: [{ type: 'text', text: `No handoff found for phase ${phaseId} in task ${masterTaskId}.` }],
            };
        }

        log.info(
            `[MCPToolHandler] Phase handoff retrieved: ${masterTaskId} / ${phaseId}`
        );
        return {
            content: [{ type: 'text', text: JSON.stringify(handoff, null, 2) }],
        };
    }

    private async handleGetSymbolContext(
        args: Record<string, unknown>
    ): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
        const filePath = MCPValidator.validateString(args['path'], 'path');
        const symbol = MCPValidator.validateString(args['symbol'], 'symbol');

        if (filePath.length > 260 || !/^[\w\-./]+$/.test(filePath)) {
            throw new Error('Invalid path: contains disallowed characters or exceeds maximum length.');
        }
        if (symbol.length > 200) {
            throw new Error('Invalid symbol: exceeds maximum length (200).');
        }

        const rawRoot = typeof args['workspaceFolder'] === 'string'
            ? args['workspaceFolder'] : this.workspaceRoot;
        const root = this.resolveWorkspaceRoot(rawRoot);

        let resolved: string;
        let realRoot: string;
        try {
            resolved = await fs.realpath(path.resolve(root, filePath));
            realRoot = await fs.realpath(root);
        } catch {
            throw new Error('File not found');
        }
        if (!resolved.startsWith(realRoot + path.sep) && resolved !== realRoot) {
            throw new Error('Access denied');
        }

        try {
            const rawContent = await fs.readFile(resolved, 'utf-8');
            const lines = rawContent.split('\n');
            const matchIndex = lines.findIndex(line => line.includes(symbol));
            if (matchIndex === -1) {
                return {
                    content: [{ type: 'text', text: `Symbol "${symbol}" not found in ${filePath}.` }],
                };
            }

            const CONTEXT_LINES = 25; // 25 before + 25 after = ~50 lines
            const start = Math.max(0, matchIndex - CONTEXT_LINES);
            const end = Math.min(lines.length, matchIndex + CONTEXT_LINES + 1);
            const slice = lines.slice(start, end);

            log.info(
                `[MCPToolHandler] Symbol context read: ${symbol} in ${filePath} (L${start + 1}-${end})`
            );
            return {
                content: [{ type: 'text', text: slice.join('\n') }],
            };
        } catch (err: unknown) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code === 'ENOENT') { throw new Error('File not found'); }
            throw new Error('Failed to read file');
        }
    }
}
