// ─────────────────────────────────────────────────────────────────────────────
// src/mcp/ArtifactDBBackup.ts — Periodic snapshot/backup system for ArtifactDB
// ─────────────────────────────────────────────────────────────────────────────
//
// Provides self-contained SQLite backup files (full copies, not diffs) with
// atomic writes to prevent partial backups on crash. Supports rotation to
// bound disk usage and restore for corruption recovery.
//
// All I/O uses `node:fs/promises` for non-blocking operation.

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import log from '../logger/log.js';

/** Default maximum number of backup files to retain. */
const DEFAULT_MAX_BACKUPS = 3;

/**
 * Manages periodic snapshots and restores for the ArtifactDB SQLite file.
 *
 * Backups are self-contained SQLite database copies stored in a dedicated
 * directory, named with ISO timestamps for chronological sorting.
 *
 * All write operations use atomic rename (write to `.tmp`, then `fs.rename`)
 * to prevent partial files on crash.
 */
export class ArtifactDBBackup {
    private readonly dbPath: string;
    private readonly backupDir: string;

    constructor(dbPath: string, backupDir: string) {
        this.dbPath = dbPath;
        this.backupDir = backupDir;
    }

    /**
     * Create a timestamped backup of the current database file.
     *
     * The backup is written atomically: first to a `.tmp` file, then renamed
     * to the final path. Returns the absolute path of the created backup.
     *
     * @returns Absolute path to the newly created backup file.
     * @throws If the source database file does not exist or I/O fails.
     */
    async createSnapshot(): Promise<string> {
        // Ensure backup directory exists
        await fsp.mkdir(this.backupDir, { recursive: true });

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupName = `artifacts-${timestamp}.db`;
        const backupPath = path.join(this.backupDir, backupName);
        const tmpPath = backupPath + '.tmp';

        // Atomic copy: write to temp, then rename
        await fsp.copyFile(this.dbPath, tmpPath);
        await fsp.rename(tmpPath, backupPath);

        log.info(`[ArtifactDBBackup] Snapshot created: ${backupName}`);
        return backupPath;
    }

    /**
     * Rotate backups to keep only the N most recent files.
     *
     * Scans the backup directory for files matching the `artifacts-*.db`
     * pattern, sorts them lexicographically (ISO timestamps sort correctly),
     * and deletes the oldest files beyond the limit.
     *
     * @param maxBackups Maximum number of backups to retain. Defaults to 3.
     */
    async rotateBackups(maxBackups: number = DEFAULT_MAX_BACKUPS): Promise<void> {
        let entries: string[];
        try {
            entries = await fsp.readdir(this.backupDir);
        } catch {
            // Backup directory doesn't exist yet — nothing to rotate
            return;
        }

        const backups = entries
            .filter(f => f.startsWith('artifacts-') && f.endsWith('.db') && !f.endsWith('.tmp'))
            .sort(); // Lexicographic — ISO timestamps sort chronologically

        if (backups.length <= maxBackups) {
            return;
        }

        const toDelete = backups.slice(0, backups.length - maxBackups);
        for (const old of toDelete) {
            const fullPath = path.join(this.backupDir, old);
            await fsp.unlink(fullPath).catch(() => { /* best-effort */ });
            log.info(`[ArtifactDBBackup] Rotated old backup: ${old}`);
        }
    }

    /**
     * Get the path to the most recent backup file.
     *
     * @returns Absolute path to the newest backup, or `null` if no backups exist.
     */
    async getLatestBackup(): Promise<string | null> {
        let entries: string[];
        try {
            entries = await fsp.readdir(this.backupDir);
        } catch {
            return null;
        }

        const backups = entries
            .filter(f => f.startsWith('artifacts-') && f.endsWith('.db') && !f.endsWith('.tmp'))
            .sort();

        if (backups.length === 0) {
            return null;
        }

        return path.join(this.backupDir, backups[backups.length - 1]);
    }

    /**
     * Restore the database from a backup file.
     *
     * Uses atomic write: copies the backup to a `.tmp` file adjacent to the
     * database path, then renames it into place. This ensures the DB file is
     * never in a partially-written state.
     *
     * @param backupPath Absolute path to the backup file to restore from.
     * @throws If the backup file does not exist.
     */
    async restoreFromBackup(backupPath: string): Promise<void> {
        // Verify backup exists
        try {
            await fsp.access(backupPath);
        } catch {
            throw new Error(`Backup file not found: ${backupPath}`);
        }

        const tmpPath = this.dbPath + '.restore.tmp';

        // Atomic restore: copy backup to temp, then rename over DB
        await fsp.copyFile(backupPath, tmpPath);
        await fsp.rename(tmpPath, this.dbPath);

        log.info(`[ArtifactDBBackup] Database restored from: ${backupPath}`);
        log.warn('[ArtifactDBBackup] Restart required to reload database from disk.');
    }
}
