import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ADKController } from '../ADKController.js';
import { MockADKAdapter } from './mocks/MockADKAdapter.js';
import type { Phase } from '../../types/index.js';
import { asPhaseId } from '../../types/index.js';

describe('ADKController (with MockADKAdapter)', () => {
    let controller: ADKController;
    let adapter: MockADKAdapter;
    let tmpDir: string;
    const testPhase: Phase = {
        id: asPhaseId(42),
        prompt: 'Mock phase',
        context_files: [],
        status: 'pending',
        success_criteria: 'exit_code:0'
    };

    beforeEach(async () => {
        jest.useFakeTimers();
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'coogent-adk-'));
        adapter = new MockADKAdapter(500); // 500ms mock delay (fake, won't actually wait)
        controller = new ADKController(adapter, tmpDir);
    });

    afterEach(async () => {
        jest.useRealTimers();
        await controller.terminateWorker(testPhase.id, 'TEST_CLEANUP');
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('should spawn a worker and emit lifecycle events', async () => {
        const outputSpy = jest.fn();
        const exitedSpy = jest.fn();

        controller.on('worker:output', outputSpy);
        controller.on('worker:exited', exitedSpy);

        await controller.spawnWorker(testPhase, 5000);

        // Should return almost immediately with the mock
        expect(controller.getActiveWorker(42)?.phaseId).toBe(42);

        // Advance fake timers to trigger the mock's setTimeout
        await jest.advanceTimersByTimeAsync(600);

        expect(outputSpy).toHaveBeenCalledWith(42, 'stdout', expect.any(String));
        expect(exitedSpy).toHaveBeenCalledWith(42, 0);

        expect(controller.getActiveWorker(42)).toBeUndefined();
    });

    it('should timeout a worker if it runs too long', async () => {
        const timeoutSpy = jest.fn();
        controller.on('worker:timeout', timeoutSpy);

        // 100ms timeout, the mock takes ~500ms to exit normally
        await controller.spawnWorker(testPhase, 100);

        await jest.advanceTimersByTimeAsync(200);

        expect(timeoutSpy).toHaveBeenCalledWith(42);
        expect(controller.getActiveWorker(42)).toBeUndefined();
    });

    it('should terminate duplicate worker when spawning same phase again', async () => {
        const terminateSpy = jest.spyOn(adapter, 'terminateSession');

        await controller.spawnWorker(testPhase, 5000);
        expect(controller.getActiveWorker(42)?.phaseId).toBe(42);

        // Spawn same phase again — should terminate the existing one first
        await controller.spawnWorker(testPhase, 5000);

        expect(terminateSpy).toHaveBeenCalled();
        expect(controller.getActiveWorker(42)?.phaseId).toBe(42);
    });

    /**
     * P1-1 Verification: When a timeout fires and triggers terminateWorker(),
     * the mock's onExit callback may also fire. We must ensure only ONE event
     * type is emitted to the engine — not both 'worker:timeout' AND 'worker:exited'.
     */
    it('should not double-fire timeout + exited events (P1-1)', async () => {
        const timeoutSpy = jest.fn();
        const exitedSpy = jest.fn();
        controller.on('worker:timeout', timeoutSpy);
        controller.on('worker:exited', exitedSpy);

        // 100ms timeout, mock takes ~500ms to exit
        await controller.spawnWorker(testPhase, 100);

        // Advance enough for both timeout AND mock exit to fire
        await jest.advanceTimersByTimeAsync(700);

        // Timeout should fire, but exited should NOT fire since the
        // worker was already cleaned up by terminateWorker()
        expect(timeoutSpy).toHaveBeenCalledTimes(1);
        expect(exitedSpy).toHaveBeenCalledTimes(0);
    });

    it('should cleanup orphaned PID files (#64)', async () => {
        // Create fake PID files pointing to non-existent processes
        const pidDir = path.join(tmpDir, '.coogent', 'pid');
        await fs.mkdir(pidDir, { recursive: true });
        await fs.writeFile(path.join(pidDir, 'phase-99.pid'), '99999999');

        await controller.cleanupOrphanedWorkers();

        const remaining = await fs.readdir(pidDir);
        expect(remaining).toHaveLength(0);
    });

    it('should return null when concurrency cap (4) is reached (#65)', async () => {
        const phases = [0, 1, 2, 3].map(id => ({
            ...testPhase,
            id: asPhaseId(id),
        }));

        for (const phase of phases) {
            const worker = await controller.spawnWorker(phase, 10000);
            expect(worker).not.toBeNull();
        }

        // 5th worker should return null
        const fifth = await controller.spawnWorker({ ...testPhase, id: asPhaseId(99) }, 10000);
        expect(fifth).toBeNull();

        // Clean up all workers
        await controller.terminateAll('TEST_CLEANUP');
    });

    it('should terminateAll active workers (#65)', async () => {
        const terminateSpy = jest.spyOn(adapter, 'terminateSession');

        await controller.spawnWorker({ ...testPhase, id: asPhaseId(1) }, 10000);
        await controller.spawnWorker({ ...testPhase, id: asPhaseId(2) }, 10000);

        expect(controller.getActiveWorker(1)).toBeDefined();
        expect(controller.getActiveWorker(2)).toBeDefined();

        await controller.terminateAll('TEST');

        expect(controller.getActiveWorker(1)).toBeUndefined();
        expect(controller.getActiveWorker(2)).toBeUndefined();
        expect(terminateSpy).toHaveBeenCalledTimes(2);
    });

    // ═══════════════════════════════════════════════════════════════════════
    //  Process Isolation & Zombie Prevention Tests
    // ═══════════════════════════════════════════════════════════════════════

    it('should track worker PIDs in activePids set', async () => {
        // Initially empty
        expect(controller.getActivePids().size).toBe(0);

        const worker = await controller.spawnWorker(testPhase, 5000);
        expect(worker).not.toBeNull();

        // PID should be tracked
        const pids = controller.getActivePids();
        expect(pids.size).toBe(1);
        expect(pids.has(worker!.handle.pid)).toBe(true);

        // After natural exit, PID should be removed
        await jest.advanceTimersByTimeAsync(600);
        expect(controller.getActivePids().size).toBe(0);
    });

    it('should remove PIDs from activePids on terminateWorker', async () => {
        await controller.spawnWorker(testPhase, 5000);
        expect(controller.getActivePids().size).toBe(1);

        await controller.terminateWorker(testPhase.id, 'TEST');
        expect(controller.getActivePids().size).toBe(0);
    });

    it('should track multiple PIDs for parallel workers', async () => {
        await controller.spawnWorker({ ...testPhase, id: asPhaseId(1) }, 10000);
        await controller.spawnWorker({ ...testPhase, id: asPhaseId(2) }, 10000);
        await controller.spawnWorker({ ...testPhase, id: asPhaseId(3) }, 10000);

        expect(controller.getActivePids().size).toBe(3);

        await controller.terminateAll('TEST');
        expect(controller.getActivePids().size).toBe(0);
    });

    it('should killAllWorkers and clear all PIDs', async () => {
        await controller.spawnWorker({ ...testPhase, id: asPhaseId(1) }, 10000);
        await controller.spawnWorker({ ...testPhase, id: asPhaseId(2) }, 10000);

        expect(controller.getActivePids().size).toBe(2);

        // killAllWorkers sends SIGTERM, waits (5s grace), then SIGKILL
        // Advance fake timers to skip the 5s grace period immediately
        const killPromise = controller.killAllWorkers();
        await jest.advanceTimersByTimeAsync(6000);
        await killPromise;

        expect(controller.getActivePids().size).toBe(0);
        expect(controller.getActiveWorker(1)).toBeUndefined();
        expect(controller.getActiveWorker(2)).toBeUndefined();
    });

    it('should dispose and be idempotent', async () => {
        await controller.spawnWorker({ ...testPhase, id: asPhaseId(1) }, 10000);
        expect(controller.getActivePids().size).toBe(1);

        const disposePromise = controller.dispose();
        await jest.advanceTimersByTimeAsync(6000);
        await disposePromise;

        expect(controller.getActivePids().size).toBe(0);

        // Second dispose should be a no-op (idempotent)
        await controller.dispose();
    });

    // ═══════════════════════════════════════════════════════════════════════
    //  B-1: Pull-Model Prompt Builder Tests
    // ═══════════════════════════════════════════════════════════════════════

    it('B-1: prompt lists MCP tool directives when phase.context_files is non-empty', async () => {
        // Capture the initialPrompt that the adapter receives
        let capturedPrompt = '';
        jest.spyOn(adapter, 'createSession').mockImplementationOnce(async (options) => {
            capturedPrompt = options.initialPrompt;
            return {
                sessionId: 'mock-b1',
                pid: 99001,
                onOutput: () => { },
                onExit: () => { },
            };
        });

        const phaseWithFiles = {
            ...testPhase,
            context_files: ['src/foo.ts', 'src/bar.ts'],
        };

        await controller.spawnWorker(phaseWithFiles, 5000);

        // Should contain MCP tool directives
        expect(capturedPrompt).toContain('get_modified_file_content');
        expect(capturedPrompt).toContain('src/foo.ts');
        expect(capturedPrompt).toContain('src/bar.ts');
    });

    it('B-1: prompt emits no context section when phase.context_files is empty', async () => {
        let capturedPrompt = '';
        jest.spyOn(adapter, 'createSession').mockImplementationOnce(async (options) => {
            capturedPrompt = options.initialPrompt;
            return {
                sessionId: 'mock-b1-empty',
                pid: 99002,
                onOutput: () => { },
                onExit: () => { },
            };
        });

        // testPhase has context_files: [] — should emit NO context section
        await controller.spawnWorker(testPhase, 5000);

        // No tool directive, no raw bytes
        expect(capturedPrompt).not.toContain('get_modified_file_content');
        expect(capturedPrompt).not.toContain('## Context Files');
        // Should still have the task prompt
        expect(capturedPrompt).toContain('Mock phase');
    });
});
