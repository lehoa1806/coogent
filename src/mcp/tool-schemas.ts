// ─────────────────────────────────────────────────────────────────────────────
// src/mcp/tool-schemas.ts — MCP Tool schema definitions (extracted from MCPToolHandler)
// ─────────────────────────────────────────────────────────────────────────────

import {
    MASTER_TASK_ID_PATTERN,
    PHASE_ID_PATTERN,
    MCP_TOOLS,
} from './types.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Shared handler dependencies type
// ═══════════════════════════════════════════════════════════════════════════════

import type { EventEmitter } from 'node:events';
import type { ArtifactDB } from './ArtifactDB.js';
import type { TelemetryLogger } from '../logger/TelemetryLogger.js';

/**
 * Shared dependencies injected into every tool handler function.
 */
export interface ToolHandlerDeps {
    db: ArtifactDB;
    workspaceRoot: string;
    emitter: EventEmitter;
    allowedRoots: string[];
    telemetryLogger?: TelemetryLogger | undefined;
    /** Validate that a candidate workspace root is within the allowed set. */
    resolveWorkspaceRoot: (candidate: string) => string;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  MCP content response type
// ═══════════════════════════════════════════════════════════════════════════════

export type MCPTextContent = { content: Array<{ type: 'text'; text: string }> };

// ═══════════════════════════════════════════════════════════════════════════════
//  Tool Schema Definitions
// ═══════════════════════════════════════════════════════════════════════════════

export const SUBMIT_IMPLEMENTATION_PLAN_SCHEMA = {
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
};

export const SUBMIT_PHASE_HANDOFF_SCHEMA = {
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
                    pattern: '^[\\\\w\\\\-./]+$',
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
};

export const SUBMIT_CONSOLIDATION_REPORT_SCHEMA = {
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
};

export const GET_MODIFIED_FILE_CONTENT_SCHEMA = {
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
            // MF-2 FIX: pathLike + maxLength for defense-in-depth parity with
            // submit_phase_handoff's modified_files
            file_path: {
                type: 'string',
                description:
                    'Relative path to the file within the workspace.',
                pattern: '^[\\\\w\\\\-./]+$',
                maxLength: 260,
            },
        },
    },
};

export const GET_FILE_SLICE_SCHEMA = {
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
};

export const GET_PHASE_HANDOFF_SCHEMA = {
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
};

export const GET_SYMBOL_CONTEXT_SCHEMA = {
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
};

/**
 * All tool schemas combined for the ListTools response.
 */
export const ALL_TOOL_SCHEMAS = [
    SUBMIT_IMPLEMENTATION_PLAN_SCHEMA,
    SUBMIT_PHASE_HANDOFF_SCHEMA,
    SUBMIT_CONSOLIDATION_REPORT_SCHEMA,
    GET_MODIFIED_FILE_CONTENT_SCHEMA,
    GET_FILE_SLICE_SCHEMA,
    GET_PHASE_HANDOFF_SCHEMA,
    GET_SYMBOL_CONTEXT_SCHEMA,
];
