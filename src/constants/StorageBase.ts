// ─────────────────────────────────────────────────────────────────────────────
// src/constants/StorageBase.ts — Unified storage-base abstraction
// ─────────────────────────────────────────────────────────────────────────────
//
// P1.2: Resolves the split between documented `storageUri` behaviour and
// workspace-local `.coogent` behaviour by providing a single StorageBase
// class that all path derivations can delegate to.
//
// This phase creates the abstraction only — call-site migration is a
// follow-up task.
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
 * Encapsulates the decision of *where* Coogent stores data at runtime:
 * - If `storageUri` is provided (VS Code extension-managed storage), all
 *   paths derive from that URI.
 * - Otherwise, paths fall back to `<workspaceRoot>/.coogent`.
 *
 * All methods are **deterministic and stateless** — they perform pure path
 * computation with no filesystem side-effects.
 */
export class StorageBase {
    private readonly base: string;

    constructor(
        storageUri: string | undefined,
        workspaceRoot: string,
    ) {
        this.base = storageUri ?? path.join(workspaceRoot, COOGENT_DIR);
    }

    /** Root storage directory. */
    getBase(): string {
        return this.base;
    }

    /** Absolute path to the SQLite database file. */
    getDBPath(): string {
        return path.join(this.base, DATABASE_FILE);
    }

    /** Absolute path to the logs directory. */
    getLogsDir(): string {
        return path.join(this.base, LOG_DIR);
    }

    /** Absolute path to a session-specific directory. */
    getSessionDir(sessionId: string): string {
        return path.join(this.base, SESSIONS_DIR, sessionId);
    }

    /** Absolute path to the backups directory. */
    getBackupDir(): string {
        return path.join(this.base, BACKUPS_DIR);
    }

    /** Absolute path to the IPC root directory. */
    getIPCDir(): string {
        return path.join(this.base, IPC_DIR);
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
