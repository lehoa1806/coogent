import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { LogStream } from '../LogStream.js';

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

    it('should capture console.log with INFO level', (done) => {
        const ls = new LogStream(tmpDir);
        console.log('[Test] hello from test');
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

    it('should capture console.warn with WARN level', (done) => {
        const ls = new LogStream(tmpDir);
        console.warn('[Test] a warning');
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

    it('should capture console.error with ERROR level', (done) => {
        const ls = new LogStream(tmpDir);
        console.error('[Test] an error');
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

    it('should restore original console methods on dispose', () => {
        const origLog = console.log;
        const origWarn = console.warn;
        const origError = console.error;

        const ls = new LogStream(tmpDir);
        // After construction, console.log should be patched (different reference)
        expect(console.log).not.toBe(origLog);

        ls.dispose();
        // After dispose, originals should be restored
        expect(console.log).toBe(origLog);
        expect(console.warn).toBe(origWarn);
        expect(console.error).toBe(origError);
    });

    it('should include ISO timestamp in each line', (done) => {
        const ls = new LogStream(tmpDir);
        console.log('timestamp-check');
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

    it('should rotate when file exceeds 5 MB', (done) => {
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
        console.log('object test:', { key: 'value' }, 42);
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
});
