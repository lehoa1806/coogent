// ─────────────────────────────────────────────────────────────────────────────
// src/context/ContextScoper.ts — File reading, tokenization, and payload assembly
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ContextResult, Phase, FileResolver } from '../types/index.js';
import { ASTFileResolver, ExplicitFileResolver } from './FileResolver.js';
import { TokenPruner, type PrunableEntry } from './TokenPruner.js';
import { TiktokenEncoder } from './TiktokenEncoder.js';
import { SecretsGuard } from './SecretsGuard.js';
import { generateRepoMap } from './RepoMap.js';
import log from '../logger/log.js';

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
    private tokenLimit: number;
    private readonly resolver: FileResolver;

    constructor(options?: { encoder?: TokenEncoder; tokenLimit?: number; resolver?: FileResolver }) {
        this.encoder = options?.encoder ?? ContextScoper.createDefaultEncoder();
        this.tokenLimit = options?.tokenLimit ?? 100_000;
        this.resolver = options?.resolver ?? new ASTFileResolver({ maxDepth: 2 });
    }

    /**
     * Create the default token encoder.
     * Tries TiktokenEncoder first; falls back to CharRatioEncoder if it
     * fails to load (e.g. js-tiktoken not installed or WASM error).
     */
    private static createDefaultEncoder(): TokenEncoder {
        try {
            return new TiktokenEncoder();
        } catch {
            log.warn('[ContextScoper] TiktokenEncoder unavailable, falling back to CharRatioEncoder');
            return new CharRatioEncoder();
        }
    }

    /** Return the underlying token encoder for shared use by ContextPackBuilder. */
    getEncoder(): TokenEncoder {
        return this.encoder;
    }

    /**
     * Update the token limit at runtime (called when VS Code settings change).
     * Takes effect on the next `assemble()` call.
     */
    setTokenLimit(limit: number): void {
        this.tokenLimit = limit;
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

        const realWorkspaceRoot = await fs.realpath(workspaceRoot).catch(() => workspaceRoot);

        for (const relativePath of resolvedFiles) {
            // Use realWorkspaceRoot as base to avoid symlink mismatches (e.g. /var → /private/var on macOS)
            const absPath = path.resolve(realWorkspaceRoot, relativePath);

            // Path traversal and symlink boundary guard
            let realPath: string;
            try {
                realPath = await fs.realpath(absPath);
            } catch {
                realPath = absPath; // fallback for missing files, handled by fileExists
            }

            if (!realPath.startsWith(realWorkspaceRoot)) {
                log.warn(
                    `[ContextScoper] Skipping file outside workspace boundary: ${relativePath} ` +
                    `(resolved: ${realPath}, workspace: ${realWorkspaceRoot})`
                );
                continue;
            }

            // #41: Skip files > 10 MB to prevent memory issues
            const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
            try {
                const stat = await fs.stat(realPath);
                if (stat.size > MAX_FILE_SIZE) {
                    log.warn(`[ContextScoper] Skipping file > 10 MB: ${relativePath} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
                    continue;
                }
            } catch {
                // stat failure handled by fileExists below
            }

            // Guard: file exists
            const exists = await fileExists(realPath);
            if (!exists) {
                throw new ContextError(
                    `File not found: ${relativePath}`,
                    'FILE_NOT_FOUND',
                    relativePath
                );
            }

            // Guard: not binary
            if (await isBinary(realPath)) {
                throw new ContextError(
                    `Binary file rejected: ${relativePath}`,
                    'BINARY_FILE',
                    relativePath
                );
            }

            const content = await fs.readFile(realPath, 'utf-8');

            // S1-3 (SEC-1): Check blocking mode setting
            const blockOnSecrets = vscode.workspace
                .getConfiguration('coogent')
                .get<boolean>('blockOnSecretsDetection', false);

            // Guard: secrets detection — optionally blocking
            const scanResult = SecretsGuard.scanWithBlocking(
                content, relativePath, blockOnSecrets,
            );
            if (!scanResult.safe) {
                for (const finding of scanResult.findings) {
                    log.warn(`[ContextScoper] ⚠ ${finding}`);
                }
            }

            const wrapperTokens = this.encoder.countTokens(`<<<FILE: ${relativePath}>>>\n\n<<<END FILE>>>`);
            const tokenCount = this.encoder.countTokens(content) + wrapperTokens;

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

        // Guard: token budget — over-budget fallback strategy
        if (!pruneResult.withinBudget) {
            // If we were using ASTFileResolver (expanded deps), retry with only
            // the user's explicit context_files via ExplicitFileResolver.
            if (this.resolver instanceof ASTFileResolver) {
                log.warn(
                    `[ContextScoper] AST-expanded context (${pruneResult.totalTokens} tokens) exceeds budget ` +
                    `(${pruneResult.limit}). Retrying with explicit files only.`
                );
                const fallbackScoper = new ContextScoper({
                    encoder: this.encoder,
                    tokenLimit: this.tokenLimit,
                    resolver: new ExplicitFileResolver(),
                });
                return fallbackScoper.assemble(phase, workspaceRoot);
            }

            // ExplicitFileResolver was already used — nothing left to fall back to.
            return {
                ok: false,
                totalTokens: pruneResult.totalTokens,
                limit: pruneResult.limit,
                breakdown: pruneResult.breakdown,
            };
        }

        // Assemble delimited payload
        const filePayload = pruneResult.entries
            .map(e => `<<<FILE: ${e.path}>>>\n${e.content}\n<<<END FILE>>>`)
            .join('\n\n');

        // Prepend repo-map for structural awareness (token cost deducted below)
        let repoMap = '';
        try {
            repoMap = await generateRepoMap(workspaceRoot);
        } catch {
            log.warn('[ContextScoper] RepoMap generation failed — skipping.');
        }

        const repoMapTokens = repoMap ? this.encoder.countTokens(repoMap) : 0;
        const totalWithMap = pruneResult.totalTokens + repoMapTokens;
        const payload = repoMap
            ? `${repoMap}\n\n${filePayload}`
            : filePayload;

        return {
            ok: true,
            payload,
            totalTokens: totalWithMap,
            limit: pruneResult.limit,
            breakdown: [
                ...(repoMap ? [{ path: '<repo-map>', tokens: repoMapTokens }] : []),
                ...pruneResult.breakdown,
            ],
        };
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Context Error
// ═══════════════════════════════════════════════════════════════════════════════

export type ContextErrorCode = 'FILE_NOT_FOUND' | 'BINARY_FILE' | 'PATH_TRAVERSAL';

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
