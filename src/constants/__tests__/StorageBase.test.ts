// ─────────────────────────────────────────────────────────────────────────────
// StorageBase.test.ts — Unit tests for the StorageBase abstraction
// ─────────────────────────────────────────────────────────────────────────────
// P1.2: Validates that all derived paths honour the storageUri / workspace
// fallback logic and produce normalised, cross-platform paths.

import * as path from 'node:path';
import { StorageBase, createStorageBase } from '../StorageBase.js';

const WORKSPACE = '/home/user/project';
const STORAGE_URI = '/tmp/vscode-storage/coogent';

// ─── storageUri provided ─────────────────────────────────────────────────────

describe('StorageBase — storageUri provided', () => {
    const sb = new StorageBase(STORAGE_URI, WORKSPACE);

    it('getBase() returns storageUri as-is', () => {
        expect(sb.getBase()).toBe(STORAGE_URI);
    });

    it('getDBPath() derives from storageUri', () => {
        expect(sb.getDBPath()).toBe(path.join(STORAGE_URI, 'artifacts.db'));
    });

    it('getLogsDir() derives from storageUri', () => {
        expect(sb.getLogsDir()).toBe(path.join(STORAGE_URI, 'logs'));
    });

    it('getSessionDir() derives from storageUri', () => {
        expect(sb.getSessionDir('abc-123')).toBe(
            path.join(STORAGE_URI, 'sessions', 'abc-123'),
        );
    });

    it('getBackupDir() derives from storageUri', () => {
        expect(sb.getBackupDir()).toBe(path.join(STORAGE_URI, 'backups'));
    });

    it('getIPCDir() derives from storageUri', () => {
        expect(sb.getIPCDir()).toBe(path.join(STORAGE_URI, 'ipc'));
    });
});

// ─── storageUri undefined (workspace fallback) ───────────────────────────────

describe('StorageBase — storageUri undefined', () => {
    const sb = new StorageBase(undefined, WORKSPACE);
    const expectedBase = path.join(WORKSPACE, '.coogent');

    it('getBase() falls back to <workspaceRoot>/.coogent', () => {
        expect(sb.getBase()).toBe(expectedBase);
    });

    it('getDBPath() falls back to workspace .coogent', () => {
        expect(sb.getDBPath()).toBe(path.join(expectedBase, 'artifacts.db'));
    });

    it('getLogsDir() falls back to workspace .coogent', () => {
        expect(sb.getLogsDir()).toBe(path.join(expectedBase, 'logs'));
    });

    it('getSessionDir() falls back to workspace .coogent', () => {
        expect(sb.getSessionDir('sess-001')).toBe(
            path.join(expectedBase, 'sessions', 'sess-001'),
        );
    });

    it('getBackupDir() falls back to workspace .coogent', () => {
        expect(sb.getBackupDir()).toBe(path.join(expectedBase, 'backups'));
    });

    it('getIPCDir() falls back to workspace .coogent', () => {
        expect(sb.getIPCDir()).toBe(path.join(expectedBase, 'ipc'));
    });
});

// ─── Path normalisation ──────────────────────────────────────────────────────

describe('StorageBase — path normalisation', () => {
    it('produces no double separators when storageUri has trailing slash', () => {
        const sb = new StorageBase('/storage/', WORKSPACE);
        // path.join normalises trailing separators
        expect(sb.getDBPath()).toBe(path.join('/storage', 'artifacts.db'));
        expect(sb.getDBPath()).not.toMatch(/\/\//);
    });

    it('produces no double separators when workspaceRoot has trailing slash', () => {
        const sb = new StorageBase(undefined, '/workspace/');
        expect(sb.getBase()).toBe(path.join('/workspace', '.coogent'));
        expect(sb.getBase()).not.toMatch(/\/\//);
    });
});

// ─── getSessionDir with varied session ID formats ────────────────────────────

describe('StorageBase — getSessionDir formats', () => {
    const sb = new StorageBase(STORAGE_URI, WORKSPACE);

    it('handles UUID-style session IDs', () => {
        const id = '7f888e30-9ddf-4e5e-9a3d-ea683bdc38b9';
        expect(sb.getSessionDir(id)).toBe(path.join(STORAGE_URI, 'sessions', id));
    });

    it('handles timestamp-prefixed session IDs', () => {
        const id = '20260309-105927-7f888e30';
        expect(sb.getSessionDir(id)).toBe(path.join(STORAGE_URI, 'sessions', id));
    });

    it('handles simple numeric session IDs', () => {
        expect(sb.getSessionDir('42')).toBe(path.join(STORAGE_URI, 'sessions', '42'));
    });

    it('handles empty string session ID (edge case)', () => {
        // path.join strips trailing sep; result is just sessions dir
        expect(sb.getSessionDir('')).toBe(path.join(STORAGE_URI, 'sessions'));
    });
});

// ─── createStorageBase factory ───────────────────────────────────────────────

describe('createStorageBase factory', () => {
    it('returns a StorageBase instance with storageUri', () => {
        const sb = createStorageBase(STORAGE_URI, WORKSPACE);
        expect(sb).toBeInstanceOf(StorageBase);
        expect(sb.getBase()).toBe(STORAGE_URI);
    });

    it('returns a StorageBase instance without storageUri', () => {
        const sb = createStorageBase(undefined, WORKSPACE);
        expect(sb).toBeInstanceOf(StorageBase);
        expect(sb.getBase()).toBe(path.join(WORKSPACE, '.coogent'));
    });
});
