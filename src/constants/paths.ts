// ─────────────────────────────────────────────────────────────────────────────
// src/constants/paths.ts — Canonical path constants and builders
// ─────────────────────────────────────────────────────────────────────────────
//
// This is the SINGLE SOURCE OF TRUTH for all filesystem paths, directory
// names, and file names used by Coogent. No other module may construct
// storage paths using raw string literals.
//
// ## Storage Model
//
// ### Workspace-Level  (workspaceRoot / .coogent /)
//   All data lives here: logs, config, plugins, session/IPC data,
//   the database, and backups. Must be gitignored.
//   This keeps everything local for easy debugging.
//
// ### IPC  (workspaceRoot / .coogent / ipc / <sessionDirName> /)
//   Transient exchange files for master↔worker communication. Must NOT
//   be treated as durable state. Cleaned up via TTL.
// ─────────────────────────────────────────────────────────────────────────────

import * as path from 'node:path';

// ═══════════════════════════════════════════════════════════════════════════════
//  Directory Names
// ═══════════════════════════════════════════════════════════════════════════════

/** Top-level workspace directory for Coogent data. NOT for IPC sessions. */
export const COOGENT_DIR = '.coogent';

/** Session IPC exchange directory. Rooted under workspaceRoot/.coogent/. */
export const IPC_DIR = 'ipc';

/** Worker PID registry directory. Rooted under workspaceRoot/.coogent/. Runtime-only. */
export const PID_DIR = 'pid';

/** Telemetry JSONL run directories. Rooted under workspaceRoot/.coogent/. */
export const LOG_DIR = 'logs';

/** Debug clone output (prompts, plans). Rooted under workspaceRoot/.coogent/. Deletable cache. */
export const DEBUG_DIR = 'debug';

/** MCP plugin directories. Rooted under workspaceRoot/.coogent/. User-facing config. */
export const PLUGIN_DIR = 'plugins';

// ═══════════════════════════════════════════════════════════════════════════════
//  File Names
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Canonical filename for the persisted runbook (session-scoped, inside IPC session dir).
 *
 * Re-exported for backward compatibility with existing `types/phase.ts` consumers.
 */
export const RUNBOOK_FILE = '.task-runbook.json';

/** WAL crash-recovery file (session-scoped, auto-deleted on successful write). */
export const WAL_FILE = '.wal.json';

/** Advisory file lock (session-scoped, PID-based stale detection). */
export const LOCK_FILE = '.lock';

/**
 * SQLite persistent database filename.
 *
 * Stored under `<workspaceRoot>/.coogent/` for local debug visibility.
 */
export const DATABASE_FILE = 'artifacts.db';

/** Main log stream filename (rotated, workspace-scoped). */
export const LOG_FILE = 'coogent.log';

/** Engine state-transition log filename (per telemetry run). */
export const ENGINE_LOG_FILE = 'engine.jsonl';

/** Workspace-level agent profile configuration (user-editable). */
export const WORKERS_CONFIG_FILE = 'workers.json';

/** File-based IPC prompt file (per subtask). */
export const IPC_REQUEST_FILE = 'request.md';

/** File-based IPC response file (per subtask). */
export const IPC_RESPONSE_FILE = 'response.md';

/** Plugin manifest file (per plugin directory). */
export const PLUGIN_MANIFEST_FILE = 'plugin.json';

// ═══════════════════════════════════════════════════════════════════════════════
//  Workspace-Level Path Builders
//  Root: workspaceRoot / .coogent /
// ═══════════════════════════════════════════════════════════════════════════════

/** Absolute path to the workspace-level `.coogent` directory. */
export function getCoogentDir(workspaceRoot: string): string {
    return path.join(workspaceRoot, COOGENT_DIR);
}

/**
 * Absolute path to the SQLite database file.
 * Lives under `<coogentDir>/artifacts.db` for local debug visibility.
 */
