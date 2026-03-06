import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { LogStream, LogLevel } from '../LogStream.js';

describe('LogStream', () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'coogent-logstream-'));
    });

    afterEach(async () => {
        await fsp.rm(tmpDir, { recursive: true, force: true });
    });

    /**
     * Helper: write, dispose, await stream finish, then read the log file.
     * This avoids any real time waits — we just wait on the stream's 'finish' event.
     */
    async function disposeAndRead(ls: LogStream, logPath: string): Promise<string> {
        // Access the internal stream before dispose() nulls it
        const stream = (ls as unknown as { stream: fs.WriteStream | null }).stream;
        const finishPromise = stream
            ? new Promise<void>(resolve => stream.on('finish', resolve))
            : Promise.resolve();
        ls.dispose();
        await finishPromise;
        try {
            return fs.readFileSync(logPath, 'utf-8');
        } catch {
            return '';
        }
    }

    it('should create coogent.log in .coogent/', async () => {
        const ls = new LogStream(tmpDir);
        const logPath = path.join(tmpDir, '.coogent', 'coogent.log');
        await disposeAndRead(ls, logPath);
        expect(fs.existsSync(logPath)).toBe(true);
    });

    it('should capture log() with INFO level', async () => {
        const ls = new LogStream(tmpDir);
        ls.log('[Test] hello from test');
        const content = await disposeAndRead(ls, path.join(tmpDir, '.coogent', 'coogent.log'));
        expect(content).toContain('[INFO ]');
        expect(content).toContain('[Test] hello from test');
    });

    it('should capture warn() with WARN level', async () => {
        const ls = new LogStream(tmpDir);
        ls.warn('[Test] a warning');
        const content = await disposeAndRead(ls, path.join(tmpDir, '.coogent', 'coogent.log'));
        expect(content).toContain('[WARN ]');
        expect(content).toContain('[Test] a warning');
    });

    it('should capture error() with ERROR level', async () => {
        const ls = new LogStream(tmpDir);
        ls.error('[Test] an error');
        const content = await disposeAndRead(ls, path.join(tmpDir, '.coogent', 'coogent.log'));
        expect(content).toContain('[ERROR]');
        expect(content).toContain('[Test] an error');
    });

    it('should capture info() with INFO level', async () => {
        const ls = new LogStream(tmpDir);
        ls.info('[Test] info message');
        const content = await disposeAndRead(ls, path.join(tmpDir, '.coogent', 'coogent.log'));
        expect(content).toContain('[INFO ]');
        expect(content).toContain('[Test] info message');
    });

    it('should capture debug() with DEBUG level', async () => {
        const ls = new LogStream(tmpDir, { level: LogLevel.DEBUG });
        ls.debug('[Test] debug message');
        const content = await disposeAndRead(ls, path.join(tmpDir, '.coogent', 'coogent.log'));
        expect(content).toContain('[DEBUG]');
        expect(content).toContain('[Test] debug message');
    });

    it('should not monkey-patch console methods', () => {
        const origLog = console.log;
        const origInfo = console.info;
        const origWarn = console.warn;
        const origError = console.error;
        const origDebug = console.debug;

        const ls = new LogStream(tmpDir);
        expect(console.log).toBe(origLog);
        expect(console.info).toBe(origInfo);
        expect(console.warn).toBe(origWarn);
        expect(console.error).toBe(origError);
        expect(console.debug).toBe(origDebug);

        ls.dispose();
        expect(console.log).toBe(origLog);
        expect(console.info).toBe(origInfo);
        expect(console.warn).toBe(origWarn);
        expect(console.error).toBe(origError);
        expect(console.debug).toBe(origDebug);
    });

    it('should include ISO timestamp in each line', async () => {
        const ls = new LogStream(tmpDir);
        ls.log('timestamp-check');
        const content = await disposeAndRead(ls, path.join(tmpDir, '.coogent', 'coogent.log'));
        expect(content).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]/);
    });

    it('should rotate when file exceeds configured max size', async () => {
        const logDir = path.join(tmpDir, '.coogent');
        fs.mkdirSync(logDir, { recursive: true });
        const logPath = path.join(logDir, 'coogent.log');

        const buf = Buffer.alloc(6 * 1024 * 1024, 'x');
        fs.writeFileSync(logPath, buf);

        const ls = new LogStream(tmpDir);
        await disposeAndRead(ls, logPath);

        expect(fs.existsSync(`${logPath}.1`)).toBe(true);
        const backupSize = fs.statSync(`${logPath}.1`).size;
        expect(backupSize).toBeGreaterThan(5 * 1024 * 1024);
        expect(fs.existsSync(logPath)).toBe(true);
        const newSize = fs.statSync(logPath).size;
        expect(newSize).toBeLessThan(1024);
    });

    it('should stringify non-string arguments', async () => {
        const ls = new LogStream(tmpDir);
        ls.log('object test:', { key: 'value' }, 42);
        const content = await disposeAndRead(ls, path.join(tmpDir, '.coogent', 'coogent.log'));
        expect(content).toContain('object test:');
        expect(content).toContain('"key":"value"');
        expect(content).toContain('42');
    });

    it('should filter messages below the configured level', async () => {
        const ls = new LogStream(tmpDir, { level: LogLevel.WARN });
        ls.log('[Test] should NOT appear');
        ls.info('[Test] should NOT appear either');
        ls.debug('[Test] also hidden');
        ls.warn('[Test] warning visible');
        ls.error('[Test] error visible');
        const content = await disposeAndRead(ls, path.join(tmpDir, '.coogent', 'coogent.log'));
        expect(content).not.toContain('should NOT appear');
        expect(content).not.toContain('should NOT appear either');
        expect(content).not.toContain('also hidden');
        expect(content).toContain('warning visible');
        expect(content).toContain('error visible');
    });

    it('should suppress all file output when level is OFF', async () => {
        const ls = new LogStream(tmpDir, { level: LogLevel.OFF });
        ls.log('[Test] should NOT appear');
        ls.error('[Test] should NOT appear');
        const logPath = path.join(tmpDir, '.coogent', 'coogent.log');
        await disposeAndRead(ls, logPath);
        // File may not exist at all when OFF suppresses everything
        if (fs.existsSync(logPath)) {
            const content = fs.readFileSync(logPath, 'utf-8');
            expect(content).toBe('');
        }
        // Either: file doesn't exist OR it's empty — both are valid for OFF level
    });

    it('setLevel() should change filtering at runtime', async () => {
        const ls = new LogStream(tmpDir, { level: LogLevel.INFO });
        ls.log('[Test] info visible');
        ls.setLevel(LogLevel.ERROR);
        ls.log('[Test] info now hidden');
        ls.error('[Test] error still visible');
        const content = await disposeAndRead(ls, path.join(tmpDir, '.coogent', 'coogent.log'));
        expect(content).toContain('info visible');
        expect(content).not.toContain('info now hidden');
        expect(content).toContain('error still visible');
    });

    it('should respect custom rotation config', async () => {
        const logDir = path.join(tmpDir, '.coogent');
        fs.mkdirSync(logDir, { recursive: true });
        const logPath = path.join(logDir, 'coogent.log');

        const buf = Buffer.alloc(2 * 1024, 'x');
        fs.writeFileSync(logPath, buf);

        const ls = new LogStream(tmpDir, { maxLogBytes: 1024 });
        await disposeAndRead(ls, logPath);

        expect(fs.existsSync(`${logPath}.1`)).toBe(true);
    });

    it('getLevel() should return the current level', () => {
        const ls = new LogStream(tmpDir, { level: LogLevel.WARN });
        expect(ls.getLevel()).toBe(LogLevel.WARN);
        ls.setLevel(LogLevel.ERROR);
        expect(ls.getLevel()).toBe(LogLevel.ERROR);
        ls.dispose();
    });
});
