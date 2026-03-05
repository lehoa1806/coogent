import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { StateManager, RunbookValidationError } from '../StateManager.js';
import { Runbook, EngineState, asPhaseId } from '../../types/index.js';

describe('StateManager', () => {
    let tmpDir: string;
    let runbookPath: string;

    const validRunbook: Runbook = {
        project_id: 'test-project',
        status: 'idle',
        current_phase: 0,
        phases: [
            {
                id: asPhaseId(0),
                status: 'pending',
                prompt: 'Test prompt',
                context_files: [],
                success_criteria: 'exit_code:0'
            }
        ]
    };

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'coogent-test-'));
        // Simulate session dir: .coogent/ipc/<id>/
        const sessionDir = path.join(tmpDir, '.coogent', 'ipc', 'test-session');
        await fs.mkdir(sessionDir, { recursive: true });
        runbookPath = path.join(sessionDir, '.task-runbook.json');
        tmpDir = sessionDir; // Tests use sessionDir as the StateManager root
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('should initialize and load a valid runbook', async () => {
        await fs.writeFile(runbookPath, JSON.stringify(validRunbook));
        const sm = new StateManager(tmpDir);
        const runbook = await sm.loadRunbook();
        expect(runbook).toEqual(validRunbook);
    });

    it('should throw an error if the runbook is malformed', async () => {
        const invalidRunbook = { ...validRunbook };
        // @ts-ignore
        delete invalidRunbook.status;
        await fs.writeFile(runbookPath, JSON.stringify(invalidRunbook));
        const sm = new StateManager(tmpDir);

        await expect(sm.loadRunbook()).rejects.toThrow(RunbookValidationError);
    });

    it('should save the runbook', async () => {
        await fs.writeFile(runbookPath, JSON.stringify(validRunbook));
        const sm = new StateManager(tmpDir);
        const runbook = await sm.loadRunbook();

        // Mutate and save
        runbook!.status = 'completed';
        await sm.saveRunbook(runbook!, EngineState.EVALUATING);

        // Check if file is updated
        const content = await fs.readFile(runbookPath, 'utf-8');
        expect(JSON.parse(content).status).toBe('completed');
    });

    it('should create independent instances per workspace', () => {
        const sm1 = new StateManager(tmpDir);
        const sm2 = new StateManager(tmpDir);
        expect(sm1).not.toBe(sm2);
    });

    // ═══════════════════════════════════════════════════════════════════════
    //  #62: Corrupt WAL Recovery
    // ═══════════════════════════════════════════════════════════════════════

    it('should handle corrupt WAL gracefully (non-JSON)', async () => {
        const walPath = path.join(tmpDir, '.wal.json');
        await fs.writeFile(walPath, '<<<CORRUPTED DATA>>>');

        const sm = new StateManager(tmpDir);
        const recovered = await sm.recoverFromCrash();

        expect(recovered).toBe(false);

        // WAL file should have been deleted
        await expect(fs.access(walPath)).rejects.toThrow();
    });

    // ═══════════════════════════════════════════════════════════════════════
    //  #63: WAL Schema Validation Rejection
    // ═══════════════════════════════════════════════════════════════════════

    it('should reject WAL snapshot with missing required fields', async () => {
        const walPath = path.join(tmpDir, '.wal.json');
        // Valid JSON, but snapshot is missing required `project_id`
        const invalidWal = {
            timestamp: Date.now(),
            engineState: 'IDLE',
            currentPhase: 0,
            snapshot: {
                // project_id is MISSING
                status: 'idle',
                current_phase: 0,
                phases: [
                    {
                        id: 0,
                        status: 'pending',
                        prompt: 'Test',
                        context_files: [],
                        success_criteria: 'exit_code:0',
                    },
                ],
            },
        };
        await fs.writeFile(walPath, JSON.stringify(invalidWal));

        const sm = new StateManager(tmpDir);
        const recovered = await sm.recoverFromCrash();

        expect(recovered).toBe(false);

        // WAL file should have been deleted
        await expect(fs.access(walPath)).rejects.toThrow();
    });
});
