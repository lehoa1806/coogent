// ─────────────────────────────────────────────────────────────────────────────
// src/mcp/__tests__/MCPToolHandler.policy-integration.test.ts — Integration tests
// for ToolExecutionGateway ↔ MCPToolHandler pipeline
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

import { ToolExecutionGateway } from '../../tool-policy/ToolExecutionGateway.js';
import { ToolRegistry } from '../../tool-policy/ToolRegistry.js';
import { ToolPolicyResolver } from '../../tool-policy/ToolPolicyResolver.js';
import { ToolPolicyEnforcer } from '../../tool-policy/ToolPolicyEnforcer.js';
import type { AllowedToolsPolicy, WorkspaceToolPolicy } from '../../tool-policy/types.js';

describe('MCPToolHandler ↔ ToolExecutionGateway integration', () => {
    let registry: ToolRegistry;
    let resolver: ToolPolicyResolver;
    let enforcer: ToolPolicyEnforcer;
    let gateway: ToolExecutionGateway;

    // ═══════════════════════════════════════════════════════════════════════
    //  Shared setup: builds a real gateway stack (no mocks)
    // ═══════════════════════════════════════════════════════════════════════

    beforeEach(() => {
        jest.clearAllMocks();
        registry = new ToolRegistry();
        resolver = new ToolPolicyResolver(registry);
        enforcer = new ToolPolicyEnforcer();
    });

    function makeGateway(policy: WorkspaceToolPolicy): ToolExecutionGateway {
        gateway = new ToolExecutionGateway(registry, resolver, enforcer, policy);
        return gateway;
    }

    function makeCtx(requestedToolId: string, workerId = 'worker-001') {
        return {
            runId: 'run-001',
            sessionId: 'session-001',
            phaseId: 'phase-001',
            workerId,
            requestedToolId,
        };
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Enforce mode: gateway denies unlisted tools
    // ═══════════════════════════════════════════════════════════════════════

    it('denies an unlisted tool in enforce mode', async () => {
        makeGateway({
            defaultPolicy: {
                mode: 'explicit',
                allowedTools: ['submit_execution_plan'],
            },
            enforcementMode: 'enforce',
        });

        const decision = await gateway.evaluateInvocation(
            makeCtx('submit_phase_handoff'),
        );

        expect(decision.allowed).toBe(false);
        expect(decision.toolId).toBe('coogent.submit_phase_handoff');
    });

    // ═══════════════════════════════════════════════════════════════════════
    //  Enforce mode: gateway allows listed tools
    // ═══════════════════════════════════════════════════════════════════════

    it('allows a listed tool in enforce mode', async () => {
        makeGateway({
            defaultPolicy: {
                mode: 'explicit',
                allowedTools: ['submit_execution_plan'],
            },
            enforcementMode: 'enforce',
        });

        const decision = await gateway.evaluateInvocation(
            makeCtx('submit_execution_plan'),
        );

        expect(decision.allowed).toBe(true);
        expect(decision.toolId).toBe('coogent.submit_execution_plan');
    });

    // ═══════════════════════════════════════════════════════════════════════
    //  Observe mode: tool proceeds even when policy would deny
    // ═══════════════════════════════════════════════════════════════════════

    it('allows any tool in observe mode (log-only)', async () => {
        makeGateway({
            defaultPolicy: {
                mode: 'explicit',
                allowedTools: ['submit_execution_plan'],
            },
            enforcementMode: 'observe',
        });

        const decision = await gateway.evaluateInvocation(
            makeCtx('submit_phase_handoff'),
        );

        // In observe mode, the enforcer always returns allowed=true
        expect(decision.allowed).toBe(true);
    });

    // ═══════════════════════════════════════════════════════════════════════
    //  Worker override: per-worker policy takes precedence
    // ═══════════════════════════════════════════════════════════════════════

    it('uses worker-specific policy when provided', async () => {
        makeGateway({
            defaultPolicy: {
                mode: 'explicit',
                allowedTools: ['submit_execution_plan'],
            },
            enforcementMode: 'enforce',
        });

        // Worker has an explicit policy that allows submit_phase_handoff
        const workerPolicy: AllowedToolsPolicy = {
            mode: 'explicit',
            allowedTools: ['submit_phase_handoff'],
        };

        const decision = await gateway.evaluateInvocation(
            makeCtx('submit_phase_handoff'),
            workerPolicy,
        );

        expect(decision.allowed).toBe(true);
        expect(decision.policySource).toBe('worker_override');
    });

    // ═══════════════════════════════════════════════════════════════════════
    //  Legacy worker: compatibility mode passes all tools
    // ═══════════════════════════════════════════════════════════════════════

    it('passes all tools for legacy workers in compatibility mode', async () => {
        makeGateway({
            defaultPolicy: {
                mode: 'explicit',
                allowedTools: ['submit_execution_plan'],
            },
            enforcementMode: 'compatibility',
        });

        // Legacy worker — no per-worker policy, isLegacyWorker = true
        const decision = await gateway.evaluateInvocation(
            makeCtx('submit_phase_handoff'),
            undefined,
            true, // isLegacyWorker
        );

        // In compatibility mode, legacy workers are not blocked
        expect(decision.allowed).toBe(true);
    });

    // ═══════════════════════════════════════════════════════════════════════
    //  setWorkspacePolicy: runtime policy update
    // ═══════════════════════════════════════════════════════════════════════

    it('respects runtime policy updates via setWorkspacePolicy', async () => {
        makeGateway({
            defaultPolicy: {
                mode: 'explicit',
                allowedTools: ['submit_execution_plan'],
            },
            enforcementMode: 'enforce',
        });

        // Initially denied
        let decision = await gateway.evaluateInvocation(
            makeCtx('submit_phase_handoff'),
        );
        expect(decision.allowed).toBe(false);

        // Switch to observe mode at runtime
        gateway.setWorkspacePolicy({
            defaultPolicy: {
                mode: 'explicit',
                allowedTools: ['submit_execution_plan'],
            },
            enforcementMode: 'observe',
        });

        // Now allowed (observe mode = log only)
        decision = await gateway.evaluateInvocation(
            makeCtx('submit_phase_handoff'),
        );
        expect(decision.allowed).toBe(true);
    });
});
