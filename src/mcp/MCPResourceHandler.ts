// ─────────────────────────────────────────────────────────────────────────────
// src/mcp/MCPResourceHandler.ts — MCP Resource read handlers
// ─────────────────────────────────────────────────────────────────────────────
// Extracted from CoogentMCPServer.ts (Sprint 2: MCP Server Decomposition).
// Handles ListResources and ReadResource protocol requests.

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
    ListResourcesRequestSchema,
    ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { RESOURCE_URIS } from './types.js';
import { parseResourceURI } from './CoogentMCPServer.js';
import type { ArtifactDB } from './ArtifactDB.js';

/**
 * Registers MCP Resource handlers (read-only) on a given MCP Server instance.
 *
 * Resources exposed:
 *   - coogent://tasks/{masterTaskId}/summary
 *   - coogent://tasks/{masterTaskId}/implementation_plan
 *   - coogent://tasks/{masterTaskId}/consolidation_report
 *   - coogent://tasks/{masterTaskId}/consolidation_report_json
 *   - coogent://tasks/{masterTaskId}/phases/{phaseId}/implementation_plan
 *   - coogent://tasks/{masterTaskId}/phases/{phaseId}/handoff
 */
export class MCPResourceHandler {
    constructor(
        private readonly server: Server,
        private readonly db: ArtifactDB
    ) { }

    /**
     * Register all resource-related protocol handlers on the MCP server.
     * Must be called once during server initialisation.
     */
    register(): void {
        this.registerListResources();
        this.registerReadResource();
    }

    // ── ListResourcesRequest ─────────────────────────────────────────────

    private registerListResources(): void {
        this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
            const resources: Array<{
                uri: string;
                name: string;
                mimeType: string;
            }> = [];

            const taskIds = this.db.tasks.listIds();
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
                resources.push({
                    uri: RESOURCE_URIS.taskReportJson(taskId),
                    name: `Task ${taskId} — Consolidation Report (JSON)`,
                    mimeType: 'application/json',
                });

                // Phase-level resources — lightweight query avoids full task deserialization
                const phaseIds = this.db.phases.listIds(taskId);
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
    }

    // ── ReadResourceRequest ──────────────────────────────────────────────

    private registerReadResource(): void {
        this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
            const uri = request.params.uri;
            const parsed = parseResourceURI(uri);

            if (!parsed) {
                throw new Error(`Unknown or malformed resource URI: ${uri}`);
            }

            const task = this.db.tasks.get(parsed.masterTaskId);
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
                        if (phase.planRequired === false) {
                            // Agent type doesn't produce implementation plans
                            content = 'Implementation plan is not applicable for this phase type.';
                        } else if (!phase.implementationPlan) {
                            if (phase.handoff) {
                                // Phase completed without submitting a plan — plan was expected
                                throw new Error(
                                    `Implementation plan was expected but not submitted for phase ${parsed.phaseId}.`
                                );
                            } else {
                                // Phase still in progress
                                throw new Error(
                                    `Resource not yet available: implementation plan has not been submitted for phase ${parsed.phaseId} of task ${parsed.masterTaskId}.`
                                );
                            }
                        } else {
                            content = phase.implementationPlan;
                        }
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
                    case 'consolidation_report_json':
                        if (!task.consolidationReportJson) {
                            throw new Error(
                                `Resource not yet available: structured consolidation report has not been submitted for task ${parsed.masterTaskId}.`
                            );
                        }
                        content = task.consolidationReportJson;
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
                        mimeType: parsed.resource === 'handoff' || parsed.resource === 'consolidation_report_json'
                            ? 'application/json'
                            : parsed.resource === 'summary'
                                ? 'text/plain'
                                : 'text/markdown',
                    },
                ],
            };
        });
    }
}
