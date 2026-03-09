jest.mock('vscode', () => ({
    commands: { registerCommand: jest.fn() },
    window: { showWarningMessage: jest.fn(), showErrorMessage: jest.fn(), showInformationMessage: jest.fn() },
    workspace: { workspaceFolders: [] },
    Uri: { file: jest.fn() },
}), { virtual: true });

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { WorkspaceScanner, IGNORE } from '../WorkspaceScanner.js';

describe('WorkspaceScanner', () => {
    let scanner: WorkspaceScanner;
    let tmpDir: string;

    beforeEach(async () => {
        scanner = new WorkspaceScanner();
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-scanner-'));
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    // ═════════════════════════════════════════════════════════════════════
    //  Depth limits
    // ═════════════════════════════════════════════════════════════════════

    it('should respect maxDepth=0 (only root entries)', async () => {
        await fs.mkdir(path.join(tmpDir, 'sub'));
        await fs.writeFile(path.join(tmpDir, 'root.txt'), 'hi');
        await fs.mkdir(path.join(tmpDir, 'sub', 'deep'));
        await fs.writeFile(path.join(tmpDir, 'sub', 'deep', 'nested.txt'), 'hi');

        const result = await scanner.scan(tmpDir, 0, 100_000);
        // depth=0 means only the root level entries (sub/ and root.txt)
        // but NOT sub/deep/ or sub/deep/nested.txt
        expect(result).toContain('root.txt');
        expect(result).toContain(`sub/`);
        expect(result).not.toContain(expect.stringContaining('deep'));
        expect(result).not.toContain(expect.stringContaining('nested'));
    });

    it('should recurse into subdirectories up to maxDepth', async () => {
        await fs.mkdir(path.join(tmpDir, 'a', 'b'), { recursive: true });
        await fs.writeFile(path.join(tmpDir, 'a', 'b', 'file.txt'), 'hi');

        const result = await scanner.scan(tmpDir, 5, 100_000);
        expect(result).toContain(`a/`);
        expect(result).toContain(`a/b/`);
        expect(result.some(r => r.includes('file.txt'))).toBe(true);
    });

    // ═════════════════════════════════════════════════════════════════════
    //  Ignore patterns
    // ═════════════════════════════════════════════════════════════════════

    it('should skip ignored directories', async () => {
        for (const ignored of ['node_modules', '.git', 'dist']) {
            await fs.mkdir(path.join(tmpDir, ignored), { recursive: true });
            await fs.writeFile(path.join(tmpDir, ignored, 'file.txt'), 'hi');
        }
        await fs.writeFile(path.join(tmpDir, 'keep.txt'), 'hi');

        const result = await scanner.scan(tmpDir, 5, 100_000);
        expect(result).toContain('keep.txt');
        expect(result.some(r => r.includes('node_modules'))).toBe(false);
        expect(result.some(r => r.includes('.git'))).toBe(false);
        expect(result.some(r => r.includes('dist'))).toBe(false);
    });

    it('should skip dot-prefixed files/dirs except .gitignore', async () => {
        await fs.writeFile(path.join(tmpDir, '.hidden'), '');
        await fs.writeFile(path.join(tmpDir, '.gitignore'), '');
        await fs.writeFile(path.join(tmpDir, 'visible.txt'), '');

        const result = await scanner.scan(tmpDir, 5, 100_000);
        expect(result).toContain('.gitignore');
        expect(result).toContain('visible.txt');
        expect(result).not.toContain('.hidden');
    });

    it('IGNORE set should contain expected entries', () => {
        expect(IGNORE.has('.git')).toBe(true);
        expect(IGNORE.has('node_modules')).toBe(true);
        expect(IGNORE.has('coverage')).toBe(true);
    });

    // ═════════════════════════════════════════════════════════════════════
    //  Character budget
    // ═════════════════════════════════════════════════════════════════════

    it('should stop collecting when maxChars budget is exceeded', async () => {
        // Create many files to exceed a small budget
        for (let i = 0; i < 50; i++) {
            await fs.writeFile(path.join(tmpDir, `file_with_a_long_name_${i}.txt`), '');
        }

        const result = await scanner.scan(tmpDir, 5, 100);
        // Should have collected fewer than 50 files due to the 100-char budget
        expect(result.length).toBeLessThan(50);
        expect(result.length).toBeGreaterThan(0);
    });

    // ═════════════════════════════════════════════════════════════════════
    //  Edge cases
    // ═════════════════════════════════════════════════════════════════════

    it('should return empty array for non-existent directory', async () => {
        const result = await scanner.scan('/tmp/nonexistent-dir-xyz', 5, 100_000);
        expect(result).toEqual([]);
    });

    it('should return empty array for empty directory', async () => {
        const result = await scanner.scan(tmpDir, 5, 100_000);
        expect(result).toEqual([]);
    });
});
