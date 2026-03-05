// ─────────────────────────────────────────────────────────────────────────────
// Verification tests for P0/P1 fixes from 02-review.md
// Tests: concurrent writes (P0-1), stale lockfile (P0-2), WAL replay
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { StateManager } from '../StateManager.js';
import { Runbook, EngineState } from '../../types/index.js';

describe('StateManager — P0 Verification Tests', () => {
    let tmpDir: string;

    const makeRunbook = (status: string = 'idle'): Runbook => ({
        project_id: 'test-project',
        status: status as Runbook['status'],
        current_phase: 0,
        phases: [{
            id: 0,
            status: 'pending',
            prompt: 'Test',
            context_files: [],
            success_criteria: 'exit_code:0',
        }],
    });

    beforeEach(async () => {
        const base = await fs.mkdtemp(path.join(os.tmpdir(), 'coogent-race-'));
        // Simulate session dir: .coogent/ipc/<id>/
        tmpDir = path.join(base, '.coogent', 'ipc', 'test-session');
        await fs.mkdir(tmpDir, { recursive: true });
        await fs.writeFile(
            path.join(tmpDir, '.task-runbook.json'),
            JSON.stringify(makeRunbook())
        );
    });

    afterEach(async () => {
        await new Promise(r => setTimeout(r, 100)); // let async writes settle
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    // ═══════════════════════════════════════════════════════════════════════════
    //  P0-1: Concurrent saveRunbook() calls must not corrupt data
    // ═══════════════════════════════════════════════════════════════════════════

    describe('P0-1: Async mutex on saveRunbook()', () => {
        it('should serialize 10 concurrent saves without corruption', async () => {
            const sm = new StateManager(tmpDir);

            // Fire 10 concurrent saves with incrementing current_phase
            const promises: Promise<void>[] = [];
            for (let i = 0; i < 10; i++) {
                const rb = makeRunbook('running');
                rb.current_phase = i;
                promises.push(sm.saveRunbook(rb, EngineState.EXECUTING_WORKER));
            }

            await Promise.all(promises);

            // The last save should win — verify disk state is valid JSON
            const disk = await fs.readFile(
                path.join(tmpDir, '.task-runbook.json'), 'utf-8'
            );
            const parsed = JSON.parse(disk) as Runbook;
            expect(parsed.project_id).toBe('test-project');
            expect(parsed.status).toBe('running');
            // current_phase should be one of the 10 values (deterministic order via mutex)
            expect(parsed.current_phase).toBe(9); // last write wins due to serialization
        });

        it('should not leave WAL file after successful concurrent writes', async () => {
            const sm = new StateManager(tmpDir);

            const promises: Promise<void>[] = [];
            for (let i = 0; i < 5; i++) {
                promises.push(sm.saveRunbook(makeRunbook(), EngineState.IDLE));
            }
            await Promise.all(promises);

            const walExists = await fs.access(
                path.join(tmpDir, '.wal.json')
            ).then(() => true).catch(() => false);
            expect(walExists).toBe(false);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════════
    //  P0-2: Stale lockfile recovery
    // ═══════════════════════════════════════════════════════════════════════════

    describe('P0-2: Stale lockfile cleanup', () => {
        it('should remove lockfile from a dead PID on recovery', async () => {
            const lockPath = path.join(tmpDir, '.lock');

            // Write lockfile with a PID that definitely doesn't exist
            // (PID 99999999 is extremely unlikely to be alive)
            await fs.writeFile(lockPath, '99999999');

            const sm = new StateManager(tmpDir);
            await sm.recoverFromCrash();

            // Lockfile should be cleaned
            const lockExists = await fs.access(lockPath)
                .then(() => true)
                .catch(() => false);
            expect(lockExists).toBe(false);
        });

        it('should NOT remove lockfile from a live PID', async () => {
            const lockPath = path.join(tmpDir, '.lock');

            // Write lockfile with our own PID (which is definitely alive)
            await fs.writeFile(lockPath, String(process.pid));

            const sm = new StateManager(tmpDir);
            await sm.recoverFromCrash();

            // Lockfile should still exist
            const lockExists = await fs.access(lockPath)
                .then(() => true)
                .catch(() => false);
            expect(lockExists).toBe(true);

            // Clean up so afterEach doesn't fail
            await fs.unlink(lockPath).catch(() => { });
        });

        it('should remove corrupt lockfile (non-numeric content)', async () => {
            const lockPath = path.join(tmpDir, '.lock');
            await fs.writeFile(lockPath, 'NOT_A_PID');

            const sm = new StateManager(tmpDir);
            await sm.recoverFromCrash();

            const lockExists = await fs.access(lockPath)
                .then(() => true)
                .catch(() => false);
            expect(lockExists).toBe(false);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════════
    //  WAL replay after crash
    // ═══════════════════════════════════════════════════════════════════════════

    describe('WAL replay', () => {
        it('should replay WAL and recover runbook state', async () => {
            const walPath = path.join(tmpDir, '.wal.json');
            const recoveredRunbook = makeRunbook('running');
            recoveredRunbook.current_phase = 5;

            // Simulate a crash: WAL exists but rename never completed
            await fs.writeFile(walPath, JSON.stringify({
                timestamp: Date.now(),
                engineState: EngineState.EXECUTING_WORKER,
                currentPhase: 5,
                snapshot: recoveredRunbook,
            }));

            const sm = new StateManager(tmpDir);
            const recovered = await sm.recoverFromCrash();

            expect(recovered).toBe(true);

            // Disk should now have the recovered state
            const disk = await fs.readFile(
                path.join(tmpDir, '.task-runbook.json'), 'utf-8'
            );
            const parsed = JSON.parse(disk) as Runbook;
            expect(parsed.current_phase).toBe(5);
            expect(parsed.status).toBe('running');

            // WAL should be cleaned up
            const walExists = await fs.access(walPath)
                .then(() => true)
                .catch(() => false);
            expect(walExists).toBe(false);
        });
    });
});
