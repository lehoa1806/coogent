// ─────────────────────────────────────────────────────────────────────────────
// src/logger/log.ts — Singleton accessor for the global LogStream
// ─────────────────────────────────────────────────────────────────────────────
//
// Usage:
//   import log from '../logger/log.js';
//   log.info('[Module] message');
//   somePromise.catch(log.onError);
//
// Lifecycle (managed in extension.ts):
//   1. initLog(workspaceRoot, options) — call once in activate()
//   2. disposeLog()                   — call once in deactivate()
// ─────────────────────────────────────────────────────────────────────────────

import { LogStream, LogLevel, type LogStreamOptions } from './LogStream.js';

let _instance: LogStream | undefined;

/** Create and store the global LogStream instance. Call once in activate(). */
export function initLog(workspaceRoot: string, options?: LogStreamOptions): LogStream {
    _instance = new LogStream(workspaceRoot, options);
    return _instance;
}

/** Close the global LogStream. Call once in deactivate(). */
export function disposeLog(): void {
    _instance?.dispose();
    _instance = undefined;
}

/**
 * Global log proxy — safe to call before initLog() (calls are silently dropped).
 *
 * Import as:  import log from '../logger/log.js';
 * Then use:   log.info('message');  log.warn('problem');  promise.catch(log.onError);
 */
const log = {
    log: (...args: unknown[]): void => { _instance?.log(...args); },
    info: (...args: unknown[]): void => { _instance?.info(...args); },
    warn: (...args: unknown[]): void => { _instance?.warn(...args); },
    error: (...args: unknown[]): void => { _instance?.error(...args); },
    debug: (...args: unknown[]): void => { _instance?.debug(...args); },

    /** Use as `.catch(log.onError)` to replace `.catch(console.error)`. */
    onError: (err: unknown): void => { _instance?.error(String(err)); },

    setLevel: (level: LogLevel): void => { _instance?.setLevel(level); },
    getLevel: (): LogLevel | undefined => _instance?.getLevel(),
    getLogPath: (): string | undefined => _instance?.getLogPath(),
};

export default log;
export { LogLevel };
