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
import { COOGENT_DIR } from '../constants/paths.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  CLI Argument Parsing
// ═══════════════════════════════════════════════════════════════════════════════

function parseArgs(): { workspaceRoot: string } {
    const args = process.argv.slice(2);
    let workspaceRoot = process.cwd();

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--workspace' && args[i + 1]) {
            workspaceRoot = path.resolve(args[i + 1]);
            i++; // skip the value
        }
    }

    return { workspaceRoot };
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
    const { workspaceRoot } = parseArgs();
    const coogentDir = path.join(workspaceRoot, COOGENT_DIR);

    log(`Starting CoogentMCPServer (stdio transport)`);
    log(`Workspace: ${workspaceRoot}`);
    log(`Data dir:  ${coogentDir}`);

    // Ensure .coogent directory exists
    if (!fs.existsSync(coogentDir)) {
        fs.mkdirSync(coogentDir, { recursive: true });
        log(`Created ${coogentDir}`);
    }

    // Instantiate and initialise the MCP server
    const server = new CoogentMCPServer(workspaceRoot);
    await server.init(coogentDir);
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
