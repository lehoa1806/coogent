// ─────────────────────────────────────────────────────────────────────────────
// src/context/FileResolver.ts — Pluggable file resolution strategies
// ─────────────────────────────────────────────────────────────────────────────

import type { Phase, FileResolver } from '../types/index.js';
import { resolve as pathResolve, dirname, relative, extname, join } from 'node:path';
import { access, readFile } from 'node:fs/promises';
import * as ts from 'typescript';

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

/** Cached tsconfig path aliases: mapping from alias pattern to resolved base paths. */
interface PathAliases {
    /** e.g. { "@/*": ["/abs/path/src/*"] } */
    patterns: Map<string, string[]>;
}

/**
 * Resolves files by walking the TypeScript AST of the explicit entrypoint files,
 * discovering `import`, `export ... from`, `require()`, and dynamic `import()`
 * references recursively.
 *
 * Uses the TypeScript Compiler API (`ts.createSourceFile`) for syntax-only AST
 * parsing — no type checking program is created, keeping it fast.
 *
 * Resolution strategy:
 * 1. Start with the explicit `context_files`.
 * 2. For each file, parse the AST to extract module specifiers.
 * 3. Resolve discovered paths relative to the file's directory (with tsconfig
 *    path alias support).
 * 4. Recurse into discovered files (with cycle detection).
 * 5. Return the deduplicated union of explicit + discovered files.
 */
export class ASTFileResolver implements FileResolver {
    /** Maximum depth to crawl to prevent runaway resolution. */
    private readonly maxDepth: number;

    /** Cached path aliases — loaded once per resolve() call. */
    private pathAliases: PathAliases | null = null;

    constructor(options?: { maxDepth?: number }) {
        this.maxDepth = options?.maxDepth ?? 5;
    }

    async resolve(phase: Phase, workspaceRoot: string): Promise<string[]> {
        const visited = new Set<string>();
        const result: string[] = [];

        // Load tsconfig path aliases once per resolve() call
        this.pathAliases = await this.loadPathAliases(workspaceRoot);

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

        // Clear cached aliases after resolve() completes
        this.pathAliases = null;

        return result;
    }

    // ───────────────────────────────────────────────────────────────────────────
    //  AST-Based Import Extraction
    // ───────────────────────────────────────────────────────────────────────────

    /**
     * Detect the TypeScript ScriptKind from file extension.
     */
    private getScriptKind(ext: string): ts.ScriptKind {
        switch (ext) {
            case '.tsx': return ts.ScriptKind.TSX;
            case '.jsx': return ts.ScriptKind.JSX;
            case '.js':
            case '.mjs':
            case '.cjs': return ts.ScriptKind.JS;
            default: return ts.ScriptKind.TS;
        }
    }

    /**
     * Extract import/require paths from source code using the TypeScript Compiler API.
     *
     * For JS/TS files: parses the AST with `ts.createSourceFile()` (syntax-only,
     * no type checker) and walks it to find:
     * - `import ... from '...'` declarations
     * - `export ... from '...'` declarations
     * - `require('...')` calls
     * - Dynamic `import('...')` calls
     *
     * For C/C++ and Python files: falls back to regex (TS parser can't handle them).
     */
    private extractImports(content: string, ext: string): string[] {
        const imports: string[] = [];

        if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
            // Parse with TypeScript Compiler API (syntax-only — fast)
            const sourceFile = ts.createSourceFile(
                'file' + ext,
                content,
                ts.ScriptTarget.Latest,
                /* setParentNodes */ true,
                this.getScriptKind(ext),
            );

            const walk = (node: ts.Node): void => {
                // import ... from 'module'
                if (ts.isImportDeclaration(node) && node.moduleSpecifier) {
                    if (ts.isStringLiteral(node.moduleSpecifier)) {
                        imports.push(node.moduleSpecifier.text);
                    }
                }

                // export ... from 'module'
                if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
                    if (ts.isStringLiteral(node.moduleSpecifier)) {
                        imports.push(node.moduleSpecifier.text);
                    }
                }

                // require('module') and dynamic import('module')
                if (ts.isCallExpression(node)) {
                    const expr = node.expression;

                    // require('...')
                    if (ts.isIdentifier(expr) && expr.text === 'require') {
                        if (node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
                            imports.push(node.arguments[0].text);
                        }
                    }

                    // import('...')
                    if (expr.kind === ts.SyntaxKind.ImportKeyword) {
                        if (node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
                            imports.push(node.arguments[0].text);
                        }
                    }
                }

                ts.forEachChild(node, walk);
            };

