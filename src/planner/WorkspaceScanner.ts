// ─────────────────────────────────────────────────────────────────────────────
// src/planner/WorkspaceScanner.ts — Workspace file tree scanner
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { COOGENT_DIR } from '../constants/paths.js';

/**
 * Directories to exclude when scanning the file tree.
 * Exported for testing.
 */
export const IGNORE = new Set([
    '.git', 'node_modules', '.next', 'dist', 'out', 'build',
    '.cache', '.vscode', '__pycache__', '.DS_Store', 'coverage',
    COOGENT_DIR,
]);

/**
 * Scans a workspace directory tree up to a specified depth,
 * respecting common ignore patterns and a character budget.
 */
export class WorkspaceScanner {
    /**
     * Collect the workspace file tree up to the specified depth.
     * Respects common ignore patterns (.git, node_modules, etc.).
     *
     * @param rootDir    Absolute path to the directory root to scan.
     * @param maxDepth   Maximum recursion depth.
     * @param maxChars   Maximum total characters for all collected path strings.
     * @returns Array of relative paths (directories suffixed with `/`).
     */
    async scan(rootDir: string, maxDepth: number, maxChars: number): Promise<string[]> {
        const result: string[] = [];
        let charCount = 0;

        const walk = async (dir: string, depth: number, prefix: string): Promise<void> => {
            if (depth > maxDepth || charCount > maxChars) return;

            let entries: import('node:fs').Dirent[];
            try {
                entries = await fs.readdir(dir, { withFileTypes: true }) as import('node:fs').Dirent[];
            } catch {
                return;
            }

            // Sort: directories first, then files
            const sorted = [...entries].sort((a, b) => {
                if (a.isDirectory() && !b.isDirectory()) return -1;
                if (!a.isDirectory() && b.isDirectory()) return 1;
                return String(a.name).localeCompare(String(b.name));
            });

            for (const entry of sorted) {
                const name = String(entry.name);
                if (IGNORE.has(name)) continue;
                // Skip dot-prefixed entries (except .gitignore) — matches RepoMap behaviour
                if (name.startsWith('.') && name !== '.gitignore') continue;
                if (charCount > maxChars) break;

                const relativePath = path.join(prefix, name);

                if (entry.isDirectory()) {
                    const line = `${relativePath}/`;
                    result.push(line);
                    charCount += line.length;
                    await walk(path.join(dir, name), depth + 1, relativePath);
                } else {
                    result.push(relativePath);
                    charCount += relativePath.length;
                }
            }
        };

        await walk(rootDir, 0, '');
        return result;
    }
}
