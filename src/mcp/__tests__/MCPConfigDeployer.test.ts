// ─────────────────────────────────────────────────────────────────────────────
// src/mcp/__tests__/MCPConfigDeployer.test.ts — Unit tests for MCP config
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { deployMCPConfig } from '../MCPConfigDeployer';

let tempDir: string;
let configPath: string;

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-config-test-'));
    configPath = path.join(tempDir, 'mcp_config.json');
});

afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
});

// Mock getMCPConfigPath to use temp directory
jest.mock('../../constants/paths', () => ({
    ...jest.requireActual('../../constants/paths'),
    getMCPConfigPath: () => configPath,
}));

const WORKSPACE_ROOT = '/Users/testuser/projects/my-app';

function readConfig(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

describe('deployMCPConfig', () => {
    it('creates config when no file exists', () => {
        expect(fs.existsSync(configPath)).toBe(false);

        deployMCPConfig(WORKSPACE_ROOT);

        expect(fs.existsSync(configPath)).toBe(true);
        const config = readConfig();
        expect(config).toHaveProperty('mcpServers');
        expect(config.mcpServers).toHaveProperty('coogent');

        const coogent = (config.mcpServers as Record<string, unknown>)['coogent'] as Record<string, unknown>;
        expect(coogent.command).toBe('node');
        expect((coogent.args as string[])).toContain('--workspace');
        expect((coogent.args as string[])).toContain(WORKSPACE_ROOT);
    });

    it('creates parent directories if they do not exist', () => {
        const deepPath = path.join(tempDir, 'a', 'b', 'c', 'mcp_config.json');
        // Re-mock for this test
        const pathsMod = require('../../constants/paths');
        const original = pathsMod.getMCPConfigPath;
        pathsMod.getMCPConfigPath = () => deepPath;

        try {
            deployMCPConfig(WORKSPACE_ROOT);
            expect(fs.existsSync(deepPath)).toBe(true);
        } finally {
            pathsMod.getMCPConfigPath = original;
        }
    });

    it('preserves other MCP server entries when adding coogent', () => {
        // Write a config with another server
        const existingConfig = {
            mcpServers: {
                'other-server': {
                    command: 'python',
                    args: ['server.py'],
                },
            },
        };
        fs.writeFileSync(configPath, JSON.stringify(existingConfig, null, 4), 'utf-8');

        deployMCPConfig(WORKSPACE_ROOT);

        const config = readConfig();
        const servers = config.mcpServers as Record<string, unknown>;
        // Other server preserved
        expect(servers).toHaveProperty('other-server');
        expect((servers['other-server'] as Record<string, unknown>).command).toBe('python');
        // Coogent added
        expect(servers).toHaveProperty('coogent');
    });

    it('updates workspace arg when coogent entry has different workspace', () => {
        const { getMCPServerDir } = jest.requireActual('../../constants/paths');
        const serverPath = path.join(getMCPServerDir(), 'stdio-server.js');

        // Write config with old workspace
        const existingConfig = {
            mcpServers: {
                coogent: {
                    command: 'node',
                    args: [serverPath, '--workspace', '/old/workspace'],
                },
            },
        };
        fs.writeFileSync(configPath, JSON.stringify(existingConfig, null, 4), 'utf-8');

        deployMCPConfig(WORKSPACE_ROOT);

        const config = readConfig();
        const coogent = (config.mcpServers as Record<string, unknown>)['coogent'] as Record<string, unknown>;
        expect((coogent.args as string[])).toContain(WORKSPACE_ROOT);
        expect((coogent.args as string[])).not.toContain('/old/workspace');
    });

    it('skips write when config already matches', () => {
        // First deploy
        deployMCPConfig(WORKSPACE_ROOT);
        const statBefore = fs.statSync(configPath);

        // Wait a tick to ensure mtime would differ if rewritten
        const now = Date.now();
        while (Date.now() - now < 50) { /* spin */ }

        // Second deploy — should skip
        deployMCPConfig(WORKSPACE_ROOT);
        const statAfter = fs.statSync(configPath);

        // File should not have been rewritten (mtime unchanged)
        expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
    });

    it('overwrites corrupted JSON gracefully', () => {
        fs.writeFileSync(configPath, '{{{{invalid json!!!!', 'utf-8');

        // Should not throw
        deployMCPConfig(WORKSPACE_ROOT);

        const config = readConfig();
        expect(config).toHaveProperty('mcpServers');
        expect((config.mcpServers as Record<string, unknown>)).toHaveProperty('coogent');
    });

    it('overwrites config with unexpected structure', () => {
        // Valid JSON but wrong shape
        fs.writeFileSync(configPath, JSON.stringify({ foo: 'bar' }), 'utf-8');

        deployMCPConfig(WORKSPACE_ROOT);

        const config = readConfig();
        expect(config).toHaveProperty('mcpServers');
        expect((config.mcpServers as Record<string, unknown>)).toHaveProperty('coogent');
    });
});
