// ─────────────────────────────────────────────────────────────────────────────
// src/prompt-compiler/RepoFingerprinter.ts — Builds a compact RepoFingerprint
//   from the workspace for planning-oriented prompt compilation.
// ─────────────────────────────────────────────────────────────────────────────

import * as vscode from 'vscode';
import type { RepoFingerprint, SubprojectProfile } from './types.js';
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
/**
 * Manifest filenames that indicate a project root.
 * Used to detect whether the workspace root *is* a project root,
 * or whether the real project lives in a subdirectory.
 */
const PROJECT_MANIFEST_FILES: readonly string[] = [
    'package.json',
    'Cargo.toml',
    'go.mod',
    'pyproject.toml',
    'requirements.txt',
];

export class RepoFingerprinter {
    private readonly rootUri: vscode.Uri;
    private templateManager: PromptTemplateManager;

    /** Lazily resolved effective project root (may differ from rootUri). */
    private effectiveRoot: vscode.Uri | null = null;
    /** Relative subdirectory name if the project was found in a child dir. */
    private detectedSubdirectory: string | undefined;
    /** All child directories that contain a project manifest (multi-repo). */
    private discoveredSubprojects: Array<{ uri: vscode.Uri; name: string }> = [];

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
            // Resolve the effective project root (may be a subdirectory).
            await this.resolveEffectiveRoot();

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

