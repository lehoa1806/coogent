// ─────────────────────────────────────────────────────────────────────────────
// src/prompt-compiler/TechStackDetector.ts — Toolchain, architecture, and risk
//   detection extracted from RepoFingerprinter for single-responsibility.
// ─────────────────────────────────────────────────────────────────────────────

import type { TechStackInfo } from '../context/PromptTemplateManager.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  File I/O Contract
//
//  Consumers inject a FileReader so detection logic stays pure and testable
//  without VS Code API dependencies.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Minimal file-system interface used by TechStackDetector.
 * Implementors (e.g. RepoFingerprinter) provide workspace-scoped I/O.
 */
export interface FileReader {
    /** Read a file relative to the workspace root. Returns null if not found. */
    readFileQuietly(relativePath: string): Promise<string | null>;
    /** Check if a file or directory exists at the workspace root. */
    fileExists(relativePath: string): Promise<boolean>;
    /** Check if any file matching a glob-like pattern exists. */
    hasFileMatching(pattern: string): Promise<boolean>;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  TechStackDetector
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Detects toolchains, architectural patterns, and risk surfaces from
 * workspace files and dependency manifests.
 *
 * Operates through a {@link FileReader} interface — no direct file-system
 * or VS Code dependency. All detection is best-effort and never throws.
 */
export class TechStackDetector {
    constructor(private readonly reader: FileReader) { }

    // ═════════════════════════════════════════════════════════════════════════
    //  Language Derivation
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * Map the detected runtime to primary language list.
     */
    derivePrimaryLanguages(techStack: TechStackInfo): string[] {
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
    async detectToolchains(
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
    async getNodeDependencyNames(): Promise<Set<string>> {
        const content = await this.reader.readFileQuietly('package.json');
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
    async getPythonDependencyNames(): Promise<Set<string>> {
        const deps = new Set<string>();

        const reqTxt = await this.reader.readFileQuietly('requirements.txt');
        if (reqTxt) {
            for (const line of reqTxt.split('\n')) {
                const match = line.trim().match(/^([a-zA-Z0-9_-]+)/);
                if (match && !line.startsWith('#') && !line.startsWith('-')) {
                    deps.add(match[1].toLowerCase());
                }
            }
        }

        const pyproject = await this.reader.readFileQuietly('pyproject.toml');
        if (pyproject) {
            const depMatches = pyproject.matchAll(/['"]([a-zA-Z0-9_-]+)/g);
            for (const m of depMatches) {
                deps.add(m[1].toLowerCase());
            }
        }

        return deps;
    }

    /** Detect test frameworks. */
    detectTestStack(nodeDeps: Set<string>, pythonDeps: Set<string>): string[] {
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
    detectLintStack(nodeDeps: Set<string>, pythonDeps: Set<string>): string[] {
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
    async detectTypecheckStack(nodeDeps: Set<string>, pythonDeps: Set<string>): Promise<string[]> {
        const stack: string[] = [];

        // TypeScript: check for tsconfig.json OR typescript in deps
        if (nodeDeps.has('typescript') || await this.reader.fileExists('tsconfig.json')) {
            stack.push('tsc');
        }

        if (pythonDeps.has('mypy')) stack.push('mypy');
        if (pythonDeps.has('pyright')) stack.push('pyright');

        return stack;
    }

    /** Detect build tools. */
    detectBuildStack(nodeDeps: Set<string>, techStack: TechStackInfo): string[] {
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
    async detectArchitectureHints(): Promise<string[]> {
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
            if (await this.reader.fileExists(path)) {
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
    async detectHighRiskSurfaces(): Promise<string[]> {
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
            if (await this.reader.fileExists(path)) {
                if (!surfaces.includes(surface)) surfaces.push(surface);
            }
        }

        return surfaces;
    }
}
