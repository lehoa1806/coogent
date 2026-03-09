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
import { FileContextModeSelector, type FileModeInput } from '../FileContextModeSelector.js';
import { CharRatioEncoder } from '../ContextScoper.js';

describe('FileContextModeSelector', () => {
    let tmpDir: string;
    let selector: FileContextModeSelector;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'coogent-fms-'));
        selector = new FileContextModeSelector(new CharRatioEncoder());
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    // ─────────────────────────────────────────────────────────────────────
    //  Helper: build a FileModeInput with sensible defaults
    // ─────────────────────────────────────────────────────────────────────

    function makeInput(overrides: Partial<FileModeInput> & { filePath: string }): FileModeInput {
        return {
            workspaceRoot: tmpDir,
            isSameFileContinuation: false,
            phaseNeedsFullSemantics: false,
            ...overrides,
        };
    }

    /** Write a file with the given number of lines. */
    async function writeLines(filename: string, lineCount: number): Promise<string> {
        const absPath = path.join(tmpDir, filename);
        const lines = Array.from({ length: lineCount }, (_, i) => `line ${i + 1}`);
        await fs.writeFile(absPath, lines.join('\n'));
        return absPath;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Test 1: Small file (<200 lines) → selects `full` mode
    // ═══════════════════════════════════════════════════════════════════════

    it('selects `full` mode for a small file (<200 lines)', async () => {
        const absPath = await writeLines('small.ts', 50);

        const decision = await selector.selectMode(makeInput({ filePath: absPath }));

        expect(decision.mode).toBe('full');
        expect(decision.reason).toContain('small file');
    });

    // ═══════════════════════════════════════════════════════════════════════
    //  Test 2: Large file (>=500 lines) with same-file continuation and
    //           edit regions → selects `slice` mode
    // ═══════════════════════════════════════════════════════════════════════

    it('selects `slice` mode for large same-file continuation with edit regions', async () => {
        const absPath = await writeLines('large.ts', 600);

        const decision = await selector.selectMode(
            makeInput({
                filePath: absPath,
                isSameFileContinuation: true,
                upstreamHandoff: {
                    path: 'large.ts',
                    editRegions: [{ startLine: 100, endLine: 150 }],
                },
            }),
        );

        expect(decision.mode).toBe('slice');
        expect(decision.reason).toContain('same-file continuation');
        expect(decision.reason).toContain('slicing');
    });

    // ═══════════════════════════════════════════════════════════════════════
    //  Test 3: File with upstream patch, NOT same-file continuation
    //           → selects `patch` mode
    // ═══════════════════════════════════════════════════════════════════════

    it('selects `patch` mode when upstream patch is available and NOT same-file continuation', async () => {
        const absPath = await writeLines('patched.ts', 300);

        const decision = await selector.selectMode(
            makeInput({
                filePath: absPath,
                isSameFileContinuation: false,
                upstreamHandoff: {
                    path: 'patched.ts',
                    patch: '--- a/patched.ts\n+++ b/patched.ts\n@@ -1 +1 @@\n-old\n+new',
                },
            }),
        );

        expect(decision.mode).toBe('patch');
        expect(decision.reason).toContain('upstream patch');
    });

    // ═══════════════════════════════════════════════════════════════════════
    //  Test 4: No upstream data, large file → selects `metadata` mode
    // ═══════════════════════════════════════════════════════════════════════

    it('selects `metadata` mode for a large file with no upstream data', async () => {
        const absPath = await writeLines('big-no-upstream.ts', 500);

        const decision = await selector.selectMode(
            makeInput({
                filePath: absPath,
                isSameFileContinuation: false,
            }),
        );

        expect(decision.mode).toBe('metadata');
        expect(decision.reason).toContain('default');
    });

    // ═══════════════════════════════════════════════════════════════════════
    //  Test 5: File not found → returns `metadata` with reason 'file not found'
    // ═══════════════════════════════════════════════════════════════════════

    it('returns `metadata` with reason "file not found" when file does not exist', async () => {
        const missingPath = path.join(tmpDir, 'does-not-exist.ts');

        const decision = await selector.selectMode(
            makeInput({ filePath: missingPath }),
        );

        expect(decision.mode).toBe('metadata');
        // The reason is 'file not found' when err.code === 'ENOENT' is detected,
        // or a 'file read error: ...' message otherwise (depends on runtime).
        expect(decision.reason).toMatch(/file not found|ENOENT/);
    });

    // ═══════════════════════════════════════════════════════════════════════
    //  Test 6: Same-file continuation, moderate file (<500 lines) → `full`
    // ═══════════════════════════════════════════════════════════════════════

    it('selects `full` mode for same-file continuation on moderate file (<500 lines)', async () => {
        const absPath = await writeLines('moderate.ts', 350);

        const decision = await selector.selectMode(
            makeInput({
                filePath: absPath,
                isSameFileContinuation: true,
                upstreamHandoff: { path: 'moderate.ts' },
            }),
        );

        expect(decision.mode).toBe('full');
        expect(decision.reason).toContain('same-file continuation');
        expect(decision.reason).toContain('within limit');
    });

    // ═══════════════════════════════════════════════════════════════════════
    //  Test 7: `phaseNeedsFullSemantics` flag → `full` regardless of size
    // ═══════════════════════════════════════════════════════════════════════

    it('selects `full` mode when phaseNeedsFullSemantics is true regardless of file size', async () => {
        const absPath = await writeLines('huge.ts', 2000);

        const decision = await selector.selectMode(
            makeInput({
                filePath: absPath,
                phaseNeedsFullSemantics: true,
            }),
        );

        expect(decision.mode).toBe('full');
        expect(decision.reason).toContain('full semantic');
    });

    // ═══════════════════════════════════════════════════════════════════════
    //  Test 8: Budget-aware downgrade — fullSemantics + huge file + edit regions → slice
    // ═══════════════════════════════════════════════════════════════════════

    it('downgrades phaseNeedsFullSemantics to slice when file exceeds 40% of budget with edit regions', async () => {
        // 2000-line file → ~2000 tokens with CharRatioEncoder (each "line N\n" is ~8-10 chars ÷ 4 ≈ 2-3 tokens/line)
        const absPath = await writeLines('huge-with-regions.ts', 2000);

        const decision = await selector.selectMode(
            makeInput({
                filePath: absPath,
                phaseNeedsFullSemantics: true,
                tokenBudget: 500,  // Very tight — file will exceed 40% (200 tokens)
                upstreamHandoff: {
                    path: 'huge-with-regions.ts',
                    editRegions: [{ startLine: 100, endLine: 150 }],
                },
            }),
        );

        expect(decision.mode).toBe('slice');
        expect(decision.reason).toContain('full semantics requested');
        expect(decision.reason).toContain('budget');
    });

    // ═══════════════════════════════════════════════════════════════════════
    //  Test 9: Budget-aware — fullSemantics + huge file + NO edit regions → still full
    // ═══════════════════════════════════════════════════════════════════════

    it('keeps full mode for phaseNeedsFullSemantics even when expensive if no edit regions', async () => {
        const absPath = await writeLines('huge-no-regions.ts', 2000);

        const decision = await selector.selectMode(
            makeInput({
                filePath: absPath,
                phaseNeedsFullSemantics: true,
                tokenBudget: 500,
                // No upstreamHandoff — no edit regions to slice around
            }),
        );

        // No edit regions → can't downgrade to slice, so respects the explicit spec request
        expect(decision.mode).toBe('full');
        expect(decision.reason).toContain('full semantic');
    });

    // ═══════════════════════════════════════════════════════════════════════
    //  Test 10: Same-file continuation budget downgrade → slice
    // ═══════════════════════════════════════════════════════════════════════

    it('downgrades same-file continuation to slice when file exceeds budget fraction', async () => {
        const absPath = await writeLines('expensive-cont.ts', 600);

        const decision = await selector.selectMode(
            makeInput({
                filePath: absPath,
                isSameFileContinuation: true,
                tokenBudget: 200,  // Very tight — 600 lines will exceed 40% (80 tokens)
                upstreamHandoff: {
                    path: 'expensive-cont.ts',
                    editRegions: [{ startLine: 10, endLine: 20 }],
                },
            }),
        );

        expect(decision.mode).toBe('slice');
        expect(decision.reason).toContain('budget');
    });
});
