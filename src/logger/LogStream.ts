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

    // Re-patch timer — VS Code's Extension Host may overwrite our patches
    private _repatchTimer: ReturnType<typeof setInterval> | null = null;
    private _patched = false;

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

            // Re-apply patches periodically — VS Code's Extension Host may
            // overwrite our console patches after activate() returns.
            this._repatchTimer = setInterval(() => this.ensurePatched(), 500);
        } catch {
            // Best-effort — if we can't create the log file, don't break the extension
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Public API
    // ═══════════════════════════════════════════════════════════════════════════

    /** Flush the stream and restore original console methods. */
    dispose(): void {
        // Stop re-patching timer
        if (this._repatchTimer) {
            clearInterval(this._repatchTimer);
            this._repatchTimer = null;
        }

        // Restore originals first so any further console calls go through
        console.log = this._origLog;
        console.info = this._origInfo;
        console.warn = this._origWarn;
        console.error = this._origError;
        console.debug = this._origDebug;
        console.trace = this._origTrace;
        this._patched = false;

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
    //  Explicit Logging API — use these for guaranteed file output
    // ═══════════════════════════════════════════════════════════════════════════

    /** Log at INFO level (guaranteed to write to file). */
    log(...args: unknown[]): void {
        this._origLog.apply(console, args);
        this.writeLine(LogLevel.INFO, 'INFO', this.formatArgs(args));
    }

    /** Log at INFO level. */
    info(...args: unknown[]): void {
        this._origInfo.apply(console, args);
        this.writeLine(LogLevel.INFO, 'INFO', this.formatArgs(args));
    }

    /** Log at WARN level. */
    warn(...args: unknown[]): void {
        this._origWarn.apply(console, args);
        this.writeLine(LogLevel.WARN, 'WARN', this.formatArgs(args));
    }

    /** Log at ERROR level. */
    error(...args: unknown[]): void {
        this._origError.apply(console, args);
        this.writeLine(LogLevel.ERROR, 'ERROR', this.formatArgs(args));
    }

    /** Log at DEBUG level. */
    debug(...args: unknown[]): void {
        this._origDebug.apply(console, args);
        this.writeLine(LogLevel.DEBUG, 'DEBUG', this.formatArgs(args));
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Internal — Patching
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Re-check whether our patches are still in place. VS Code's Extension Host
     * may overwrite console methods after activate() returns.
     */
    private ensurePatched(): void {
        // Quick identity check: if console.log is NOT our wrapper, re-patch.
        // We tag our wrappers with a `__coogentPatched` marker.
        if (!(console.log as any).__coogentPatched) {
            this.patch();
        }
    }

    private patch(): void {
        const self = this;

        // ALWAYS capture the CURRENT console methods as upstream.
        // When VS Code's Extension Host overwrites our patches, the current
        // console.* methods are VS Code's versions — we must chain through
        // them so the Extension Host output channel keeps working.
        const upstreamLog = console.log;
        const upstreamInfo = console.info;
        const upstreamWarn = console.warn;
        const upstreamError = console.error;
        const upstreamDebug = console.debug;
        const upstreamTrace = console.trace;

        const makeWrapper = (
            upstream: (...args: unknown[]) => void,
            level: LogLevel,
            tag: string
        ) => {
            const wrapper = (...args: unknown[]) => {
                upstream.apply(console, args);
                self.writeLine(level, tag, self.formatArgs(args));
            };
            (wrapper as any).__coogentPatched = true;
            return wrapper;
        };

        console.log = makeWrapper(upstreamLog, LogLevel.INFO, 'INFO');
        console.info = makeWrapper(upstreamInfo, LogLevel.INFO, 'INFO');
        console.warn = makeWrapper(upstreamWarn, LogLevel.WARN, 'WARN');
        console.error = makeWrapper(upstreamError, LogLevel.ERROR, 'ERROR');
        console.debug = makeWrapper(upstreamDebug, LogLevel.DEBUG, 'DEBUG');
        console.trace = makeWrapper(upstreamTrace, LogLevel.TRACE, 'TRACE');

        this._patched = true;
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
