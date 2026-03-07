// ─────────────────────────────────────────────────────────────────────────────
// src/context/PromptTemplateManager.ts — Dynamic tech stack discovery
//   and planner prompt template injection
// ─────────────────────────────────────────────────────────────────────────────

import * as vscode from 'vscode';

// ═══════════════════════════════════════════════════════════════════════════════
//  Exported Interface
// ═══════════════════════════════════════════════════════════════════════════════

export interface TechStackInfo {
    /** Primary runtime/language (e.g., "node", "python", "go"). */
    runtime: string;
    /** Package manager detected (e.g., "npm", "yarn", "pnpm", "pip", "go mod"). */
    packageManager: string;
    /** Key dependencies extracted from the manifest file. */
    dependencies: string[];
    /** Frameworks detected (e.g., "next.js", "express", "fastapi"). */
    frameworks: string[];
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Known Framework Patterns
// ═══════════════════════════════════════════════════════════════════════════════

/** Map from npm dependency name to human-readable framework label. */
const NODE_FRAMEWORK_MAP: Record<string, string> = {
    'next': 'next.js',
    'react': 'react',
    'svelte': 'svelte',
    'vue': 'vue',
    'angular': 'angular',
    'express': 'express',
    'fastify': 'fastify',
    'nuxt': 'nuxt',
    'gatsby': 'gatsby',
    'remix': 'remix',
    'nest': 'nest.js',
    '@nestjs/core': 'nest.js',
    'hono': 'hono',
};

/** npm dependency names considered "important" (top 20 cap applies). */
const NODE_IMPORTANT_DEPS = new Set([
    'react', 'next', 'vue', 'svelte', 'angular', 'express', 'fastify',
    'typescript', 'jest', 'vitest', 'mocha', 'prettier', 'eslint',
    'tailwindcss', 'prisma', 'drizzle-orm', 'zod', 'trpc',
    '@trpc/server', 'graphql', 'mongoose', 'sequelize', 'typeorm',
    'webpack', 'vite', 'esbuild', 'rollup', 'playwright', 'cypress',
]);

/** Python package names to framework labels. */
const PYTHON_FRAMEWORK_MAP: Record<string, string> = {
    'fastapi': 'fastapi',
    'django': 'django',
    'flask': 'flask',
    'starlette': 'starlette',
    'tornado': 'tornado',
    'sanic': 'sanic',
};

/** Max dependencies to include in the prompt (token budget). */
const MAX_DEPENDENCIES = 20;

// ═══════════════════════════════════════════════════════════════════════════════
//  PromptTemplateManager
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Dynamically discovers the workspace's tech stack from manifest files
 * and provides template variable injection for the Planner's system prompt.
 *
 * Design goals:
 *  - Fast: Only reads root-level manifest files, no directory walking.
 *  - Graceful: Missing files are silently skipped.
 *  - Lean: Limits dependency list to top 20 to avoid token bloat.
 */
export class PromptTemplateManager {
    private readonly rootUri: vscode.Uri;

