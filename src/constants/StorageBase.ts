// ─────────────────────────────────────────────────────────────────────────────
// src/constants/StorageBase.ts — Hybrid storage-base abstraction
// ─────────────────────────────────────────────────────────────────────────────
//
// ADR-001 Hybrid Storage Topology:
//
//   ┌─ GLOBAL (durable, shared across workspaces) ──────────────────────────┐
//   │  ~/Library/Application Support/Antigravity/coogent/                   │
//   │    → artifacts.db          (tenant-scoped via workspace_id)           │
//   │    → backups/              (rotating snapshot copies)                  │
//   └────────────────────────────────────────────────────────────────────────┘
//
//   ┌─ LOCAL (workspace-scoped operational state) ──────────────────────────┐
//   │  <workspaceRoot>/.coogent/                                            │
//   │    → ipc/, pid/, logs/, sessions/, debug/, plugins/                   │
//   │    → workers.json, coogent.log                                        │
//   └────────────────────────────────────────────────────────────────────────┘
//
// ─────────────────────────────────────────────────────────────────────────────

import * as path from 'node:path';

import {
    COOGENT_DIR,
    IPC_DIR,
    LOG_DIR,
    getGlobalDatabasePath,
    getGlobalBackupDir,
    getGlobalCoogentDir,
} from './paths.js';
import { deriveWorkspaceId } from './WorkspaceIdentity.js';

/** Directory name for session-scoped data. */
const SESSIONS_DIR = 'sessions';

/**
 * Hybrid storage-base abstraction.
 *
 * Routes **durable artefacts** (DB, backups) to the global Antigravity
 * directory and **operational state** (IPC, logs, sessions) to the
 * workspace-local `.coogent/` directory.
 */
export class StorageBase {
    /** Workspace-local storage root for operational data. */
    private readonly workspaceBase: string;

    /** Stable tenant identity derived from the workspace root (ADR-002). */
    private readonly workspaceId: string;

    constructor(
        _storageUri: string | undefined,
        workspaceRoot: string,
    ) {
        this.workspaceBase = path.join(workspaceRoot, COOGENT_DIR);
        this.workspaceId = deriveWorkspaceId(workspaceRoot);
    }

    // ── Tenant Identity ─────────────────────────────────────────────────

    /** Stable workspace tenant ID (16-hex-char SHA-256 prefix). */
    getWorkspaceId(): string {
        return this.workspaceId;
    }

    // ── Global (durable) paths ─────────────────────────────────────────

    /** Global base directory for durable storage (DB, backups). */
    getDurableBase(): string {
        return getGlobalCoogentDir();
    }

    /** Absolute path to the global SQLite database file. */
    getDBPath(): string {
        return getGlobalDatabasePath();
    }

    /** Absolute path to the global backups directory. */
    getBackupDir(): string {
        return getGlobalBackupDir();
    }

    // ── Local (workspace-operational) paths ─────────────────────────────

    /** Root directory for workspace-local operational storage (IPC, logs, sessions). */
    getWorkspaceBase(): string {
        return this.workspaceBase;
    }

    /** Absolute path to the workspace logs directory. */
    getLogsDir(): string {
        return path.join(this.workspaceBase, LOG_DIR);
    }

    /** Absolute path to a session-specific workspace directory. */
    getSessionDir(sessionId: string): string {
        return path.join(this.workspaceBase, SESSIONS_DIR, sessionId);
    }

    /** Absolute path to the workspace IPC root directory. */
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
