jest.mock('vscode', () => ({
    workspace: {
        workspaceFolders: [],
        getConfiguration: () => ({
            get: () => false,
        }),
    },
}), { virtual: true });

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ImportScanner } from '../ImportScanner.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('ImportScanner', () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'coogent-imp-'));
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    // ─────────────────────────────────────────────────────────────────────
    //  Helper
    // ─────────────────────────────────────────────────────────────────────

    async function writeFile(relPath: string, content: string): Promise<void> {
        const absPath = path.join(tmpDir, relPath);
        await fs.mkdir(path.dirname(absPath), { recursive: true });
        await fs.writeFile(absPath, content);
    }

    // ─────────────────────────────────────────────────────────────────────
    //  1. Discovers relative imports from a file
    // ─────────────────────────────────────────────────────────────────────

    it('discovers relative .ts imports and returns workspace-relative paths', async () => {
        await writeFile('src/main.ts', `
            import { foo } from './utils.js';
            import { bar } from './helpers/strings.js';
        `);
        await writeFile('src/utils.ts', 'export const foo = 1;');
        await writeFile('src/helpers/strings.ts', 'export const bar = "b";');

        const scanner = new ImportScanner(tmpDir);
        const deps = await scanner.scan(['src/main.ts']);

        // Should resolve ./utils.js → src/utils.ts and ./helpers/strings.js → src/helpers/strings.ts
        expect(deps).toContain('src/utils.ts');
        expect(deps).toContain('src/helpers/strings.ts');
    });

    // ─────────────────────────────────────────────────────────────────────
    //  2. Filters out bare specifiers (node_modules)
    // ─────────────────────────────────────────────────────────────────────

    it('filters out non-relative imports (bare specifiers)', async () => {
        await writeFile('src/app.ts', `
            import * as path from 'node:path';
            import express from 'express';
            import { local } from './local.js';
        `);
        await writeFile('src/local.ts', 'export const local = 1;');

        const scanner = new ImportScanner(tmpDir);
        const deps = await scanner.scan(['src/app.ts']);

        // Only relative imports should be discovered
        expect(deps).toContain('src/local.ts');
        expect(deps).not.toContain(expect.stringContaining('express'));
        expect(deps).not.toContain(expect.stringContaining('node:path'));
    });

    // ─────────────────────────────────────────────────────────────────────
    //  3. Excludes files already in the source set
    // ─────────────────────────────────────────────────────────────────────

    it('excludes files already in the source set', async () => {
        await writeFile('src/a.ts', "import { b } from './b.js';");
        await writeFile('src/b.ts', 'export const b = 1;');

        const scanner = new ImportScanner(tmpDir);
        const deps = await scanner.scan(['src/a.ts', 'src/b.ts']);

        // b.ts is already in the source set — should not appear as dependency
        expect(deps).not.toContain('src/b.ts');
    });

    // ─────────────────────────────────────────────────────────────────────
    //  4. Handles unreadable files gracefully
    // ─────────────────────────────────────────────────────────────────────

    it('skips unreadable files without throwing', async () => {
        const scanner = new ImportScanner(tmpDir);
        const deps = await scanner.scan(['src/nonexistent.ts']);

        expect(deps).toEqual([]);
    });

    // ─────────────────────────────────────────────────────────────────────
    //  5. Returns deduplicated results
    // ─────────────────────────────────────────────────────────────────────

    it('returns deduplicated import paths when multiple files import the same dep', async () => {
        await writeFile('src/a.ts', "import { shared } from './shared.js';");
        await writeFile('src/b.ts', "import { shared } from './shared.js';");
        await writeFile('src/shared.ts', 'export const shared = 1;');

        const scanner = new ImportScanner(tmpDir);
        const deps = await scanner.scan(['src/a.ts', 'src/b.ts']);

        const sharedCount = deps.filter(d => d === 'src/shared.ts').length;
        expect(sharedCount).toBe(1);
    });
});
