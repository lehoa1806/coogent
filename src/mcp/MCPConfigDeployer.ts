// ─────────────────────────────────────────────────────────────────────────────
// src/mcp/MCPConfigDeployer.ts — Deploy MCP config for external AI tools
// ─────────────────────────────────────────────────────────────────────────────
// Writes (or merges into) the MCP config file that external AI tools read
// to discover and launch the Coogent MCP stdio server.
//
// Target: ~/.gemini/antigravity/mcp_config.json
//
// Merge strategy:
//   - If the file doesn't exist → create it with the coogent server entry.
//   - If it exists with other mcpServers → preserve them, add/update coogent.
//   - If it already matches → no-op.
//   - If it's corrupt JSON → overwrite with a valid config.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getMCPConfigPath, getMCPServerDir } from '../constants/paths.js';
import log from '../logger/log.js';

/** Shape of the `coogent` entry within `mcpServers`. */
interface MCPServerEntry {
    command: string;
    args: string[];
}

/** Top-level shape of the mcp_config.json file. */
interface MCPConfig {
    mcpServers: Record<string, MCPServerEntry>;
}

/**
 * Build the expected coogent server entry for the given workspace.
 */
function buildCoogentEntry(workspaceRoot: string): MCPServerEntry {
    const serverPath = path.join(getMCPServerDir(), 'stdio-server.js');
    return {
        command: 'node',
        args: [serverPath, '--workspace', workspaceRoot],
    };
}

/**
 * Check whether two server entries are functionally identical.
 */
function entriesMatch(a: MCPServerEntry, b: MCPServerEntry): boolean {
    return (
        a.command === b.command &&
        a.args.length === b.args.length &&
        a.args.every((arg, i) => arg === b.args[i])
    );
}

/**
 * Read and parse the existing config file.
 * Returns `null` if the file doesn't exist or contains invalid JSON.
 */
function readExistingConfig(configPath: string): MCPConfig | null {
    try {
        const raw = fs.readFileSync(configPath, 'utf-8');
        const parsed = JSON.parse(raw);
        // Validate basic structure
        if (parsed && typeof parsed === 'object' && typeof parsed.mcpServers === 'object') {
            return parsed as MCPConfig;
        }
        log.warn('[MCPConfigDeployer] Config file has unexpected structure, will overwrite.');
        return null;
    } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            return null; // File doesn't exist — expected for first run
        }
        log.warn('[MCPConfigDeployer] Failed to parse existing config, will overwrite:', err);
        return null;
    }
}

/**
 * Deploy the MCP config file for external AI tools.
 *
 * Writes `~/.gemini/antigravity/mcp_config.json` with a `coogent` server
 * entry pointing to the deployed stdio-server and the current workspace.
 *
 * Existing entries for other MCP servers are preserved. If the config
 * already has a matching `coogent` entry, the write is skipped.
 *
 * @param workspaceRoot  Absolute path to the primary workspace root.
 */
export function deployMCPConfig(workspaceRoot: string): void {
    const configPath = getMCPConfigPath();
    log.info(`[MCPConfigDeployer] Deploying MCP config for workspace: ${workspaceRoot}`);
    log.info(`[MCPConfigDeployer] Target config path: ${configPath}`);

    const desiredEntry = buildCoogentEntry(workspaceRoot);
    log.debug(`[MCPConfigDeployer] Desired entry: command=${desiredEntry.command}, args=${JSON.stringify(desiredEntry.args)}`);

    // Read existing config (if any)
    const existing = readExistingConfig(configPath);

    if (existing) {
        const existingServerKeys = Object.keys(existing.mcpServers);
        log.info(`[MCPConfigDeployer] Found existing config with servers: [${existingServerKeys.join(', ')}]`);

        const currentEntry = existing.mcpServers['coogent'];
        if (currentEntry && entriesMatch(currentEntry, desiredEntry)) {
            log.info('[MCPConfigDeployer] Config already up-to-date, skipping write.');
            return;
        }

        if (currentEntry) {
            log.info('[MCPConfigDeployer] Existing coogent entry differs — updating.');
        } else {
            log.info('[MCPConfigDeployer] No coogent entry found — adding to existing config.');
        }

        // Merge: preserve other servers, add/update coogent
        existing.mcpServers['coogent'] = desiredEntry;

        writeConfig(configPath, existing);
        log.info('[MCPConfigDeployer] Successfully wrote updated config.');
    } else {
        log.info('[MCPConfigDeployer] No existing config found — creating fresh config.');

        // Create fresh config
        const config: MCPConfig = {
            mcpServers: {
                coogent: desiredEntry,
            },
        };

        writeConfig(configPath, config);
        log.info('[MCPConfigDeployer] Successfully created new MCP config.');
    }
}

/**
 * Atomically write the config file (write to .tmp, then rename).
 */
function writeConfig(configPath: string, config: MCPConfig): void {
    const dir = path.dirname(configPath);
    fs.mkdirSync(dir, { recursive: true });

    const tmpPath = configPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(config, null, 4) + '\n', 'utf-8');
    fs.renameSync(tmpPath, configPath);
}
