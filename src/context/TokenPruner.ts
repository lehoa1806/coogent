// ─────────────────────────────────────────────────────────────────────────────
// src/context/TokenPruner.ts — Heuristic token pruning for over-budget payloads
// ─────────────────────────────────────────────────────────────────────────────

import type { TokenEncoder } from './ContextScoper.js';
import type { FileTokenEntry } from '../types/index.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Token Pruner
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * A single file entry with content and token metadata.
 */
export interface PrunableEntry {
    readonly path: string;
    content: string;
    tokenCount: number;
    /** Whether this file was explicitly listed (vs. discovered). */
    readonly isExplicit: boolean;
}

/**
 * Result of a pruning operation.
 */
export interface PruneResult {
    /** Whether the pruned payload fits within the token budget. */
    readonly withinBudget: boolean;
    /** The pruned entries. */
    readonly entries: readonly PrunableEntry[];
    /** Total tokens after pruning. */
    readonly totalTokens: number;
    /** Token limit that was targeted. */
    readonly limit: number;
    /** Breakdown per file after pruning. */
    readonly breakdown: readonly FileTokenEntry[];
    /** Number of files that were pruned. */
    readonly prunedCount: number;
}

/**
 * Heuristic token pruning strategies for reducing over-budget payloads.
 *
 * Pruning strategy (in priority order):
 * 1. Drop discovered (non-explicit) files by size (largest first).
 * 2. Strip function/method bodies from discovered files (keep signatures).
 * 3. Truncate remaining large files to a max-per-file token budget.
 *
 * This is a best-effort reducer — it does NOT guarantee the payload will
 * fit within budget. The caller must check `withinBudget` after pruning.
 */
export class TokenPruner {
    constructor(
        private readonly encoder: TokenEncoder,
        private readonly tokenLimit: number
    ) { }

    /**
     * Attempt to prune entries to fit within the token limit.
     */
    prune(entries: PrunableEntry[]): PruneResult {
        let totalTokens = entries.reduce((sum, e) => sum + e.tokenCount, 0);
        let prunedCount = 0;

        // Already within budget — no pruning needed
        if (totalTokens <= this.tokenLimit) {
            return this.buildResult(entries, totalTokens, prunedCount);
        }

        // ── Strategy 1: Drop discovered (non-explicit) files, largest first ──
        const discoveredIndices = entries
            .map((e, i) => ({ index: i, tokens: e.tokenCount, isExplicit: e.isExplicit }))
            .filter(e => !e.isExplicit)
            .sort((a, b) => b.tokens - a.tokens);

        const droppedIndices = new Set<number>();

        for (const disc of discoveredIndices) {
            if (totalTokens <= this.tokenLimit) break;
            totalTokens -= disc.tokens;
            droppedIndices.add(disc.index);
            prunedCount++;
        }

        const remaining = entries.filter((_, i) => !droppedIndices.has(i));

        if (totalTokens <= this.tokenLimit) {
            return this.buildResult(remaining, totalTokens, prunedCount);
        }

        // ── Strategy 2: Strip function bodies from remaining files ───────────
        for (const entry of remaining) {
            const stripped = this.stripFunctionBodies(entry.content, entry.path);
            if (stripped !== entry.content) {
                const oldTokens = entry.tokenCount;
                entry.content = stripped;
                entry.tokenCount = this.encoder.countTokens(stripped);
                totalTokens -= (oldTokens - entry.tokenCount);
                prunedCount++;
            }
        }

        if (totalTokens <= this.tokenLimit) {
            return this.buildResult(remaining, totalTokens, prunedCount);
        }

        // ── Strategy 3: Truncate large files proportionally ──────────────────
        const maxPerFile = Math.floor(this.tokenLimit / remaining.length);
        totalTokens = 0;

        for (const entry of remaining) {
            if (entry.tokenCount > maxPerFile) {
                // Truncate content to rough character estimate
                const targetChars = maxPerFile * 4; // inverse of CharRatioEncoder
                entry.content = entry.content.slice(0, targetChars) +
                    '\n\n// ... [truncated by Coogent — exceeds per-file token budget] ...';
                entry.tokenCount = this.encoder.countTokens(entry.content);
                prunedCount++;
            }
            totalTokens += entry.tokenCount;
        }

        return this.buildResult(remaining, totalTokens, prunedCount);
    }

    /**
     * Strip function/method bodies from source code, keeping signatures.
     * Uses brace-counting heuristic — works for C-family and Swift.
     */
    private stripFunctionBodies(content: string, filePath: string): string {
        const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
        const braceLanguages = ['ts', 'tsx', 'js', 'jsx', 'swift', 'c', 'cpp', 'cc', 'h', 'hpp', 'cxx'];

        if (!braceLanguages.includes(ext)) {
            return content; // Don't strip non-brace languages (Python, etc.)
        }

        const lines = content.split('\n');
        const result: string[] = [];
        let braceDepth = 0;
        let inFunctionBody = false;
        let functionStartDepth = 0;

        for (const line of lines) {
            const trimmed = line.trim();

            // Skip empty lines inside function bodies
            if (inFunctionBody) {
                for (const ch of line) {
                    if (ch === '{') braceDepth++;
                    if (ch === '}') braceDepth--;
                }
                if (braceDepth <= functionStartDepth) {
                    inFunctionBody = false;
                    result.push(line.replace(/\{[\s\S]*\}/, '{ /* ... */ }'));
                }
                continue;
            }

            // Detect function/method start (heuristic: line ends or contains '{')
            const isFnSignature = /^(export\s+)?(async\s+)?function\s+/.test(trimmed) ||
                /^(public|private|protected|static|async)\s+/.test(trimmed) ||
                /^\w+.*\(.*\)\s*(\{|:)/.test(trimmed);

            if (isFnSignature && line.includes('{')) {
                functionStartDepth = braceDepth;
                for (const ch of line) {
                    if (ch === '{') braceDepth++;
                    if (ch === '}') braceDepth--;
                }

                if (braceDepth > functionStartDepth) {
                    // Function body spans multiple lines
                    inFunctionBody = true;
                    result.push(line.replace(/\{.*$/, '{ /* ... pruned ... */ }'));
                } else {
                    // One-liner function — keep as-is
                    result.push(line);
                }
            } else {
                result.push(line);
            }
        }

        return result.join('\n');
    }

    private buildResult(
        entries: PrunableEntry[],
        totalTokens: number,
        prunedCount: number
    ): PruneResult {
        return {
            withinBudget: totalTokens <= this.tokenLimit,
            entries,
            totalTokens,
            limit: this.tokenLimit,
            breakdown: entries.map(e => ({ path: e.path, tokens: e.tokenCount })),
            prunedCount,
        };
    }
}
