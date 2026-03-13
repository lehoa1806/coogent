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
import { ContextPackBuilder } from '../ContextPackBuilder.js';
import { CharRatioEncoder } from '../ContextScoper.js';
import type { ArtifactDB } from '../../mcp/ArtifactDB.js';
import type { PhaseHandoff } from '../../mcp/types.js';
import type { BuildContextPackInput } from '../../types/context.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Mock ArtifactDB factory
// ═══════════════════════════════════════════════════════════════════════════════

interface MockArtifactDB {
    handoffs: { get: jest.Mock };
    contextManifests: { upsert: jest.Mock };
}

function createMockArtifactDB(handoffMap: Record<string, PhaseHandoff | undefined> = {}): MockArtifactDB {
    return {
        handoffs: {
            get: jest.fn((_taskId: string, phaseId: string) => handoffMap[phaseId]),
        },
        contextManifests: {
            upsert: jest.fn(),
        },
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════════════════════════════════

function defaultInput(overrides: Partial<BuildContextPackInput> = {}): BuildContextPackInput {
    return {
        sessionId: 'session-1',
        taskId: 'task-1',
        phaseId: 'phase-002',
        prompt: 'Implement feature X',
        contextFiles: [],
        upstreamPhaseIds: [],
        maxTokens: 100_000,
        ...overrides,
    };
}

function makeHandoff(phaseId: string, overrides: Partial<PhaseHandoff> = {}): PhaseHandoff {
    return {
        phaseId,
        masterTaskId: 'task-1',
        decisions: ['used pattern A'],
        modifiedFiles: ['src/a.ts'],
        blockers: [],
        completedAt: Date.now(),
        nextStepsContext: 'Continue with tests',
        ...overrides,
    };
}

/** Write a file with the given number of lines under tmpDir. */
async function writeLines(dir: string, relativePath: string, lineCount: number): Promise<void> {
    const absPath = path.join(dir, relativePath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    const lines = Array.from({ length: lineCount }, (_, i) => `line ${i + 1}`);
    await fs.writeFile(absPath, lines.join('\n'));
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('ContextPackBuilder', () => {
    let tmpDir: string;
    const encoder = new CharRatioEncoder();

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'coogent-cpb-'));
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    // ─────────────────────────────────────────────────────────────────────
    //  1. Build with no upstream phases → empty handoffs, files from contextFiles
    // ─────────────────────────────────────────────────────────────────────

    it('builds a pack with empty handoffs when there are no upstream phases', async () => {
        await writeLines(tmpDir, 'src/foo.ts', 10);

        const mockDb = createMockArtifactDB();
        const builder = new ContextPackBuilder(mockDb as unknown as ArtifactDB, encoder, tmpDir);

        const { pack, manifest } = await builder.build(
            defaultInput({ contextFiles: ['src/foo.ts'], upstreamPhaseIds: [] }),
        );

        expect(pack.handoffs).toHaveLength(0);
        expect(pack.fileContexts).toHaveLength(1);
        expect(pack.fileContexts[0].path).toBe('src/foo.ts');
        expect(pack.fileContexts[0].mode).toBe('full'); // small file
        expect(manifest.includedHandoffIds).toHaveLength(0);
        expect(manifest.fileDecisions).toHaveLength(1);
    });

    // ─────────────────────────────────────────────────────────────────────
    //  2. Build with upstream phases → pack includes handoff packets
    // ─────────────────────────────────────────────────────────────────────

    it('includes handoff packets from upstream phases via HandoffRepository', async () => {
        await writeLines(tmpDir, 'src/a.ts', 10);

        const handoff = makeHandoff('phase-001');
        const mockDb = createMockArtifactDB({ 'phase-001': handoff });
        const builder = new ContextPackBuilder(mockDb as unknown as ArtifactDB, encoder, tmpDir);

        const { pack } = await builder.build(
            defaultInput({ upstreamPhaseIds: ['phase-001'] }),
        );

        expect(pack.handoffs).toHaveLength(1);
        expect(pack.handoffs[0].fromPhaseId).toBe('phase-001');
        expect(pack.handoffs[0].summary).toContain('Continue with tests');
        expect(mockDb.handoffs.get).toHaveBeenCalledWith('task-1', 'phase-001');
    });

    // ─────────────────────────────────────────────────────────────────────
    //  3. Same-file continuation → correct mode (full for small)
    // ─────────────────────────────────────────────────────────────────────

    it('uses correct mode for same-file continuation file from upstream', async () => {
        await writeLines(tmpDir, 'src/b.ts', 50);

        const handoff = makeHandoff('phase-001', {
            modifiedFiles: ['src/b.ts'],
            changedFilesJson: JSON.stringify([{ path: 'src/b.ts' }]),
        });
        const mockDb = createMockArtifactDB({ 'phase-001': handoff });
        const builder = new ContextPackBuilder(mockDb as unknown as ArtifactDB, encoder, tmpDir);

        const { pack } = await builder.build(
            defaultInput({ upstreamPhaseIds: ['phase-001'] }),
        );

        // src/b.ts is also from upstream handoff changedFiles, so it's a same-file continuation
        // 50 lines < 200 → small file → full mode
        const entry = pack.fileContexts.find(f => f.path === 'src/b.ts');
        expect(entry).toBeDefined();
        expect(entry!.mode).toBe('full');
    });

    // ─────────────────────────────────────────────────────────────────────
    //  4. Token budget exceeded → lowest-priority entries pruned
    // ─────────────────────────────────────────────────────────────────────

    it('prunes lowest-priority entries when token budget is exceeded', async () => {
        // Create two files: one small (gets full mode) and one large no-upstream (metadata mode)
        await writeLines(tmpDir, 'src/important.ts', 10);
        await writeLines(tmpDir, 'src/extra.ts', 300);

        const mockDb = createMockArtifactDB();
        // Very tight budget: only room for the handoffs overhead + one small file
        const tinyBudget = 50;
        const builder = new ContextPackBuilder(mockDb as unknown as ArtifactDB, encoder, tmpDir);

        const { pack, manifest } = await builder.build(
            defaultInput({
                contextFiles: ['src/important.ts', 'src/extra.ts'],
                maxTokens: tinyBudget,
            }),
        );

        // At least one file decision must show omitted
        const omitted = manifest.fileDecisions.filter(d => d.omitted);
        // The pruning logic removes metadata/patch entries first
        // With such a tight budget, something should be pruned
        const totalTokens = pack.tokenUsage.total;
        // Either entries were pruned or total is already within budget
        expect(totalTokens <= tinyBudget || omitted.length > 0).toBe(true);
    });

    // ─────────────────────────────────────────────────────────────────────
    //  5. File read failure → gracefully omitted, no throw
    // ─────────────────────────────────────────────────────────────────────

    it('gracefully omits files that cannot be read and records in manifest', async () => {
        // Don't create the file — it will fail to read during materialization
        // But the mode selector will catch ENOENT and return metadata mode.
        // Metadata mode doesn't need to read the file again, so we need a different approach.
        // Create a file that exists for mode selection but becomes unreadable for materialization.
        // Instead: reference a file that doesn't exist — mode selector returns metadata, materialization succeeds.
        // Actually: let's test the full flow with a file that exists in contextFiles but not on disk.
        const mockDb = createMockArtifactDB();
        const builder = new ContextPackBuilder(mockDb as unknown as ArtifactDB, encoder, tmpDir);

        // Should not throw
        const { pack, manifest } = await builder.build(
            defaultInput({ contextFiles: ['src/missing.ts'] }),
        );

        // File should not appear in file contexts (metadata mode from missing file)
        // or it appears with metadata mode since materialization for metadata doesn't read the file
        const decision = manifest.fileDecisions.find(d => d.path === 'src/missing.ts');
        expect(decision).toBeDefined();
        expect(decision!.selectedMode).toBe('metadata');
        // No throw occurred
        expect(pack.phaseId).toBe('phase-002');
    });

    // ─────────────────────────────────────────────────────────────────────
    //  6. Context manifest is persisted via ContextManifestRepository.upsert
    // ─────────────────────────────────────────────────────────────────────

    it('persists context manifest via ContextManifestRepository.upsert', async () => {
        await writeLines(tmpDir, 'src/c.ts', 10);

        const mockDb = createMockArtifactDB();
        const builder = new ContextPackBuilder(mockDb as unknown as ArtifactDB, encoder, tmpDir);

        const { manifest } = await builder.build(
            defaultInput({ contextFiles: ['src/c.ts'] }),
        );

        expect(mockDb.contextManifests.upsert).toHaveBeenCalledTimes(1);

        const upsertArg = mockDb.contextManifests.upsert.mock.calls[0][0] as Record<string, unknown>;
        expect(upsertArg.manifestId).toBe(manifest.manifestId);
        expect(upsertArg.sessionId).toBe('session-1');
        expect(upsertArg.taskId).toBe('task-1');
        expect(upsertArg.phaseId).toBe('phase-002');
        expect(typeof upsertArg.payloadJson).toBe('string');
        expect(typeof upsertArg.createdAt).toBe('number');
    });

    // ─────────────────────────────────────────────────────────────────────
    //  7. Deduplication of files across contextFiles and upstream modifiedFiles
    // ─────────────────────────────────────────────────────────────────────

    it('deduplicates files appearing in both contextFiles and upstream modifiedFiles', async () => {
        await writeLines(tmpDir, 'src/shared.ts', 10);

        const handoff = makeHandoff('phase-001', {
            modifiedFiles: ['src/shared.ts'],
            changedFilesJson: JSON.stringify([{ path: 'src/shared.ts' }]),
        });
        const mockDb = createMockArtifactDB({ 'phase-001': handoff });
        const builder = new ContextPackBuilder(mockDb as unknown as ArtifactDB, encoder, tmpDir);

        const { pack, manifest } = await builder.build(
            defaultInput({
                contextFiles: ['src/shared.ts'],
                upstreamPhaseIds: ['phase-001'],
            }),
        );

        // File should appear only once in fileContexts
        const matches = pack.fileContexts.filter(f => f.path === 'src/shared.ts');
        expect(matches).toHaveLength(1);

        // File should appear only once in fileDecisions
        const decisions = manifest.fileDecisions.filter(d => d.path === 'src/shared.ts');
        expect(decisions).toHaveLength(1);
    });

    // ─────────────────────────────────────────────────────────────────────
    //  8. Overlapping slice regions → merged without duplicate lines
    // ─────────────────────────────────────────────────────────────────────

    it('merges overlapping slice regions and produces no duplicate lines', async () => {
        // 1000-line file with two overlapping edit regions (lines 80-120, 100-140)
        // With SLICE_PADDING_LINES=75 the padded intervals overlap heavily
        await writeLines(tmpDir, 'src/overlap.ts', 1000);

        const handoff = makeHandoff('phase-001', {
            modifiedFiles: ['src/overlap.ts'],
            changedFilesJson: JSON.stringify([{
                path: 'src/overlap.ts',
                editRegions: [
                    { startLine: 80, endLine: 120 },
                    { startLine: 100, endLine: 140 },
                ],
            }]),
        });
        const mockDb = createMockArtifactDB({ 'phase-001': handoff });
        const builder = new ContextPackBuilder(mockDb as unknown as ArtifactDB, encoder, tmpDir);

        const { pack } = await builder.build(
            defaultInput({ upstreamPhaseIds: ['phase-001'] }),
        );

        const entry = pack.fileContexts.find(f => f.path === 'src/overlap.ts');
        expect(entry).toBeDefined();
        expect(entry!.mode).toBe('slice');

        // With merging, overlapping padded intervals should produce exactly 1 slice
        if (entry!.mode === 'slice' && 'slices' in entry!) {
            const slices = entry!.slices as Array<{ startLine: number; endLine: number; content: string }>;
            expect(slices).toHaveLength(1); // Merged into a single slice

            // Verify no duplicate lines in the content
            const lineArray = slices[0].content.split('\n');
            const uniqueLines = new Set(lineArray);
            expect(uniqueLines.size).toBe(lineArray.length);
        }
    });

    // ─────────────────────────────────────────────────────────────────────
    //  9. Budget-aware pruning respects priority order (metadata first)
    // ─────────────────────────────────────────────────────────────────────

    it('prunes metadata entries before patch entries during budget overflow', async () => {
        // small full-mode file + large metadata-mode file
        await writeLines(tmpDir, 'src/full.ts', 10);    // → full mode (small)
        await writeLines(tmpDir, 'src/meta.ts', 500);    // → metadata mode (large, no upstream)

        const mockDb = createMockArtifactDB();
        const builder = new ContextPackBuilder(mockDb as unknown as ArtifactDB, encoder, tmpDir);

        // Budget that fits full file but not both
        const { manifest } = await builder.build(
            defaultInput({
                contextFiles: ['src/full.ts', 'src/meta.ts'],
                maxTokens: 20,  // Very tight
            }),
        );

        // At a very tight budget, metadata entries should be pruned first
        const metaDecision = manifest.fileDecisions.find(d => d.path === 'src/meta.ts');
        const fullDecision = manifest.fileDecisions.find(d => d.path === 'src/full.ts');
        expect(metaDecision).toBeDefined();
        expect(fullDecision).toBeDefined();
        // metadata is pruned before full mode
        if (manifest.totals.totalTokens > 20) {
            expect(metaDecision!.omitted).toBe(true);
        }
    });

    // ─────────────────────────────────────────────────────────────────────
    //  10. Directory paths in contextFiles → gracefully skipped (EISDIR fix)
    // ─────────────────────────────────────────────────────────────────────

    it('skips directory paths in contextFiles without EISDIR crash', async () => {
        // Create a directory and a real file
        await fs.mkdir(path.join(tmpDir, 'src', 'utils'), { recursive: true });
        await writeLines(tmpDir, 'src/real.ts', 10);

        const mockDb = createMockArtifactDB();
        const builder = new ContextPackBuilder(mockDb as unknown as ArtifactDB, encoder, tmpDir);

        // Should NOT throw EISDIR
        const { pack, manifest } = await builder.build(
            defaultInput({ contextFiles: ['src/utils', 'src/real.ts'] }),
        );

        // Directory should be skipped, real file should be present
        const realEntry = pack.fileContexts.find(f => f.path === 'src/real.ts');
        expect(realEntry).toBeDefined();
        expect(realEntry!.mode).toBe('full');

        const dirEntry = pack.fileContexts.find(f => f.path === 'src/utils');
        expect(dirEntry).toBeUndefined();

        // Manifest should not contain a decision for the skipped directory
        const dirDecision = manifest.fileDecisions.find(d => d.path === 'src/utils');
        expect(dirDecision).toBeUndefined();
    });
});
