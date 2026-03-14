// ─────────────────────────────────────────────────────────────────────────────
// src/adk/__tests__/FileStabilityWatcher.test.ts — Unit tests
// ─────────────────────────────────────────────────────────────────────────────
// Tests the file-stability detection logic: polling, fs.watch integration,
// timeout, cancellation, and the concurrency guard.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

// ── Mock vscode before import ────────────────────────────────────────────────
jest.mock('vscode', () => ({}), { virtual: true });

import { FileStabilityWatcher } from '../FileStabilityWatcher.js';

describe('FileStabilityWatcher', () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fsw-test-'));
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { });
    });

    it('detects a file that already exists before watching starts', async () => {
        const filePath = path.join(tmpDir, 'response.md');
        await fs.writeFile(filePath, 'Already here', 'utf-8');

        const watcher = new FileStabilityWatcher();
        const content = await watcher.waitForStableFile(filePath, {
            timeoutMs: 5_000,
            pollMs: 100,
            stabilityThresholdMs: 200,
        });

        expect(content).toBe('Already here');
    });

    it('detects a file that appears after watching starts', async () => {
        const filePath = path.join(tmpDir, 'response.md');

        const watcher = new FileStabilityWatcher();
        const promise = watcher.waitForStableFile(filePath, {
            timeoutMs: 10_000,
            pollMs: 100,
            stabilityThresholdMs: 200,
        });

        // Write the file after a short delay
        setTimeout(async () => {
            await fs.writeFile(filePath, 'Delayed content', 'utf-8');
        }, 150);

        const content = await promise;
        expect(content).toBe('Delayed content');
    });

    it('waits for file to stabilize (incremental writes)', async () => {
        const filePath = path.join(tmpDir, 'response.md');

        const watcher = new FileStabilityWatcher();
        const promise = watcher.waitForStableFile(filePath, {
            timeoutMs: 10_000,
            pollMs: 50,
            stabilityThresholdMs: 200,
        });

        // Write incrementally
        await fs.writeFile(filePath, 'Chunk 1\n', 'utf-8');
        await new Promise(r => setTimeout(r, 80));
        await fs.writeFile(filePath, 'Chunk 1\nChunk 2\n', 'utf-8');
        await new Promise(r => setTimeout(r, 80));
        await fs.writeFile(filePath, 'Chunk 1\nChunk 2\nChunk 3 — final\n', 'utf-8');

        const content = await promise;
        expect(content).toContain('Chunk 3 — final');
    });

    it('returns null on timeout when file never appears', async () => {
        const filePath = path.join(tmpDir, 'never-exists.md');

        const watcher = new FileStabilityWatcher();
        const content = await watcher.waitForStableFile(filePath, {
            timeoutMs: 300,
            pollMs: 50,
            stabilityThresholdMs: 100,
        });

        expect(content).toBeNull();
    });

    it('returns null on cancellation', async () => {
        const filePath = path.join(tmpDir, 'cancelled.md');

        let cancelFn: (() => void) | undefined;
        const mockToken = {
            isCancellationRequested: false,
            onCancellationRequested: (cb: () => void) => { cancelFn = cb; },
        };

        const watcher = new FileStabilityWatcher();
        const promise = watcher.waitForStableFile(filePath, {
            timeoutMs: 10_000,
            pollMs: 50,
            stabilityThresholdMs: 100,
            cancellationToken: mockToken as any,
        });

        // Cancel after a short delay
        setTimeout(() => {
            mockToken.isCancellationRequested = true;
            cancelFn?.();
        }, 100);

        const content = await promise;
        expect(content).toBeNull();
    });

    it('keeps waiting when file is empty, resolves when content arrives', async () => {
        const filePath = path.join(tmpDir, 'response.md');

        const watcher = new FileStabilityWatcher();
        const promise = watcher.waitForStableFile(filePath, {
            timeoutMs: 10_000,
            pollMs: 50,
            stabilityThresholdMs: 150,
        });

        // Write empty file first
        await fs.writeFile(filePath, '', 'utf-8');
        await new Promise(r => setTimeout(r, 300));

        // Now write actual content
        await fs.writeFile(filePath, 'Real content', 'utf-8');

        const content = await promise;
        expect(content).toBe('Real content');
    });

    it('does not resolve for whitespace-only files', async () => {
        const filePath = path.join(tmpDir, 'response.md');

        const watcher = new FileStabilityWatcher();
        const promise = watcher.waitForStableFile(filePath, {
            timeoutMs: 500,
            pollMs: 50,
            stabilityThresholdMs: 100,
        });

        // Write whitespace-only file
        await fs.writeFile(filePath, '   \n\n  \t  ', 'utf-8');

        const content = await promise;
        // Should timeout because trim() produces empty string
        expect(content).toBeNull();
    });

    it('concurrent rapid events do not prevent stability detection', async () => {
        const filePath = path.join(tmpDir, 'response.md');

        const watcher = new FileStabilityWatcher();
        const promise = watcher.waitForStableFile(filePath, {
            timeoutMs: 10_000,
            pollMs: 50,
            stabilityThresholdMs: 200,
        });

        // Write the file once — the concurrency guard should prevent
        // rapid poll/watch interleaving from resetting the stability window
        await fs.writeFile(filePath, 'Stable content', 'utf-8');

        const content = await promise;
        expect(content).toBe('Stable content');
    }, 10_000);
});
