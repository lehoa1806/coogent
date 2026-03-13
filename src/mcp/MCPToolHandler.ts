// ─────────────────────────────────────────────────────────────────────────────
// src/mcp/MCPToolHandler.ts — MCP Tool handlers (thin orchestrator)
// ─────────────────────────────────────────────────────────────────────────────
// Extracted from CoogentMCPServer.ts (Sprint 2: MCP Server Decomposition).
// Handles ListTools and CallTool protocol requests.
//
// All tool logic is delegated to individual handler functions under
// src/mcp/handlers/. Tool schemas live in src/mcp/tool-schemas.ts.

import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
    ListToolsRequestSchema,
    CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { MCP_TOOLS } from './types.js';
import type { ArtifactDB } from './ArtifactDB.js';
import type { TelemetryLogger } from '../logger/TelemetryLogger.js';
import { ALL_TOOL_SCHEMAS, type ToolHandlerDeps } from './tool-schemas.js';

// ── Handler imports ──────────────────────────────────────────────────────────
import { handleSubmitImplementationPlan } from './handlers/SubmitImplementationPlanHandler.js';
import { handleSubmitPhaseHandoff } from './handlers/SubmitPhaseHandoffHandler.js';
import { handleSubmitConsolidationReport } from './handlers/SubmitConsolidationReportHandler.js';
import { handleGetModifiedFileContent } from './handlers/GetModifiedFileContentHandler.js';
import { handleGetFileSlice } from './handlers/GetFileSliceHandler.js';
import { handleGetPhaseHandoff } from './handlers/GetPhaseHandoffHandler.js';
import { handleGetSymbolContext } from './handlers/GetSymbolContextHandler.js';

/**
 * Registers MCP Tool handlers (mutating) on a given MCP Server instance.
 *
 * Tools:
 *   - submit_execution_plan
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
            return { tools: ALL_TOOL_SCHEMAS };
        });
    }

    // ── CallToolRequest ──────────────────────────────────────────────────

    /** Build the shared dependency bag for handler functions. */
    private getDeps(): ToolHandlerDeps {
        return {
            db: this.db,
            workspaceRoot: this.workspaceRoot,
            emitter: this.emitter,
            allowedRoots: this.allowedRoots,
            telemetryLogger: this.telemetryLogger,
            resolveWorkspaceRoot: (c: string) => this.resolveWorkspaceRoot(c),
        };
    }

    private registerCallTool(): void {
        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name } = request.params;
            const args = (request.params.arguments ?? {}) as Record<string, unknown>;
            const deps = this.getDeps();

            switch (name) {
                case MCP_TOOLS.SUBMIT_EXECUTION_PLAN:
                    return handleSubmitImplementationPlan(deps, args);
                case MCP_TOOLS.SUBMIT_PHASE_HANDOFF:
                    return handleSubmitPhaseHandoff(deps, args);
                case MCP_TOOLS.SUBMIT_CONSOLIDATION_REPORT:
                    return handleSubmitConsolidationReport(deps, args);
                case MCP_TOOLS.GET_MODIFIED_FILE_CONTENT:
                    return handleGetModifiedFileContent(deps, args);
                case MCP_TOOLS.GET_FILE_SLICE:
                    return handleGetFileSlice(deps, args);
                case MCP_TOOLS.GET_PHASE_HANDOFF:
                    return handleGetPhaseHandoff(deps, args);
                case MCP_TOOLS.GET_SYMBOL_CONTEXT:
                    return handleGetSymbolContext(deps, args);
                default:
                    throw new Error(`Unknown tool: ${name}`);
            }
        });
    }
}
