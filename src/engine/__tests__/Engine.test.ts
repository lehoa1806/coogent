import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { Engine } from '../Engine.js';
import { StateManager } from '../../state/StateManager.js';
import type { Runbook } from '../../types/index.js';

describe('Engine', () => {
    let tmpDir: string;
    let runbookPath: string;
    let stateManager: StateManager;
    let engine: Engine;

    const validRunbook: Runbook = {
        project_id: 'test-project',
        status: 'idle',
        current_phase: 0,
        phases: [
            {
                id: 0,
                status: 'pending',
                prompt: 'Phase 1',
                context_files: [],
                success_criteria: 'exit_code:0',
                max_retries: 0
            },
            {
                id: 1,
                status: 'pending',
                prompt: 'Phase 2',
                context_files: [],
                success_criteria: 'exit_code:0',
                max_retries: 0
            }
        ]
    };

    beforeEach(async () => {
        const base = await fs.mkdtemp(path.join(os.tmpdir(), 'coogent-eng-'));
        // Simulate session dir: .coogent/ipc/<id>/
        tmpDir = path.join(base, '.coogent', 'ipc', 'test-session');
        await fs.mkdir(tmpDir, { recursive: true });
        runbookPath = path.join(tmpDir, '.task-runbook.json');
        await fs.writeFile(runbookPath, JSON.stringify(validRunbook));

        stateManager = new StateManager(tmpDir);
        engine = new Engine(stateManager);
    });

    afterEach(async () => {
        // give any pending async writes a chance to settle
        await new Promise(res => setTimeout(res, 50));
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('should start in IDLE state', () => {
        expect(engine.getState()).toBe('IDLE');
    });

    it('should load runbook and transition to READY', async () => {
        await engine.loadRunbook();
        expect(engine.getState()).toBe('READY');
        expect(engine.getRunbook()?.project_id).toBe('test-project');
    });

    it('should transition IDLE -> READY -> EXECUTING_WORKER -> EVALUATING -> COMPLETED', async () => {
        // Arrange spies
        const executeSpy = jest.fn();
        engine.on('phase:execute', executeSpy);

        // Load
        await engine.loadRunbook();

        // Start
        await engine.start();
        expect(engine.getState()).toBe('EXECUTING_WORKER');
        expect(executeSpy).toHaveBeenCalledWith(expect.objectContaining({ id: 0 }));

        // Simulate Worker Exited
        await engine.onWorkerExited(0, 0);
        expect(engine.getState()).toBe('EXECUTING_WORKER'); // Advances to Phase 1 and starts it
        expect(executeSpy).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));

        // Simulate second worker exited
        await engine.onWorkerExited(1, 0);
        expect(engine.getState()).toBe('COMPLETED');
    });

    it('should transition to ERROR_PAUSED if worker fails', async () => {
        await engine.loadRunbook();
        await engine.start();

        await engine.onWorkerExited(0, 1); // exit code 1
        expect(engine.getState()).toBe('ERROR_PAUSED');

        const rb = engine.getRunbook()!;
        expect(rb.phases[0].status).toBe('failed');
    });

    // ═══════════════════════════════════════════════════════════════════════
    //  AB-1: Parallel DAG Execution Tests
    // ═══════════════════════════════════════════════════════════════════════

    describe('Parallel DAG execution (AB-1)', () => {
        const dagRunbook: Runbook = {
            project_id: 'dag-test',
            status: 'idle',
            current_phase: 0,
            phases: [
                {
                    id: 0,
                    status: 'pending',
                    prompt: 'Root',
                    context_files: [],
                    success_criteria: 'exit_code:0',
                    max_retries: 0,
                },
                {
                    id: 1,
                    status: 'pending',
                    prompt: 'Branch A',
                    context_files: [],
                    success_criteria: 'exit_code:0',
                    depends_on: [0],
                    max_retries: 0,
                },
                {
                    id: 2,
                    status: 'pending',
                    prompt: 'Branch B',
                    context_files: [],
                    success_criteria: 'exit_code:0',
                    depends_on: [0],
                    max_retries: 0,
                },
            ],
        };

        beforeEach(async () => {
            // Write the DAG runbook
            await fs.writeFile(runbookPath, JSON.stringify(dagRunbook));
        });

        it('should complete when both parallel phases succeed', async () => {
            const executeSpy = jest.fn();
            engine.on('phase:execute', executeSpy);

            await engine.loadRunbook();
            await engine.start();

            // Root phase dispatched
            expect(engine.getState()).toBe('EXECUTING_WORKER');
            expect(executeSpy).toHaveBeenCalledWith(expect.objectContaining({ id: 0 }));

            // Root completes → branches A and B dispatched in parallel
            await engine.onWorkerExited(0, 0);
            expect(executeSpy).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
            expect(executeSpy).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }));
            expect(engine.getState()).toBe('EXECUTING_WORKER');

            // Branch A completes (B still running → stays in EXECUTING_WORKER)
            await engine.onWorkerExited(1, 0);
            expect(engine.getState()).toBe('EXECUTING_WORKER');
            expect(engine.getRunbook()!.phases[1].status).toBe('completed');

            // Branch B completes (last worker → COMPLETED)
            await engine.onWorkerExited(2, 0);
            expect(engine.getState()).toBe('COMPLETED');
            expect(engine.getRunbook()!.status).toBe('completed');
        });

        it('should transition to ERROR_PAUSED when one parallel phase fails', async () => {
            const executeSpy = jest.fn();
            engine.on('phase:execute', executeSpy);

            await engine.loadRunbook();
            await engine.start();

            // Root completes → dispatches A and B
            await engine.onWorkerExited(0, 0);

            // Branch A fails (B still running → stays in EXECUTING_WORKER)
            await engine.onWorkerExited(1, 1);
            expect(engine.getState()).toBe('EXECUTING_WORKER');
            expect(engine.getRunbook()!.phases[1].status).toBe('failed');

            // Branch B succeeds (last worker, but A failed → ERROR_PAUSED)
            await engine.onWorkerExited(2, 0);
            expect(engine.getState()).toBe('ERROR_PAUSED');
            expect(engine.getRunbook()!.status).toBe('paused_error');
        });

        it('should keep FSM in EXECUTING_WORKER during staggered exits', async () => {
            const executeSpy = jest.fn();
            engine.on('phase:execute', executeSpy);

            await engine.loadRunbook();
            await engine.start();

            // Root completes → dispatches A and B
            await engine.onWorkerExited(0, 0);
            expect(engine.getState()).toBe('EXECUTING_WORKER');

            // Branch A completes first — FSM stays in EXECUTING_WORKER
            await engine.onWorkerExited(1, 0);
            expect(engine.getState()).toBe('EXECUTING_WORKER');

            // Branch B completes — all done, FSM transitions to COMPLETED
            await engine.onWorkerExited(2, 0);
            expect(engine.getState()).toBe('COMPLETED');
        });
    });
});
