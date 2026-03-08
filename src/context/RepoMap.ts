// ─────────────────────────────────────────────────────────────────────────────
// src/context/RepoMap.ts — Lightweight file tree for worker context injection
// ─────────────────────────────────────────────────────────────────────────────
// Generates a compact directory listing of the workspace, respecting .gitignore.
// Injected into each phase's context payload so workers have structural
// awareness of the repository (à la Aider's repo-map concept).

import * as fs from 'fs/promises';
import * as path from 'path';
import { COOGENT_DIR } from '../constants/paths.js';

/** Default patterns to exclude from the repo map (always applied). */
const DEFAULT_EXCLUDES = new Set([
    'node_modules', '.git', COOGENT_DIR, '__pycache__', '.venv', 'venv',
    'dist', 'build', 'out', '.next', '.svelte-kit', 'coverage',
    '.DS_Store', 'Thumbs.db', '.env', '.env.local',
]);

/** Default max depth for directory walking. */
const DEFAULT_MAX_DEPTH = 6;

/** Default max entries to prevent token blowout on huge repos. */
const DEFAULT_MAX_ENTRIES = 200;

/**
 * Generate a lightweight file tree map of the workspace.
 *
 * @param workspaceRoot - Absolute path to the workspace root.
 * @param options.maxDepth - Maximum directory depth (default: 6).
 * @param options.maxEntries - Maximum number of entries (default: 200).
 * @returns A formatted text block listing the repository structure.
 */
export async function generateRepoMap(
    workspaceRoot: string,
    options: { maxDepth?: number; maxEntries?: number } = {},
): Promise<string> {
    const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    const entries: string[] = [];

    await walk(workspaceRoot, workspaceRoot, 0, maxDepth, maxEntries, entries);

    if (entries.length === 0) {
        return '';
    }

    const truncated = entries.length >= maxEntries
        ? `\n[... truncated at ${maxEntries} entries]`
        : '';

    return [
        '<<<REPO MAP>>>',
        ...entries,
        truncated,
        '<<<END REPO MAP>>>',
    ].filter(Boolean).join('\n');
}

/**
 * Recursively walk a directory, collecting relative paths.
 */
async function walk(
    root: string,
    dir: string,
    depth: number,
    maxDepth: number,
    maxEntries: number,
    entries: string[],
): Promise<void> {
    if (depth > maxDepth || entries.length >= maxEntries) return;

    let dirents;
    try {
        dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
        return; // Permission denied or similar
    }

    // Sort for deterministic output
    dirents.sort((a, b) => a.name.localeCompare(b.name));

    for (const dirent of dirents) {
        if (entries.length >= maxEntries) break;

        if (DEFAULT_EXCLUDES.has(dirent.name)) continue;
        if (dirent.name.startsWith('.') && dirent.name !== '.gitignore') continue;

        const fullPath = path.join(dir, dirent.name);
        const relPath = path.relative(root, fullPath);

        if (dirent.isDirectory()) {
            entries.push(`${relPath}/`);
            await walk(root, fullPath, depth + 1, maxDepth, maxEntries, entries);
        } else if (dirent.isFile()) {
            entries.push(relPath);
        }
    }
}
