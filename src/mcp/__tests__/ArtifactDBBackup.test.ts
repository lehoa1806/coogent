// ─────────────────────────────────────────────────────────────────────────────
// ArtifactDBBackup.test.ts — Unit tests for ArtifactDB snapshot/backup system
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ArtifactDBBackup } from '../ArtifactDBBackup.js';

describe('ArtifactDBBackup', () => {
    let tmpDir: string;
    let dbPath: string;
    let backupDir: string;
    let backup: ArtifactDBBackup;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact-backup-test-'));
        dbPath = path.join(tmpDir, 'artifacts.db');
        backupDir = path.join(tmpDir, 'backups');

        // Create a fake DB file to back up
        await fs.writeFile(dbPath, 'SQLite database content v1');

        backup = new ArtifactDBBackup(dbPath, backupDir);
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    // ─── createSnapshot ──────────────────────────────────────────────────

    it('createSnapshot creates a file in the backup directory', async () => {
        const snapshotPath = await backup.createSnapshot();

        // File should exist
        const stat = await fs.stat(snapshotPath);
        expect(stat.isFile()).toBe(true);

        // Should be in the backup directory
        expect(path.dirname(snapshotPath)).toBe(backupDir);

        // Filename should match pattern: artifacts-<ISO-timestamp>.db
        const filename = path.basename(snapshotPath);
        expect(filename).toMatch(/^artifacts-\d{4}-\d{2}-\d{2}T.*\.db$/);

        // Content should match the source DB
        const content = await fs.readFile(snapshotPath, 'utf-8');
        expect(content).toBe('SQLite database content v1');
    });

    it('createSnapshot creates the backup directory if it does not exist', async () => {
        const nestedBackupDir = path.join(tmpDir, 'deep', 'nested', 'backups');
        const nestedBackup = new ArtifactDBBackup(dbPath, nestedBackupDir);

        const snapshotPath = await nestedBackup.createSnapshot();

        const stat = await fs.stat(snapshotPath);
        expect(stat.isFile()).toBe(true);
    });

    it('createSnapshot creates distinct files on successive calls', async () => {
        const first = await backup.createSnapshot();
        // Small delay to ensure different timestamps
        await new Promise(resolve => setTimeout(resolve, 10));
        const second = await backup.createSnapshot();

        expect(first).not.toBe(second);

        const entries = await fs.readdir(backupDir);
        const dbFiles = entries.filter(f => f.endsWith('.db') && !f.endsWith('.tmp'));
        expect(dbFiles.length).toBe(2);
    });

    // ─── rotateBackups ───────────────────────────────────────────────────

    it('rotateBackups keeps only N most recent backups', async () => {
        // Create 5 backups with distinct timestamps
        for (let i = 0; i < 5; i++) {
            await backup.createSnapshot();
            await new Promise(resolve => setTimeout(resolve, 10));
        }

        // Verify 5 backups exist
        let entries = await fs.readdir(backupDir);
        let dbFiles = entries.filter(f => f.endsWith('.db') && !f.endsWith('.tmp'));
        expect(dbFiles.length).toBe(5);

        // Rotate to keep only 2
        await backup.rotateBackups(2);

        entries = await fs.readdir(backupDir);
        dbFiles = entries.filter(f => f.endsWith('.db') && !f.endsWith('.tmp'));
        expect(dbFiles.length).toBe(2);
    });

    it('rotateBackups keeps the newest backups', async () => {
        // Create backups with known content progression
        for (let i = 1; i <= 4; i++) {
            await fs.writeFile(dbPath, `SQLite database content v${i}`);
            await backup.createSnapshot();
            await new Promise(resolve => setTimeout(resolve, 10));
        }

        await backup.rotateBackups(1);

        const entries = await fs.readdir(backupDir);
        const dbFiles = entries.filter(f => f.endsWith('.db') && !f.endsWith('.tmp'));
        expect(dbFiles.length).toBe(1);

        // The remaining backup should have the latest content
        const remaining = await fs.readFile(path.join(backupDir, dbFiles[0]), 'utf-8');
        expect(remaining).toBe('SQLite database content v4');
    });

    it('rotateBackups is a no-op when fewer than maxBackups exist', async () => {
        await backup.createSnapshot();

        await backup.rotateBackups(3);

        const entries = await fs.readdir(backupDir);
        const dbFiles = entries.filter(f => f.endsWith('.db') && !f.endsWith('.tmp'));
        expect(dbFiles.length).toBe(1);
    });

    it('rotateBackups handles non-existent backup directory gracefully', async () => {
        const emptyBackup = new ArtifactDBBackup(dbPath, path.join(tmpDir, 'no-such-dir'));

        // Should not throw
        await expect(emptyBackup.rotateBackups(3)).resolves.not.toThrow();
    });

    // ─── getLatestBackup ─────────────────────────────────────────────────

    it('getLatestBackup returns the newest backup file', async () => {
        await backup.createSnapshot();
        await new Promise(resolve => setTimeout(resolve, 10));

        await fs.writeFile(dbPath, 'SQLite database content v2');
        const secondPath = await backup.createSnapshot();

        const latest = await backup.getLatestBackup();
        expect(latest).toBe(secondPath);

        // Verify content is from the second snapshot
        const content = await fs.readFile(latest!, 'utf-8');
        expect(content).toBe('SQLite database content v2');
    });

    it('getLatestBackup returns null when no backups exist', async () => {
        const latest = await backup.getLatestBackup();
        expect(latest).toBeNull();
    });

    it('getLatestBackup returns null when backup directory does not exist', async () => {
        const emptyBackup = new ArtifactDBBackup(dbPath, path.join(tmpDir, 'no-such-dir'));

        const latest = await emptyBackup.getLatestBackup();
        expect(latest).toBeNull();
    });

    it('getLatestBackup ignores .tmp files', async () => {
        await fs.mkdir(backupDir, { recursive: true });

        // Write a .tmp file that looks like a backup
        await fs.writeFile(path.join(backupDir, 'artifacts-2026-03-09.db.tmp'), 'incomplete');

        const latest = await backup.getLatestBackup();
        expect(latest).toBeNull();
    });

    // ─── restoreFromBackup ───────────────────────────────────────────────

    it('restoreFromBackup overwrites the DB file with the backup', async () => {
        // Create a snapshot of v1
        const snapshotPath = await backup.createSnapshot();

        // Modify the "live" DB
        await fs.writeFile(dbPath, 'CORRUPTED database');

        // Restore from the v1 snapshot
        await backup.restoreFromBackup(snapshotPath);

        // DB should now contain the v1 content
        const restoredContent = await fs.readFile(dbPath, 'utf-8');
        expect(restoredContent).toBe('SQLite database content v1');
    });

    it('restoreFromBackup throws when backup file does not exist', async () => {
        const fakePath = path.join(backupDir, 'nonexistent.db');

        await expect(backup.restoreFromBackup(fakePath)).rejects.toThrow(/Backup file not found/);
    });

    it('restoreFromBackup uses atomic write (temp + rename)', async () => {
        const snapshotPath = await backup.createSnapshot();

        await backup.restoreFromBackup(snapshotPath);

        // The .restore.tmp file should not persist after a successful restore
        const tmpExists = await fs.access(dbPath + '.restore.tmp').then(() => true).catch(() => false);
        expect(tmpExists).toBe(false);

        // The DB file should exist and have correct content
        const content = await fs.readFile(dbPath, 'utf-8');
        expect(content).toBe('SQLite database content v1');
    });
});