    constructor(workspaceRoot: string) {
        this.rootUri = vscode.Uri.file(workspaceRoot);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Tech Stack Discovery
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * Scan the workspace root for manifest files and determine the tech stack.
     * Checks package.json, requirements.txt, pyproject.toml, go.mod, Cargo.toml.
     * Returns sensible defaults if nothing is found.
     */
    async discoverTechStack(): Promise<TechStackInfo> {
        // Try each ecosystem in priority order
        const nodeResult = await this.scanNode();
        if (nodeResult) return nodeResult;

        const pythonResult = await this.scanPython();
        if (pythonResult) return pythonResult;

        const goResult = await this.scanGo();
        if (goResult) return goResult;

        const rustResult = await this.scanRust();
        if (rustResult) return rustResult;

        // Nothing found — return defaults
        return {
            runtime: 'unknown',
            packageManager: 'unknown',
            dependencies: [],
            frameworks: [],
        };
    }

    // ── Node.js ─────────────────────────────────────────────────────────────

    private async scanNode(): Promise<TechStackInfo | null> {
        const content = await this.readFileQuietly('package.json');
        if (!content) return null;

        let pkg: Record<string, unknown>;
        try {
            pkg = JSON.parse(content) as Record<string, unknown>;
        } catch {
            return null;
        }

        const allDeps: Record<string, string> = {
            ...(typeof pkg.dependencies === 'object' && pkg.dependencies !== null
                ? pkg.dependencies as Record<string, string>
                : {}),
            ...(typeof pkg.devDependencies === 'object' && pkg.devDependencies !== null
                ? pkg.devDependencies as Record<string, string>
                : {}),
        };

        const depNames = Object.keys(allDeps);

        // Detect frameworks
        const frameworks: string[] = [];
        for (const dep of depNames) {
            const fw = NODE_FRAMEWORK_MAP[dep];
            if (fw && !frameworks.includes(fw)) {
                frameworks.push(fw);
            }
        }

        // Filter to important deps (or first N if none match importance set)
        let keyDeps = depNames.filter(d => NODE_IMPORTANT_DEPS.has(d));
        if (keyDeps.length === 0) {
            keyDeps = depNames.slice(0, MAX_DEPENDENCIES);
        }

        // Format as name@majorVersion where possible
        const formattedDeps = keyDeps.slice(0, MAX_DEPENDENCIES).map(dep => {
            const ver = allDeps[dep];
            if (ver) {
                const major = ver.replace(/^[~^>=<\s]*/, '').split('.')[0];
                return major ? `${dep}@${major}` : dep;
            }
            return dep;
        });

        // Detect package manager from lock files
        const packageManager = await this.detectNodePackageManager();

        return {
            runtime: 'node',
            packageManager,
            dependencies: formattedDeps,
            frameworks,
        };
    }

    private async detectNodePackageManager(): Promise<string> {
        if (await this.fileExists('pnpm-lock.yaml')) return 'pnpm';
        if (await this.fileExists('yarn.lock')) return 'yarn';
        if (await this.fileExists('bun.lockb') || await this.fileExists('bun.lock')) return 'bun';
        if (await this.fileExists('package-lock.json')) return 'npm';
        return 'npm'; // default
    }

    // ── Python ──────────────────────────────────────────────────────────────

    private async scanPython(): Promise<TechStackInfo | null> {
        // Try requirements.txt first
        const reqTxt = await this.readFileQuietly('requirements.txt');
        if (reqTxt) {
            return this.parsePythonRequirements(reqTxt);
        }

        // Try pyproject.toml
        const pyproject = await this.readFileQuietly('pyproject.toml');
        if (pyproject) {
            return this.parsePyproject(pyproject);
        }

        return null;
    }

    private parsePythonRequirements(content: string): TechStackInfo {
        const lines = content.split('\n')
            .map(l => l.trim())
            .filter(l => l && !l.startsWith('#') && !l.startsWith('-'));

        const deps: string[] = [];
        const frameworks: string[] = [];

        for (const line of lines) {
            // Extract package name (before any version specifier)
            const match = line.match(/^([a-zA-Z0-9_-]+)/);
            if (!match) continue;
            const pkgName = match[1].toLowerCase();
            deps.push(pkgName);

            const fw = PYTHON_FRAMEWORK_MAP[pkgName];
            if (fw && !frameworks.includes(fw)) {
                frameworks.push(fw);
            }
        }

        return {
            runtime: 'python',
            packageManager: 'pip',
            dependencies: deps.slice(0, MAX_DEPENDENCIES),
            frameworks,
        };
    }

    private parsePyproject(content: string): TechStackInfo {
        const deps: string[] = [];
        const frameworks: string[] = [];

        // Simple TOML-like parsing for dependencies array
        // Matches lines like: "fastapi>=0.100.0", 'django', etc.
        const depMatches = content.matchAll(/["']([a-zA-Z0-9_-]+)/g);
        const seen = new Set<string>();
        for (const m of depMatches) {
            const pkgName = m[1].toLowerCase();
            if (seen.has(pkgName)) continue;
            seen.add(pkgName);
            deps.push(pkgName);

            const fw = PYTHON_FRAMEWORK_MAP[pkgName];
            if (fw && !frameworks.includes(fw)) {
                frameworks.push(fw);
            }
        }

        // Detect package manager
        let packageManager = 'pip';
        if (content.includes('[tool.poetry]')) packageManager = 'poetry';
        if (content.includes('[tool.pdm]')) packageManager = 'pdm';
        if (content.includes('[tool.uv]') || content.includes('[dependency-groups]')) packageManager = 'uv';

        return {
            runtime: 'python',
            packageManager,
            dependencies: deps.slice(0, MAX_DEPENDENCIES),
            frameworks,
        };
    }

    // ── Go ──────────────────────────────────────────────────────────────────

    private async scanGo(): Promise<TechStackInfo | null> {
        const content = await this.readFileQuietly('go.mod');
        if (!content) return null;

        const deps: string[] = [];
        const frameworks: string[] = [];

        // Extract module path
        const moduleMatch = content.match(/^module\s+(\S+)/m);
        if (moduleMatch) {
            deps.push(moduleMatch[1]);
        }

        // Extract require directives
        const requireMatches = content.matchAll(/^\s+(\S+)\s+v[\d.]+/gm);
        for (const m of requireMatches) {
            const dep = m[1];
            deps.push(dep);

            // Detect common Go frameworks
            if (dep.includes('gin-gonic')) frameworks.push('gin');
            if (dep.includes('gorilla/mux')) frameworks.push('gorilla/mux');
            if (dep.includes('labstack/echo')) frameworks.push('echo');
            if (dep.includes('gofiber/fiber')) frameworks.push('fiber');
        }

        return {
            runtime: 'go',
            packageManager: 'go mod',
            dependencies: deps.slice(0, MAX_DEPENDENCIES),
            frameworks,
        };
    }

    // ── Rust ────────────────────────────────────────────────────────────────

    private async scanRust(): Promise<TechStackInfo | null> {
        const content = await this.readFileQuietly('Cargo.toml');
        if (!content) return null;

        const deps: string[] = [];
        const frameworks: string[] = [];

        // Extract crate name
        const nameMatch = content.match(/^name\s*=\s*"([^"]+)"/m);
        if (nameMatch) {
            deps.push(nameMatch[1]);
        }

        // Extract dependency names from [dependencies] section
        const depSection = content.match(/\[dependencies\]([\s\S]*?)(?:\n\[|$)/);
        if (depSection) {
            const depMatches = depSection[1].matchAll(/^([a-zA-Z0-9_-]+)\s*=/gm);
            for (const m of depMatches) {
                const dep = m[1];
                deps.push(dep);

                // Detect common Rust frameworks
                if (dep === 'actix-web') frameworks.push('actix-web');
                if (dep === 'axum') frameworks.push('axum');
                if (dep === 'rocket') frameworks.push('rocket');
                if (dep === 'warp') frameworks.push('warp');
                if (dep === 'tokio') frameworks.push('tokio');
            }
        }

        return {
            runtime: 'rust',
            packageManager: 'cargo',
            dependencies: deps.slice(0, MAX_DEPENDENCIES),
            frameworks,
        };
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Formatting
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * Format the tech stack into a lean string for prompt injection.
     *
     * Example output:
     * ```
     * Runtime: node (npm)
     * Key Dependencies: react@18, next@14, typescript@5, jest
     * Frameworks: next.js, react
     * ```
     */
    formatTechStack(info: TechStackInfo): string {
        const lines: string[] = [];
        lines.push(`Runtime: ${info.runtime} (${info.packageManager})`);

        if (info.dependencies.length > 0) {
            lines.push(`Key Dependencies: ${info.dependencies.join(', ')}`);
        }

        if (info.frameworks.length > 0) {
            lines.push(`Frameworks: ${info.frameworks.join(', ')}`);
        }

        return lines.join('\n');
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Prompt Injection
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * Inject workspace context and available skill tags into the base planner prompt.
     *
     * Inserts two new sections BEFORE the `## User Request` section:
     *  - `## Workspace Tech Stack`  — formatted tech stack
     *  - `## Available Worker Skills` — sorted tag list with guidance
     *
     * If no `## User Request` marker is found, appends the sections at the end.
     */
    buildEnhancedPlannerPrompt(
        basePrompt: string,
        techStack: TechStackInfo,
        availableTags: string[]
    ): string {
        const formattedStack = this.formatTechStack(techStack);
        const sortedTags = [...availableTags].sort();

        const injectedSections = [
            `## Workspace Tech Stack\n${formattedStack}`,
            `## Available Worker Skills\nWhen assigning phases, you may specify \`required_skills\` as an array of tags from this list:\n${sortedTags.join(', ')}\nIf a phase needs no special skills, omit \`required_skills\` (a generalist worker will be used).`,
        ].join('\n\n');

        // Try to insert before `## User Request`
        const marker = '## User Request';
        const markerIndex = basePrompt.indexOf(marker);

        if (markerIndex !== -1) {
            const before = basePrompt.slice(0, markerIndex);
            const after = basePrompt.slice(markerIndex);
            return `${before}${injectedSections}\n\n${after}`;
        }

        // Fallback: append at the end
        return `${basePrompt}\n\n${injectedSections}`;
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  File I/O Helpers (graceful — no throws on missing files)
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * Read a file at the workspace root. Returns null if the file doesn't exist
     * or cannot be read (no error thrown).
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
     * Check if a file exists at the workspace root.
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
}
