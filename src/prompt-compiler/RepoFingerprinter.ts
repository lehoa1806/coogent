// ─────────────────────────────────────────────────────────────────────────────
// src/prompt-compiler/RepoFingerprinter.ts — Builds a compact RepoFingerprint
//   from the workspace for planning-oriented prompt compilation.
// ─────────────────────────────────────────────────────────────────────────────

import * as vscode from 'vscode';
import type { RepoFingerprint } from './types.js';
import { PromptTemplateManager, type TechStackInfo } from '../context/PromptTemplateManager.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  RepoFingerprinter
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Builds a compact, planning-oriented {@link RepoFingerprint} from the workspace.
 *
 * Delegates base tech-stack discovery to {@link PromptTemplateManager} and
 * augments it with workspace layout, toolchain, architecture, and risk surface
 * detection.
 *
 * Design goals:
 *  - **Fast**: Only reads root-level config files — no deep directory walks.
 *  - **Graceful**: Missing files are silently skipped; never throws.
 *  - **Deterministic**: Given the same workspace, always produces the same fingerprint.
 *
 * @example
 * ```ts
 * const fp = new RepoFingerprinter('/path/to/workspace');
 * const fingerprint = await fp.fingerprint();
 * ```
 */
export class RepoFingerprinter {
    private readonly rootUri: vscode.Uri;
    private readonly templateManager: PromptTemplateManager;

