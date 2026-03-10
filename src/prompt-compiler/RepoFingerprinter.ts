// ─────────────────────────────────────────────────────────────────────────────
// src/prompt-compiler/RepoFingerprinter.ts — Builds a compact RepoFingerprint
//   from the workspace for planning-oriented prompt compilation.
// ─────────────────────────────────────────────────────────────────────────────

import * as vscode from 'vscode';
import type { RepoFingerprint, SubprojectProfile } from './types.js';
import { PromptTemplateManager } from '../context/PromptTemplateManager.js';
import { TechStackDetector, type FileReader } from './TechStackDetector.js';

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
    'README.md',
];

export class RepoFingerprinter implements FileReader {
    private readonly rootUri: vscode.Uri;
    private templateManager: PromptTemplateManager;
    private detector: TechStackDetector;

    /** Lazily resolved effective project root (may differ from rootUri). */
    private effectiveRoot: vscode.Uri | null = null;
    /** Relative subdirectory name if the project was found in a child dir. */
    private detectedSubdirectory: string | undefined;
    /** All child directories that contain a project manifest (multi-repo). */
    private discoveredSubprojects: Array<{ uri: vscode.Uri; name: string }> = [];

    constructor(workspaceRoot: string) {
        this.rootUri = vscode.Uri.file(workspaceRoot);
        this.templateManager = new PromptTemplateManager(workspaceRoot);
        this.detector = new TechStackDetector(this);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Public API
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * Return the resolved effective project root path.
     * Must be called after {@link fingerprint} has been invoked at least once.
     * Falls back to the raw workspace root if resolution has not yet run.
     */
    async getEffectiveRoot(): Promise<string> {
        await this.resolveEffectiveRoot();
        return (this.effectiveRoot ?? this.rootUri).fsPath;
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Fingerprint Generation
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

            const primaryLanguages = this.detector.derivePrimaryLanguages(techStack);
            const keyFrameworks = [...techStack.frameworks];
            const packageManager = techStack.packageManager;

            const [
                testStack,
                lintStack,
                typecheckStack,
                buildStack,
            ] = await this.detector.detectToolchains(techStack);

            const architectureHints = await this.detector.detectArchitectureHints();
            const highRiskSurfaces = await this.detector.detectHighRiskSurfaces();

            // ── Multi-repo: profile each discovered subproject ───────────
            if (this.discoveredSubprojects.length >= 1) {
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

        if (candidates.length >= 1) {
            // One or more child projects found while root has no manifest.
            // Always treat as multi-repo so each subproject gets its own profile.
            this.effectiveRoot = candidates[0].uri;
            this.discoveredSubprojects = candidates;
            this.detectedSubdirectory = candidates.length === 1 ? candidates[0].name : undefined;
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

        // Create a scoped detector for this subproject's effective root.
        const prevRoot = this.effectiveRoot;
        this.effectiveRoot = childUri;
        const scopedDetector = new TechStackDetector(this);

        const primaryLanguages = scopedDetector.derivePrimaryLanguages(techStack);
        const keyFrameworks = [...techStack.frameworks];
        const packageManager = techStack.packageManager;

        const [testStack, lintStack, typecheckStack, buildStack] =
            await scopedDetector.detectToolchains(techStack);

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
    //  File I/O Helpers (graceful — no throws on missing files)
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * Read a file at the workspace root.
     * Returns `null` if the file doesn't exist or cannot be read (no error thrown).
     * Implements {@link FileReader.readFileQuietly}.
     */
    async readFileQuietly(relativePath: string): Promise<string | null> {
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
     * Implements {@link FileReader.fileExists}.
     */
    async fileExists(relativePath: string): Promise<boolean> {
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
     * Implements {@link FileReader.hasFileMatching}.
     */
    async hasFileMatching(pattern: string): Promise<boolean> {
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