            // ── Multi-repo: profile each discovered subproject ───────────
            if (this.discoveredSubprojects.length > 1) {
                const subprojects = await this.profileAllSubprojects();

                // Union top-level arrays across all subprojects for
                // backward-compatible policy evaluation.
                const unionLanguages = this.unionStrings(
                    subprojects.map(s => [...s.primaryLanguages]),
                );
                const unionFrameworks = this.unionStrings(
                    subprojects.map(s => [...s.keyFrameworks]),
                );
                const unionTestStack = this.unionStrings(
                    subprojects.map(s => [...s.testStack]),
                );
                const unionLintStack = this.unionStrings(
                    subprojects.map(s => [...s.lintStack]),
                );
                const unionTypecheckStack = this.unionStrings(
                    subprojects.map(s => [...s.typecheckStack]),
                );
                const unionBuildStack = this.unionStrings(
                    subprojects.map(s => [...s.buildStack]),
                );

                return {
                    workspaceType: 'multi-repo',
                    workspaceFolders: subprojects.map(s => s.name),
                    primaryLanguages: unionLanguages,
                    keyFrameworks: unionFrameworks,
                    packageManager: 'mixed',
                    testStack: unionTestStack,
                    lintStack: unionLintStack,
                    typecheckStack: unionTypecheckStack,
                    buildStack: unionBuildStack,
                    architectureHints,
                    highRiskSurfaces,
                    subprojects,
                };
            }

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
                ...(this.detectedSubdirectory
                    ? { detectedSubdirectory: this.detectedSubdirectory }
                    : {}),
            };
        } catch {
            // Absolute fallback — should never reach here, but guarantees no throws.
            return this.emptyFingerprint();
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Effective Root Resolution
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * Determine the effective project root.
     *
     * If no manifest file is found at the workspace root, scan immediate
     * child directories for a project manifest. If exactly one (or the first)
     * child directory contains a manifest, treat it as the real project root.
     *
     * This handles the common case where a wrapper directory (e.g., `anti-ex/`)
     * contains the actual project in a subdirectory (e.g., `coogent/`).
     */
    private async resolveEffectiveRoot(): Promise<void> {
        if (this.effectiveRoot) return;

        // Check if the workspace root already has a manifest.
        for (const manifest of PROJECT_MANIFEST_FILES) {
            if (await this.rootHasFile(manifest)) {
                this.effectiveRoot = this.rootUri;
                return;
            }
        }

        // No manifest at root — scan ALL immediate child directories for manifests.
        const candidates: Array<{ uri: vscode.Uri; name: string }> = [];
        try {
            const entries = await vscode.workspace.fs.readDirectory(this.rootUri);
            const subdirs = entries.filter(
                ([, type]) => type === vscode.FileType.Directory,
            );

            for (const [name] of subdirs) {
                // Skip hidden directories and common non-project dirs.
                if (name.startsWith('.') || name === 'node_modules') continue;

                const childUri = vscode.Uri.joinPath(this.rootUri, name);
                for (const manifest of PROJECT_MANIFEST_FILES) {
                    try {
                        await vscode.workspace.fs.stat(
                            vscode.Uri.joinPath(childUri, manifest),
                        );
                        candidates.push({ uri: childUri, name });
                        break; // Found a manifest — no need to check others.
                    } catch {
                        // Manifest not found in this subdir — continue.
                    }
                }
            }
        } catch {
            // readDirectory failed — fall through to default.
        }

        if (candidates.length === 1) {
            // Single subproject — use existing single-project behavior.
            this.effectiveRoot = candidates[0].uri;
            this.detectedSubdirectory = candidates[0].name;
            this.templateManager = new PromptTemplateManager(
                candidates[0].uri.fsPath,
            );
        } else if (candidates.length > 1) {
            // Multiple subprojects — store them all.
            // Use the first as the effective root for base detection,
            // but subprojects will each be profiled independently.
            this.effectiveRoot = candidates[0].uri;
            this.discoveredSubprojects = candidates;
            this.templateManager = new PromptTemplateManager(
                candidates[0].uri.fsPath,
            );
        } else {
            // Fallback: use the workspace root as-is.
            this.effectiveRoot = this.rootUri;
        }
    }

    /**
     * Check if a file exists directly under the *original* workspace root
     * (before effective root resolution). Used only during resolution itself.
     */
    private async rootHasFile(relativePath: string): Promise<boolean> {
        try {
            await vscode.workspace.fs.stat(
                vscode.Uri.joinPath(this.rootUri, relativePath),
            );
            return true;
        } catch {
            return false;
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Multi-Repo Profiling
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * Profile every discovered subproject independently.
     * Each subproject gets its own `PromptTemplateManager` scoped to its directory.
     */
    private async profileAllSubprojects(): Promise<SubprojectProfile[]> {
        const profiles: SubprojectProfile[] = [];

        for (const { uri, name } of this.discoveredSubprojects) {
            try {
                profiles.push(await this.profileSubproject(uri, name));
            } catch {
                // Skip subprojects that fail to profile — never throw.
                profiles.push({
                    name,
                    primaryLanguages: [],
                    keyFrameworks: [],
                    packageManager: 'unknown',
                    testStack: [],
                    lintStack: [],
                    typecheckStack: [],
                    buildStack: [],
                });
            }
        }

        return profiles;
    }

    /**
     * Profile a single subproject at the given URI.
     */
    private async profileSubproject(
        childUri: vscode.Uri,
        name: string,
    ): Promise<SubprojectProfile> {
        const mgr = new PromptTemplateManager(childUri.fsPath);
        const techStack = await mgr.discoverTechStack();

        // Temporarily point the effective root at this subproject for toolchain detection.
        const prevRoot = this.effectiveRoot;
        this.effectiveRoot = childUri;

        const primaryLanguages = this.derivePrimaryLanguages(techStack);
        const keyFrameworks = [...techStack.frameworks];
        const packageManager = techStack.packageManager;

        const [testStack, lintStack, typecheckStack, buildStack] =
            await this.detectToolchains(techStack);

        // Restore the effective root.
        this.effectiveRoot = prevRoot;

        return {
            name,
            primaryLanguages,
            keyFrameworks,
            packageManager,
            testStack,
            lintStack,
            typecheckStack,
            buildStack,
        };
    }

    /**
     * Merge multiple string arrays into a deduplicated union list.
     */
    private unionStrings(arrays: string[][]): string[] {
        const set = new Set<string>();
        for (const arr of arrays) {
            for (const s of arr) set.add(s);
        }
        return [...set];
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
            const root = this.effectiveRoot ?? this.rootUri;
            const uri = vscode.Uri.joinPath(root, relativePath);
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
            const root = this.effectiveRoot ?? this.rootUri;
            const uri = vscode.Uri.joinPath(root, relativePath);
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
            const root = this.effectiveRoot ?? this.rootUri;
            const entries = await vscode.workspace.fs.readDirectory(root);
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