    constructor(workspaceRoot: string) {
        this.rootUri = vscode.Uri.file(workspaceRoot);
        this.templateManager = new PromptTemplateManager(workspaceRoot);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Public API
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * Scan the workspace and produce a full {@link RepoFingerprint}.
     *
     * All detection is best-effort. Missing files result in empty arrays or
     * sensible defaults — this method never throws.
     */
    async fingerprint(): Promise<RepoFingerprint> {
        try {
            const techStack = await this.templateManager.discoverTechStack();

            const [
                workspaceType,
                workspaceFolders,
            ] = await this.detectWorkspaceLayout();

            const primaryLanguages = this.derivePrimaryLanguages(techStack);
            const keyFrameworks = [...techStack.frameworks];
            const packageManager = techStack.packageManager;

            const [
                testStack,
                lintStack,
                typecheckStack,
                buildStack,
            ] = await this.detectToolchains(techStack);

            const architectureHints = await this.detectArchitectureHints();
            const highRiskSurfaces = await this.detectHighRiskSurfaces();

            return {
                workspaceType,
                workspaceFolders,
                primaryLanguages,
                keyFrameworks,
                packageManager,
                testStack,
                lintStack,
                typecheckStack,
                buildStack,
                architectureHints,
                highRiskSurfaces,
            };
        } catch {
            // Absolute fallback — should never reach here, but guarantees no throws.
            return this.emptyFingerprint();
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Workspace Layout Detection
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * Detect the workspace type and folder list.
     *
     * - `.code-workspace` file → `'multi-root'`
     * - `lerna.json` / `pnpm-workspace.yaml` / `turbo.json` / `nx.json` → `'monorepo'`
     * - otherwise → `'single'`
     */
    private async detectWorkspaceLayout(): Promise<[RepoFingerprint['workspaceType'], string[]]> {
        // Multi-root check
        if (await this.hasFileMatching('*.code-workspace')) {
            const folders = await this.extractMultiRootFolders();
            return ['multi-root', folders.length > 0 ? folders : ['.']];
        }

        // Monorepo check
        const monorepoMarkers: readonly string[] = [
            'lerna.json',
            'pnpm-workspace.yaml',
            'turbo.json',
            'nx.json',
        ];

        for (const marker of monorepoMarkers) {
            if (await this.fileExists(marker)) {
                const folders = await this.extractMonorepoFolders(marker);
                return ['monorepo', folders.length > 0 ? folders : ['.']];
            }
        }

        return ['single', ['.']];
    }

    /**
     * Attempt to read `.code-workspace` file and extract folder paths.
     */
    private async extractMultiRootFolders(): Promise<string[]> {
        // Try to find the .code-workspace file
        const content = await this.readFileQuietly('*.code-workspace');
        if (!content) return [];

        try {
            const ws = JSON.parse(content) as { folders?: Array<{ path?: string }> };
            if (Array.isArray(ws.folders)) {
                return ws.folders
                    .map(f => f.path)
                    .filter((p): p is string => typeof p === 'string');
            }
        } catch {
            // Malformed JSON — ignore
        }
        return [];
    }

    /**
     * Attempt to extract workspace folder names from a monorepo config file.
     */
    private async extractMonorepoFolders(marker: string): Promise<string[]> {
        if (marker === 'pnpm-workspace.yaml') {
            const content = await this.readFileQuietly('pnpm-workspace.yaml');
            if (content) {
                // Simple YAML parsing for packages array
                const matches = content.matchAll(/- ['"]?([^'"}\n]+)['"]?/g);
                const folders: string[] = [];
                for (const m of matches) {
                    folders.push(m[1].trim());
                }
                return folders;
            }
        }

        if (marker === 'lerna.json') {
            const content = await this.readFileQuietly('lerna.json');
            if (content) {
                try {
                    const lerna = JSON.parse(content) as { packages?: string[] };
                    return lerna.packages ?? [];
                } catch { /* ignore */ }
            }
        }

        if (marker === 'nx.json') {
            // Nx workspaces typically use package.json workspaces
            const content = await this.readFileQuietly('package.json');
            if (content) {
                try {
                    const pkg = JSON.parse(content) as { workspaces?: string[] | { packages?: string[] } };
                    if (Array.isArray(pkg.workspaces)) return pkg.workspaces;
                    if (pkg.workspaces && Array.isArray(pkg.workspaces.packages)) return pkg.workspaces.packages;
                } catch { /* ignore */ }
            }
        }

        if (marker === 'turbo.json') {
            // Turbo repos use package.json workspaces
            const content = await this.readFileQuietly('package.json');
            if (content) {
                try {
                    const pkg = JSON.parse(content) as { workspaces?: string[] | { packages?: string[] } };
                    if (Array.isArray(pkg.workspaces)) return pkg.workspaces;
                    if (pkg.workspaces && Array.isArray(pkg.workspaces.packages)) return pkg.workspaces.packages;
                } catch { /* ignore */ }
            }
        }

        return [];
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Language Derivation
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * Map the detected runtime to primary language list.
     */
    private derivePrimaryLanguages(techStack: TechStackInfo): string[] {
        switch (techStack.runtime) {
            case 'node': return ['typescript', 'javascript'];
            case 'python': return ['python'];
            case 'go': return ['go'];
            case 'rust': return ['rust'];
            default: return [];
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Toolchain Detection
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * Detect test, lint, typecheck, and build stacks from package manifests.
     * Returns `[testStack, lintStack, typecheckStack, buildStack]`.
     */
    private async detectToolchains(
        techStack: TechStackInfo,
    ): Promise<[string[], string[], string[], string[]]> {
        // Collect all dependency names from package.json (includes devDeps)
        const nodeDeps = await this.getNodeDependencyNames();

        // Also gather Python deps if applicable
        const pythonDeps = techStack.runtime === 'python'
            ? await this.getPythonDependencyNames()
            : new Set<string>();

        const testStack = this.detectTestStack(nodeDeps, pythonDeps);
        const lintStack = this.detectLintStack(nodeDeps, pythonDeps);
        const typecheckStack = await this.detectTypecheckStack(nodeDeps, pythonDeps);
        const buildStack = this.detectBuildStack(nodeDeps, techStack);

        return [testStack, lintStack, typecheckStack, buildStack];
    }

    /**
     * Read package.json and return a Set of all dependency names
     * (both `dependencies` and `devDependencies`).
     */
    private async getNodeDependencyNames(): Promise<Set<string>> {
        const content = await this.readFileQuietly('package.json');
        if (!content) return new Set();

        try {
            const pkg = JSON.parse(content) as Record<string, unknown>;
            const deps = new Set<string>();

            for (const section of ['dependencies', 'devDependencies']) {
                const block = pkg[section];
                if (typeof block === 'object' && block !== null) {
                    for (const name of Object.keys(block as Record<string, unknown>)) {
                        deps.add(name);
                    }
                }
            }
            return deps;
        } catch {
            return new Set();
        }
    }

    /**
     * Read requirements.txt / pyproject.toml and return a Set of Python package names.
     */
    private async getPythonDependencyNames(): Promise<Set<string>> {
        const deps = new Set<string>();

        const reqTxt = await this.readFileQuietly('requirements.txt');
        if (reqTxt) {
            for (const line of reqTxt.split('\n')) {
                const match = line.trim().match(/^([a-zA-Z0-9_-]+)/);
                if (match && !line.startsWith('#') && !line.startsWith('-')) {
                    deps.add(match[1].toLowerCase());
                }
            }
        }

        const pyproject = await this.readFileQuietly('pyproject.toml');
        if (pyproject) {
            const depMatches = pyproject.matchAll(/["']([a-zA-Z0-9_-]+)/g);
            for (const m of depMatches) {
                deps.add(m[1].toLowerCase());
            }
        }

        return deps;
    }

    /** Detect test frameworks. */
    private detectTestStack(nodeDeps: Set<string>, pythonDeps: Set<string>): string[] {
        const stack: string[] = [];
        const nodeTests: ReadonlyArray<[string, string]> = [
            ['jest', 'jest'],
            ['vitest', 'vitest'],
            ['mocha', 'mocha'],
            ['cypress', 'cypress'],
            ['playwright', 'playwright'],
            ['@playwright/test', 'playwright'],
        ];
        for (const [dep, label] of nodeTests) {
            if (nodeDeps.has(dep) && !stack.includes(label)) stack.push(label);
        }

        const pyTests: ReadonlyArray<[string, string]> = [
            ['pytest', 'pytest'],
            ['unittest', 'unittest'],
        ];
        for (const [dep, label] of pyTests) {
            if (pythonDeps.has(dep) && !stack.includes(label)) stack.push(label);
        }

        return stack;
    }

    /** Detect lint tools. */
    private detectLintStack(nodeDeps: Set<string>, pythonDeps: Set<string>): string[] {
        const stack: string[] = [];
        const nodeLint: ReadonlyArray<[string, string]> = [
            ['eslint', 'eslint'],
            ['prettier', 'prettier'],
        ];
        for (const [dep, label] of nodeLint) {
            if (nodeDeps.has(dep) && !stack.includes(label)) stack.push(label);
        }

        const pyLint: ReadonlyArray<[string, string]> = [
            ['ruff', 'ruff'],
            ['flake8', 'flake8'],
            ['pylint', 'pylint'],
        ];
        for (const [dep, label] of pyLint) {
            if (pythonDeps.has(dep) && !stack.includes(label)) stack.push(label);
        }

        return stack;
    }

    /** Detect type-checking tools. */
    private async detectTypecheckStack(nodeDeps: Set<string>, pythonDeps: Set<string>): Promise<string[]> {
        const stack: string[] = [];

        // TypeScript: check for tsconfig.json OR typescript in deps
        if (nodeDeps.has('typescript') || await this.fileExists('tsconfig.json')) {
            stack.push('tsc');
        }

        if (pythonDeps.has('mypy')) stack.push('mypy');
        if (pythonDeps.has('pyright')) stack.push('pyright');

        return stack;
    }

    /** Detect build tools. */
    private detectBuildStack(nodeDeps: Set<string>, techStack: TechStackInfo): string[] {
        const stack: string[] = [];
        const nodeBuild: ReadonlyArray<[string, string]> = [
            ['esbuild', 'esbuild'],
            ['webpack', 'webpack'],
            ['vite', 'vite'],
            ['rollup', 'rollup'],
            ['typescript', 'tsc'],
        ];
        for (const [dep, label] of nodeBuild) {
            if (nodeDeps.has(dep) && !stack.includes(label)) stack.push(label);
        }

        if (techStack.runtime === 'go') stack.push('go build');

        return stack;
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Architecture Hints
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * Detect high-level architectural patterns from directory and file presence.
     */
    private async detectArchitectureHints(): Promise<string[]> {
        const hints: string[] = [];

        const checks: ReadonlyArray<[string, string]> = [
            ['src/engine', 'orchestration engine'],
            ['src/api', 'api server'],
            ['docker-compose.yml', 'containerized'],
            ['docker-compose.yaml', 'containerized'],
            ['Dockerfile', 'containerized'],
            ['k8s', 'kubernetes'],
            ['helm', 'kubernetes'],
        ];

        for (const [path, hint] of checks) {
            if (await this.fileExists(path)) {
                if (!hints.includes(hint)) hints.push(hint);
            }
        }

        return hints;
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  High-Risk Surfaces
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * Detect high-risk surfaces that require extra caution during planning.
     */
    private async detectHighRiskSurfaces(): Promise<string[]> {
        const surfaces: string[] = [];

        const checks: ReadonlyArray<[string, string]> = [
            ['migrations', 'database migrations'],
            ['db/migrations', 'database migrations'],
            ['src/migrations', 'database migrations'],
            ['src/api', 'public API routes'],
            ['src/routes', 'public API routes'],
            ['prisma/schema.prisma', 'database schema'],
            ['schema.graphql', 'API schema'],
            ['schema.prisma', 'database schema'],
            ['drizzle', 'database schema'],
            ['src/security', 'security'],
            ['src/auth', 'authentication'],
        ];

        for (const [path, surface] of checks) {
            if (await this.fileExists(path)) {
                if (!surfaces.includes(surface)) surfaces.push(surface);
            }
        }

        return surfaces;
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  File I/O Helpers (graceful — no throws on missing files)
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * Read a file at the workspace root.
     * Returns `null` if the file doesn't exist or cannot be read (no error thrown).
     */
    private async readFileQuietly(relativePath: string): Promise<string | null> {
        try {
            const uri = vscode.Uri.joinPath(this.rootUri, relativePath);
            const data = await vscode.workspace.fs.readFile(uri);
            return Buffer.from(data).toString('utf-8');
        } catch {
            return null;
        }
    }

    /**
     * Check if a file or directory exists at the workspace root.
     */
    private async fileExists(relativePath: string): Promise<boolean> {
        try {
            const uri = vscode.Uri.joinPath(this.rootUri, relativePath);
            await vscode.workspace.fs.stat(uri);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Check if any file matching a glob pattern exists at the workspace root.
     * Uses a simple suffix check — not a full glob engine.
     */
    private async hasFileMatching(pattern: string): Promise<boolean> {
        if (!pattern.startsWith('*')) {
            return this.fileExists(pattern);
        }

        // For *.ext patterns, list root directory entries and check extension
        const ext = pattern.slice(1); // e.g., '.code-workspace'
        try {
            const entries = await vscode.workspace.fs.readDirectory(this.rootUri);
            return entries.some(([name]) => name.endsWith(ext));
        } catch {
            return false;
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Fallback
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * Return an empty fingerprint with safe defaults.
     */
    private emptyFingerprint(): RepoFingerprint {
        return {
            workspaceType: 'single',
            workspaceFolders: ['.'],
            primaryLanguages: [],
            keyFrameworks: [],
            packageManager: 'unknown',
            testStack: [],
            lintStack: [],
            typecheckStack: [],
            buildStack: [],
            architectureHints: [],
            highRiskSurfaces: [],
        };
    }
}
