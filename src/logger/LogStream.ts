// ─────────────────────────────────────────────────────────────────────────────
// src/logger/LogStream.ts — Centralized file-backed log stream
// ─────────────────────────────────────────────────────────────────────────────
//
// Monkey-patches console.log / console.info / console.warn / console.error /
// console.debug / console.trace so every message is additionally appended to
// `.coogent/coogent.log` with an ISO timestamp and level tag.
// The original console behaviour is preserved (Extension Host output channel
// keeps working).
//
// Log levels: TRACE < DEBUG < INFO < WARN < ERROR < OFF
// Only messages at or above the configured level are written to the file.
//
// Lifecycle:
//   1. Instantiate at the top of activate()  → opens append stream
//   2. Call dispose() in deactivate()        → restores originals, flushes stream
//
// Log rotation: on construction, if the current log exceeds maxLogBytes it
// is renamed to `coogent.log.1` (keeping at most maxBackups files).
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs';
import * as path from 'node:path';

// ═══════════════════════════════════════════════════════════════════════════════
//  Log Levels
// ═══════════════════════════════════════════════════════════════════════════════

export enum LogLevel {
    TRACE = 0,
    DEBUG = 1,
    INFO = 2,
    WARN = 3,
    ERROR = 4,
    OFF = 5,
}

/** Parse a user-facing level string into a LogLevel enum value. */
export function parseLogLevel(level: string): LogLevel {
    switch (level.toLowerCase()) {
        case 'trace': return LogLevel.TRACE;
        case 'debug': return LogLevel.DEBUG;
        case 'info': return LogLevel.INFO;
        case 'warn': return LogLevel.WARN;
        case 'error': return LogLevel.ERROR;
        case 'off': return LogLevel.OFF;
        default: return LogLevel.INFO;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Types
// ═══════════════════════════════════════════════════════════════════════════════

export interface LogStreamOptions {
    /** Minimum level to write (default: INFO). */
    level?: LogLevel;
    /** Max log file size in bytes before rotation (default: 5 MB). */
    maxLogBytes?: number;
    /** Number of rotated backups to keep (default: 2). */
    maxBackups?: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Constants
// ═══════════════════════════════════════════════════════════════════════════════

const LOG_FILENAME = 'coogent.log';
const DEFAULT_MAX_LOG_BYTES = 5 * 1024 * 1024;   // 5 MB
const DEFAULT_MAX_BACKUPS = 2;

// ═══════════════════════════════════════════════════════════════════════════════
//  LogStream
// ═══════════════════════════════════════════════════════════════════════════════

export class LogStream {
    private readonly logPath: string;
    private stream: fs.WriteStream | null = null;
    private level: LogLevel;
    private readonly maxLogBytes: number;
    private readonly maxBackups: number;

    // Saved originals — restored on dispose()
    private readonly _origLog: typeof console.log;
    private readonly _origInfo: typeof console.info;
    private readonly _origWarn: typeof console.warn;
    private readonly _origError: typeof console.error;
    private readonly _origDebug: typeof console.debug;
    private readonly _origTrace: typeof console.trace;

    constructor(workspaceRoot: string, options?: LogStreamOptions) {
        const logDir = path.join(workspaceRoot, '.coogent');
        this.logPath = path.join(logDir, LOG_FILENAME);
        this.level = options?.level ?? LogLevel.INFO;
        this.maxLogBytes = options?.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES;
        this.maxBackups = options?.maxBackups ?? DEFAULT_MAX_BACKUPS;

        // Preserve originals before patching
        this._origLog = console.log;
        this._origInfo = console.info;
        this._origWarn = console.warn;
        this._origError = console.error;
        this._origDebug = console.debug;
        this._origTrace = console.trace;

        try {
            // Ensure directory exists
            fs.mkdirSync(logDir, { recursive: true });

            // Rotate if the current log is too large
            this.rotate();

            // Open append stream
            this.stream = fs.createWriteStream(this.logPath, { flags: 'a', encoding: 'utf-8' });

            // Write startup marker
            this.writeLine(LogLevel.INFO, 'INFO', '════════════════════════════════════════════════════════════');
            this.writeLine(LogLevel.INFO, 'INFO', `Log stream started — ${new Date().toISOString()} [level=${LogLevel[this.level]}]`);
            this.writeLine(LogLevel.INFO, 'INFO', '════════════════════════════════════════════════════════════');

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
        console.info = this._origInfo;
        console.warn = this._origWarn;
        console.error = this._origError;
        console.debug = this._origDebug;
        console.trace = this._origTrace;

        if (this.stream) {
            this.writeLine(LogLevel.INFO, 'INFO', 'Log stream closed.');
            this.stream.end();
            this.stream = null;
        }
    }

    /** Path to the log file (useful for diagnostics). */
    getLogPath(): string {
        return this.logPath;
    }

    /** Update the minimum log level at runtime (e.g. on config change). */
    setLevel(level: LogLevel): void {
        this.writeLine(LogLevel.INFO, 'INFO', `Log level changed: ${LogLevel[this.level]} → ${LogLevel[level]}`);
        this.level = level;
    }

    /** Returns the current log level. */
    getLevel(): LogLevel {
        return this.level;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Internal — Patching
    // ═══════════════════════════════════════════════════════════════════════════

    private patch(): void {
        const self = this;

        console.log = (...args: unknown[]) => {
            self._origLog.apply(console, args);
            self.writeLine(LogLevel.INFO, 'INFO', self.formatArgs(args));
        };

        console.info = (...args: unknown[]) => {
            self._origInfo.apply(console, args);
            self.writeLine(LogLevel.INFO, 'INFO', self.formatArgs(args));
        };

        console.warn = (...args: unknown[]) => {
            self._origWarn.apply(console, args);
            self.writeLine(LogLevel.WARN, 'WARN', self.formatArgs(args));
        };

        console.error = (...args: unknown[]) => {
            self._origError.apply(console, args);
            self.writeLine(LogLevel.ERROR, 'ERROR', self.formatArgs(args));
        };

        console.debug = (...args: unknown[]) => {
            self._origDebug.apply(console, args);
            self.writeLine(LogLevel.DEBUG, 'DEBUG', self.formatArgs(args));
        };

        console.trace = (...args: unknown[]) => {
            self._origTrace.apply(console, args);
            self.writeLine(LogLevel.TRACE, 'TRACE', self.formatArgs(args));
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

    private writeLine(msgLevel: LogLevel, levelTag: string, message: string): void {
        if (!this.stream) return;
        if (msgLevel < this.level) return;  // ← Level gate
        const ts = new Date().toISOString();
        const paddedLevel = levelTag.padEnd(5);
        this.stream.write(`[${ts}] [${paddedLevel}] ${message}\n`);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Internal — Rotation
    // ═══════════════════════════════════════════════════════════════════════════

    private rotate(): void {
        try {
            const stat = fs.statSync(this.logPath);
            if (stat.size < this.maxLogBytes) return;
        } catch {
            // File doesn't exist yet — nothing to rotate
            return;
        }

        // Shift existing backups: .log.2 → delete, .log.1 → .log.2, .log → .log.1
        for (let i = this.maxBackups; i >= 1; i--) {
            const src = i === 1
                ? this.logPath
                : `${this.logPath}.${i - 1}`;
            const dst = `${this.logPath}.${i}`;
            try {
                if (i === this.maxBackups) {
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
