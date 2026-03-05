import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { StateManager } from '../state/StateManager.js';
import { Engine } from '../engine/Engine.js';
import { ContextScoper, CharRatioEncoder } from '../context/ContextScoper.js';
import { ADKController, MockADKAdapter } from '../adk/ADKController.js';
import { TelemetryLogger } from '../logger/TelemetryLogger.js';
import type { Runbook, Phase } from '../types/index.js';
import { asPhaseId } from '../types/index.js';

describe('Coogent Integration: End-to-End Pillar 1', () => {
    let tmpDir: string;
    let stateManager: StateManager;
    let engine: Engine;
    let scoper: ContextScoper;
    let adk: ADKController;
    let logger: TelemetryLogger;
    let completionResolve: () => void;

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
        // Simulate session dir: .coogent/ipc/<id>/
        tmpDir = path.join(baseDir, '.coogent', 'ipc', 'test-session');
        await fs.mkdir(tmpDir, { recursive: true });
        await fs.writeFile(path.join(tmpDir, '.task-runbook.json'), JSON.stringify(initialRunbook));
        await fs.writeFile(path.join(baseDir, 'existing-file.txt'), 'Hello tests');

        stateManager = new StateManager(tmpDir);
        engine = new Engine(stateManager);

        scoper = new ContextScoper({ encoder: new CharRatioEncoder(), tokenLimit: 1000 });
        logger = new TelemetryLogger(baseDir);
        adk = new ADKController(new MockADKAdapter(), baseDir);

        // Wiring logic mimicking extension.ts
        engine.on('state:changed', (from, to, event) => {
            logger.logStateTransition(from, to, event).catch(() => { });
        });

        engine.on('phase:execute', async (phase: Phase) => {
            const ctx = await scoper.assemble(phase, baseDir);
            if (ctx.ok) {
                if (phase.id === 1) await logger.initRun(engine.getRunbook()!.project_id);
                await adk.spawnWorker(phase, ctx.payload, 2000);
            }
        });

        adk.on('worker:exited', (phaseId, exitCode) => {
            engine.onWorkerExited(phaseId, exitCode).catch(() => { });
        });

        adk.on('worker:output', (phaseId, stream, chunk) => {
            logger.logPhaseOutput(phaseId, stream, chunk).catch(() => { });
        });
    });

    afterEach(async () => {
        await adk.terminateWorker(1, 'CLEANUP');
        await fs.rm(baseDir, { recursive: true, force: true });
    });

    it('should successfully execute a phase and persist its completion state', async () => {
        // Setup completion hook
        const completionPromise = new Promise<void>((resolve) => {
            completionResolve = resolve;
        });

        engine.on('run:completed', () => {
            completionResolve();
        });

        await engine.loadRunbook();
        await engine.start();

        // Wait for the mock ADK adapter and FSM evaluations to finish
        await completionPromise;

        // Verify final state
        expect(engine.getState()).toBe('COMPLETED');
        const rb = engine.getRunbook()!;
        expect(rb.current_phase).toBe(1);
        expect(rb.phases[0].status).toBe('completed');

        // Verify disk file
        const diskContent = await fs.readFile(path.join(tmpDir, '.task-runbook.json'), 'utf8');
        const diskRb = JSON.parse(diskContent) as Runbook;
        expect(diskRb.status).toBe('completed');
        expect(diskRb.phases[0].status).toBe('completed');
    });
});
