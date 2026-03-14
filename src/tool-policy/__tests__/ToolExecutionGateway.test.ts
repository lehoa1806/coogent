// ─────────────────────────────────────────────────────────────────────────────
// src/tool-policy/__tests__/ToolExecutionGateway.test.ts — Unit tests for
//                                                            ToolExecutionGateway
// ─────────────────────────────────────────────────────────────────────────────

jest.mock('../../logger/log.js', () => ({
    __esModule: true,
    default: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    },
}));

import log from '../../logger/log.js';
import { ToolExecutionGateway } from '../ToolExecutionGateway.js';
import { ToolRegistry } from '../ToolRegistry.js';
import { ToolPolicyResolver } from '../ToolPolicyResolver.js';
import { ToolPolicyEnforcer } from '../ToolPolicyEnforcer.js';
import type { ToolInvocationContext, WorkspaceToolPolicy } from '../types.js';

describe('ToolExecutionGateway', () => {
    let registry: ToolRegistry;
    let resolver: ToolPolicyResolver;
    let enforcer: ToolPolicyEnforcer;
    let gateway: ToolExecutionGateway;
    let workspacePolicy: WorkspaceToolPolicy;

    /** Build a minimal invocation context for testing. */
    function makeCtx(requestedToolId: string): ToolInvocationContext {
        return {
            runId: 'run-001',
            sessionId: 'session-001',
            phaseId: 'phase-001',
            workerId: 'worker-001',
            requestedToolId,
        };
    }

    beforeEach(() => {
        jest.clearAllMocks();

        registry = new ToolRegistry();
        resolver = new ToolPolicyResolver(registry);
        enforcer = new ToolPolicyEnforcer();
        workspacePolicy = {
            defaultPolicy: {
                mode: 'explicit',
                allowedTools: ['submit_execution_plan', 'get_file_slice'],
            },
            enforcementMode: 'enforce',
        };
        gateway = new ToolExecutionGateway(registry, resolver, enforcer, workspacePolicy);
    });

    // ═════════════════════════════════════════════════════════════════════════
    //  Full pipeline: allowed tool
    // ═════════════════════════════════════════════════════════════════════════

    it('allows a tool that is in the workspace default policy', async () => {
        const decision = await gateway.evaluateInvocation(
            makeCtx('submit_execution_plan'),
        );

        expect(decision.allowed).toBe(true);
        expect(decision.toolId).toBe('coogent.submit_execution_plan');
    });

    // ═════════════════════════════════════════════════════════════════════════
    //  Full pipeline: denied tool
    // ═════════════════════════════════════════════════════════════════════════

    it('denies a tool that is NOT in the workspace default policy', async () => {
        const decision = await gateway.evaluateInvocation(
            makeCtx('submit_phase_handoff'),
        );

        expect(decision.allowed).toBe(false);
        expect(decision.toolId).toBe('coogent.submit_phase_handoff');
        expect(decision.reason).toContain('not in the allowed tools list');
    });

    // ═════════════════════════════════════════════════════════════════════════
    //  Unknown tool ID fails closed
    // ═════════════════════════════════════════════════════════════════════════

    it('denies an unregistered/unknown tool immediately', async () => {
        const decision = await gateway.evaluateInvocation(
            makeCtx('completely_unknown_tool'),
        );

        expect(decision.allowed).toBe(false);
        expect(decision.toolId).toBe('completely_unknown_tool');
        expect(decision.reason).toBe('UNKNOWN_TOOL');
    });

    // ═════════════════════════════════════════════════════════════════════════
    //  ADR #7: Logging emitted for allow and deny
    // ═════════════════════════════════════════════════════════════════════════

    describe('audit logging', () => {
        it('logs info when a tool is allowed', async () => {
            await gateway.evaluateInvocation(makeCtx('submit_execution_plan'));

            expect(log.info).toHaveBeenCalledWith(
                expect.stringContaining('tool_policy.allowed'),
            );
            expect(log.info).toHaveBeenCalledWith(
                expect.stringContaining('worker-001'),
            );
        });

        it('logs warn when a tool is denied', async () => {
            await gateway.evaluateInvocation(makeCtx('submit_phase_handoff'));

            expect(log.warn).toHaveBeenCalledWith(
                expect.stringContaining('tool_policy.denied'),
            );
            expect(log.warn).toHaveBeenCalledWith(
                expect.stringContaining('worker-001'),
            );
        });

        it('logs warn for unknown tools', async () => {
            await gateway.evaluateInvocation(makeCtx('unknown_tool'));

            expect(log.warn).toHaveBeenCalledWith(
                expect.stringContaining('UNKNOWN_TOOL'),
            );
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    //  ADR #9: Plugin and MCP tools pass through same enforcement path
    // ═════════════════════════════════════════════════════════════════════════

    describe('plugin and MCP tools use the same enforcement path', () => {
        it('allows a registered custom plugin tool when in the allowed list', async () => {
            // Register a custom plugin tool
            registry.register('plugin.custom_lint', ['custom_lint']);

            // Create a worker policy that explicitly allows the plugin tool
            const workerPolicy = {
                mode: 'explicit' as const,
                allowedTools: ['plugin.custom_lint'],
            };

            const decision = await gateway.evaluateInvocation(
                makeCtx('custom_lint'),
                workerPolicy,
            );

            expect(decision.allowed).toBe(true);
            expect(decision.toolId).toBe('plugin.custom_lint');
            expect(decision.policySource).toBe('worker_override');
        });

        it('denies a registered custom plugin tool when NOT in the allowed list', async () => {
            registry.register('plugin.custom_lint', ['custom_lint']);

            // Worker only allows MCP tools, not the plugin tool
            const workerPolicy = {
                mode: 'explicit' as const,
                allowedTools: ['submit_execution_plan'],
            };

            const decision = await gateway.evaluateInvocation(
                makeCtx('custom_lint'),
                workerPolicy,
            );

            expect(decision.allowed).toBe(false);
            expect(decision.toolId).toBe('plugin.custom_lint');
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    //  Additional edge cases
    // ═════════════════════════════════════════════════════════════════════════

    describe('edge cases', () => {
        it('setWorkspacePolicy updates the policy at runtime', async () => {
            // Initially submit_phase_handoff is NOT allowed
            let decision = await gateway.evaluateInvocation(
                makeCtx('submit_phase_handoff'),
            );
            expect(decision.allowed).toBe(false);

            // Update workspace policy to include it
            gateway.setWorkspacePolicy({
                defaultPolicy: {
                    mode: 'explicit',
                    allowedTools: ['submit_phase_handoff'],
                },
                enforcementMode: 'enforce',
            });

            decision = await gateway.evaluateInvocation(
                makeCtx('submit_phase_handoff'),
            );
            expect(decision.allowed).toBe(true);
        });

        it('accepts canonical IDs as input and normalizes them', async () => {
            const decision = await gateway.evaluateInvocation(
                makeCtx('coogent.submit_execution_plan'),
            );
            expect(decision.allowed).toBe(true);
            expect(decision.toolId).toBe('coogent.submit_execution_plan');
        });
    });
});
