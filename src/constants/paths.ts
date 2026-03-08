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
//   User-visible data in the workspace. Includes logs, config, plugins,
//   and currently the database. Must be gitignored. Survives extension
//   updates but is workspace-scoped.
//
// ### Session / Runtime  (storageBase from context.storageUri)
//   Short-lived data tied to a single extension activation. May be
//   deleted between sessions. Lives under VS Code extension-managed
//   storage, NOT in the user's workspace tree.
//
// ### IPC  (storageBase / ipc / <sessionDirName> /)
//   Transient exchange files for master↔worker communication. Must NOT
//   be treated as durable state. Cleaned up via TTL.
// ─────────────────────────────────────────────────────────────────────────────

import * as path from 'node:path';

// ═══════════════════════════════════════════════════════════════════════════════
//  Directory Names
// ═══════════════════════════════════════════════════════════════════════════════

/** Top-level workspace directory for Coogent data. NOT for IPC sessions. */
export const COOGENT_DIR = '.coogent';

/** Session IPC exchange directory. Rooted under storageBase. */
export const IPC_DIR = 'ipc';

/** Worker PID registry directory. Rooted under workspaceRoot/.coogent/. Runtime-only. */
export const PID_DIR = 'pid';

/** Telemetry JSONL run directories. Rooted under workspaceRoot/.coogent/. */
export const LOG_DIR = 'logs';

/** Debug clone output (prompts, plans). Rooted under storageBase. Deletable cache. */
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
 * ⚠️ Currently stored under workspaceRoot/.coogent/ which puts it in the
 * user's repo tree. Future direction: move to context.storageUri or
 * extensionPath so durable state doesn't pollute workspace repos.
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
 * Currently workspace-scoped (`<workspaceRoot>/.coogent/artifacts.db`).
 */
export function getDatabasePath(workspaceRoot: string): string {
    return path.join(workspaceRoot, COOGENT_DIR, DATABASE_FILE);
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
//  Root: storageBase (from context.storageUri)
// ═══════════════════════════════════════════════════════════════════════════════

/** Absolute path to the IPC root directory (`<storageBase>/ipc/`). */
export function getIpcRoot(storageBase: string): string {
    return path.join(storageBase, IPC_DIR);
}

/** Absolute path to a specific session's IPC directory (`<storageBase>/ipc/<dirName>/`). */
export function getSessionDir(storageBase: string, sessionDirName: string): string {
    return path.join(storageBase, IPC_DIR, sessionDirName);
}

/** Absolute path to the debug output directory for a session (`<storageBase>/debug/<dirName>/`). */
export function getDebugDir(storageBase: string, sessionDirName: string): string {
    return path.join(storageBase, DEBUG_DIR, sessionDirName);
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
