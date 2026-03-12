// ─────────────────────────────────────────────────────────────────────────────
// src/context/TokenPruner.ts — Heuristic token pruning for over-budget payloads
// ─────────────────────────────────────────────────────────────────────────────

import type { TokenEncoder } from './ContextScoper.js';
import type { FileTokenEntry } from '../types/index.js';
import type { FileContextMode } from '../types/context.js';

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
    /** The context mode this entry was materialized with. */
    mode?: FileContextMode;
    /** Priority weight (lower = drop first). Defaults to 0 if unset. */
    priority?: number;
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
    /** True when the pack exceeds the budget even after full degradation. */
    readonly overBudget: boolean;
    /** Reason for irreducibility when overBudget is true. */
    readonly reason?: string;
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
        // #40: Clone entries to prevent mutation of caller's array
        const cloned = entries.map(e => ({ ...e }));
        let totalTokens = cloned.reduce((sum, e) => sum + e.tokenCount, 0);
        let prunedCount = 0;

        // Already within budget — no pruning needed
        if (totalTokens <= this.tokenLimit) {
            return this.buildResult(cloned, totalTokens, prunedCount);
        }

        // ── Strategy 1: Drop discovered (non-explicit) files, largest first ──
        const discoveredIndices = cloned
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

        const remaining = cloned.filter((_, i) => !droppedIndices.has(i));

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
                // #39: Derive chars-per-token from the encoder instead of hardcoded 4:1
                const charsPerToken = entry.tokenCount > 0
                    ? Math.ceil(entry.content.length / entry.tokenCount)
                    : 4; // fallback
                const targetChars = maxPerFile * charsPerToken;
                entry.content = entry.content.slice(0, targetChars) +
                    '\n\n// ... [truncated by Coogent — exceeds per-file token budget] ...';
                entry.tokenCount = this.encoder.countTokens(entry.content);
                prunedCount++;
            }
            totalTokens += entry.tokenCount;
        }

        if (totalTokens <= this.tokenLimit) {
            return this.buildResult(remaining, totalTokens, prunedCount);
        }

        // ── Strategy 4: Degradation cascade ──────────────────────────────
        return this.degradationCascade(remaining, totalTokens, prunedCount);
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
        let inBlockComment = false;

        for (const line of lines) {
            const trimmed = line.trim();

            // QUAL-3: Count braces using lexer-aware helper
            const braces = TokenPruner.countEffectiveBraces(line, inBlockComment);
            inBlockComment = braces.endsInBlockComment;

            // Skip empty lines inside function bodies
            if (inFunctionBody) {
                braceDepth += braces.open - braces.close;
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

            if (isFnSignature && braces.open > 0) {
                functionStartDepth = braceDepth;
                braceDepth += braces.open - braces.close;

                if (braceDepth > functionStartDepth) {
                    // Function body spans multiple lines
                    inFunctionBody = true;
                    result.push(line.replace(/\{.*$/, '{ /* ... pruned ... */ }'));
                } else {
                    // One-liner function — keep as-is
                    result.push(line);
                }
            } else {
                braceDepth += braces.open - braces.close;
                result.push(line);
            }
        }

        return result.join('\n');
    }

    /**
     * QUAL-3: Count braces in a line while respecting lexer state.
     * Skips braces inside string literals, single-line comments, and
     * block comments.
     */
    private static countEffectiveBraces(
        line: string,
        inBlockComment: boolean,
    ): { open: number; close: number; endsInBlockComment: boolean } {
        let open = 0;
        let close = 0;
        let inString: string | false = false;
        let inLineComment = false;
        let inBlock = inBlockComment;

        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            const next = i + 1 < line.length ? line[i + 1] : '';

            // Block comment state
            if (inBlock) {
                if (ch === '*' && next === '/') { inBlock = false; i++; }
                continue;
            }

            // Line comment — rest of line is ignored
            if (inLineComment) continue;

            // String literal state
            if (inString) {
                if (ch === '\\') { i++; continue; } // skip escaped char
                if (ch === inString) inString = false;
                continue;
            }

            // Detect comment starts
            if (ch === '/' && next === '/') { inLineComment = true; continue; }
            if (ch === '/' && next === '*') { inBlock = true; i++; continue; }

            // Detect string starts
            if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue; }

            // Count braces
            if (ch === '{') open++;
            if (ch === '}') close++;
        }

        return { open, close, endsInBlockComment: inBlock };
    }

    /**
     * Deterministic degradation cascade:
     *   a. Downgrade `full` → `slice` (first 200 lines)
     *   b. Downgrade `slice` → `metadata` (file name + size + first 10 lines)
     *   c. Drop lowest-priority metadata entries
     */
    private degradationCascade(
        entries: PrunableEntry[],
        initialTotal: number,
        prunedCount: number
    ): PruneResult {
        let totalTokens = initialTotal;

        // ── Pass A: Downgrade full → slice (first 200 lines) ─────────────
        for (const entry of entries) {
            if (totalTokens <= this.tokenLimit) break;
            if (entry.mode !== 'full') continue;

            const lines = entry.content.split('\n');
            if (lines.length <= 200) continue; // already small enough

            const oldTokens = entry.tokenCount;
            entry.content = lines.slice(0, 200).join('\n') +
                '\n\n// ... [sliced by Coogent — budget degradation, first 200 lines] ...';
            entry.tokenCount = this.encoder.countTokens(entry.content);
            entry.mode = 'slice';
            totalTokens -= (oldTokens - entry.tokenCount);
            prunedCount++;
        }

        if (totalTokens <= this.tokenLimit) {
            return this.buildResult(entries, totalTokens, prunedCount);
        }

        // ── Pass B: Downgrade slice → metadata (file name + size + first 10 lines)
        for (const entry of entries) {
            if (totalTokens <= this.tokenLimit) break;
            if (entry.mode !== 'slice') continue;

            const lines = entry.content.split('\n');
            const oldTokens = entry.tokenCount;
            const header = `// ${entry.path} (${lines.length} lines, ${entry.content.length} bytes)`;
            const preview = lines.slice(0, 10).join('\n');
            const metadataContent = header + '\n' + preview +
                '\n// ... [metadata-only — budget degradation] ...';
            const metadataTokens = this.encoder.countTokens(metadataContent);

            // Only apply if it actually reduces token count
            if (metadataTokens < oldTokens) {
                entry.content = metadataContent;
                entry.tokenCount = metadataTokens;
                entry.mode = 'metadata';
                totalTokens -= (oldTokens - metadataTokens);
                prunedCount++;
            }
        }

        if (totalTokens <= this.tokenLimit) {
            return this.buildResult(entries, totalTokens, prunedCount);
        }

        // ── Pass C: Drop lowest-priority metadata entries ────────────────
        const sorted = entries
            .map((e, i) => ({ entry: e, index: i, priority: e.priority ?? 0 }))
            .sort((a, b) => a.priority - b.priority); // lowest priority first

        const droppedIndices = new Set<number>();
        for (const { entry, index } of sorted) {
            if (totalTokens <= this.tokenLimit) break;
            if (entry.mode !== 'metadata') continue;
            totalTokens -= entry.tokenCount;
            droppedIndices.add(index);
            prunedCount++;
        }

        const remaining = entries.filter((_, i) => !droppedIndices.has(i));

        if (totalTokens <= this.tokenLimit) {
            return this.buildResult(remaining, totalTokens, prunedCount);
        }

        // Irreducible — cannot reach budget
        return this.buildResult(remaining, totalTokens, prunedCount, true, 'irreducible');
    }

    private buildResult(
        entries: PrunableEntry[],
        totalTokens: number,
        prunedCount: number,
        overBudget = false,
        reason?: string,
    ): PruneResult {
        const result: PruneResult = {
            withinBudget: totalTokens <= this.tokenLimit,
            entries,
            totalTokens,
            limit: this.tokenLimit,
            breakdown: entries.map(e => ({ path: e.path, tokens: e.tokenCount })),
            prunedCount,
            overBudget,
            ...(reason !== undefined ? { reason } : {}),
        };
        return result;
    }
}
