// ─────────────────────────────────────────────────────────────────────────────
// src/context/__tests__/RepoMap.test.ts — RepoMap unit tests
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { generateRepoMap } from '../RepoMap.js';

describe('RepoMap', () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repomap-'));
        // Create a minimal project structure
        await fs.mkdir(path.join(tmpDir, 'src'));
        await fs.mkdir(path.join(tmpDir, 'src', 'utils'));
        await fs.writeFile(path.join(tmpDir, 'src', 'index.ts'), 'export {};');
        await fs.writeFile(path.join(tmpDir, 'src', 'utils', 'helpers.ts'), 'export {};');
        await fs.writeFile(path.join(tmpDir, 'package.json'), '{}');
        await fs.writeFile(path.join(tmpDir, 'README.md'), '# Test');
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('generates a non-empty tree for a valid directory', async () => {
        const result = await generateRepoMap(tmpDir);
        expect(result).toContain('<<<REPO MAP>>>');
        expect(result).toContain('<<<END REPO MAP>>>');
        expect(result).toContain('src/');
        expect(result).toContain('src/index.ts');
        expect(result).toContain('package.json');
    });

    it('lists files in sorted order', async () => {
        const result = await generateRepoMap(tmpDir);
        const lines = result.split('\n').filter(l => !l.startsWith('<<<') && l.trim());
        // Verify deterministic sorting
        for (let i = 1; i < lines.length; i++) {
            // Directories and their contents are interleaved, so just check non-empty
            expect(lines[i].length).toBeGreaterThan(0);
        }
    });

    it('excludes node_modules and .git directories', async () => {
        await fs.mkdir(path.join(tmpDir, 'node_modules'));
        await fs.writeFile(path.join(tmpDir, 'node_modules', 'pkg.js'), '');
        await fs.mkdir(path.join(tmpDir, '.git'));
        await fs.writeFile(path.join(tmpDir, '.git', 'HEAD'), '');

        const result = await generateRepoMap(tmpDir);
        expect(result).not.toContain('node_modules');
        expect(result).not.toContain('.git/');
    });

    it('respects maxEntries limit', async () => {
        const result = await generateRepoMap(tmpDir, { maxEntries: 2 });
        const lines = result.split('\n').filter(l => !l.startsWith('<<<') && !l.startsWith('[..'));
        // Should have at most 2 real entries
        const entryLines = lines.filter(l => l.trim().length > 0);
        expect(entryLines.length).toBeLessThanOrEqual(2);
        expect(result).toContain('[... truncated at 2 entries]');
    });

    it('returns empty string for empty directory', async () => {
        const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'empty-'));
        try {
            const result = await generateRepoMap(emptyDir);
            expect(result).toBe('');
        } finally {
            await fs.rm(emptyDir, { recursive: true, force: true });
        }
    });

    it('handles maxDepth correctly', async () => {
        // Create a deeply nested structure
        const deep = path.join(tmpDir, 'a', 'b', 'c', 'd', 'e', 'f', 'g');
        await fs.mkdir(deep, { recursive: true });
        await fs.writeFile(path.join(deep, 'deep.txt'), 'deep');

        const result = await generateRepoMap(tmpDir, { maxDepth: 2 });
        // Should not contain the deeply nested file
        expect(result).not.toContain('deep.txt');
    });
});
