// ─────────────────────────────────────────────────────────────────────────────
// src/context/FileResolver.ts — Pluggable file resolution strategies
// ─────────────────────────────────────────────────────────────────────────────

import type { Phase, FileResolver } from '../types/index.js';
import { resolve as pathResolve, dirname, relative, extname } from 'node:path';
import { access, readFile } from 'node:fs/promises';

// ═══════════════════════════════════════════════════════════════════════════════
//  Explicit File Resolver (V1 — default)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Returns the phase's `context_files` as-is — no discovery, no crawling.
 * This is the V1 default and always available as a fallback.
 */
export class ExplicitFileResolver implements FileResolver {
    async resolve(phase: Phase, _workspaceRoot: string): Promise<string[]> {
        return [...phase.context_files];
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  AST File Resolver (V2 — Pillar 2)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Resolves files by walking the AST of the explicit entrypoint files,
 * discovering `import`, `require()`, and `#include` references recursively.
 *
 * Uses simple regex-based parsing for V2 MVP. Can be upgraded to full
 * tree-sitter parsing when the dependency is approved.
 *
 * Resolution strategy:
 * 1. Start with the explicit `context_files`.
 * 2. For each file, parse import/require statements.
 * 3. Resolve discovered paths relative to the file's directory.
 * 4. Recurse into discovered files (with cycle detection).
 * 5. Return the deduplicated union of explicit + discovered files.
 */
export class ASTFileResolver implements FileResolver {
    /** Maximum depth to crawl to prevent runaway resolution. */
    private readonly maxDepth: number;

    constructor(options?: { maxDepth?: number }) {
        this.maxDepth = options?.maxDepth ?? 5;
    }

    async resolve(phase: Phase, workspaceRoot: string): Promise<string[]> {
        // Use top-level imports (node:path, node:fs/promises)

        const visited = new Set<string>();
        const result: string[] = [];

        const enqueue = async (relativePath: string, depth: number): Promise<void> => {
            if (depth > this.maxDepth) return;

            // Gitignore-aware filtering — skip common non-source directories (#15)
            const IGNORED_DIRS = new Set([
                'node_modules', '.git', 'dist', 'build', 'out', 'coverage',
                '.next', '__pycache__', '.coogent', '.cache', '.DS_Store',
            ]);
            const parts = relativePath.split(/[/\\]/);
            if (parts.some(p => IGNORED_DIRS.has(p))) {
                return;
            }

            // Normalize to prevent duplicates
            const absPath = pathResolve(workspaceRoot, relativePath);
            if (visited.has(absPath)) return;
            visited.add(absPath);

            // Verify file exists before adding
            try {
                await access(absPath);
            } catch {
                return; // Skip non-existent discovered files (best-effort)
            }

            result.push(relativePath);

            // Only parse text source files for imports
            const ext = extname(absPath).toLowerCase();
            const parsableExtensions = [
                '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
                '.swift', '.py',
                '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp',
            ];
            if (!parsableExtensions.includes(ext)) return;

            let content: string;
            try {
                content = await readFile(absPath, 'utf-8');
            } catch {
                return;
            }

            const imports = this.extractImports(content, ext);
            const fileDir = dirname(absPath);

            for (const imp of imports) {
                const resolved = await this.resolveImportPath(imp, fileDir, workspaceRoot, ext);
                if (resolved) {
                    const rel = relative(workspaceRoot, resolved);
                    await enqueue(rel, depth + 1);
                }
            }
        };

        // Crawl all explicit files
        for (const file of phase.context_files) {
            await enqueue(file, 0);
        }

        return result;
    }

    /**
     * Extract import/require paths from source code using regex heuristics.
     * Handles: ES6 imports, CommonJS require(), Python imports, C/C++ includes.
     */
    private extractImports(content: string, ext: string): string[] {
        const imports: string[] = [];

        if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
            // ES6: import ... from 'path'
            const esImports = content.matchAll(/import\s+.*?from\s+['"]([^'"]+)['"]/g);
            for (const m of esImports) imports.push(m[1]);

            // ES6: export ... from 'path'
            const esExports = content.matchAll(/export\s+.*?from\s+['"]([^'"]+)['"]/g);
            for (const m of esExports) imports.push(m[1]);

            // CommonJS: require('path')
            const cjsRequires = content.matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g);
            for (const m of cjsRequires) imports.push(m[1]);

            // Dynamic import: import('path')
            const dynImports = content.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g);
            for (const m of dynImports) imports.push(m[1]);
        }

        if (['.c', '.cpp', '.cc', '.cxx', '.h', '.hpp'].includes(ext)) {
            // C/C++: #include "local.h" (skip <system> includes)
            const includes = content.matchAll(/#include\s+"([^"]+)"/g);
            for (const m of includes) imports.push(m[1]);
        }

        if (ext === '.py') {
            // Python: from x.y import z → x/y.py
            const pyFromImports = content.matchAll(/from\s+([\w.]+)\s+import/g);
            for (const m of pyFromImports) {
                imports.push(m[1].replace(/\./g, '/') + '.py');
            }
        }

        if (ext === '.swift') {
            // Swift: import ModuleName (limited — mostly framework imports)
            // Skip framework imports; only local file imports matter
        }

        return imports;
    }

    /**
     * Resolve an import path to an absolute file path.
     * Handles relative paths (./ and ../) and tries common extensions.
     * See 02-review.md § R12 — fully async, no event loop blocking.
     */
    private async resolveImportPath(
        importPath: string,
        fileDir: string,
        _workspaceRoot: string,
        _ext: string
    ): Promise<string | null> {
        // Use top-level imports (node:path, node:fs/promises)

        // Only resolve relative imports
        if (!importPath.startsWith('.') && !importPath.startsWith('/')) {
            return null; // Skip bare specifiers (npm packages, etc.)
        }

        const base = pathResolve(fileDir, importPath);

        // Helper: check if a file exists without blocking the event loop
        const exists = async (p: string): Promise<boolean> => {
            try { await access(p); return true; } catch { return false; }
        };

        // Try exact path first
        if (await exists(base)) return base;

        // Try common extensions
        const extensions = ['.ts', '.tsx', '.js', '.jsx', '.py', '.swift', '.h', '.hpp', '.c', '.cpp'];
        for (const ext of extensions) {
            const withExt = base + ext;
            if (await exists(withExt)) return withExt;
        }

        // Try index files
        for (const ext of extensions) {
            const indexFile = pathResolve(base, `index${ext}`);
            if (await exists(indexFile)) return indexFile;
        }

        return null;
    }
}
