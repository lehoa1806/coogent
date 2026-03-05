import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ADKController, MockADKAdapter, WorkerHandle } from '../ADKController.js';
import type { Phase } from '../../types/index.js';

describe('ADKController (with MockADKAdapter)', () => {
    let controller: ADKController;
    let adapter: MockADKAdapter;
    let tmpDir: string;
    const testPhase: Phase = {
        id: 42,
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
});
