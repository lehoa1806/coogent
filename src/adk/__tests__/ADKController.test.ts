import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ADKController, MockADKAdapter } from '../ADKController.js';
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
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'coogent-adk-'));
        adapter = new MockADKAdapter(500); // 500ms delay to make timeout testing reliable
        controller = new ADKController(adapter, tmpDir);
    });

    afterEach(async () => {
        await controller.terminateWorker(testPhase.id, 'TEST_CLEANUP');
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('should spawn a worker and emit lifecycle events', async () => {
        const outputSpy = jest.fn();
        const exitedSpy = jest.fn();

        controller.on('worker:output', outputSpy);
        controller.on('worker:exited', exitedSpy);

        await controller.spawnWorker(testPhase, 'FAKECONTEXT', 5000);

        // Should return almost immediately with the mock
        expect(controller.getActiveWorker(42)?.phaseId).toBe(42);

        // Advance timers to trigger the mock's setTimeout
        await new Promise(res => setTimeout(res, 600));

        expect(outputSpy).toHaveBeenCalledWith(42, 'stdout', expect.any(String));
        expect(exitedSpy).toHaveBeenCalledWith(42, 0);

        expect(controller.getActiveWorker(42)).toBeUndefined();
    });

    it('should timeout a worker if it runs too long', async () => {
        const timeoutSpy = jest.fn();
        controller.on('worker:timeout', timeoutSpy);

        // 100ms timeout, the mock takes ~500ms to exit normally
        await controller.spawnWorker(testPhase, 'FAKECONTEXT', 100);

        await new Promise(res => setTimeout(res, 200));

        expect(timeoutSpy).toHaveBeenCalledWith(42);
        expect(controller.getActiveWorker(42)).toBeUndefined();
    });

    it('should terminate duplicate worker when spawning same phase again', async () => {
        const terminateSpy = jest.spyOn(adapter, 'terminateSession');

        await controller.spawnWorker(testPhase, 'FAKECONTEXT', 5000);
        expect(controller.getActiveWorker(42)?.phaseId).toBe(42);

        // Spawn same phase again — should terminate the existing one first
        await controller.spawnWorker(testPhase, 'FAKECONTEXT_RETRY', 5000);

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
        await controller.spawnWorker(testPhase, 'FAKECONTEXT', 100);

        // Wait long enough for both timeout AND mock exit to fire
        await new Promise(res => setTimeout(res, 700));

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
            const worker = await controller.spawnWorker(phase, 'CTX', 10000);
            expect(worker).not.toBeNull();
        }

        // 5th worker should return null
        const fifth = await controller.spawnWorker({ ...testPhase, id: asPhaseId(99) }, 'CTX', 10000);
        expect(fifth).toBeNull();

        // Clean up all workers
        await controller.terminateAll('TEST_CLEANUP');
    });

    it('should terminateAll active workers (#65)', async () => {
        const terminateSpy = jest.spyOn(adapter, 'terminateSession');

        await controller.spawnWorker({ ...testPhase, id: asPhaseId(1) }, 'CTX', 10000);
        await controller.spawnWorker({ ...testPhase, id: asPhaseId(2) }, 'CTX', 10000);

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

        const worker = await controller.spawnWorker(testPhase, 'FAKECONTEXT', 5000);
        expect(worker).not.toBeNull();

        // PID should be tracked
        const pids = controller.getActivePids();
        expect(pids.size).toBe(1);
        expect(pids.has(worker!.handle.pid)).toBe(true);

        // After natural exit, PID should be removed
        await new Promise(res => setTimeout(res, 600));
        expect(controller.getActivePids().size).toBe(0);
    });

    it('should remove PIDs from activePids on terminateWorker', async () => {
        await controller.spawnWorker(testPhase, 'FAKECONTEXT', 5000);
        expect(controller.getActivePids().size).toBe(1);

        await controller.terminateWorker(testPhase.id, 'TEST');
        expect(controller.getActivePids().size).toBe(0);
    });

    it('should track multiple PIDs for parallel workers', async () => {
        await controller.spawnWorker({ ...testPhase, id: asPhaseId(1) }, 'CTX', 10000);
        await controller.spawnWorker({ ...testPhase, id: asPhaseId(2) }, 'CTX', 10000);
        await controller.spawnWorker({ ...testPhase, id: asPhaseId(3) }, 'CTX', 10000);

        expect(controller.getActivePids().size).toBe(3);

        await controller.terminateAll('TEST');
        expect(controller.getActivePids().size).toBe(0);
    });

    it('should killAllWorkers and clear all PIDs', async () => {
        await controller.spawnWorker({ ...testPhase, id: asPhaseId(1) }, 'CTX', 10000);
        await controller.spawnWorker({ ...testPhase, id: asPhaseId(2) }, 'CTX', 10000);

        expect(controller.getActivePids().size).toBe(2);

        // killAllWorkers sends SIGTERM, waits, then SIGKILL
        // With mock adapter PIDs are fake (90000+), so process.kill will no-op/throw
        // but the method should still clean up the set
        await controller.killAllWorkers();

        expect(controller.getActivePids().size).toBe(0);
        expect(controller.getActiveWorker(1)).toBeUndefined();
        expect(controller.getActiveWorker(2)).toBeUndefined();
    }, 15000); // Extended timeout for the 5s grace period

    it('should dispose and be idempotent', async () => {
        await controller.spawnWorker({ ...testPhase, id: asPhaseId(1) }, 'CTX', 10000);
        expect(controller.getActivePids().size).toBe(1);

        await controller.dispose();
        expect(controller.getActivePids().size).toBe(0);

        // Second dispose should be a no-op (idempotent)
        await controller.dispose();
    }, 15000);
});
