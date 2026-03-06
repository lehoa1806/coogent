// ─────────────────────────────────────────────────────────────────────────────
// CoogentMCPServer.test.ts — Comprehensive tests for the MCP Server
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CoogentMCPServer } from '../CoogentMCPServer.js';
import {
    RESOURCE_URIS,
    MCP_TOOLS,
} from '../types.js';
import type { PhaseHandoff } from '../types.js';

// ─── Test Fixtures ───────────────────────────────────────────────────────────

const VALID_MASTER_TASK_ID =
    '20260305-173000-a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const VALID_PHASE_ID =
    'phase-001-a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const VALID_PHASE_ID_2 =
    'phase-002-b2c3d4e5-f6a7-8901-bcde-f12345678901';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Create a CoogentMCPServer + Client connected via InMemoryTransport.
 * Returns both so tests can interact via MCP protocol.
 */
async function createConnectedPair(workspaceRoot: string) {
    const server = new CoogentMCPServer(workspaceRoot);
    const client = new Client(
        { name: 'test-client', version: '0.1.0' },
        { capabilities: {} }
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.getServer().connect(serverTransport);
    await client.connect(clientTransport);

    return { server, client };
}

async function teardown(client: Client, server: CoogentMCPServer) {
    await client.close();
    await server.getServer().close();
}

// ═════════════════════════════════════════════════════════════════════════════
//  State Store Tests
// ═════════════════════════════════════════════════════════════════════════════

describe('CoogentMCPServer — State Store', () => {
    let tmpDir: string;
    let server: CoogentMCPServer;
    let client: Client;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-server-test-'));
        ({ server, client } = await createConnectedPair(tmpDir));
    });

    afterEach(async () => {
        await teardown(client, server);
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('getOrCreateTask creates a new task entry if it does not exist', async () => {
        // Submitting a plan forces task creation via getOrCreateTask
        await client.callTool({
            name: MCP_TOOLS.SUBMIT_IMPLEMENTATION_PLAN,
            arguments: {
                masterTaskId: VALID_MASTER_TASK_ID,
                markdown_content: '# Plan',
            },
        });

        const task = server.getTaskState(VALID_MASTER_TASK_ID);
        expect(task).toBeDefined();
        expect(task!.masterTaskId).toBe(VALID_MASTER_TASK_ID);
    });

    it('getOrCreateTask returns existing task on repeated calls', async () => {
        await client.callTool({
            name: MCP_TOOLS.SUBMIT_IMPLEMENTATION_PLAN,
            arguments: {
                masterTaskId: VALID_MASTER_TASK_ID,
                markdown_content: '# Plan v1',
            },
        });

        await client.callTool({
            name: MCP_TOOLS.SUBMIT_IMPLEMENTATION_PLAN,
            arguments: {
                masterTaskId: VALID_MASTER_TASK_ID,
                markdown_content: '# Plan v2',
            },
        });

        const task = server.getTaskState(VALID_MASTER_TASK_ID);
        expect(task).toBeDefined();
        // Latest value wins
        expect(task!.implementationPlan).toBe('# Plan v2');
    });

    it('task state correctly nests phases', async () => {
        // Create phase-level artifacts
        await client.callTool({
            name: MCP_TOOLS.SUBMIT_IMPLEMENTATION_PLAN,
            arguments: {
                masterTaskId: VALID_MASTER_TASK_ID,
                phaseId: VALID_PHASE_ID,
                markdown_content: '# Phase 1 Plan',
            },
        });

        await client.callTool({
            name: MCP_TOOLS.SUBMIT_IMPLEMENTATION_PLAN,
            arguments: {
                masterTaskId: VALID_MASTER_TASK_ID,
                phaseId: VALID_PHASE_ID_2,
                markdown_content: '# Phase 2 Plan',
            },
        });

        const task = server.getTaskState(VALID_MASTER_TASK_ID);
        expect(task).toBeDefined();
        expect(task!.phases.size).toBe(2);
        expect(task!.phases.get(VALID_PHASE_ID)?.implementationPlan).toBe('# Phase 1 Plan');
        expect(task!.phases.get(VALID_PHASE_ID_2)?.implementationPlan).toBe('# Phase 2 Plan');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Resource Handler Tests
// ═════════════════════════════════════════════════════════════════════════════

describe('CoogentMCPServer — Resource Handlers', () => {
    let tmpDir: string;
    let server: CoogentMCPServer;
    let client: Client;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-server-test-'));
        ({ server, client } = await createConnectedPair(tmpDir));
    });

    afterEach(async () => {
        await teardown(client, server);
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    // ── Task-Level Resources ─────────────────────────────────────────────

    it('reading task summary returns the summary', async () => {
        // Seed state: submit a plan to create the task, then manually add summary
        await client.callTool({
            name: MCP_TOOLS.SUBMIT_IMPLEMENTATION_PLAN,
            arguments: {
                masterTaskId: VALID_MASTER_TASK_ID,
                markdown_content: '# Plan',
            },
        });
        // Directly set the summary on the state for testing
        const task = server.getTaskState(VALID_MASTER_TASK_ID)!;
        task.summary = 'This is the task summary';

        const result = await client.readResource({
            uri: RESOURCE_URIS.taskSummary(VALID_MASTER_TASK_ID),
        });

        expect(result.contents).toHaveLength(1);
        expect(result.contents[0]).toMatchObject({
            text: 'This is the task summary',
        });
    });

    it('reading task implementation_plan returns the plan', async () => {
        await client.callTool({
            name: MCP_TOOLS.SUBMIT_IMPLEMENTATION_PLAN,
            arguments: {
                masterTaskId: VALID_MASTER_TASK_ID,
                markdown_content: '# Master Plan Content',
            },
        });

        const result = await client.readResource({
            uri: RESOURCE_URIS.taskPlan(VALID_MASTER_TASK_ID),
        });

        expect(result.contents[0]).toMatchObject({
            text: '# Master Plan Content',
        });
    });

    it('reading task consolidation_report returns the report', async () => {
        await client.callTool({
            name: MCP_TOOLS.SUBMIT_CONSOLIDATION_REPORT,
            arguments: {
                masterTaskId: VALID_MASTER_TASK_ID,
                markdown_content: '# Final Report',
            },
        });

        const result = await client.readResource({
            uri: RESOURCE_URIS.taskReport(VALID_MASTER_TASK_ID),
        });

        expect(result.contents[0]).toMatchObject({
            text: '# Final Report',
        });
    });

    // ── Phase-Level Resources ────────────────────────────────────────────

    it('reading phase implementation_plan returns the phase plan', async () => {
        await client.callTool({
            name: MCP_TOOLS.SUBMIT_IMPLEMENTATION_PLAN,
            arguments: {
                masterTaskId: VALID_MASTER_TASK_ID,
                phaseId: VALID_PHASE_ID,
                markdown_content: '# Phase Specific Plan',
            },
        });

        const result = await client.readResource({
            uri: RESOURCE_URIS.phasePlan(VALID_MASTER_TASK_ID, VALID_PHASE_ID),
        });

        expect(result.contents[0]).toMatchObject({
            text: '# Phase Specific Plan',
        });
    });

    it('reading phase handoff returns the handoff JSON', async () => {
        await client.callTool({
            name: MCP_TOOLS.SUBMIT_PHASE_HANDOFF,
            arguments: {
                masterTaskId: VALID_MASTER_TASK_ID,
                phaseId: VALID_PHASE_ID,
                decisions: ['Decision A'],
                modified_files: ['src/foo.ts'],
                blockers: [],
            },
        });

        const result = await client.readResource({
            uri: RESOURCE_URIS.phaseHandoff(VALID_MASTER_TASK_ID, VALID_PHASE_ID),
        });

        const handoff = JSON.parse((result.contents[0] as any).text as string) as PhaseHandoff;
        expect(handoff.phaseId).toBe(VALID_PHASE_ID);
        expect(handoff.masterTaskId).toBe(VALID_MASTER_TASK_ID);
        expect(handoff.decisions).toEqual(['Decision A']);
        expect(handoff.modifiedFiles).toEqual(['src/foo.ts']);
        expect(handoff.blockers).toEqual([]);
        expect(typeof handoff.completedAt).toBe('number');
    });

    // ── Error Cases ──────────────────────────────────────────────────────

    it('reading an unknown URI throws an error', async () => {
        await expect(
            client.readResource({
                uri: `coogent://tasks/${VALID_MASTER_TASK_ID}/nonexistent_resource`,
            })
        ).rejects.toThrow();
    });

    it('reading a resource with no data returns empty content', async () => {
        // Create the task but don't set a summary
        await client.callTool({
            name: MCP_TOOLS.SUBMIT_IMPLEMENTATION_PLAN,
            arguments: {
                masterTaskId: VALID_MASTER_TASK_ID,
                markdown_content: '',
            },
        });

        const result = await client.readResource({
            uri: RESOURCE_URIS.taskSummary(VALID_MASTER_TASK_ID),
        });

        // summary was never set, should be empty string
        expect(result.contents[0]).toMatchObject({
            text: '',
        });
    });

    it('reading a resource for non-existent task throws', async () => {
        await expect(
            client.readResource({
                uri: RESOURCE_URIS.taskSummary(VALID_MASTER_TASK_ID),
            })
        ).rejects.toThrow(/Task not found/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Tool Handler Tests
// ═════════════════════════════════════════════════════════════════════════════

describe('CoogentMCPServer — Tool Handlers', () => {
    let tmpDir: string;
    let server: CoogentMCPServer;
    let client: Client;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-server-test-'));
        ({ server, client } = await createConnectedPair(tmpDir));
    });

    afterEach(async () => {
        await teardown(client, server);
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    // ── submit_implementation_plan ───────────────────────────────────────

    it('submit_implementation_plan at master level stores correctly', async () => {
        const result = await client.callTool({
            name: MCP_TOOLS.SUBMIT_IMPLEMENTATION_PLAN,
            arguments: {
                masterTaskId: VALID_MASTER_TASK_ID,
                markdown_content: '# Master Level Plan',
            },
        });

        expect(result).toBeDefined();
        const task = server.getTaskState(VALID_MASTER_TASK_ID);
        expect(task!.implementationPlan).toBe('# Master Level Plan');
    });

    it('submit_implementation_plan at phase level stores correctly', async () => {
        await client.callTool({
            name: MCP_TOOLS.SUBMIT_IMPLEMENTATION_PLAN,
            arguments: {
                masterTaskId: VALID_MASTER_TASK_ID,
                phaseId: VALID_PHASE_ID,
                markdown_content: '# Phase Level Plan',
            },
        });

        const task = server.getTaskState(VALID_MASTER_TASK_ID);
        const phase = task!.phases.get(VALID_PHASE_ID);
        expect(phase).toBeDefined();
        expect(phase!.implementationPlan).toBe('# Phase Level Plan');
    });

    // ── submit_phase_handoff ─────────────────────────────────────────────

    it('submit_phase_handoff stores handoff and emits phaseCompleted', async () => {
        let emittedHandoff: PhaseHandoff | undefined;
        server.onPhaseCompleted((h) => {
            emittedHandoff = h;
        });

        await client.callTool({
            name: MCP_TOOLS.SUBMIT_PHASE_HANDOFF,
            arguments: {
                masterTaskId: VALID_MASTER_TASK_ID,
                phaseId: VALID_PHASE_ID,
                decisions: ['Chose approach A'],
                modified_files: ['src/main.ts', 'src/util.ts'],
                blockers: ['Need API key'],
            },
        });

        const task = server.getTaskState(VALID_MASTER_TASK_ID);
        const phase = task!.phases.get(VALID_PHASE_ID);
        expect(phase!.handoff).toBeDefined();
        expect(phase!.handoff!.decisions).toEqual(['Chose approach A']);
        expect(phase!.handoff!.modifiedFiles).toEqual(['src/main.ts', 'src/util.ts']);
        expect(phase!.handoff!.blockers).toEqual(['Need API key']);

        // Event should have fired
        expect(emittedHandoff).toBeDefined();
        expect(emittedHandoff!.phaseId).toBe(VALID_PHASE_ID);
    });

    // ── submit_consolidation_report ──────────────────────────────────────

    it('submit_consolidation_report stores the report', async () => {
        await client.callTool({
            name: MCP_TOOLS.SUBMIT_CONSOLIDATION_REPORT,
            arguments: {
                masterTaskId: VALID_MASTER_TASK_ID,
                markdown_content: '# Consolidation Report\n\nAll done.',
            },
        });

        const task = server.getTaskState(VALID_MASTER_TASK_ID);
        expect(task!.consolidationReport).toBe('# Consolidation Report\n\nAll done.');
    });

    // ── get_modified_file_content ────────────────────────────────────────

    it('get_modified_file_content reads file from workspace', async () => {
        // Create a file in the temp workspace
        await fs.writeFile(path.join(tmpDir, 'hello.txt'), 'Hello from test');

        const result = await client.callTool({
            name: MCP_TOOLS.GET_MODIFIED_FILE_CONTENT,
            arguments: {
                masterTaskId: VALID_MASTER_TASK_ID,
                phaseId: VALID_PHASE_ID,
                file_path: 'hello.txt',
            },
        });

        expect(result).toBeDefined();
        const content = (result as any).content;
        expect(content).toHaveLength(1);
        expect(content[0].text).toBe('Hello from test');
    });

    it('get_modified_file_content throws for non-existent file', async () => {
        await expect(
            client.callTool({
                name: MCP_TOOLS.GET_MODIFIED_FILE_CONTENT,
                arguments: {
                    masterTaskId: VALID_MASTER_TASK_ID,
                    phaseId: VALID_PHASE_ID,
                    file_path: 'does-not-exist.txt',
                },
            })
        ).rejects.toThrow(/Cannot resolve path/);
    });

    // ── Validation Errors ────────────────────────────────────────────────

    it('tools reject invalid masterTaskId format', async () => {
        await expect(
            client.callTool({
                name: MCP_TOOLS.SUBMIT_IMPLEMENTATION_PLAN,
                arguments: {
                    masterTaskId: 'not-a-valid-id',
                    markdown_content: '# Plan',
                },
            })
        ).rejects.toThrow(/Invalid masterTaskId/);
    });

    it('tools reject invalid phaseId format', async () => {
        await expect(
            client.callTool({
                name: MCP_TOOLS.SUBMIT_PHASE_HANDOFF,
                arguments: {
                    masterTaskId: VALID_MASTER_TASK_ID,
                    phaseId: 'bad-phase-id',
                    decisions: [],
                    modified_files: [],
                    blockers: [],
                },
            })
        ).rejects.toThrow(/Invalid phaseId/);
    });

    it('tools reject unknown tool name', async () => {
        await expect(
            client.callTool({
                name: 'nonexistent_tool',
                arguments: {},
            })
        ).rejects.toThrow();
    });
});

// ═════════════════════════════════════════════════════════════════════════════
//  URI Parsing Tests (via Resource Read — integration)
// ═════════════════════════════════════════════════════════════════════════════

describe('CoogentMCPServer — URI Parsing (via resource reads)', () => {
    let tmpDir: string;
    let server: CoogentMCPServer;
    let client: Client;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-server-test-'));
        ({ server, client } = await createConnectedPair(tmpDir));

        // Seed data so resource reads succeed
        await client.callTool({
            name: MCP_TOOLS.SUBMIT_IMPLEMENTATION_PLAN,
            arguments: {
                masterTaskId: VALID_MASTER_TASK_ID,
                markdown_content: '# Plan',
            },
        });
        await client.callTool({
            name: MCP_TOOLS.SUBMIT_IMPLEMENTATION_PLAN,
            arguments: {
                masterTaskId: VALID_MASTER_TASK_ID,
                phaseId: VALID_PHASE_ID,
                markdown_content: '# Phase Plan',
            },
        });
    });

    afterEach(async () => {
        await teardown(client, server);
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('correctly extracts masterTaskId from task-level URI', async () => {
        const result = await client.readResource({
            uri: `coogent://tasks/${VALID_MASTER_TASK_ID}/implementation_plan`,
        });
        expect((result.contents[0] as any).text).toBe('# Plan');
    });

    it('correctly extracts both masterTaskId and phaseId', async () => {
        const result = await client.readResource({
            uri: `coogent://tasks/${VALID_MASTER_TASK_ID}/phases/${VALID_PHASE_ID}/implementation_plan`,
        });
        expect((result.contents[0] as any).text).toBe('# Phase Plan');
    });

    it('handles trailing slashes gracefully', async () => {
        const result = await client.readResource({
            uri: `coogent://tasks/${VALID_MASTER_TASK_ID}/implementation_plan/`,
        });
        expect((result.contents[0] as any).text).toBe('# Plan');
    });

    it('extra segments after a valid leaf are tolerated by the parser', async () => {
        // The URI parser accepts trailing segments after the resource type
        // (e.g., /handoff/extra) — the extra parts are silently ignored.
        // Seed the phase handoff first so read doesn't throw "Phase not found"
        await client.callTool({
            name: MCP_TOOLS.SUBMIT_PHASE_HANDOFF,
            arguments: {
                masterTaskId: VALID_MASTER_TASK_ID,
                phaseId: VALID_PHASE_ID,
                decisions: [],
                modified_files: [],
                blockers: [],
            },
        });

        const result = await client.readResource({
            uri: `coogent://tasks/${VALID_MASTER_TASK_ID}/phases/${VALID_PHASE_ID}/handoff/extra`,
        });
        // Returns the handoff resource content (extra segment ignored)
        expect(result.contents).toHaveLength(1);
    });

    it('rejects non-coogent scheme URIs', async () => {
        await expect(
            client.readResource({
                uri: `https://example.com/tasks/${VALID_MASTER_TASK_ID}/summary`,
            })
        ).rejects.toThrow();
    });
});

// ═════════════════════════════════════════════════════════════════════════════
//  ListResources Tests
// ═════════════════════════════════════════════════════════════════════════════

describe('CoogentMCPServer — ListResources', () => {
    let tmpDir: string;
    let server: CoogentMCPServer;
    let client: Client;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-server-test-'));
        ({ server, client } = await createConnectedPair(tmpDir));
    });

    afterEach(async () => {
        await teardown(client, server);
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('returns empty list when no tasks exist', async () => {
        const result = await client.listResources();
        expect(result.resources).toEqual([]);
    });

    it('returns task-level and phase-level resources after seeding', async () => {
        await client.callTool({
            name: MCP_TOOLS.SUBMIT_IMPLEMENTATION_PLAN,
            arguments: {
                masterTaskId: VALID_MASTER_TASK_ID,
                phaseId: VALID_PHASE_ID,
                markdown_content: '# Plan',
            },
        });

        const result = await client.listResources();
        // Should have 3 task-level + 2 phase-level = 5
        expect(result.resources.length).toBe(5);
        const uris = result.resources.map((r) => r.uri);
        expect(uris).toContain(RESOURCE_URIS.taskSummary(VALID_MASTER_TASK_ID));
        expect(uris).toContain(RESOURCE_URIS.taskPlan(VALID_MASTER_TASK_ID));
        expect(uris).toContain(RESOURCE_URIS.taskReport(VALID_MASTER_TASK_ID));
        expect(uris).toContain(RESOURCE_URIS.phasePlan(VALID_MASTER_TASK_ID, VALID_PHASE_ID));
        expect(uris).toContain(RESOURCE_URIS.phaseHandoff(VALID_MASTER_TASK_ID, VALID_PHASE_ID));
    });
});
