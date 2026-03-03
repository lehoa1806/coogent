// ─────────────────────────────────────────────────────────────────────────────
// src/context/ContextScoper.ts — File reading, tokenization, and payload assembly
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ContextResult, FileTokenEntry, Phase } from '../types/index.js';
import { ExplicitFileResolver } from './FileResolver.js';
import type { FileResolver } from '../types/index.js';
import { TokenPruner, type PrunableEntry } from './TokenPruner.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Token Encoder Interface (pluggable — V2: swap in tiktoken WASM)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Interface for token counting implementations.
 * V1 ships with CharRatioEncoder (~4 chars per token).
 * V2 can swap in TiktokenEncoder for model-accurate counts.
 */
export interface TokenEncoder {
    /** Count the number of tokens in a string. */
    countTokens(text: string): number;
}

/**
 * Fast, dependency-free token estimator.
 * Assumes ~4 characters per token (reasonable for English code).
 * Error margin: ±10-15% vs. tiktoken.
 */
export class CharRatioEncoder implements TokenEncoder {
    constructor(private readonly charsPerToken = 4) { }

    countTokens(text: string): number {
        return Math.ceil(text.length / this.charsPerToken);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Context Scoper
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Assembles file context payloads for worker agent injection.
 *
 * Pipeline: resolve paths → validate existence → reject binaries →
 *           read contents → count tokens → check budget → assemble payload.
 *
 * See TDD §4.2 for the full specification.
 */
export class ContextScoper {
    private readonly encoder: TokenEncoder;
    private readonly tokenLimit: number;
    private readonly resolver: FileResolver;

    constructor(options?: { encoder?: TokenEncoder; tokenLimit?: number; resolver?: FileResolver }) {
        this.encoder = options?.encoder ?? new CharRatioEncoder();
        this.tokenLimit = options?.tokenLimit ?? 100_000;
        this.resolver = options?.resolver ?? new ExplicitFileResolver();
    }

    /**
     * Assemble the injection payload from a phase's context files.
     *
     * @param phase - The phase containing context_files to resolve.
     * @param workspaceRoot - Absolute path to the workspace.
     * @returns ContextResult — discriminated union (ok | over-budget).
     * @throws {ContextError} If a file is missing or binary.
     */
    async assemble(phase: Phase, workspaceRoot: string): Promise<ContextResult> {
        const entries: PrunableEntry[] = [];
        const explicitFiles = new Set(phase.context_files);

        // Resolve files dynamically
        const resolvedFiles = await this.resolver.resolve(phase, workspaceRoot);

        for (const relativePath of resolvedFiles) {
            const absPath = path.resolve(workspaceRoot, relativePath);

            // Guard: file exists
            const exists = await fileExists(absPath);
            if (!exists) {
                throw new ContextError(
                    `File not found: ${relativePath}`,
                    'FILE_NOT_FOUND',
                    relativePath
                );
            }

            // Guard: not binary
            if (await isBinary(absPath)) {
                throw new ContextError(
                    `Binary file rejected: ${relativePath}`,
                    'BINARY_FILE',
                    relativePath
                );
            }

            const content = await fs.readFile(absPath, 'utf-8');
            const tokenCount = this.encoder.countTokens(content);

            entries.push({
                path: relativePath,
                content,
                tokenCount,
                isExplicit: explicitFiles.has(relativePath)
            });
        }

        // Prune if necessary
        const pruner = new TokenPruner(this.encoder, this.tokenLimit);
        const pruneResult = pruner.prune(entries);

        // Guard: token budget
        if (!pruneResult.withinBudget) {
            return {
                ok: false,
                totalTokens: pruneResult.totalTokens,
                limit: pruneResult.limit,
                breakdown: pruneResult.breakdown,
            };
        }

        // Assemble delimited payload
        const payload = pruneResult.entries
            .map(e => `<<<FILE: ${e.path}>>>\n${e.content}\n<<<END FILE>>>`)
            .join('\n\n');

        return {
            ok: true,
            payload,
            totalTokens: pruneResult.totalTokens,
            limit: pruneResult.limit,
            breakdown: pruneResult.breakdown,
        };
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Context Error
// ═══════════════════════════════════════════════════════════════════════════════

export type ContextErrorCode = 'FILE_NOT_FOUND' | 'BINARY_FILE';

export class ContextError extends Error {
    constructor(
        message: string,
        public readonly code: ContextErrorCode,
        public readonly filePath: string
    ) {
        super(message);
        this.name = 'ContextError';
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Utility Functions
// ═══════════════════════════════════════════════════════════════════════════════

async function fileExists(absPath: string): Promise<boolean> {
    try {
        await fs.access(absPath);
        return true;
    } catch {
        return false;
    }
}

/**
 * Heuristic binary detection: read the first 8KB and check for null bytes.
 * This catches most binary formats (images, compiled code, archives).
 */
async function isBinary(absPath: string): Promise<boolean> {
    const handle = await fs.open(absPath, 'r');
    try {
        const buf = Buffer.alloc(8192);
        const { bytesRead } = await handle.read(buf, 0, 8192, 0);
        for (let i = 0; i < bytesRead; i++) {
            if (buf[i] === 0) return true; // Null byte → likely binary
        }
        return false;
    } finally {
        await handle.close();
    }
}
