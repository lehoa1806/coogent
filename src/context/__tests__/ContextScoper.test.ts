import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ContextScoper, CharRatioEncoder } from '../ContextScoper.js';
import type { Phase } from '../../types/index.js';

describe('ContextScoper', () => {
    let tmpDir: string;
    let scoper: ContextScoper;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'coogent-ctx-'));
        scoper = new ContextScoper({
            encoder: new CharRatioEncoder(),
            tokenLimit: 100 // tight budget
        });
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('should correctly assemble multiple text files', async () => {
        await fs.writeFile(path.join(tmpDir, 'file1.txt'), 'Hello world');
        await fs.writeFile(path.join(tmpDir, 'file2.txt'), 'Foo bar');

        const phase = { id: 1, status: 'pending', prompt: '', context_files: ['file1.txt', 'file2.txt'], success_criteria: '' } as Phase;
        const res = await scoper.assemble(phase, tmpDir);

        expect(res.ok).toBe(true);
        if (res.ok) {
            expect(res.payload).toContain('<<<FILE: file1.txt>>>');
            expect(res.payload).toContain('Hello world');
            expect(res.payload).toContain('<<<FILE: file2.txt>>>');
            expect(res.payload).toContain('Foo bar');
            expect(res.breakdown.length).toBe(2);
        }
    });

    it('should fail if file not found', async () => {
        const phase = { id: 1, status: 'pending', prompt: '', context_files: ['does-not-exist.txt'], success_criteria: '' } as Phase;
        await expect(scoper.assemble(phase, tmpDir))
            .rejects.toThrow('File not found: does-not-exist.txt');
    });

    it('should enforce token limits', async () => {
        // Char ratio is chars / 4. Token limit is 100, so ~400 chars.
        const largeText = 'A'.repeat(500);
        await fs.writeFile(path.join(tmpDir, 'large.txt'), largeText);

        const phase = { id: 1, status: 'pending', prompt: '', context_files: ['large.txt'], success_criteria: '' } as Phase;
        const res = await scoper.assemble(phase, tmpDir);
        expect(res.ok).toBe(false);
        if (!res.ok) {
            expect(res.totalTokens).toBeGreaterThan(100);
        }
    });
});