            walk(sourceFile);
        }

        if (['.c', '.cpp', '.cc', '.cxx', '.h', '.hpp'].includes(ext)) {
            // C/C++: #include "local.h" (skip <system> includes)
            const includeRe = /#include\s+"([^"]+)"/g;
            let m: RegExpExecArray | null;
            while ((m = includeRe.exec(content)) !== null) {
                imports.push(m[1]);
            }
        }

        if (ext === '.py') {
            // Python: from x.y import z → x/y.py
            const pyRe = /from\s+([\w.]+)\s+import/g;
            let pm: RegExpExecArray | null;
            while ((pm = pyRe.exec(content)) !== null) {
                imports.push(pm[1].replace(/\./g, '/') + '.py');
            }
        }

        // Swift: import ModuleName — framework-level, no local file discovery

        return imports;
    }

    // ───────────────────────────────────────────────────────────────────────────
    //  tsconfig Path Alias Resolution
    // ───────────────────────────────────────────────────────────────────────────

    /**
     * Load tsconfig.json path aliases from workspaceRoot.
     * Uses `ts.parseJsonConfigFileContent()` for correct parsing.
     * Returns null if tsconfig doesn't exist or has no paths.
     */
    private async loadPathAliases(workspaceRoot: string): Promise<PathAliases | null> {
        const tsconfigPath = join(workspaceRoot, 'tsconfig.json');

        let tsconfigText: string;
        try {
            tsconfigText = await readFile(tsconfigPath, 'utf-8');
        } catch {
            return null; // No tsconfig.json
        }

        try {
            const { config, error } = ts.readConfigFile(tsconfigPath, () => tsconfigText);
            if (error || !config) return null;

            const parsed = ts.parseJsonConfigFileContent(config, ts.sys, workspaceRoot);
            const paths = parsed.options.paths;
            if (!paths) return null;

            const baseUrl = parsed.options.baseUrl || workspaceRoot;
            const patterns = new Map<string, string[]>();

            for (const [alias, targets] of Object.entries(paths)) {
                const resolvedTargets = targets.map(t => join(baseUrl, t));
                patterns.set(alias, resolvedTargets);
            }

            return { patterns };
        } catch {
            return null; // Malformed tsconfig — ignore
        }
    }

    /**
     * Attempt to resolve an import path via tsconfig path aliases.
     * Returns the resolved absolute path, or null if no alias matched.
     */
    private async resolvePathAlias(
        importPath: string,
    ): Promise<string | null> {
        if (!this.pathAliases) return null;

        const entries = Array.from(this.pathAliases.patterns.entries());
        for (let i = 0; i < entries.length; i++) {
            const alias = entries[i][0];
            const targets = entries[i][1];
            // Match wildcard aliases: "@/*" matches "@/foo/bar"
            if (alias.endsWith('/*')) {
                const prefix = alias.slice(0, -2); // "@"
                if (importPath.startsWith(prefix + '/')) {
                    const rest = importPath.slice(prefix.length + 1);
                    for (let j = 0; j < targets.length; j++) {
                        const target = targets[j];
                        const targetBase = target.endsWith('/*')
                            ? target.slice(0, -2)
                            : target;
                        const candidate = join(targetBase, rest);
                        const resolved = await this.tryResolveFile(candidate);
                        if (resolved) return resolved;
                    }
                }
            }
            // Match exact aliases
            else if (importPath === alias) {
                for (let j = 0; j < targets.length; j++) {
                    const resolved = await this.tryResolveFile(targets[j]);
                    if (resolved) return resolved;
                }
            }
        }

        return null;
    }

    /**
     * Try to resolve a candidate path as a file, trying extensions and index files.
     */
    private async tryResolveFile(candidate: string): Promise<string | null> {
        const exists = async (p: string): Promise<boolean> => {
            try { await access(p); return true; } catch { return false; }
        };

        if (await exists(candidate)) return candidate;

        const extensions = ['.ts', '.tsx', '.js', '.jsx', '.py', '.swift', '.h', '.hpp', '.c', '.cpp'];
        for (const ext of extensions) {
            if (await exists(candidate + ext)) return candidate + ext;
        }
        for (const ext of extensions) {
            const indexFile = join(candidate, `index${ext}`);
            if (await exists(indexFile)) return indexFile;
        }

        return null;
    }

    // ───────────────────────────────────────────────────────────────────────────
    //  Import Path Resolution
    // ───────────────────────────────────────────────────────────────────────────

    /**
     * Resolve an import path to an absolute file path.
     * Handles:
     * - tsconfig path aliases (e.g. `@/foo` → `src/foo`)
     * - Relative paths (./ and ../)
     * - Extension probing (.ts, .tsx, .js, .jsx, etc.)
     * - Index file resolution (foo/ → foo/index.ts)
     *
     * See 02-review.md § R12 — fully async, no event loop blocking.
     */
    private async resolveImportPath(
        importPath: string,
        fileDir: string,
        _workspaceRoot: string,
        _ext: string
    ): Promise<string | null> {
        // 1. Try tsconfig path alias resolution first (uses cached this.pathAliases)
        const aliasResolved = await this.resolvePathAlias(importPath);
        if (aliasResolved) return aliasResolved;

        // 2. Only resolve relative imports for non-alias paths
        if (!importPath.startsWith('.') && !importPath.startsWith('/')) {
            return null; // Skip bare specifiers (npm packages, etc.)
        }

        const base = pathResolve(fileDir, importPath);
        return this.tryResolveFile(base);
    }
}

