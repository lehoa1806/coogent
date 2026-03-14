// ─────────────────────────────────────────────────────────────────────────────
// src/tool-policy/ToolExecutionGateway.ts — Single enforcement boundary for
//                                            all worker-initiated MCP tool calls.
// ─────────────────────────────────────────────────────────────────────────────
// Orchestrates: ToolRegistry → ToolPolicyResolver → ToolPolicyEnforcer → audit log.

import log from '../logger/log.js';
import type { ToolRegistry } from './ToolRegistry.js';
import type { ToolPolicyResolver } from './ToolPolicyResolver.js';
import type { ToolPolicyEnforcer } from './ToolPolicyEnforcer.js';
import type {
    WorkspaceToolPolicy,
    AllowedToolsPolicy,
    ToolInvocationContext,
    ToolDecision,
} from './types.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  ToolExecutionGateway — policy evaluation orchestrator
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The single enforcement boundary for all worker-initiated MCP tool calls.
 *
 * Ties together registry normalization, policy resolution, enforcement
 * evaluation, and audit logging into a single `evaluateInvocation()` call.
 *
 * Phase 1 (observe mode): logs decisions but never blocks tool execution.
 */
export class ToolExecutionGateway {
    constructor(
        private readonly registry: ToolRegistry,
        private readonly resolver: ToolPolicyResolver,
        private readonly enforcer: ToolPolicyEnforcer,
        private workspacePolicy: WorkspaceToolPolicy,
    ) {}

    // ─────────────────────────────────────────────────────────────────────────
    //  Public API
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Update the workspace policy at runtime (e.g., from settings changes).
     */
    setWorkspacePolicy(policy: WorkspaceToolPolicy): void {
        this.workspacePolicy = policy;
    }

    /**
     * Main entry point: evaluate policy before a tool invocation.
     *
     * @param ctx          - Runtime context for the tool invocation.
     * @param workerPolicy - The worker's own allowed-tools policy (if any).
     * @param isLegacyWorker - `true` when the worker has no policy configured.
     * @returns The `ToolDecision` indicating whether the invocation is allowed.
     */
    async evaluateInvocation(
        ctx: ToolInvocationContext,
        workerPolicy?: AllowedToolsPolicy,
        isLegacyWorker?: boolean,
    ): Promise<ToolDecision> {
        // ── Step 1: Normalize the raw tool ID to its canonical form ──────────
        const canonicalId = this.registry.normalize(ctx.requestedToolId);

        if (canonicalId === null) {
            // Unknown tool — deny immediately.
            const decision: ToolDecision = {
                allowed: false,
                toolId: ctx.requestedToolId,
                policySource: 'workspace_default',
                reason: 'UNKNOWN_TOOL',
            };
            log.warn(
                `[ToolPolicy] tool_policy.denied: workerId=${ctx.workerId} toolId=${ctx.requestedToolId} reason=UNKNOWN_TOOL phaseId=${ctx.phaseId}`,
            );
            return decision;
        }

        // ── Step 2: Resolve the effective policy ─────────────────────────────
        const resolvedPolicy = this.resolver.resolve(
            this.workspacePolicy,
            workerPolicy,
            isLegacyWorker ?? false,
        );

        // ── Step 3: Evaluate the policy ──────────────────────────────────────
        const decision = this.enforcer.evaluate(resolvedPolicy, canonicalId);

        // ── Step 4: Audit log the decision ───────────────────────────────────
        if (decision.allowed) {
            log.info(
                `[ToolPolicy] tool_policy.allowed: workerId=${ctx.workerId} toolId=${decision.toolId} policySource=${decision.policySource} phaseId=${ctx.phaseId}`,
            );
        } else {
            log.warn(
                `[ToolPolicy] tool_policy.denied: workerId=${ctx.workerId} toolId=${decision.toolId} policySource=${decision.policySource} phaseId=${ctx.phaseId} reason=${decision.reason ?? 'N/A'}`,
            );
        }

        return decision;
    }
}
