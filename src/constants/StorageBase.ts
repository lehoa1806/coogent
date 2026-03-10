// ─────────────────────────────────────────────────────────────────────────────
// src/constants/StorageBase.ts — Unified storage-base abstraction
// ─────────────────────────────────────────────────────────────────────────────
//
// Single-root storage model (local debug):
//
//   All data lives under <workspaceRoot>/.coogent/:
//     → artifacts.db, backups/, ipc/, debug/, pid/, logs/, sessions/
//
//   The storageUri parameter is accepted for API compatibility but ignored.
//   Everything routes to the workspace .coogent/ directory.
// ─────────────────────────────────────────────────────────────────────────────

import * as path from 'node:path';

import { COOGENT_DIR, DATABASE_FILE, IPC_DIR, LOG_DIR } from './paths.js';

/** Directory name for periodic backup snapshots. */
const BACKUPS_DIR = 'backups';

/** Directory name for session-scoped data. */
const SESSIONS_DIR = 'sessions';

/**
 * Unified storage-base abstraction.
 *
 * All data (DB, backups, IPC, logs, sessions) routes to
 * `<workspaceRoot>/.coogent/` for local debug visibility.
 */
export class StorageBase {
    /** Workspace-local storage root for all data. */
    private readonly workspaceBase: string;

    constructor(
        _storageUri: string | undefined,
        workspaceRoot: string,
    ) {
        this.workspaceBase = path.join(workspaceRoot, COOGENT_DIR);
    }

    /** Root directory for durable storage (DB, backups). Same as workspace base. */
    getDurableBase(): string {
        return this.workspaceBase;
    }

    /** Root directory for workspace-local storage (IPC, logs, sessions). */
    getWorkspaceBase(): string {
        return this.workspaceBase;
    }

    /** Absolute path to the SQLite database file. */
    getDBPath(): string {
        return path.join(this.workspaceBase, DATABASE_FILE);
    }

    /** Absolute path to the backups directory. */
    getBackupDir(): string {
        return path.join(this.workspaceBase, BACKUPS_DIR);
    }

    /** Absolute path to the logs directory. */
    getLogsDir(): string {
        return path.join(this.workspaceBase, LOG_DIR);
    }

    /** Absolute path to a session-specific directory. */
    getSessionDir(sessionId: string): string {
        return path.join(this.workspaceBase, SESSIONS_DIR, sessionId);
    }

    /** Absolute path to the IPC root directory. */
    getIPCDir(): string {
        return path.join(this.workspaceBase, IPC_DIR);
    }
}

/**
 * Factory function for creating a {@link StorageBase} instance.
 *
 * Prefer this over `new StorageBase(…)` if you want a clear functional
 * entry-point for dependency injection or testing.
 */
export function createStorageBase(
    storageUri: string | undefined,
    workspaceRoot: string,
): StorageBase {
    return new StorageBase(storageUri, workspaceRoot);
}
