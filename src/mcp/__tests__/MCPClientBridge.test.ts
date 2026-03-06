// ─────────────────────────────────────────────────────────────────────────────
// MCPClientBridge.test.ts — Comprehensive tests for the MCP Client Bridge
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { CoogentMCPServer } from '../CoogentMCPServer.js';
import { MCPClientBridge } from '../MCPClientBridge.js';
import {
    RESOURCE_URIS,
    MCP_TOOLS,
} from '../types.js';

// ─── Test Fixtures ───────────────────────────────────────────────────────────

const VALID_MASTER_TASK_ID =
    '20260305-173000-a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const VALID_PHASE_ID =
    'phase-001-a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const PARENT_PHASE_ID =
    'phase-000-00000000-0000-0000-0000-000000000000';

// ═════════════════════════════════════════════════════════════════════════════
//  Connection Lifecycle Tests
// ═════════════════════════════════════════════════════════════════════════════

describe('MCPClientBridge — Connection Lifecycle', () => {
    let tmpDir: string;
    let server: CoogentMCPServer;
    let bridge: MCPClientBridge;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-bridge-test-'));
        server = new CoogentMCPServer(tmpDir);
        bridge = new MCPClientBridge(server, tmpDir);
    });

    afterEach(async () => {
        await bridge.disconnect();
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('connect() establishes InMemoryTransport connection', async () => {
        await bridge.connect();

        // After connect, tool calls should work
        await bridge.submitImplementationPlan(
            VALID_MASTER_TASK_ID,
            '# Plan via bridge'
        );

        const task = server.getTaskState(VALID_MASTER_TASK_ID);
        expect(task).toBeDefined();
        expect(task!.implementationPlan).toBe('# Plan via bridge');
    });

    it('connect() is idempotent — second call is a no-op', async () => {
        await bridge.connect();
        // Should not throw on second connect
        await bridge.connect();

        // Should still work correctly
        await bridge.submitImplementationPlan(
            VALID_MASTER_TASK_ID,
            '# Plan'
        );
        expect(server.getTaskState(VALID_MASTER_TASK_ID)!.implementationPlan).toBe('# Plan');
    });

    it('disconnect() closes transport cleanly', async () => {
        await bridge.connect();
        await bridge.disconnect();

        // After disconnect, operations should throw
        await expect(
            bridge.submitImplementationPlan(VALID_MASTER_TASK_ID, '# Plan')
        ).rejects.toThrow(/Not connected/);
    });

    it('disconnect() is safe to call when not connected', async () => {
        // Should not throw
        await bridge.disconnect();
    });

    it('operations throw before connect()', async () => {
        await expect(
            bridge.readResource(RESOURCE_URIS.taskPlan(VALID_MASTER_TASK_ID))
        ).rejects.toThrow(/Not connected/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Core Read / Call Operations
// ═════════════════════════════════════════════════════════════════════════════

describe('MCPClientBridge — Core Operations', () => {
    let tmpDir: string;
    let server: CoogentMCPServer;
    let bridge: MCPClientBridge;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-bridge-test-'));
        server = new CoogentMCPServer(tmpDir);
        bridge = new MCPClientBridge(server, tmpDir);
        await bridge.connect();
    });

    afterEach(async () => {
        await bridge.disconnect();
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('readResource() delegates to MCP client and returns text', async () => {
        // Seed data
        await bridge.submitImplementationPlan(VALID_MASTER_TASK_ID, '# Read Test');

        const text = await bridge.readResource(
            RESOURCE_URIS.taskPlan(VALID_MASTER_TASK_ID)
        );
        expect(text).toBe('# Read Test');
    });

    it('readResource() returns empty string for unset fields', async () => {
        // Create the task but don't set summary
        await bridge.submitImplementationPlan(VALID_MASTER_TASK_ID, '');

        const text = await bridge.readResource(
            RESOURCE_URIS.taskSummary(VALID_MASTER_TASK_ID)
        );
        expect(text).toBe('');
    });

    it('callTool() delegates to MCP client', async () => {
        const result = await bridge.callTool(
            MCP_TOOLS.SUBMIT_IMPLEMENTATION_PLAN,
            {
                masterTaskId: VALID_MASTER_TASK_ID,
                markdown_content: '# Direct call',
            }
        );

        expect(result).toBeDefined();
        const task = server.getTaskState(VALID_MASTER_TASK_ID);
        expect(task!.implementationPlan).toBe('# Direct call');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Warm-Start Prompt Builder
// ═════════════════════════════════════════════════════════════════════════════

describe('MCPClientBridge — buildWarmStartPrompt', () => {
    let tmpDir: string;
    let bridge: MCPClientBridge;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-bridge-test-'));
        const server = new CoogentMCPServer(tmpDir);
        bridge = new MCPClientBridge(server, tmpDir);
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('correctly interpolates masterTaskId and phaseId', () => {
        const prompt = bridge.buildWarmStartPrompt(
            VALID_MASTER_TASK_ID,
            VALID_PHASE_ID
        );

        expect(prompt).toContain(VALID_PHASE_ID);
        expect(prompt).toContain(VALID_MASTER_TASK_ID);
        expect(prompt).toContain(`executing ${VALID_PHASE_ID}`);
        expect(prompt).toContain(`master task ${VALID_MASTER_TASK_ID}`);
    });

    it('uses phaseId for handoff URI when no parentPhaseId', () => {
        const prompt = bridge.buildWarmStartPrompt(
            VALID_MASTER_TASK_ID,
            VALID_PHASE_ID
        );

        const expectedHandoffUri = RESOURCE_URIS.phaseHandoff(
            VALID_MASTER_TASK_ID,
            VALID_PHASE_ID
        );
        expect(prompt).toContain(expectedHandoffUri);
    });

    it('uses parentPhaseId for handoff URI when provided', () => {
        const prompt = bridge.buildWarmStartPrompt(
            VALID_MASTER_TASK_ID,
            VALID_PHASE_ID,
            PARENT_PHASE_ID
        );

        const expectedHandoffUri = RESOURCE_URIS.phaseHandoff(
            VALID_MASTER_TASK_ID,
            PARENT_PHASE_ID
        );
        expect(prompt).toContain(expectedHandoffUri);
        // Should NOT point to the current phase's handoff
        const selfHandoffUri = RESOURCE_URIS.phaseHandoff(
            VALID_MASTER_TASK_ID,
            VALID_PHASE_ID
        );
        expect(prompt).not.toContain(selfHandoffUri);
    });

    it('includes the global plan URI', () => {
        const prompt = bridge.buildWarmStartPrompt(
            VALID_MASTER_TASK_ID,
            VALID_PHASE_ID
        );

        const expectedPlanUri = RESOURCE_URIS.taskPlan(VALID_MASTER_TASK_ID);
        expect(prompt).toContain(expectedPlanUri);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Convenience Method Tests
// ═════════════════════════════════════════════════════════════════════════════

describe('MCPClientBridge — Convenience Methods', () => {
    let tmpDir: string;
    let server: CoogentMCPServer;
    let bridge: MCPClientBridge;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-bridge-test-'));
        server = new CoogentMCPServer(tmpDir);
        bridge = new MCPClientBridge(server, tmpDir);
        await bridge.connect();
    });

    afterEach(async () => {
        await bridge.disconnect();
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('submitImplementationPlan stores at master level', async () => {
        await bridge.submitImplementationPlan(
            VALID_MASTER_TASK_ID,
            '# Master Plan'
        );

        const task = server.getTaskState(VALID_MASTER_TASK_ID);
        expect(task!.implementationPlan).toBe('# Master Plan');
    });

    it('submitImplementationPlan stores at phase level when phaseId given', async () => {
        await bridge.submitImplementationPlan(
            VALID_MASTER_TASK_ID,
            '# Phase Plan',
            VALID_PHASE_ID
        );

        const task = server.getTaskState(VALID_MASTER_TASK_ID);
        expect(task!.phases.get(VALID_PHASE_ID)?.implementationPlan).toBe('# Phase Plan');
    });

    it('submitPhaseHandoff stores handoff correctly', async () => {
        await bridge.submitPhaseHandoff(
            VALID_MASTER_TASK_ID,
            VALID_PHASE_ID,
            ['Decision 1', 'Decision 2'],
            ['file1.ts', 'file2.ts'],
            ['Blocker A']
        );

        const task = server.getTaskState(VALID_MASTER_TASK_ID);
        const handoff = task!.phases.get(VALID_PHASE_ID)?.handoff;
        expect(handoff).toBeDefined();
        expect(handoff!.decisions).toEqual(['Decision 1', 'Decision 2']);
        expect(handoff!.modifiedFiles).toEqual(['file1.ts', 'file2.ts']);
        expect(handoff!.blockers).toEqual(['Blocker A']);
    });

    it('submitConsolidationReport stores the report', async () => {
        await bridge.submitConsolidationReport(
            VALID_MASTER_TASK_ID,
            '# Final Summary'
        );

        const task = server.getTaskState(VALID_MASTER_TASK_ID);
        expect(task!.consolidationReport).toBe('# Final Summary');
    });
});
