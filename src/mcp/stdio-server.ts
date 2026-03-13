#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// src/mcp/stdio-server.ts — Standalone stdio MCP server entry point
// ─────────────────────────────────────────────────────────────────────────────
// Exposes the CoogentMCPServer over stdio so external AI agents (Antigravity,
// Cursor, Claude Desktop, etc.) can connect via the MCP protocol.
//
// Usage:
//   node out/stdio-server.js [--workspace /path/to/workspace]
//
// By default, workspace is process.cwd().
// All log output goes to stderr (stdout is reserved for MCP JSON-RPC).

import * as path from 'node:path';
import * as fs from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CoogentMCPServer } from './CoogentMCPServer.js';
import { COOGENT_DIR, getGlobalCoogentDir } from '../constants/paths.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  CLI Argument Parsing
// ═══════════════════════════════════════════════════════════════════════════════

function parseArgs(): { workspaceRoot: string; dataDirOverride: string | undefined } {
    const args = process.argv.slice(2);
    let workspaceRoot = process.cwd();
    let dataDirOverride: string | undefined;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--workspace' && args[i + 1]) {
            workspaceRoot = path.resolve(args[i + 1]);
            i++; // skip the value
        } else if (args[i] === '--data-dir' && args[i + 1]) {
            dataDirOverride = path.resolve(args[i + 1]);
            i++; // skip the value
        }
    }

    return { workspaceRoot, dataDirOverride };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Stderr Logger (stdout is reserved for MCP JSON-RPC)
// ═══════════════════════════════════════════════════════════════════════════════

function log(message: string): void {
    process.stderr.write(`[coogent-stdio] ${message}\n`);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Main
// ═══════════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
    const { workspaceRoot, dataDirOverride } = parseArgs();
    const globalDir = dataDirOverride ?? getGlobalCoogentDir();
    const localDir = path.join(workspaceRoot, COOGENT_DIR);

    log(`Starting CoogentMCPServer (stdio transport)`);
    log(`Workspace:  ${workspaceRoot}`);
    log(`Global dir: ${globalDir}`);
    log(`Local dir:  ${localDir}`);

    // Ensure both directories exist
    fs.mkdirSync(globalDir, { recursive: true });
    fs.mkdirSync(localDir, { recursive: true });
    log(`Ensured directories exist`);

    // Instantiate and initialise the MCP server (durable storage in globalDir)
    const server = new CoogentMCPServer(workspaceRoot);
    await server.init(globalDir);
    log('ArtifactDB initialised');

    // Connect via stdio transport
    const transport = new StdioServerTransport();
    await server.getServer().connect(transport);
    log('Connected via stdio — ready for MCP requests');

    // Graceful shutdown handlers
    const shutdown = (): void => {
        log('Shutting down...');
        server.dispose();
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch((err) => {
    process.stderr.write(`[coogent-stdio] Fatal error: ${(err as Error).message}\n`);
    process.stderr.write(`[coogent-stdio] ${(err as Error).stack ?? ''}\n`);
    process.exit(1);
});