export function getDatabasePath(coogentDir: string): string {
    return path.join(coogentDir, DATABASE_FILE);
}

/** Absolute path to the main log file (`<workspaceRoot>/.coogent/coogent.log`). */
export function getLogFilePath(workspaceRoot: string): string {
    return path.join(workspaceRoot, COOGENT_DIR, LOG_FILE);
}

/** Absolute path to the telemetry JSONL log directory (`<workspaceRoot>/.coogent/logs/`). */
export function getTelemetryLogDir(workspaceRoot: string): string {
    return path.join(workspaceRoot, COOGENT_DIR, LOG_DIR);
}

/** Absolute path to the worker PID registry directory (`<workspaceRoot>/.coogent/pid/`). */
export function getPidDir(workspaceRoot: string): string {
    return path.join(workspaceRoot, COOGENT_DIR, PID_DIR);
}

/** Absolute path to the MCP plugins directory (`<workspaceRoot>/.coogent/plugins/`). */
export function getPluginsDir(workspaceRoot: string): string {
    return path.join(workspaceRoot, COOGENT_DIR, PLUGIN_DIR);
}

/** Absolute path to the workspace `workers.json` config file. */
export function getWorkersConfigPath(workspaceRoot: string): string {
    return path.join(workspaceRoot, COOGENT_DIR, WORKERS_CONFIG_FILE);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Session-Level Path Builders
//  Root: workspaceRoot / .coogent /
// ═══════════════════════════════════════════════════════════════════════════════

/** Absolute path to the IPC root directory (`<coogentDir>/ipc/`). */
export function getIpcRoot(coogentDir: string): string {
    return path.join(coogentDir, IPC_DIR);
}

/** Absolute path to a specific session's IPC directory (`<coogentDir>/ipc/<dirName>/`). */
export function getSessionDir(coogentDir: string, sessionDirName: string): string {
    return path.join(coogentDir, IPC_DIR, sessionDirName);
}

/** Absolute path to the debug output directory for a session (`<coogentDir>/debug/<dirName>/`). */
export function getDebugDir(coogentDir: string, sessionDirName: string): string {
    return path.join(coogentDir, DEBUG_DIR, sessionDirName);
}

/** Absolute path to the runbook file within a session directory. */
export function getRunbookPath(sessionDir: string): string {
    return path.join(sessionDir, RUNBOOK_FILE);
}

/** Absolute path to the WAL file within a session directory. */
export function getWalPath(sessionDir: string): string {
    return path.join(sessionDir, WAL_FILE);
}

/** Absolute path to the lock file within a session directory. */
export function getLockPath(sessionDir: string): string {
    return path.join(sessionDir, LOCK_FILE);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  IPC File Builders (AntigravityADKAdapter)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build the IPC subtask directory path.
 *
 * When `masterTaskId` is provided, produces a hierarchical path:
 *   `<ipcRoot>/<masterTaskId>/<subTaskName>/`
 *
 * Without a master task ID, produces a flat path:
 *   `<ipcRoot>/<subTaskName>/`
 */
export function getIpcSubtaskDir(
    ipcRoot: string,
    masterTaskId: string | undefined,
    subTaskName: string,
): string {
    return masterTaskId
        ? path.join(ipcRoot, masterTaskId, subTaskName)
        : path.join(ipcRoot, subTaskName);
}

/** Absolute path to the IPC request file within a subtask directory. */
export function getIpcRequestPath(subTaskDir: string): string {
    return path.join(subTaskDir, IPC_REQUEST_FILE);
}

/** Absolute path to the IPC response file within a subtask directory. */
export function getIpcResponsePath(subTaskDir: string): string {
    return path.join(subTaskDir, IPC_RESPONSE_FILE);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Unified Storage Base (P1.2)
//  Re-exported for convenience — prefer StorageBase for new code.
// ═══════════════════════════════════════════════════════════════════════════════

export { StorageBase, createStorageBase } from './StorageBase.js';
