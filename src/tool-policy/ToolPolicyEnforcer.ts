// ─────────────────────────────────────────────────────────────────────────────
// src/tool-policy/ToolPolicyEnforcer.ts — Pure, deterministic tool policy
//                                          evaluator for allow/deny decisions.
// ─────────────────────────────────────────────────────────────────────────────

import type { ToolDecision } from './types.js';
import type { ResolvedPolicy } from './ToolPolicyResolver.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  ToolPolicyEnforcer — stateless policy evaluation
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Evaluates whether a specific tool invocation is allowed given a resolved
 * policy. This class is completely stateless — a pure evaluator with no
 * constructor dependencies.
 *
 * Evaluation rules (in priority order):
 * 1. **Observe mode** (`enforcementMode === 'observe'`): Always allow, but
 *    attach a `reason` indicating the tool *would* have been denied if
 *    enforcement were active.
 * 2. **Compatibility mode** (`enforcementMode === 'compatibility'` AND
 *    `policySource === 'compatibility_mode'`): Always allow (legacy grace
 *    period for workers without explicit policies).
 * 3. **Standard enforcement**: Check if `toolId` is in the `allowedTools`
 *    list. Allow if present, deny if absent.
 *
 * The evaluation is deterministic: same inputs → same output, always.
 */
export class ToolPolicyEnforcer {
    // ─────────────────────────────────────────────────────────────────────────
    //  Public API
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Evaluate whether a tool invocation is allowed.
     *
     * @param policy - The resolved policy from `ToolPolicyResolver.resolve()`.
     * @param toolId - The canonical tool ID to evaluate.
     * @returns A `ToolDecision` indicating whether the invocation is allowed.
     */
    evaluate(policy: ResolvedPolicy, toolId: string): ToolDecision {
        const isInAllowList = policy.allowedTools.includes(toolId);

        // ── Rule 1: Observe mode — always allow, flag would-be denials ──────
        if (policy.enforcementMode === 'observe') {
            return {
                allowed: true,
                toolId,
                policySource: policy.policySource,
                reason: isInAllowList
                    ? undefined
                    : `Tool "${toolId}" would be denied under enforcement (observe mode — not blocked).`,
            };
        }

        // ── Rule 2: Compatibility mode for legacy workers — always allow ────
        if (
            policy.enforcementMode === 'compatibility' &&
            policy.policySource === 'compatibility_mode'
        ) {
            return {
                allowed: true,
                toolId,
                policySource: policy.policySource,
                reason: isInAllowList
                    ? undefined
                    : `Tool "${toolId}" allowed under compatibility mode (legacy grace period).`,
            };
        }

        // ── Rule 3: Standard enforcement — check allow list ─────────────────
        if (isInAllowList) {
            return {
                allowed: true,
                toolId,
                policySource: policy.policySource,
            };
        }

        return {
            allowed: false,
            toolId,
            policySource: policy.policySource,
            reason: `Tool "${toolId}" is not in the allowed tools list (policy source: ${policy.policySource}).`,
        };
    }
}
