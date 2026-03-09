// ─────────────────────────────────────────────────────────────────────────────
// src/context/FileContextModeSelector.ts — Heuristic engine for file context mode selection
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs/promises';
import type { FileContextMode, ChangedFileHandoff } from '../types/context.js';
import type { TokenEncoder } from './ContextScoper.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Input / Output Contracts
// ═══════════════════════════════════════════════════════════════════════════════

/** Input parameters for mode selection on a single file. */
export interface FileModeInput {
    /** Absolute or workspace-relative path to the file. */
    filePath: string;
    /** Absolute path to the workspace root. */
    workspaceRoot: string;
    /** Optional workspace folder for multi-root workspaces. */
    workspaceFolder?: string;
    /** Handoff metadata from an upstream phase (if the file was previously changed). */
    upstreamHandoff?: ChangedFileHandoff;
    /** True if the downstream phase is continuing edits on the same file. */
    isSameFileContinuation: boolean;
    /** True if the downstream phase requires full semantic understanding. */
    phaseNeedsFullSemantics: boolean;
    /** Total token budget for the context pack. Used for budget-aware mode downgrade. */
    tokenBudget?: number;
}

/** Result of mode selection — the chosen mode and the reason it was selected. */
export interface FileModeDecision {
    /** The selected context inclusion mode. */
    mode: FileContextMode;
    /** Human-readable rationale for the mode choice. */
    reason: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Constants
// ═══════════════════════════════════════════════════════════════════════════════

/** Files with fewer lines than this are always included in full. */
const SMALL_FILE_LINE_THRESHOLD = 200;

/** Same-file continuations below this threshold get full content. */
const CONTINUATION_FULL_LINE_THRESHOLD = 500;

/** Fraction of the total budget above which `full` is downgraded. */
const BUDGET_FRACTION_THRESHOLD = 0.40;

// ═══════════════════════════════════════════════════════════════════════════════
//  FileContextModeSelector
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Heuristic engine that decides how much of a file to include in a context pack.
 *
 * Priority order:
 *   1. Full — small file, full-semantics phase, or small same-file continuation
 *   2. Slice — large same-file continuation with known edit regions
 *   3. Patch — upstream patch available for awareness-only inclusion
 *   4. Metadata — default fallback
 *
 * V2: When a token budget is provided, the encoder estimates the cost of `full`
 * mode and downgrades if it exceeds 40% of the budget.
 */
export class FileContextModeSelector {
    /**
     * @param encoder - Token encoder used for budget-aware mode downgrade.
     */
    constructor(private readonly encoder: TokenEncoder) { }

    /**
     * Select the appropriate context mode for a file.
     *
     * @param input - File metadata and phase context for heuristic evaluation.
     * @returns The selected mode and a human-readable reason.
     */
    async selectMode(input: FileModeInput): Promise<FileModeDecision> {
        const { filePath, isSameFileContinuation, phaseNeedsFullSemantics, upstreamHandoff, tokenBudget } = input;

        // ── Read file and count lines ──────────────────────────────────────
        let lineCount: number;
        let content: string;
        try {
            content = await fs.readFile(filePath, 'utf-8');
            lineCount = content.split('\n').length;
        } catch (err: unknown) {
            // File not found or unreadable — degrade to metadata
            const isNotFound =
                err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
            const reason = isNotFound
                ? 'file not found'
                : `file read error: ${err instanceof Error ? err.message : String(err)}`;
            return { mode: 'metadata', reason };
        }

        // ── Rule 1: Full file ──────────────────────────────────────────────
        if (lineCount < SMALL_FILE_LINE_THRESHOLD) {
            return {
                mode: 'full',
                reason: `small file (${lineCount} lines < ${SMALL_FILE_LINE_THRESHOLD} threshold)`,
            };
        }

        if (phaseNeedsFullSemantics) {
            // V2 3.1: Even full-semantics requests can be budget-gated for very large files
            if (tokenBudget) {
                const estimatedTokens = this.encoder.countTokens(content);
                if (estimatedTokens > tokenBudget * BUDGET_FRACTION_THRESHOLD) {
                    // Downgrade: full semantics requested but file is too expensive
                    const hasEditRegions = upstreamHandoff?.editRegions && upstreamHandoff.editRegions.length > 0;
                    if (hasEditRegions) {
                        return {
                            mode: 'slice',
                            reason: `full semantics requested but estimated ${estimatedTokens} tokens > ${Math.round(BUDGET_FRACTION_THRESHOLD * 100)}% of budget (${tokenBudget}) — slicing around edit regions`,
                        };
                    }
                    // No edit regions — still return full (respecting the explicit spec request)
                }
            }
            return {
                mode: 'full',
                reason: 'phase requires full semantic understanding',
            };
        }

        if (isSameFileContinuation && lineCount < CONTINUATION_FULL_LINE_THRESHOLD) {
            return {
                mode: 'full',
                reason: `same-file continuation, file within limit (${lineCount} lines < ${CONTINUATION_FULL_LINE_THRESHOLD} threshold)`,
            };
        }

        // V2 3.1: Budget-aware downgrade for same-file continuation full mode
        if (isSameFileContinuation && lineCount >= CONTINUATION_FULL_LINE_THRESHOLD && tokenBudget) {
            const estimatedTokens = this.encoder.countTokens(content);
            if (estimatedTokens > tokenBudget * BUDGET_FRACTION_THRESHOLD) {
                // Too expensive for full — check if we can slice
                if (upstreamHandoff?.editRegions && upstreamHandoff.editRegions.length > 0) {
                    return {
                        mode: 'slice',
                        reason: `same-file continuation, estimated ${estimatedTokens} tokens > ${Math.round(BUDGET_FRACTION_THRESHOLD * 100)}% of budget (${tokenBudget}) — slicing around edit regions`,
                    };
                }
            }
        }

        // ── Rule 2: Slice ──────────────────────────────────────────────────
        if (
            isSameFileContinuation &&
            lineCount >= CONTINUATION_FULL_LINE_THRESHOLD &&
            upstreamHandoff?.editRegions &&
            upstreamHandoff.editRegions.length > 0
        ) {
            return {
                mode: 'slice',
                reason: 'same-file continuation, large file — slicing around edit regions',
            };
        }

        // ── Rule 3: Patch ──────────────────────────────────────────────────
        if (upstreamHandoff?.patch && !isSameFileContinuation) {
            return {
                mode: 'patch',
                reason: 'upstream patch available, downstream awareness only',
            };
        }

        // ── Rule 4: Metadata (default) ─────────────────────────────────────
        return {
            mode: 'metadata',
            reason: 'default — metadata only',
        };
    }
}
