// ─────────────────────────────────────────────────────────────────────────────
// src/constants/storage.ts — Storage class enum and boundary documentation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Enumerates the storage lifecycle classes used throughout Coogent.
 * Every path constant and directory should be annotated with one of
 * these classes to make its cleanup policy and durability guarantees
 * immediately clear.
 */
export enum StorageClass {
    /** Short-lived session data. Under `storageBase/ipc/<sessionDir>/`. */
    SESSION = 'session',

    /** Transient IPC exchange files (request.md, response.md). Must NOT contain durable state. */
    IPC = 'ipc',

    /** Durable product data (database, config). Must survive session cleanup. */
    PERSISTENT = 'persistent',

    /** Log files (rotated, bounded). Under `workspaceRoot/.coogent/`. */
    LOG = 'log',

    /** Deletable debug/cache outputs. Under `storageBase/debug/`. */
    CACHE = 'cache',

    /** User-facing configuration (workers.json, plugins). Under `workspaceRoot/.coogent/`. */
    CONFIG = 'config',

    /** Runtime-only ephemeral data (PID files). Under `workspaceRoot/.coogent/pid/`. */
    RUNTIME = 'runtime',
}
