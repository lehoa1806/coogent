// ─────────────────────────────────────────────────────────────────────────────
// StorageBase.test.ts — Unit tests for the hybrid StorageBase abstraction
// ─────────────────────────────────────────────────────────────────────────────
// Validates the hybrid routing: durable data (DB, backups) routes to the
// global Antigravity directory; operational data (IPC, logs, sessions)
// routes to <workspaceRoot>/.coogent/.

import * as path from 'node:path';
import { StorageBase, createStorageBase } from '../StorageBase.js';
import { getGlobalCoogentDir, getGlobalDatabasePath, getGlobalBackupDir } from '../paths.js';

const WORKSPACE = '/home/user/project';
const STORAGE_URI = '/tmp/vscode-storage/coogent';
const WORKSPACE_BASE = path.join(WORKSPACE, '.coogent');

// ── Global path constants (resolved once) ────────────────────────────────────
const GLOBAL_BASE = getGlobalCoogentDir();
const GLOBAL_DB = getGlobalDatabasePath();
const GLOBAL_BACKUP = getGlobalBackupDir();

// ─── storageUri provided (ignored for durable, unused for operational) ───────

describe('StorageBase — storageUri provided', () => {
    const sb = new StorageBase(STORAGE_URI, WORKSPACE);

    // Durable paths → global
    it('getDurableBase() returns global Antigravity directory', () => {
        expect(sb.getDurableBase()).toBe(GLOBAL_BASE);
    });

    it('getDBPath() routes to global database', () => {
        expect(sb.getDBPath()).toBe(GLOBAL_DB);
    });

    it('getBackupDir() routes to global backups', () => {
        expect(sb.getBackupDir()).toBe(GLOBAL_BACKUP);
    });

    // Operational paths → workspace-local
    it('getWorkspaceBase() returns <workspaceRoot>/.coogent', () => {
        expect(sb.getWorkspaceBase()).toBe(WORKSPACE_BASE);
    });

    it('getLogsDir() derives from workspace-local .coogent/', () => {
        expect(sb.getLogsDir()).toBe(path.join(WORKSPACE_BASE, 'logs'));
    });

    it('getSessionDir() derives from workspace-local .coogent/', () => {
        expect(sb.getSessionDir('abc-123')).toBe(
            path.join(WORKSPACE_BASE, 'sessions', 'abc-123'),
        );
    });

    it('getIPCDir() derives from workspace-local .coogent/', () => {
        expect(sb.getIPCDir()).toBe(path.join(WORKSPACE_BASE, 'ipc'));
    });
});

// ─── storageUri undefined (same hybrid behaviour) ────────────────────────────

describe('StorageBase — storageUri undefined', () => {
    const sb = new StorageBase(undefined, WORKSPACE);

    // Durable paths → global
    it('getDurableBase() returns global Antigravity directory', () => {
        expect(sb.getDurableBase()).toBe(GLOBAL_BASE);
    });

    it('getDBPath() routes to global database', () => {
        expect(sb.getDBPath()).toBe(GLOBAL_DB);
    });

    it('getBackupDir() routes to global backups', () => {
        expect(sb.getBackupDir()).toBe(GLOBAL_BACKUP);
    });

    // Operational paths → workspace-local
    it('getWorkspaceBase() returns <workspaceRoot>/.coogent', () => {
        expect(sb.getWorkspaceBase()).toBe(WORKSPACE_BASE);
    });

    it('getLogsDir() stays under workspace-local .coogent/', () => {
        expect(sb.getLogsDir()).toBe(path.join(WORKSPACE_BASE, 'logs'));
    });

    it('getSessionDir() stays under workspace-local .coogent/', () => {
        expect(sb.getSessionDir('sess-001')).toBe(
            path.join(WORKSPACE_BASE, 'sessions', 'sess-001'),
        );
    });

    it('getIPCDir() stays under workspace-local .coogent/', () => {
        expect(sb.getIPCDir()).toBe(path.join(WORKSPACE_BASE, 'ipc'));
    });
});

// ─── Path normalisation ──────────────────────────────────────────────────────

describe('StorageBase — path normalisation', () => {
    it('global durable paths contain no double separators', () => {
        const sb = new StorageBase('/storage/', WORKSPACE);
        expect(sb.getDurableBase()).toBe(GLOBAL_BASE);
        expect(sb.getDurableBase()).not.toMatch(/\/\//);
    });

    it('workspace-local paths contain no double separators when workspaceRoot has trailing slash', () => {
        const sb = new StorageBase(undefined, '/workspace/');
        expect(sb.getWorkspaceBase()).toBe(path.join('/workspace', '.coogent'));
        expect(sb.getWorkspaceBase()).not.toMatch(/\/\//);
    });
});

// ─── getSessionDir with varied session ID formats ────────────────────────────

describe('StorageBase — getSessionDir formats', () => {
    const sb = new StorageBase(STORAGE_URI, WORKSPACE);

    it('handles UUID-style session IDs', () => {
        const id = '7f888e30-9ddf-4e5e-9a3d-ea683bdc38b9';
        expect(sb.getSessionDir(id)).toBe(path.join(WORKSPACE_BASE, 'sessions', id));
    });

    it('handles timestamp-prefixed session IDs', () => {
        const id = '20260309-105927-7f888e30';
        expect(sb.getSessionDir(id)).toBe(path.join(WORKSPACE_BASE, 'sessions', id));
    });

    it('handles simple numeric session IDs', () => {
        expect(sb.getSessionDir('42')).toBe(path.join(WORKSPACE_BASE, 'sessions', '42'));
    });

    it('handles empty string session ID (edge case)', () => {
        expect(sb.getSessionDir('')).toBe(path.join(WORKSPACE_BASE, 'sessions'));
    });
});

// ─── createStorageBase factory ───────────────────────────────────────────────

describe('createStorageBase factory', () => {
    it('returns a StorageBase instance with storageUri', () => {
        const sb = createStorageBase(STORAGE_URI, WORKSPACE);
        expect(sb).toBeInstanceOf(StorageBase);
        // Durable goes to global; workspace stays local
        expect(sb.getDurableBase()).toBe(GLOBAL_BASE);
        expect(sb.getWorkspaceBase()).toBe(WORKSPACE_BASE);
    });

    it('returns a StorageBase instance without storageUri', () => {
        const sb = createStorageBase(undefined, WORKSPACE);
        expect(sb).toBeInstanceOf(StorageBase);
        expect(sb.getDurableBase()).toBe(GLOBAL_BASE);
        expect(sb.getWorkspaceBase()).toBe(WORKSPACE_BASE);
    });
});

// ─── getWorkspaceId() — tenant identity (ADR-002) ───────────────────────────

describe('StorageBase — getWorkspaceId()', () => {
    it('returns a 16-hex-char string', () => {
        const sb = new StorageBase(undefined, WORKSPACE);
        const id = sb.getWorkspaceId();
        expect(id).toMatch(/^[0-9a-f]{16}$/);
    });

    it('returns the same workspaceId for identical workspace roots', () => {
        const sb1 = new StorageBase(STORAGE_URI, WORKSPACE);
        const sb2 = new StorageBase(undefined, WORKSPACE);
        expect(sb1.getWorkspaceId()).toBe(sb2.getWorkspaceId());
    });

    it('returns different workspaceIds for different workspace roots', () => {
        const sb1 = new StorageBase(undefined, '/home/user/project-a');
        const sb2 = new StorageBase(undefined, '/home/user/project-b');
        expect(sb1.getWorkspaceId()).not.toBe(sb2.getWorkspaceId());
    });
});
