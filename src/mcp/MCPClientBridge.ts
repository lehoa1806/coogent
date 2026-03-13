// ─────────────────────────────────────────────────────────────────────────────
// src/mcp/MCPClientBridge.ts — InMemoryTransport client bridge + worker bootstrap
// ─────────────────────────────────────────────────────────────────────────────

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CoogentMCPServer } from './CoogentMCPServer.js';
import { RESOURCE_URIS, MCP_TOOLS } from './types.js';
import log from '../logger/log.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  MCPClientBridge
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Client-side bridge that connects to the CoogentMCPServer via
 * `InMemoryTransport` and provides convenience wrappers for reading
 * resources, calling tools, and generating warm-start prompts for workers.
 *
 * Lifecycle:
 *   1. Construct with a `CoogentMCPServer` instance and `workspaceRoot`.
 *   2. Call `connect()` to establish the in-process transport.
 *   3. Use the convenience methods to interact with the MCP server.
 *   4. Call `disconnect()` to tear down the transport.
 */
export class MCPClientBridge {
    private readonly mcpServer: CoogentMCPServer;
    private readonly client: Client;
    private transportPair: [InMemoryTransport, InMemoryTransport] | null = null;
    private connected = false;

    constructor(mcpServer: CoogentMCPServer, _workspaceRoot: string) {
        this.mcpServer = mcpServer;

        this.client = new Client(
            { name: 'coogent-mcp-client', version: '0.3.0' },
            { capabilities: {} }
        );
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Connection Lifecycle
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Establish the InMemoryTransport between the client and server.
     * Must be called before any read/call operations.
     */
    async connect(): Promise<void> {
        if (this.connected) {
            log.warn('[MCPClientBridge] Already connected — skipping.');
            return;
        }

        // Create a linked InMemoryTransport pair
        this.transportPair = InMemoryTransport.createLinkedPair();
        const [clientTransport, serverTransport] = this.transportPair;

        // Connect the server to its end of the transport
        await this.mcpServer.getServer().connect(serverTransport);

        // Connect the client to its end of the transport
        await this.client.connect(clientTransport);

        this.connected = true;
        log.info('[MCPClientBridge] Connected to CoogentMCPServer via InMemoryTransport.');
    }

    /**
     * Disconnect the transport and clean up.
     */
    async disconnect(): Promise<void> {
        if (!this.connected) {
            return;
        }

        try {
            await this.client.close();
        } catch (err) {
            log.warn('[MCPClientBridge] Error closing client:', err);
        }

        // Close the server-side transport half to prevent dangling listeners.
        // This only closes the transport, NOT the MCP Server itself — the
        // server lifecycle is still managed by CoogentMCPServer.dispose().
        if (this.transportPair) {
            try {
                await this.transportPair[1].close();
            } catch (err) {
                log.warn('[MCPClientBridge] Error closing server transport:', err);
            }
        }

        this.connected = false;
        this.transportPair = null;
        log.info('[MCPClientBridge] Disconnected.');
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Core Read / Call Operations
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Read a resource from the MCP server by its `coogent://` URI.
     * Returns the text content of the resource.
     *
     * @throws if the client is not connected or the resource is not found.
     */
    async readResource(uri: string): Promise<string> {
        this.ensureConnected();

        const result = await this.client.readResource({ uri });

        // The MCP SDK returns contents as an array; pick the first entry's text.
        const contents = result.contents;
        if (!contents || contents.length === 0) {
            return '';
        }

        const first = contents[0];
        // contents[].text is the standard text content field
        if ('text' in first && typeof first.text === 'string') {
            return first.text;
        }

        return '';
    }

    /**
     * Call an MCP tool by name with the given arguments.
     *
     * @throws if the client is not connected or the tool call fails.
     */
    async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
        this.ensureConnected();

        const result = await this.client.callTool({ name, arguments: args });
        return result;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Warm-Start Prompt Builder
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Generate the warm-start injection prompt for a worker agent.
     *
     * This prompt tells the worker:
     * - Which phase and master task it is executing.
     * - How to retrieve its context via MCP resource URIs (one per parent dependency).
     * - Where to find the global implementation plan.
     *
     * @param masterTaskId   The master task identifier.
     * @param phaseId        The phase identifier (e.g., `phase-001-<uuid>`).
     * @param parentPhaseIds Array of parent phase IDs whose handoffs this phase depends on.
     *                       Pass an empty array (or omit) for root phases with no upstream deps.
     */
    buildWarmStartPrompt(
        masterTaskId: string,
        phaseId: string,
        parentPhaseIds: string[] = []
    ): string {
        const planUri = RESOURCE_URIS.taskPlan(masterTaskId);

        const lines: string[] = [
            `You are executing ${phaseId} under master task ${masterTaskId}.`,
            `DO NOT GUESS context. Read the following URIs to retrieve your context:`,
        ];

        if (parentPhaseIds.length > 0) {
            for (const parentId of parentPhaseIds) {
                lines.push(`- ${RESOURCE_URIS.phaseHandoff(masterTaskId, parentId)}`);
            }
        }
        // Root phases have no upstream handoffs to read.
        // Previously pointed to the phase's own (nonexistent) handoff URI.

        lines.push(`You can also read ${planUri} for global context.`);

        return lines.join('\n');
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Convenience Wrappers
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Submit an implementation plan (Markdown) at the master-task or phase level.
     *
     * @param masterTaskId  Master task ID.
     * @param content       Markdown content of the implementation plan.
     * @param phaseId       Optional phase ID. When provided, saves at the phase level.
     */
    async submitImplementationPlan(
        masterTaskId: string,
        content: string,
        phaseId?: string
    ): Promise<void> {
        const args: Record<string, unknown> = {
            masterTaskId,
            markdown_content: content,
        };
        if (phaseId != null) {
            args['phaseId'] = phaseId;
        }

        await this.callTool(MCP_TOOLS.SUBMIT_EXECUTION_PLAN, args);
    }

    /**
     * Submit the handoff data for a completed phase.
     *
     * @param masterTaskId     Master task ID.
     * @param phaseId          Phase ID that just completed.
     * @param decisions        Key decisions made during the phase.
     * @param modifiedFiles    Relative paths of files created or modified.
     * @param blockers         Unresolved issues or blockers.
     * @param nextStepsContext Optional free-text guidance for downstream phases.
     */
    async submitPhaseHandoff(
        masterTaskId: string,
        phaseId: string,
        decisions: string[],
        modifiedFiles: string[],
        blockers: string[],
        nextStepsContext?: string,
        enrichment?: {
            summary?: string | undefined;
            rationale?: string | undefined;
            remainingWork?: string[] | undefined;
            constraints?: string[] | undefined;
            warnings?: string[] | undefined;
        },
    ): Promise<void> {
        const args: Record<string, unknown> = {
            masterTaskId,
            phaseId,
            decisions,
            modified_files: modifiedFiles,
            blockers,
        };
        if (nextStepsContext !== undefined) {
            args['next_steps_context'] = nextStepsContext;
        }
        // Forward enriched fields when present
        if (enrichment?.summary !== undefined) { args['summary'] = enrichment.summary; }
        if (enrichment?.rationale !== undefined) { args['rationale'] = enrichment.rationale; }
        if (enrichment?.remainingWork !== undefined) { args['remainingWork'] = enrichment.remainingWork; }
        if (enrichment?.constraints !== undefined) { args['constraints'] = enrichment.constraints; }
        if (enrichment?.warnings !== undefined) { args['warnings'] = enrichment.warnings; }
        await this.callTool(MCP_TOOLS.SUBMIT_PHASE_HANDOFF, args);
    }

    /**
     * Submit the final consolidation report for a master task.
     *
     * @param masterTaskId  Master task ID.
     * @param content       Markdown content of the consolidation report.
     */
    async submitConsolidationReport(
        masterTaskId: string,
        content: string
    ): Promise<void> {
        await this.callTool(MCP_TOOLS.SUBMIT_CONSOLIDATION_REPORT, {
            masterTaskId,
            markdown_content: content,
        });
    }

    /**
     * Submit the structured consolidation report JSON for a master task.
     * S6b audit fix: Stores the typed ConsolidationReport object so
     * programmatic queries don't need to re-parse Markdown.
     *
     * @param masterTaskId  Master task ID.
     * @param json          JSON-stringified ConsolidationReport.
     */
    async submitConsolidationReportJson(
        masterTaskId: string,
        json: string
    ): Promise<void> {
        // Direct DB access — no MCP tool protocol needed for internal persistence
        const db = this.mcpServer.getArtifactDB?.();
        if (db) {
            db.tasks.upsert(masterTaskId, { consolidationReportJson: json });
        } else {
            log.warn(
                `[MCPClientBridge] submitConsolidationReportJson: ArtifactDB unavailable — ` +
                `JSON report for ${masterTaskId} was NOT persisted.`
            );
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Internal Helpers
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Assert that the client is connected before performing operations.
     */
    private ensureConnected(): void {
        if (!this.connected) {
            throw new Error(
                '[MCPClientBridge] Not connected. Call connect() before performing operations.'
            );
        }
    }
}
