import { OrchestratorState } from '../../types/index.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { TelemetryLogger } from '../TelemetryLogger.js';

describe('TelemetryLogger', () => {
    let tmpDir: string;
    let logger: TelemetryLogger;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'isolated-agent-log-'));
        logger = new TelemetryLogger(tmpDir);
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('should initialize a run directory', async () => {
        await logger.initRun('test-project');

        const logsDir = path.join(tmpDir, '.isolated_agent/logs');
        const runs = await fs.readdir(logsDir);
        expect(runs.length).toBe(1);
        expect(runs[0]).toBe('test-project');
    });

    it('should log state transitions to engine.jsonl', async () => {
        await logger.initRun('test-project');
        await logger.logStateTransition(OrchestratorState.IDLE, OrchestratorState.READY, 'COMMAND_LOAD');

        const runs = await fs.readdir(path.join(tmpDir, '.isolated_agent/logs'));
        const engineLogPath = path.join(tmpDir, '.isolated_agent/logs', runs[0], 'engine.jsonl');

        const content = await fs.readFile(engineLogPath, 'utf8');
        expect(content).toContain('"event":"COMMAND_LOAD"');
        expect(content).toContain('"from":"IDLE"');
        expect(content).toContain('"to":"READY"');
    });

    it('should log phase output to phase specific files', async () => {
        await logger.initRun('test-project');
        await logger.logPhaseOutput(0, 'stdout', 'Hello worker');

        const runs = await fs.readdir(path.join(tmpDir, '.isolated_agent/logs'));
        const phaseLogPath = path.join(tmpDir, '.isolated_agent/logs', runs[0], 'phase-0.jsonl');

        const content = await fs.readFile(phaseLogPath, 'utf8');
        expect(content).toContain('"category":"worker"');
        expect(content).toContain('"stream":"stdout"');
        expect(content).toContain('Hello worker');
    });

    it('should be non-blocking if logger fails to initialize', async () => {
        // Create parent dir, then a file where the logs directory should go to force an error
        await fs.mkdir(path.join(tmpDir, '.isolated_agent'), { recursive: true });
        await fs.writeFile(path.join(tmpDir, '.isolated_agent', 'logs'), 'blocking file');

        // This shouldn't throw an unhandled promise rejection
        await expect(logger.initRun('test-project')).resolves.not.toThrow();
        await expect(logger.logStateTransition(OrchestratorState.IDLE, OrchestratorState.READY, 'TEST')).resolves.not.toThrow();
    });
});
