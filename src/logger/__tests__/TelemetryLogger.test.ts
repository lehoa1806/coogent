import { EngineState } from '../../types/index.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { TelemetryLogger } from '../TelemetryLogger.js';

describe('TelemetryLogger', () => {
    let tmpDir: string;
    let logger: TelemetryLogger;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'coogent-log-'));
        logger = new TelemetryLogger(tmpDir);
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('should initialize a run directory', async () => {
        await logger.initRun('test-project');

        const logsDir = path.join(tmpDir, '.coogent/logs');
        const runs = await fs.readdir(logsDir);
        expect(runs.length).toBe(1);
        expect(runs[0]).toBe('test-project');
    });

    it('should log state transitions to engine.jsonl', async () => {
        await logger.initRun('test-project');
        await logger.logStateTransition(EngineState.IDLE, EngineState.READY, 'COMMAND_LOAD');

        const runs = await fs.readdir(path.join(tmpDir, '.coogent/logs'));
        const engineLogPath = path.join(tmpDir, '.coogent/logs', runs[0], 'engine.jsonl');

        const content = await fs.readFile(engineLogPath, 'utf8');
        expect(content).toContain('"event":"COMMAND_LOAD"');
        expect(content).toContain('"from":"IDLE"');
        expect(content).toContain('"to":"READY"');
    });

    it('should log phase output to phase specific files', async () => {
        await logger.initRun('test-project');
        await logger.logPhaseOutput(0, 'stdout', 'Hello worker');

        const runs = await fs.readdir(path.join(tmpDir, '.coogent/logs'));
        const phaseLogPath = path.join(tmpDir, '.coogent/logs', runs[0], 'phase-0.jsonl');

        const content = await fs.readFile(phaseLogPath, 'utf8');
        expect(content).toContain('"category":"worker"');
        expect(content).toContain('"stream":"stdout"');
        expect(content).toContain('Hello worker');
    });

    it('should be non-blocking if logger fails to initialize', async () => {
        // Create parent dir, then a file where the logs directory should go to force an error
        await fs.mkdir(path.join(tmpDir, '.coogent'), { recursive: true });
        await fs.writeFile(path.join(tmpDir, '.coogent', 'logs'), 'blocking file');

        // This shouldn't throw an unhandled promise rejection
        await expect(logger.initRun('test-project')).resolves.not.toThrow();
        await expect(logger.logStateTransition(EngineState.IDLE, EngineState.READY, 'TEST')).resolves.not.toThrow();
    });

    it('should log phase prompt (#71)', async () => {
        await logger.initRun('test-project');
        await logger.logPhasePrompt(0, 'Build the login page');

        const runs = await fs.readdir(path.join(tmpDir, '.coogent/logs'));
        const phaseLogPath = path.join(tmpDir, '.coogent/logs', runs[0], 'phase-0.jsonl');

        const content = await fs.readFile(phaseLogPath, 'utf8');
        expect(content).toContain('"category":"phase"');
        expect(content).toContain('Build the login page');
    });

    it('should log phase result (#71)', async () => {
        await logger.initRun('test-project');
        await logger.logPhaseResult(1, 0, true, 12345);

        const runs = await fs.readdir(path.join(tmpDir, '.coogent/logs'));
        const phaseLogPath = path.join(tmpDir, '.coogent/logs', runs[0], 'phase-1.jsonl');

        const content = await fs.readFile(phaseLogPath, 'utf8');
        expect(content).toContain('"category":"phase"');
        expect(content).toContain('"exitCode":0');
        expect(content).toContain('"passed":true');
    });

    it('should log context assembly (#71)', async () => {
        await logger.initRun('test-project');
        await logger.logContextAssembly(0, 5000, 10000, 3);

        const runs = await fs.readdir(path.join(tmpDir, '.coogent/logs'));
        const phaseLogPath = path.join(tmpDir, '.coogent/logs', runs[0], 'phase-0.jsonl');

        const content = await fs.readFile(phaseLogPath, 'utf8');
        expect(content).toContain('"category":"context"');
        expect(content).toContain('"totalTokens":5000');
    });
});
