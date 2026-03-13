// ─────────────────────────────────────────────────────────────────────────────
// src/mcp/MCPServerDeployer.ts — Deploy stdio MCP server to global directory
// ─────────────────────────────────────────────────────────────────────────────
// Copies the built stdio-server bundle (stdio-server.js + sql-wasm.wasm)
// from the extension's out/ directory to the Antigravity global data directory:
//   ~/Library/Application Support/Antigravity/coogent/mcp/
//
// This allows external AI tools (Antigravity IDE, Cursor, Claude Desktop)
// to find and start the MCP server at a stable, well-known location.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getMCPServerDir } from '../constants/paths.js';
import log from '../logger/log.js';

/** Files required for the stdio MCP server to function. */
const DEPLOY_FILES = ['stdio-server.js', 'sql-wasm.wasm'] as const;

/**
 * Check whether `src` is newer than `dest` (or `dest` doesn't exist).
 */
function isStale(src: string, dest: string): boolean {
    try {
        const destStat = fs.statSync(dest);
        const srcStat = fs.statSync(src);
        return srcStat.mtimeMs > destStat.mtimeMs;
    } catch {
        // dest doesn't exist → stale
        return true;
    }
}

/**
 * Deploy the MCP stdio server bundle to the global Antigravity directory.
 *
 * Copies each file from the extension's `out/` directory to:
 *   `~/Library/Application Support/Antigravity/coogent/mcp/`
 *
 * Files are only copied when the target is missing or stale (source is newer).
 *
 * @param extensionPath  Absolute path to the extension install directory
 *                       (i.e. `context.extensionPath`). The source files are
 *                       expected at `<extensionPath>/out/`.
 */
export function deployMCPServer(extensionPath: string): void {
    const sourceDir = path.join(extensionPath, 'out');
    const targetDir = getMCPServerDir();

    // Ensure the target directory exists
    fs.mkdirSync(targetDir, { recursive: true });

    for (const file of DEPLOY_FILES) {
        const src = path.join(sourceDir, file);
        const dest = path.join(targetDir, file);

        if (!fs.existsSync(src)) {
            log.warn(`[MCPServerDeployer] Source file not found, skipping: ${src}`);
            continue;
        }

        if (!isStale(src, dest)) {
            log.debug(`[MCPServerDeployer] Up-to-date, skipping: ${file}`);
            continue;
        }

        fs.copyFileSync(src, dest);
        log.info(`[MCPServerDeployer] Deployed: ${file} → ${dest}`);
    }

    log.info(`[MCPServerDeployer] MCP server deployed to: ${targetDir}`);
}
