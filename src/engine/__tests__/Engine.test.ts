import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { Engine } from '../Engine.js';
import { StateManager } from '../../state/StateManager.js';
import type { Runbook } from '../../types/index.js';
import { asPhaseId } from '../../types/index.js';

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
                id: asPhaseId(0),
                status: 'pending',
                prompt: 'Phase 1',
                context_files: [],
                success_criteria: 'exit_code:0',
                max_retries: 0
            },
            {
                id: asPhaseId(1),
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
                    id: asPhaseId(0),
                    status: 'pending',
                    prompt: 'Root',
                    context_files: [],
                    success_criteria: 'exit_code:0',
                    max_retries: 0,
                },
                {
                    id: asPhaseId(1),
                    status: 'pending',
                    prompt: 'Branch A',
                    context_files: [],
                    success_criteria: 'exit_code:0',
                    depends_on: [asPhaseId(0)],
                    max_retries: 0,
                },
                {
                    id: asPhaseId(2),
                    status: 'pending',
                    prompt: 'Branch B',
                    context_files: [],
                    success_criteria: 'exit_code:0',
                    depends_on: [asPhaseId(0)],
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

    // ═══════════════════════════════════════════════════════════════════════
    //  #58: Retry Cycle — ERROR_PAUSED → retry → EXECUTING_WORKER → COMPLETED
    // ═══════════════════════════════════════════════════════════════════════

    it('should complete retry cycle: ERROR_PAUSED → retry → EXECUTING_WORKER → COMPLETED', async () => {
        // Use a single-phase runbook with max_retries: 1
        const retryRunbook: Runbook = {
            project_id: 'retry-test',
            status: 'idle',
            current_phase: 0,
            phases: [
                {
                    id: asPhaseId(0),
                    status: 'pending',
                    prompt: 'Retryable task',
                    context_files: [],
                    success_criteria: 'exit_code:0',
                    max_retries: 1,
                },
            ],
        };
        await fs.writeFile(runbookPath, JSON.stringify(retryRunbook));

        const executeSpy = jest.fn();
        engine.on('phase:execute', executeSpy);

        await engine.loadRunbook();
        await engine.start();
        expect(engine.getState()).toBe('EXECUTING_WORKER');

        // Phase fails with exit code 1 → ERROR_PAUSED
        // (max_retries: 1, but self-healer attempts are 0 so it can auto-retry)
        // The self-healer fires with a delay. We want to test manual retry instead,
        // so we use max_retries: 0 to skip auto-healing.
        // Rewrite: use max_retries: 0 to go straight to ERROR_PAUSED
        const rb0 = { ...retryRunbook, phases: [{ ...retryRunbook.phases[0], max_retries: 0 }] };
        await fs.writeFile(runbookPath, JSON.stringify(rb0));
        // Re-initialize with fresh engine
        stateManager = new StateManager(tmpDir);
        engine = new Engine(stateManager);
        engine.on('phase:execute', executeSpy);

        await engine.loadRunbook();
        await engine.start();
        expect(engine.getState()).toBe('EXECUTING_WORKER');

        // Fail the phase
        await engine.onWorkerExited(0, 1);
        expect(engine.getState()).toBe('ERROR_PAUSED');
        expect(engine.getRunbook()!.phases[0].status).toBe('failed');

        // Manual retry
        await engine.retry(0);
        expect(engine.getState()).toBe('EXECUTING_WORKER');
        expect(engine.getRunbook()!.phases[0].status).toBe('running');

        // Now succeed
        await engine.onWorkerExited(0, 0);
        expect(engine.getState()).toBe('COMPLETED');
        expect(engine.getRunbook()!.phases[0].status).toBe('completed');
    });

    // ═══════════════════════════════════════════════════════════════════════
    //  #60: Max Retries Exceeded — stays in ERROR_PAUSED
    // ═══════════════════════════════════════════════════════════════════════

    it('should stay in ERROR_PAUSED when max retries exceeded', async () => {
        // Single phase, max_retries: 0 — no auto-healing allowed
        const noRetryRunbook: Runbook = {
            project_id: 'no-retry-test',
            status: 'idle',
            current_phase: 0,
            phases: [
                {
                    id: asPhaseId(0),
                    status: 'pending',
                    prompt: 'Non-retryable task',
                    context_files: [],
                    success_criteria: 'exit_code:0',
                    max_retries: 0,
                },
            ],
        };
        await fs.writeFile(runbookPath, JSON.stringify(noRetryRunbook));
        stateManager = new StateManager(tmpDir);
        engine = new Engine(stateManager);

        await engine.loadRunbook();
        await engine.start();

        // Fail the phase — with max_retries: 0, healer won't auto-retry
        await engine.onWorkerExited(0, 1);
        expect(engine.getState()).toBe('ERROR_PAUSED');
        expect(engine.getRunbook()!.phases[0].status).toBe('failed');
        expect(engine.getRunbook()!.status).toBe('paused_error');
    });

    // ═══════════════════════════════════════════════════════════════════════
    //  B1: start() dispatches all DAG-ready phases (not just sequential)
    // ═══════════════════════════════════════════════════════════════════════

    it('should dispatch all DAG-ready phases on start()', async () => {
        // Two root phases (depends_on: []) and one dependent phase.
        // Adding depends_on on phase 2 triggers DAG mode, enabling parallel dispatch
        // for roots (phases 0 and 1).
        const independentRunbook: Runbook = {
            project_id: 'independent-test',
            status: 'idle',
            current_phase: 0,
            phases: [
                {
                    id: asPhaseId(0),
                    status: 'pending',
                    prompt: 'Task A',
                    context_files: [],
                    success_criteria: 'exit_code:0',
                    depends_on: [],
                    max_retries: 0,
                },
                {
                    id: asPhaseId(1),
                    status: 'pending',
                    prompt: 'Task B',
                    context_files: [],
                    success_criteria: 'exit_code:0',
                    depends_on: [],
                    max_retries: 0,
                },
                {
                    id: asPhaseId(2),
                    status: 'pending',
                    prompt: 'Task C (depends on A and B)',
                    context_files: [],
                    success_criteria: 'exit_code:0',
                    depends_on: [asPhaseId(0), asPhaseId(1)],
                    max_retries: 0,
                },
            ],
        };
        await fs.writeFile(runbookPath, JSON.stringify(independentRunbook));
        stateManager = new StateManager(tmpDir);
        engine = new Engine(stateManager);

        const executeSpy = jest.fn();
        engine.on('phase:execute', executeSpy);

        await engine.loadRunbook();
        await engine.start();

        // Both root phases should be dispatched in parallel
        expect(executeSpy).toHaveBeenCalledTimes(2);
        expect(executeSpy).toHaveBeenCalledWith(expect.objectContaining({ id: 0 }));
        expect(executeSpy).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
    });

    // ═══════════════════════════════════════════════════════════════════════
    //  B2: skipPhase() unblocks dependent phases
    // ═══════════════════════════════════════════════════════════════════════

    it('should unblock dependent phases when a phase is skipped', async () => {
        const dagRunbook: Runbook = {
            project_id: 'skip-dag-test',
            status: 'idle',
            current_phase: 0,
            phases: [
                {
                    id: asPhaseId(0),
                    status: 'pending',
                    prompt: 'Root',
                    context_files: [],
                    success_criteria: 'exit_code:0',
                    max_retries: 0,
                },
                {
                    id: asPhaseId(1),
                    status: 'pending',
                    prompt: 'Depends on root',
                    context_files: [],
                    success_criteria: 'exit_code:0',
                    depends_on: [asPhaseId(0)],
                    max_retries: 0,
                },
            ],
        };
        await fs.writeFile(runbookPath, JSON.stringify(dagRunbook));
        stateManager = new StateManager(tmpDir);
        engine = new Engine(stateManager);

        const executeSpy = jest.fn();
        engine.on('phase:execute', executeSpy);

        await engine.loadRunbook();
        await engine.start();

        // Root dispatched
        expect(executeSpy).toHaveBeenCalledTimes(1);

        // Fail root
        await engine.onWorkerExited(0, 1);
        expect(engine.getState()).toBe('ERROR_PAUSED');

        // Skip root — should unblock phase 1 and dispatch it
        await engine.skipPhase(0);
        expect(engine.getRunbook()!.phases[0].status).toBe('completed');
        expect(executeSpy).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
    });

    // ═══════════════════════════════════════════════════════════════════════
    //  B3: onWorkerFailed() dispatches ready siblings in parallel
    // ═══════════════════════════════════════════════════════════════════════

    it('should dispatch ready siblings when one parallel phase fails', async () => {
        // Root → A (depends on root), B (depends on root), C (depends on A)
        // When A fails while B is still running, B should keep running.
        // If B has an independent sibling D, D should be dispatched.
        const dagRunbook: Runbook = {
            project_id: 'fail-sibling-test',
            status: 'idle',
            current_phase: 0,
            phases: [
                {
                    id: asPhaseId(0),
                    status: 'pending',
                    prompt: 'Root',
                    context_files: [],
                    success_criteria: 'exit_code:0',
                    max_retries: 0,
                },
                {
                    id: asPhaseId(1),
                    status: 'pending',
                    prompt: 'Branch A',
                    context_files: [],
                    success_criteria: 'exit_code:0',
                    depends_on: [asPhaseId(0)],
                    max_retries: 0,
                },
                {
                    id: asPhaseId(2),
                    status: 'pending',
                    prompt: 'Branch B',
                    context_files: [],
                    success_criteria: 'exit_code:0',
                    depends_on: [asPhaseId(0)],
                    max_retries: 0,
                },
            ],
        };
        await fs.writeFile(runbookPath, JSON.stringify(dagRunbook));
        stateManager = new StateManager(tmpDir);
        engine = new Engine(stateManager);

        const executeSpy = jest.fn();
        engine.on('phase:execute', executeSpy);

        await engine.loadRunbook();
        await engine.start();

        // Root completes → A and B dispatched
        await engine.onWorkerExited(0, 0);
        expect(executeSpy).toHaveBeenCalledTimes(3); // root + A + B

        // A crashes — B is still running, FSM stays EXECUTING_WORKER
        await engine.onWorkerFailed(1, 'crash');
        expect(engine.getState()).toBe('EXECUTING_WORKER');
        expect(engine.getRunbook()!.phases[1].status).toBe('failed');

        // B completes — last worker, transitions to ERROR_PAUSED (A failed)
        await engine.onWorkerExited(2, 0);
        expect(engine.getState()).toBe('ERROR_PAUSED');
    });

    // ═══════════════════════════════════════════════════════════════════════
    //  F1: resumePending() recovers stuck pipeline
    // ═══════════════════════════════════════════════════════════════════════

    it('should resume pending phases with satisfied dependencies via resumePending()', async () => {
        const dagRunbook: Runbook = {
            project_id: 'resume-test',
            status: 'idle',
            current_phase: 0,
            phases: [
                {
                    id: asPhaseId(0),
                    status: 'pending',
                    prompt: 'Root',
                    context_files: [],
                    success_criteria: 'exit_code:0',
                    max_retries: 0,
                },
                {
                    id: asPhaseId(1),
                    status: 'pending',
                    prompt: 'After Root',
                    context_files: [],
                    success_criteria: 'exit_code:0',
                    depends_on: [asPhaseId(0)],
                    max_retries: 0,
                },
            ],
        };
        await fs.writeFile(runbookPath, JSON.stringify(dagRunbook));
        stateManager = new StateManager(tmpDir);
        engine = new Engine(stateManager);

        const executeSpy = jest.fn();
        engine.on('phase:execute', executeSpy);

        await engine.loadRunbook();
        await engine.start();

        // Root dispatched, then completes
        await engine.onWorkerExited(0, 0);
        expect(engine.getRunbook()!.phases[0].status).toBe('completed');

        // Phase 1 should have been dispatched automatically
        // But simulate a scenario where it didn't (e.g., make it fail then recover)
        await engine.onWorkerExited(1, 1);
        expect(engine.getState()).toBe('ERROR_PAUSED');
        expect(engine.getRunbook()!.phases[1].status).toBe('failed');

        // Manual retry via resumePending — first reset the phase status
        const rb = engine.getRunbook()!;
        (rb.phases[1] as any).status = 'pending';

        await engine.resumePending();
        expect(engine.getState()).toBe('EXECUTING_WORKER');
        expect(executeSpy).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
    });

    // ═══════════════════════════════════════════════════════════════════════
    //  B5: Stall watchdog detects stuck pipeline
    // ═══════════════════════════════════════════════════════════════════════

    it('should detect stall via watchdog when activeWorkerCount drifts', async () => {
        jest.useFakeTimers();

        await fs.writeFile(runbookPath, JSON.stringify(validRunbook));
        stateManager = new StateManager(tmpDir);
        engine = new Engine(stateManager);

        const executeSpy = jest.fn();
        engine.on('phase:execute', executeSpy);

        await engine.loadRunbook();
        await engine.start();

        // Phase 0 dispatched normally
        expect(engine.getState()).toBe('EXECUTING_WORKER');

        // Simulate the phase being marked as completed externally but
        // the onWorkerExited never firing (lost exit event)
        const rb = engine.getRunbook()!;
        (rb.phases[0] as any).status = 'completed';
        // activeWorkerCount is still 1 but the phase is no longer running

        // Advance time to trigger the stall watchdog
        jest.advanceTimersByTime(31_000);

        // The watchdog should detect no running phases and attempt recovery
        // It should dispatch phase 1 (pending, no deps since sequential mode)
        expect(executeSpy.mock.calls.length).toBeGreaterThanOrEqual(2);

        jest.useRealTimers();
    });
});
