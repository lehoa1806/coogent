// ─────────────────────────────────────────────────────────────────────────────
// src/engine/ContextAssemblyAdapter.ts — Context assembly for phase execution
// ─────────────────────────────────────────────────────────────────────────────
// Extracted from EngineWiring.executePhase() — Steps 1–3 (context scoping).

import type { Phase, ContextResult } from '../types/index.js';
import { MissionControlPanel } from '../webview/MissionControlPanel.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Types
// ═══════════════════════════════════════════════════════════════════════════════

/** Minimal interface for the context scoper dependency. */
export interface ContextScoperLike {
    assemble(phase: Phase, workspaceRoot: string): Promise<ContextResult>;
}

/** Multi-root capable scoper (duck-typed optional extension). */
export interface MultiRootContextScoper extends ContextScoperLike {
    assembleMultiRoot(phase: Phase, roots: string[]): Promise<ContextResult>;
}

/** Minimal interface for the telemetry logger dependency. */
export interface ContextAssemblyLogger {
    logPhaseStart(phaseId: number): Promise<void>;
    logContextAssembly(
        phaseId: number,
        totalTokens: number,
        limit: number,
        breakdownLength: number,
    ): Promise<void>;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ContextAssemblyAdapter
// ═══════════════════════════════════════════════════════════════════════════════

export interface ContextAssemblyResult {
    ok: true;
    result: ContextResult & { ok: true };
}

export interface ContextAssemblyFailure {
    ok: false;
}

/**
 * Assembles context for a phase by delegating to the ContextScoper and
 * broadcasting token budget information to the UI.
 *
 * Extracted from EngineWiring.executePhase() Steps 0–3.
 */
export class ContextAssemblyAdapter {
    constructor(
        private readonly contextScoper: ContextScoperLike,
        private readonly logger: ContextAssemblyLogger,
    ) { }

    /**
     * Assemble context for a phase, broadcast token budget, and return
     * the result. Returns `{ ok: false }` if the context exceeds the
     * token budget (also broadcasts ERROR to webview).
     */
    async assembleContext(
        phase: Phase,
        workspaceRoot: string,
        workspaceRoots: string[] = [workspaceRoot],
    ): Promise<ContextAssemblyResult | ContextAssemblyFailure> {
        // Step 0: Log phase start
        await this.logger.logPhaseStart(phase.id);

        // Step 1: Assemble context
        // Multi-root: prefer assembleMultiRoot if the scoper supports it,
        // otherwise fall back to single-root assemble.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- duck-type check for optional multi-root support
        const scoper = this.contextScoper as unknown as Record<string, unknown>;
        const result = typeof scoper?.assembleMultiRoot === 'function'
            ? await (scoper.assembleMultiRoot as (phase: Phase, roots: string[]) => Promise<ContextResult>)(phase, workspaceRoots)
            : await this.contextScoper.assemble(phase, workspaceRoot);

        if (!result.ok) {
            MissionControlPanel.broadcast({
                type: 'TOKEN_BUDGET',
                payload: {
                    phaseId: phase.id,
                    breakdown: result.breakdown,
                    totalTokens: result.totalTokens,
                    limit: result.limit,
                },
            });
            MissionControlPanel.broadcast({
                type: 'ERROR',
                payload: {
                    code: 'TOKEN_OVER_BUDGET',
                    message: `Phase ${phase.id} context exceeds token limit (${result.totalTokens}/${result.limit}).`,
                    phaseId: phase.id,
                },
            });
            return { ok: false };
        }

        // Step 2: Log context assembly
        await this.logger.logContextAssembly(
            phase.id, result.totalTokens, result.limit, result.breakdown.length
        );

        // Step 3: Send token budget to UI
        MissionControlPanel.broadcast({
            type: 'TOKEN_BUDGET',
            payload: {
                phaseId: phase.id,
                breakdown: result.breakdown,
                totalTokens: result.totalTokens,
                limit: result.limit,
            },
        });

        return { ok: true, result };
    }
}
