// ─────────────────────────────────────────────────────────────────────────────
// integration.test.ts — Mocked integration test for Engine + ADK wiring.
// Uses MockADKAdapter with 0ms delay + a manual engine drive loop
// instead of waiting for real timers.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { StateManager } from '../state/StateManager.js';
import { Engine } from '../engine/Engine.js';
import { asPhaseId, type Runbook, type Phase } from '../types/index.js';

describe('Coogent Integration: End-to-End Pillar 1', () => {
    let tmpDir: string;
    let stateManager: StateManager;
    let engine: Engine;
    let baseDir: string;

    const initialRunbook: Runbook = {
        project_id: 'integration-test',
        status: 'idle',
        current_phase: 1,
        phases: [
            {
                id: asPhaseId(1),
                status: 'pending',
                prompt: 'Phase 1',
                context_files: [],
                success_criteria: 'exit_code:0'
            }
        ]
    };

    beforeEach(async () => {
        baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'coogent-e2e-'));
        tmpDir = path.join(baseDir, '.coogent', 'ipc', 'test-session');
        await fs.mkdir(tmpDir, { recursive: true });
        await fs.writeFile(path.join(tmpDir, '.task-runbook.json'), JSON.stringify(initialRunbook));

        stateManager = new StateManager(tmpDir);
        engine = new Engine(stateManager);
    });

    afterEach(async () => {
        await fs.rm(baseDir, { recursive: true, force: true });
    });

    it('should successfully execute a phase and persist its completion state', async () => {
        // Wire engine: when a phase is dispatched for execution, immediately fire
        // onWorkerExited with exit code 0 (no real ADK process needed).
        engine.on('phase:execute', async (phase: Phase) => {
            // Simulate instant successful worker completion
            await engine.onWorkerExited(phase.id, 0);
        });

        await engine.loadRunbook();

        // Wire a completion promise
        const completionPromise = new Promise<void>(resolve => {
            engine.on('run:completed', () => resolve());
        });

        await engine.start();

        // Should complete synchronously since onWorkerExited is awaited inline
        await completionPromise;

        expect(engine.getState()).toBe('COMPLETED');
        const rb = engine.getRunbook()!;
        expect(rb.phases[0].status).toBe('completed');

        // Verify disk file
        const diskContent = await fs.readFile(path.join(tmpDir, '.task-runbook.json'), 'utf8');
        const diskRb = JSON.parse(diskContent) as Runbook;
        expect(diskRb.status).toBe('completed');
        expect(diskRb.phases[0].status).toBe('completed');
    });
});
