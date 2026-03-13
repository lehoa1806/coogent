// ─────────────────────────────────────────────────────────────────────────────
// src/mcp/__tests__/MCPServerDeployer.test.ts — Unit tests for MCP deployment
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { deployMCPServer } from '../MCPServerDeployer';

// Override getMCPServerDir to use a temp directory
let tempDir: string;
let mcpDir: string;
let fakeExtDir: string;

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-deploy-test-'));
    mcpDir = path.join(tempDir, 'mcp');
    fakeExtDir = path.join(tempDir, 'ext');
    const outDir = path.join(fakeExtDir, 'out');
    fs.mkdirSync(outDir, { recursive: true });

    // Create fake source files
    fs.writeFileSync(path.join(outDir, 'stdio-server.js'), 'console.log("server")');
    fs.writeFileSync(path.join(outDir, 'sql-wasm.wasm'), 'fake-wasm-binary');
});

afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
});

// Mock getMCPServerDir to return our temp path
jest.mock('../../constants/paths', () => ({
    ...jest.requireActual('../../constants/paths'),
    getMCPServerDir: () => mcpDir,
}));

describe('deployMCPServer', () => {
    it('copies files when target directory does not exist', () => {
        deployMCPServer(fakeExtDir);

        expect(fs.existsSync(path.join(mcpDir, 'stdio-server.js'))).toBe(true);
        expect(fs.existsSync(path.join(mcpDir, 'sql-wasm.wasm'))).toBe(true);
        expect(fs.readFileSync(path.join(mcpDir, 'stdio-server.js'), 'utf-8'))
            .toBe('console.log("server")');
    });

    it('creates the mcp/ directory if it does not exist', () => {
        expect(fs.existsSync(mcpDir)).toBe(false);
        deployMCPServer(fakeExtDir);
        expect(fs.existsSync(mcpDir)).toBe(true);
    });

    it('re-copies when source is newer than target', () => {
        // First deploy
        deployMCPServer(fakeExtDir);

        // Update source file
        const srcPath = path.join(fakeExtDir, 'out', 'stdio-server.js');
        const destPath = path.join(mcpDir, 'stdio-server.js');

        // Set target mtime to the past
        const pastTime = new Date(2020, 0, 1);
        fs.utimesSync(destPath, pastTime, pastTime);

        // Write new content to source
        fs.writeFileSync(srcPath, 'console.log("updated")');

        // Second deploy
        deployMCPServer(fakeExtDir);

        expect(fs.readFileSync(destPath, 'utf-8')).toBe('console.log("updated")');
    });

    it('skips copy when target is up-to-date', () => {
        // First deploy
        deployMCPServer(fakeExtDir);

        const destPath = path.join(mcpDir, 'stdio-server.js');
        const beforeStat = fs.statSync(destPath);

        // Set source mtime to the past (target is already current)
        const srcPath = path.join(fakeExtDir, 'out', 'stdio-server.js');
        const pastTime = new Date(2020, 0, 1);
        fs.utimesSync(srcPath, pastTime, pastTime);

        // Second deploy — should skip
        deployMCPServer(fakeExtDir);

        const afterStat = fs.statSync(destPath);
        // File should not have been touched
        expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
    });

    it('skips missing source files gracefully', () => {
        // Remove one source file
        fs.unlinkSync(path.join(fakeExtDir, 'out', 'sql-wasm.wasm'));

        // Should not throw
        deployMCPServer(fakeExtDir);

        expect(fs.existsSync(path.join(mcpDir, 'stdio-server.js'))).toBe(true);
        expect(fs.existsSync(path.join(mcpDir, 'sql-wasm.wasm'))).toBe(false);
    });
});
