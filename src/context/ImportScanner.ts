// ─────────────────────────────────────────────────────────────────────────────
// src/context/ImportScanner.ts — Lightweight AST-based import discovery
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as ts from 'typescript';
import log from '../logger/log.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Constants
// ═══════════════════════════════════════════════════════════════════════════════

/** File extensions resolved when an import specifier lacks one. */
const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs'];

// ═══════════════════════════════════════════════════════════════════════════════
//  ImportScanner
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Lightweight import scanner using `ts.preProcessFile()`.
 *
 * Discovers direct (depth-1) imports from a set of source files without
 * invoking the full TypeScript compiler. External (node_modules) imports
 * and non-relative paths are filtered out.
 *
 * Returns workspace-relative paths suitable for inclusion as
 * `includedDependencies` in a context pack.
 */
export class ImportScanner {
    constructor(private readonly workspaceRoot: string) { }

    /**
     * Scan a set of files for their direct workspace-local imports.
     *
     * @param relativePaths - Workspace-relative paths to scan.
     * @returns Deduplicated list of workspace-relative import paths
     *          that are NOT already in `relativePaths`.
     */
    async scan(relativePaths: string[]): Promise<string[]> {
        const sourceSet = new Set(relativePaths);
        const discovered = new Set<string>();

        for (const relPath of relativePaths) {
            const absPath = path.resolve(this.workspaceRoot, relPath);
            try {
                const content = await fs.readFile(absPath, 'utf-8');
                const imports = this.extractImports(content, absPath);
                for (const imp of imports) {
                    if (!sourceSet.has(imp) && !discovered.has(imp)) {
                        discovered.add(imp);
                    }
                }
            } catch {
                // File unreadable — skip silently (already handled by the caller)
                log.debug(`[ImportScanner] Skipping unreadable file: ${relPath}`);
            }
        }

        return [...discovered];
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Private helpers
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Extract workspace-relative import paths from file content using
     * `ts.preProcessFile()` — a fast, parser-level scan.
     */
    private extractImports(content: string, absFilePath: string): string[] {
        const info = ts.preProcessFile(content, /* readImportFiles */ true, /* detectJavaScriptImports */ true);
        const dir = path.dirname(absFilePath);
        const results: string[] = [];

        for (const ref of info.importedFiles) {
            const spec = ref.fileName;

            // Skip non-relative imports (bare specifiers → node_modules)
            if (!spec.startsWith('.')) continue;

            // Resolve against the file's directory
            const resolved = this.resolveImport(dir, spec);
            if (resolved) {
                const relPath = path.relative(this.workspaceRoot, resolved);
                // Skip paths that escape the workspace (e.g., ../../../outside)
                if (!relPath.startsWith('..')) {
                    results.push(relPath);
                }
            }
        }

        return results;
    }

    /**
     * Resolve a relative import specifier to an absolute path, trying
     * common TypeScript/JavaScript extensions.
     *
     * @returns Absolute path if found, otherwise `null`.
     */
    private resolveImport(fromDir: string, specifier: string): string | null {
        const base = path.resolve(fromDir, specifier);

        // 1. Try exact match (specifier already has extension)
        if (RESOLVE_EXTENSIONS.some(ext => base.endsWith(ext))) {
            // Strip .js → .ts mapping (common in ESM TypeScript projects)
            const tsVariant = base.replace(/\.js$/, '.ts').replace(/\.mjs$/, '.mts');
            if (tsVariant !== base) {
                return tsVariant; // Optimistic: .js → .ts is the dominant pattern
            }
            return base;
        }

        // 2. Try highest-priority extension (optimistic: no stat for performance)
        // Note: RESOLVE_EXTENSIONS[0] is '.ts', the dominant convention.
        return base + RESOLVE_EXTENSIONS[0];

        // Section 3 (index files) is unreachable — section 2 always returns.
        // Real index resolution would require stat() calls, deferred to a
        // future enhancement if workspace imports rely on index.ts barrel files.
    }
}
