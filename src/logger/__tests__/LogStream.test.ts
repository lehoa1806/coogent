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

    it('should create coogent.log in .coogent/', (done) => {
        const ls = new LogStream(tmpDir);
        const logPath = path.join(tmpDir, '.coogent', 'coogent.log');
        ls.dispose();

        // WriteStream needs a tick to flush
        setTimeout(() => {
            expect(fs.existsSync(logPath)).toBe(true);
            done();
        }, 100);
    });

    it('should capture log() with INFO level', (done) => {
        const ls = new LogStream(tmpDir);
        ls.log('[Test] hello from test');
        ls.dispose();

        // Read the file after stream is closed
        setTimeout(() => {
            const content = fs.readFileSync(
                path.join(tmpDir, '.coogent', 'coogent.log'),
                'utf-8'
            );
            expect(content).toContain('[INFO ]');
            expect(content).toContain('[Test] hello from test');
            done();
        }, 100);
    });

    it('should capture warn() with WARN level', (done) => {
        const ls = new LogStream(tmpDir);
        ls.warn('[Test] a warning');
        ls.dispose();

        setTimeout(() => {
            const content = fs.readFileSync(
                path.join(tmpDir, '.coogent', 'coogent.log'),
                'utf-8'
            );
            expect(content).toContain('[WARN ]');
            expect(content).toContain('[Test] a warning');
            done();
        }, 100);
    });

    it('should capture error() with ERROR level', (done) => {
        const ls = new LogStream(tmpDir);
        ls.error('[Test] an error');
        ls.dispose();

        setTimeout(() => {
            const content = fs.readFileSync(
                path.join(tmpDir, '.coogent', 'coogent.log'),
                'utf-8'
            );
            expect(content).toContain('[ERROR]');
            expect(content).toContain('[Test] an error');
            done();
        }, 100);
    });

    it('should capture info() with INFO level', (done) => {
        const ls = new LogStream(tmpDir);
        ls.info('[Test] info message');
        ls.dispose();

        setTimeout(() => {
            const content = fs.readFileSync(
                path.join(tmpDir, '.coogent', 'coogent.log'),
                'utf-8'
            );
            expect(content).toContain('[INFO ]');
            expect(content).toContain('[Test] info message');
            done();
        }, 100);
    });

    it('should capture debug() with DEBUG level', (done) => {
        const ls = new LogStream(tmpDir, { level: LogLevel.DEBUG });
        ls.debug('[Test] debug message');
        ls.dispose();

        setTimeout(() => {
            const content = fs.readFileSync(
                path.join(tmpDir, '.coogent', 'coogent.log'),
                'utf-8'
            );
            expect(content).toContain('[DEBUG]');
            expect(content).toContain('[Test] debug message');
            done();
        }, 100);
    });

    it('should not monkey-patch console methods', () => {
        const origLog = console.log;
        const origInfo = console.info;
        const origWarn = console.warn;
        const origError = console.error;
        const origDebug = console.debug;

        const ls = new LogStream(tmpDir);
        // After construction, console methods should remain untouched
        expect(console.log).toBe(origLog);
        expect(console.info).toBe(origInfo);
        expect(console.warn).toBe(origWarn);
        expect(console.error).toBe(origError);
        expect(console.debug).toBe(origDebug);

        ls.dispose();
        // After dispose, console methods should still be the same
        expect(console.log).toBe(origLog);
        expect(console.info).toBe(origInfo);
        expect(console.warn).toBe(origWarn);
        expect(console.error).toBe(origError);
        expect(console.debug).toBe(origDebug);
    });

    it('should include ISO timestamp in each line', (done) => {
        const ls = new LogStream(tmpDir);
        ls.log('timestamp-check');
        ls.dispose();

        setTimeout(() => {
            const content = fs.readFileSync(
                path.join(tmpDir, '.coogent', 'coogent.log'),
                'utf-8'
            );
            // ISO timestamp pattern: [2026-03-05T20:31:23.456Z]
            expect(content).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]/);
            done();
        }, 100);
    });

    it('should rotate when file exceeds configured max size', (done) => {
        const logDir = path.join(tmpDir, '.coogent');
        fs.mkdirSync(logDir, { recursive: true });
        const logPath = path.join(logDir, 'coogent.log');

        // Create a fake 6 MB file
        const buf = Buffer.alloc(6 * 1024 * 1024, 'x');
        fs.writeFileSync(logPath, buf);

        const ls = new LogStream(tmpDir);
        ls.dispose();

        // Wait for stream to close
        setTimeout(() => {
            // Old file should have been rotated to .log.1
            expect(fs.existsSync(`${logPath}.1`)).toBe(true);
            // Backup should be ~6 MB
            const backupSize = fs.statSync(`${logPath}.1`).size;
            expect(backupSize).toBeGreaterThan(5 * 1024 * 1024);
            // New log file should exist (and be small — just the startup marker)
            expect(fs.existsSync(logPath)).toBe(true);
            const newSize = fs.statSync(logPath).size;
            expect(newSize).toBeLessThan(1024);
            done();
        }, 100);
    });

    it('should stringify non-string arguments', (done) => {
        const ls = new LogStream(tmpDir);
        ls.log('object test:', { key: 'value' }, 42);
        ls.dispose();

        setTimeout(() => {
            const content = fs.readFileSync(
                path.join(tmpDir, '.coogent', 'coogent.log'),
                'utf-8'
            );
            expect(content).toContain('object test:');
            expect(content).toContain('"key":"value"');
            expect(content).toContain('42');
            done();
        }, 100);
    });

    // ─── Level filtering tests ─────────────────────────────────────────

    it('should filter messages below the configured level', (done) => {
        const ls = new LogStream(tmpDir, { level: LogLevel.WARN });
        ls.log('[Test] should NOT appear');
        ls.info('[Test] should NOT appear either');
        ls.debug('[Test] also hidden');
        ls.warn('[Test] warning visible');
        ls.error('[Test] error visible');
        ls.dispose();

        setTimeout(() => {
            const content = fs.readFileSync(
                path.join(tmpDir, '.coogent', 'coogent.log'),
                'utf-8'
            );
            expect(content).not.toContain('should NOT appear');
            expect(content).not.toContain('should NOT appear either');
            expect(content).not.toContain('also hidden');
            expect(content).toContain('warning visible');
            expect(content).toContain('error visible');
            done();
        }, 100);
    });

    it('should suppress all file output when level is OFF', (done) => {
        const ls = new LogStream(tmpDir, { level: LogLevel.OFF });
        ls.log('[Test] should NOT appear');
        ls.error('[Test] should NOT appear');
        ls.dispose();

        setTimeout(() => {
            const logPath = path.join(tmpDir, '.coogent', 'coogent.log');
            // File exists but should be empty (startup marker also suppressed)
            const content = fs.readFileSync(logPath, 'utf-8');
            expect(content).toBe('');
            done();
        }, 100);
    });

    it('setLevel() should change filtering at runtime', (done) => {
        const ls = new LogStream(tmpDir, { level: LogLevel.INFO });
        ls.log('[Test] info visible');
        ls.setLevel(LogLevel.ERROR);
        ls.log('[Test] info now hidden');
        ls.error('[Test] error still visible');
        ls.dispose();

        setTimeout(() => {
            const content = fs.readFileSync(
                path.join(tmpDir, '.coogent', 'coogent.log'),
                'utf-8'
            );
            expect(content).toContain('info visible');
            expect(content).not.toContain('info now hidden');
            expect(content).toContain('error still visible');
            done();
        }, 100);
    });

    it('should respect custom rotation config', (done) => {
        const logDir = path.join(tmpDir, '.coogent');
        fs.mkdirSync(logDir, { recursive: true });
        const logPath = path.join(logDir, 'coogent.log');

        // Create a 2 KB file — small enough for default, big enough for custom
        const buf = Buffer.alloc(2 * 1024, 'x');
        fs.writeFileSync(logPath, buf);

        // With custom maxLogBytes of 1 KB, 2 KB file should trigger rotation
        const ls = new LogStream(tmpDir, { maxLogBytes: 1024 });
        ls.dispose();

        setTimeout(() => {
            expect(fs.existsSync(`${logPath}.1`)).toBe(true);
            done();
        }, 100);
    });

    it('getLevel() should return the current level', () => {
        const ls = new LogStream(tmpDir, { level: LogLevel.WARN });
        expect(ls.getLevel()).toBe(LogLevel.WARN);
        ls.setLevel(LogLevel.ERROR);
        expect(ls.getLevel()).toBe(LogLevel.ERROR);
        ls.dispose();
    });
});
