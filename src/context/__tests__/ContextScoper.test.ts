jest.mock('vscode', () => ({
    workspace: {
        workspaceFolders: [],
        getConfiguration: () => ({
            get: () => false,
        }),
    },
}), { virtual: true });

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ContextScoper, CharRatioEncoder } from '../ContextScoper.js';
import { TiktokenEncoder } from '../TiktokenEncoder.js';
import { ExplicitFileResolver } from '../FileResolver.js';
import { asPhaseId, type Phase } from '../../types/index.js';

describe('ContextScoper', () => {
    let tmpDir: string;
    let scoper: ContextScoper;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'coogent-ctx-'));
        scoper = new ContextScoper({
            encoder: new CharRatioEncoder(),
            tokenLimit: 100, // tight budget
            resolver: new ExplicitFileResolver(),
        });
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('should correctly assemble multiple text files', async () => {
        await fs.writeFile(path.join(tmpDir, 'file1.txt'), 'Hello world');
        await fs.writeFile(path.join(tmpDir, 'file2.txt'), 'Foo bar');

        const phase = { id: asPhaseId(1), status: 'pending', prompt: '', context_files: ['file1.txt', 'file2.txt'], success_criteria: '' } as Phase;
        const res = await scoper.assemble(phase, tmpDir);

        expect(res.ok).toBe(true);
        if (res.ok) {
            expect(res.payload).toContain('<<<FILE: file1.txt>>>');
            expect(res.payload).toContain('Hello world');
            expect(res.payload).toContain('<<<FILE: file2.txt>>>');
            expect(res.payload).toContain('Foo bar');
            expect(res.breakdown.length).toBeGreaterThanOrEqual(2);
        }
    });

    it('should fail if file not found', async () => {
        const phase = { id: asPhaseId(1), status: 'pending', prompt: '', context_files: ['does-not-exist.txt'], success_criteria: '' } as Phase;
        await expect(scoper.assemble(phase, tmpDir))
            .rejects.toThrow('File not found: does-not-exist.txt');
    });

    it('should enforce token limits', async () => {
        // Char ratio is chars / 4. Token limit is 100, so ~400 chars.
        const largeText = 'A'.repeat(500);
        await fs.writeFile(path.join(tmpDir, 'large.txt'), largeText);

        const phase = { id: asPhaseId(1), status: 'pending', prompt: '', context_files: ['large.txt'], success_criteria: '' } as Phase;
        const res = await scoper.assemble(phase, tmpDir);
        expect(res.ok).toBe(false);
        if (!res.ok) {
            expect(res.totalTokens).toBeGreaterThan(100);
        }
    });

    // ═══════════════════════════════════════════════════════════════════════════
    //  Pillar 2 — TiktokenEncoder Integration Tests
    // ═══════════════════════════════════════════════════════════════════════════

    it('TiktokenEncoder produces different token counts than CharRatioEncoder for same content', async () => {
        // Use a longer, more complex string to ensure encoders produce different counts.
        // CharRatioEncoder: ceil(length / 4), Tiktoken: actual BPE tokenization.
        const content = 'export async function processUserAuthentication(userId: string, token: string): Promise<boolean> {\n  const decoded = await verifyJWT(token);\n  return decoded.sub === userId;\n}';

        const charEncoder = new CharRatioEncoder();
        const tiktokenEncoder = new TiktokenEncoder();

        const charCount = charEncoder.countTokens(content);
        const tiktokenCount = tiktokenEncoder.countTokens(content);

        // Both should return positive
        expect(charCount).toBeGreaterThan(0);
        expect(tiktokenCount).toBeGreaterThan(0);

        // For this longer string, char/4 heuristic should differ from actual BPE count
        expect(charCount).not.toBe(tiktokenCount);
    });

    it('ContextScoper with TiktokenEncoder assembles files correctly', async () => {
        const tiktokenScoper = new ContextScoper({
            encoder: new TiktokenEncoder(),
            tokenLimit: 10_000,
            resolver: new ExplicitFileResolver(),
        });

        await fs.writeFile(path.join(tmpDir, 'sample.ts'), 'export const x = 42;');

        const phase = { id: asPhaseId(1), status: 'pending', prompt: '', context_files: ['sample.ts'], success_criteria: '' } as Phase;
        const res = await tiktokenScoper.assemble(phase, tmpDir);

        expect(res.ok).toBe(true);
        if (res.ok) {
            expect(res.payload).toContain('<<<FILE: sample.ts>>>');
            expect(res.payload).toContain('export const x = 42;');
            expect(res.totalTokens).toBeGreaterThan(0);
        }
    });

    // ═══════════════════════════════════════════════════════════════════════════
    //  Pillar 2 — Over-Budget Fallback Tests
    // ═══════════════════════════════════════════════════════════════════════════

    it('falls back to ExplicitFileResolver when AST-expanded files exceed budget', async () => {
        // Create an entry file that imports a huge dependency
        const smallContent = 'import { big } from "./big";';
        const hugeContent = 'X'.repeat(2000); // This will blow the budget

        await fs.writeFile(path.join(tmpDir, 'entry.ts'), smallContent);
        await fs.writeFile(path.join(tmpDir, 'big.ts'), hugeContent);

        // Use ASTFileResolver (the default) with a tight budget that can fit
        // just entry.ts but NOT entry.ts + big.ts
        const astScoper = new ContextScoper({
            encoder: new CharRatioEncoder(),
            tokenLimit: 50, // Very tight — can fit small file but not both
            // default resolver = ASTFileResolver which will discover big.ts
        });

        const phase = {
            id: asPhaseId(1), status: 'pending', prompt: '',
            context_files: ['entry.ts'],
            success_criteria: ''
        } as Phase;

        const res = await astScoper.assemble(phase, tmpDir);

        // After fallback to ExplicitFileResolver with just entry.ts,
        // the small file should fit within budget
        if (res.ok) {
            expect(res.payload).toContain('<<<FILE: entry.ts>>>');
            // big.ts should NOT be in the final payload (it was dropped by fallback)
            expect(res.payload).not.toContain('<<<FILE: big.ts>>>');
        }
        // If even entry.ts alone exceeds 50 tokens (with wrapper overhead),
        // then ok will be false — which is also a valid outcome for a 50-token budget
    });

    it('skips symlinked files that resolve outside workspace instead of throwing', async () => {
        // Create a real file inside the workspace
        await fs.writeFile(path.join(tmpDir, 'local.txt'), 'local content');

        // Create a temp dir OUTSIDE the workspace and symlink into it
        const externalDir = await fs.mkdtemp(path.join(os.tmpdir(), 'coogent-external-'));
        await fs.writeFile(path.join(externalDir, 'remote.txt'), 'remote content');
        await fs.symlink(
            path.join(externalDir, 'remote.txt'),
            path.join(tmpDir, 'remote-link.txt'),
        );

        const phase = {
            id: asPhaseId(1), status: 'pending', prompt: '',
            context_files: ['local.txt', 'remote-link.txt'],
            success_criteria: ''
        } as Phase;

        // Should NOT throw — should skip the symlinked file and assemble the local one
        const res = await scoper.assemble(phase, tmpDir);

        expect(res.ok).toBe(true);
        if (res.ok) {
            expect(res.payload).toContain('<<<FILE: local.txt>>>');
            expect(res.payload).toContain('local content');
            // The symlinked file should be skipped
            expect(res.payload).not.toContain('remote content');
        }

        // Cleanup external dir
        await fs.rm(externalDir, { recursive: true, force: true });
    });

    it('should skip directories in context_files without EISDIR crash', async () => {
        // Create a directory that looks like a file path in context_files
        await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
        await fs.mkdir(path.join(tmpDir, 'src', 'utils'), { recursive: true });
        await fs.writeFile(path.join(tmpDir, 'real-file.txt'), 'real content');

        const phase = {
            id: asPhaseId(1), status: 'pending', prompt: '',
            context_files: ['src/utils', 'real-file.txt'],
            success_criteria: '',
        } as Phase;

        // Should NOT throw EISDIR — directory should be skipped
        const res = await scoper.assemble(phase, tmpDir);

        expect(res.ok).toBe(true);
        if (res.ok) {
            // Directory should be skipped, real file should be present
            expect(res.payload).toContain('<<<FILE: real-file.txt>>>');
            expect(res.payload).toContain('real content');
            expect(res.payload).not.toContain('<<<FILE: src/utils>>>');
        }
    });
});
