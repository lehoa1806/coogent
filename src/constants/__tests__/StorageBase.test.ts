// ─────────────────────────────────────────────────────────────────────────────
// StorageBase.test.ts — Unit tests for the single-root StorageBase abstraction
// ─────────────────────────────────────────────────────────────────────────────
// Validates that ALL data (DB, backups, IPC, logs, sessions) routes to
// <workspaceRoot>/.coogent/ regardless of whether storageUri is provided.

import * as path from 'node:path';
import { StorageBase, createStorageBase } from '../StorageBase.js';

const WORKSPACE = '/home/user/project';
const STORAGE_URI = '/tmp/vscode-storage/coogent';
const COOGENT_BASE = path.join(WORKSPACE, '.coogent');

// ─── storageUri provided (ignored — everything goes to .coogent/) ────────────

describe('StorageBase — storageUri provided', () => {
    const sb = new StorageBase(STORAGE_URI, WORKSPACE);

    it('getDurableBase() returns .coogent/ (storageUri is ignored)', () => {
        expect(sb.getDurableBase()).toBe(COOGENT_BASE);
    });

    it('getWorkspaceBase() returns <workspaceRoot>/.coogent', () => {
        expect(sb.getWorkspaceBase()).toBe(COOGENT_BASE);
    });

    // ── All paths derive from .coogent/ ──────────────────────────────────

    it('getDBPath() derives from .coogent/', () => {
        expect(sb.getDBPath()).toBe(path.join(COOGENT_BASE, 'artifacts.db'));
    });

    it('getBackupDir() derives from .coogent/', () => {
        expect(sb.getBackupDir()).toBe(path.join(COOGENT_BASE, 'backups'));
    });

    it('getLogsDir() derives from .coogent/', () => {
        expect(sb.getLogsDir()).toBe(path.join(COOGENT_BASE, 'logs'));
    });

    it('getSessionDir() derives from .coogent/', () => {
        expect(sb.getSessionDir('abc-123')).toBe(
            path.join(COOGENT_BASE, 'sessions', 'abc-123'),
        );
    });

    it('getIPCDir() derives from .coogent/', () => {
        expect(sb.getIPCDir()).toBe(path.join(COOGENT_BASE, 'ipc'));
    });
});

// ─── storageUri undefined (same behaviour) ───────────────────────────────────

describe('StorageBase — storageUri undefined', () => {
    const sb = new StorageBase(undefined, WORKSPACE);

    it('getDurableBase() returns <workspaceRoot>/.coogent', () => {
        expect(sb.getDurableBase()).toBe(COOGENT_BASE);
    });

    it('getWorkspaceBase() returns <workspaceRoot>/.coogent', () => {
        expect(sb.getWorkspaceBase()).toBe(COOGENT_BASE);
    });

    it('getDBPath() derives from .coogent/', () => {
        expect(sb.getDBPath()).toBe(path.join(COOGENT_BASE, 'artifacts.db'));
    });

    it('getBackupDir() derives from .coogent/', () => {
        expect(sb.getBackupDir()).toBe(path.join(COOGENT_BASE, 'backups'));
    });

    it('getLogsDir() stays under .coogent/', () => {
        expect(sb.getLogsDir()).toBe(path.join(COOGENT_BASE, 'logs'));
    });

    it('getSessionDir() stays under .coogent/', () => {
        expect(sb.getSessionDir('sess-001')).toBe(
            path.join(COOGENT_BASE, 'sessions', 'sess-001'),
        );
    });

    it('getIPCDir() stays under .coogent/', () => {
        expect(sb.getIPCDir()).toBe(path.join(COOGENT_BASE, 'ipc'));
    });
});

// ─── Path normalisation ──────────────────────────────────────────────────────

describe('StorageBase — path normalisation', () => {
    it('produces no double separators when storageUri has trailing slash', () => {
        const sb = new StorageBase('/storage/', WORKSPACE);
        // storageUri is ignored — DB comes from .coogent/
        expect(sb.getDBPath()).toBe(path.join(COOGENT_BASE, 'artifacts.db'));
        expect(sb.getDBPath()).not.toMatch(/\/\//);
    });

    it('produces no double separators when workspaceRoot has trailing slash', () => {
        const sb = new StorageBase(undefined, '/workspace/');
        expect(sb.getDurableBase()).toBe(path.join('/workspace', '.coogent'));
        expect(sb.getDurableBase()).not.toMatch(/\/\//);
    });
});

// ─── getSessionDir with varied session ID formats ────────────────────────────

describe('StorageBase — getSessionDir formats', () => {
    const sb = new StorageBase(STORAGE_URI, WORKSPACE);

    it('handles UUID-style session IDs', () => {
        const id = '7f888e30-9ddf-4e5e-9a3d-ea683bdc38b9';
        expect(sb.getSessionDir(id)).toBe(path.join(COOGENT_BASE, 'sessions', id));
    });

    it('handles timestamp-prefixed session IDs', () => {
        const id = '20260309-105927-7f888e30';
        expect(sb.getSessionDir(id)).toBe(path.join(COOGENT_BASE, 'sessions', id));
    });

    it('handles simple numeric session IDs', () => {
        expect(sb.getSessionDir('42')).toBe(path.join(COOGENT_BASE, 'sessions', '42'));
    });

    it('handles empty string session ID (edge case)', () => {
        expect(sb.getSessionDir('')).toBe(path.join(COOGENT_BASE, 'sessions'));
    });
});

// ─── createStorageBase factory ───────────────────────────────────────────────

describe('createStorageBase factory', () => {
    it('returns a StorageBase instance with storageUri', () => {
        const sb = createStorageBase(STORAGE_URI, WORKSPACE);
        expect(sb).toBeInstanceOf(StorageBase);
        // storageUri is ignored — durable base is always .coogent/
        expect(sb.getDurableBase()).toBe(COOGENT_BASE);
    });

    it('returns a StorageBase instance without storageUri', () => {
        const sb = createStorageBase(undefined, WORKSPACE);
        expect(sb).toBeInstanceOf(StorageBase);
        expect(sb.getDurableBase()).toBe(COOGENT_BASE);
    });
});
