// ─────────────────────────────────────────────────────────────────────────────
// src/logger/LogStream.ts — Centralized file-backed log stream
// ─────────────────────────────────────────────────────────────────────────────
//
// Monkey-patches console.log / console.warn / console.error so every message
// is additionally appended to `.coogent/coogent.log` with an ISO timestamp
// and level tag.  The original console behaviour is preserved (Extension Host
// output channel keeps working).
//
// Lifecycle:
//   1. Instantiate at the top of activate()  → opens append stream
//   2. Call dispose() in deactivate()        → restores originals, flushes stream
//
// Log rotation: on construction, if the current log exceeds MAX_LOG_BYTES it
// is renamed to `coogent.log.1` (keeping at most MAX_BACKUPS files).
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs';
import * as path from 'node:path';

// ═══════════════════════════════════════════════════════════════════════════════
//  Constants
// ═══════════════════════════════════════════════════════════════════════════════

const LOG_FILENAME = 'coogent.log';
const MAX_LOG_BYTES = 5 * 1024 * 1024;   // 5 MB
const MAX_BACKUPS = 2;

// ═══════════════════════════════════════════════════════════════════════════════
//  LogStream
// ═══════════════════════════════════════════════════════════════════════════════

export class LogStream {
    private readonly logPath: string;
    private stream: fs.WriteStream | null = null;

    // Saved originals — restored on dispose()
    private readonly _origLog: typeof console.log;
    private readonly _origWarn: typeof console.warn;
    private readonly _origError: typeof console.error;

    constructor(workspaceRoot: string) {
        const logDir = path.join(workspaceRoot, '.coogent');
        this.logPath = path.join(logDir, LOG_FILENAME);

        // Preserve originals before patching
        this._origLog = console.log;
        this._origWarn = console.warn;
        this._origError = console.error;

        try {
            // Ensure directory exists
            fs.mkdirSync(logDir, { recursive: true });

            // Rotate if the current log is too large
            this.rotate();

            // Open append stream
            this.stream = fs.createWriteStream(this.logPath, { flags: 'a', encoding: 'utf-8' });

            // Write startup marker
            this.writeLine('INFO', '════════════════════════════════════════════════════════════');
            this.writeLine('INFO', `Log stream started — ${new Date().toISOString()}`);
            this.writeLine('INFO', '════════════════════════════════════════════════════════════');

            // Patch console methods
            this.patch();
        } catch {
            // Best-effort — if we can't create the log file, don't break the extension
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Public API
    // ═══════════════════════════════════════════════════════════════════════════

    /** Flush the stream and restore original console methods. */
    dispose(): void {
        // Restore originals first so any further console calls go through
        console.log = this._origLog;
        console.warn = this._origWarn;
        console.error = this._origError;

        if (this.stream) {
            this.writeLine('INFO', 'Log stream closed.');
            this.stream.end();
            this.stream = null;
        }
    }

    /** Path to the log file (useful for diagnostics). */
    getLogPath(): string {
        return this.logPath;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Internal — Patching
    // ═══════════════════════════════════════════════════════════════════════════

    private patch(): void {
        const self = this;

        console.log = (...args: unknown[]) => {
            self._origLog.apply(console, args);
            self.writeLine('INFO', self.formatArgs(args));
        };

        console.warn = (...args: unknown[]) => {
            self._origWarn.apply(console, args);
            self.writeLine('WARN', self.formatArgs(args));
        };

        console.error = (...args: unknown[]) => {
            self._origError.apply(console, args);
            self.writeLine('ERROR', self.formatArgs(args));
        };
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Internal — Formatting & Writing
    // ═══════════════════════════════════════════════════════════════════════════

    private formatArgs(args: unknown[]): string {
        return args
            .map(a => {
                if (typeof a === 'string') return a;
                try {
                    return JSON.stringify(a);
                } catch {
                    return String(a);
                }
            })
            .join(' ');
    }

    private writeLine(level: string, message: string): void {
        if (!this.stream) return;
        const ts = new Date().toISOString();
        const paddedLevel = level.padEnd(5);
        this.stream.write(`[${ts}] [${paddedLevel}] ${message}\n`);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Internal — Rotation
    // ═══════════════════════════════════════════════════════════════════════════

    private rotate(): void {
        try {
            const stat = fs.statSync(this.logPath);
            if (stat.size < MAX_LOG_BYTES) return;
        } catch {
            // File doesn't exist yet — nothing to rotate
            return;
        }

        // Shift existing backups: .log.2 → delete, .log.1 → .log.2, .log → .log.1
        for (let i = MAX_BACKUPS; i >= 1; i--) {
            const src = i === 1
                ? this.logPath
                : `${this.logPath}.${i - 1}`;
            const dst = `${this.logPath}.${i}`;
            try {
                if (i === MAX_BACKUPS) {
                    fs.unlinkSync(dst); // delete oldest
                }
            } catch {
                // file may not exist
            }
            try {
                fs.renameSync(src, dst);
            } catch {
                // source may not exist
            }
        }
    }
}
