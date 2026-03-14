// ─────────────────────────────────────────────────────────────────────────────
// src/tool-policy/ToolPolicyResolver.ts — Resolves the effective allowed-tools
//                                          policy for a worker agent.
// ─────────────────────────────────────────────────────────────────────────────

import type { AllowedToolsPolicy, EnforcementMode, WorkspaceToolPolicy } from './types.js';
import type { ToolRegistry } from './ToolRegistry.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Resolved Policy — the output of the resolution process
// ═══════════════════════════════════════════════════════════════════════════════

/** The effective policy after resolution, ready for enforcement. */
export interface ResolvedPolicy {
    /** Canonical tool IDs the worker is allowed to invoke. */
    allowedTools: string[];
    /** Which policy source produced this resolved policy. */
    policySource: 'workspace_default' | 'worker_override' | 'compatibility_mode';
    /** Current enforcement stage. */
    enforcementMode: EnforcementMode;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ToolPolicyResolver — deterministic policy resolution
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Resolves the effective allowed-tools policy for a worker agent by merging
 * workspace defaults, worker overrides, and legacy compatibility rules.
 *
 * Resolution priority:
 * 1. If `isLegacyWorker` is true and no explicit policy exists → compatibility
 *    mode (all known tools allowed).
 * 2. If the worker has an explicit policy (`mode: 'explicit'`) → use the
 *    worker's `allowedTools` list.
 * 3. If the worker inherits (`mode: 'inherit'`) or has no policy → use the
 *    workspace default.
 * 4. If neither workspace default nor worker policy exists → safe default
 *    (empty allow list = deny all).
 *
 * This class is pure and deterministic: same inputs → same output.
 */
export class ToolPolicyResolver {
    private readonly registry: ToolRegistry;

    constructor(registry: ToolRegistry) {
        this.registry = registry;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Public API
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Resolve the effective policy for a worker.
     *
     * @param workspacePolicy - Workspace-level default policy (may be undefined
     *   for legacy setups that predate the policy system).
     * @param workerPolicy    - The worker's own `AllowedToolsPolicy` from its
     *   `AgentProfile` (may be undefined if the worker has no policy configured).
     * @param isLegacyWorker  - `true` when the worker has no policy configured
     *   at all (triggers compatibility mode).
     * @returns The resolved policy ready for enforcement.
     */
    resolve(
        workspacePolicy: WorkspaceToolPolicy | undefined,
        workerPolicy: AllowedToolsPolicy | undefined,
        isLegacyWorker: boolean,
    ): ResolvedPolicy {
        // ── Case 1: Legacy worker with no explicit policy → compatibility mode ──
        if (isLegacyWorker && !workerPolicy) {
            return {
                allowedTools: this.registry.getAllCanonicalIds(),
                policySource: 'compatibility_mode',
                enforcementMode: workspacePolicy?.enforcementMode ?? 'compatibility',
            };
        }

        // ── Case 2: Worker has an explicit policy → worker override ─────────
        if (workerPolicy?.mode === 'explicit') {
            return {
                allowedTools: this.normalizeToolIds(workerPolicy.allowedTools ?? []),
                policySource: 'worker_override',
                enforcementMode: workspacePolicy?.enforcementMode ?? 'enforce',
            };
        }

        // ── Case 3: Worker inherits or has no policy → workspace default ────
        if (workspacePolicy) {
            return {
                allowedTools: this.normalizeToolIds(
                    workspacePolicy.defaultPolicy.allowedTools ?? [],
                ),
                policySource: 'workspace_default',
                enforcementMode: workspacePolicy.enforcementMode,
            };
        }

        // ── Case 4: No workspace default, no worker policy → deny all ───────
        return {
            allowedTools: [],
            policySource: 'workspace_default',
            enforcementMode: 'enforce',
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Internals
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Normalize an array of raw tool IDs to their canonical forms.
     * Unknown tool IDs are silently dropped — the enforcer will deny them
     * anyway since they won't appear in the allow list.
     */
    private normalizeToolIds(rawIds: string[]): string[] {
        const normalized: string[] = [];
        for (const raw of rawIds) {
            const canonical = this.registry.normalize(raw);
            if (canonical !== null) {
                normalized.push(canonical);
            }
        }
        return normalized;
    }
}
