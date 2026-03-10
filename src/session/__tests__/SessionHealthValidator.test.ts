// ─────────────────────────────────────────────────────────────────────────────
// src/session/__tests__/SessionHealthValidator.test.ts
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SessionHealthValidator } from '../SessionHealthValidator.js';
import type { ArtifactDB } from '../../mcp/ArtifactDB.js';

// ── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('node:fs', () => ({
    ...jest.requireActual('node:fs'),
    existsSync: jest.fn(),
}));

jest.mock('../../logger/log.js', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function createMockArtifactDB(
    sessions: Array<{
        sessionDirName: string;
        sessionId: string;
        prompt: string;
        createdAt: number;
        runbookJson: string | null;
        status: string | null;
    }>,
): ArtifactDB {
    return {
        sessions: {
            list: jest.fn().mockReturnValue(sessions),
        },
    } as unknown as ArtifactDB;
}

const existsSyncMock = jest.mocked(fs.existsSync);

// ── Test Suite ───────────────────────────────────────────────────────────────

describe('SessionHealthValidator', () => {
    const storageBase = path.join(os.tmpdir(), 'coogent-shv-test');
    const SESSION_DIR_NAME = 'test-session-001';
    // getSessionDir computes: path.join(storageBase, 'ipc', sessionDirName)
    const expectedSessionDir = path.join(storageBase, 'ipc', SESSION_DIR_NAME);
    const expectedRunbookPath = path.join(expectedSessionDir, '.task-runbook.json');

    afterEach(() => {
        existsSyncMock.mockReset();
    });

    // ── 1. Healthy session ───────────────────────────────────────────────

    it('returns healthy when metadata, session dir, and runbook file all exist', () => {
        const db = createMockArtifactDB([
            {
                sessionDirName: SESSION_DIR_NAME,
                sessionId: 'sid-1',
                prompt: 'do something',
                createdAt: Date.now(),
                runbookJson: null,
                status: 'running',
            },
        ]);

        existsSyncMock.mockImplementation((p: fs.PathLike) => {
            if (p === expectedSessionDir) { return true; }
            if (p === expectedRunbookPath) { return true; }
            return false;
        });

        const validator = new SessionHealthValidator(db, storageBase);
        const result = validator.validate(SESSION_DIR_NAME);

        expect(result.status).toBe('healthy');
        expect(result.hasMetadata).toBe(true);
        expect(result.hasSnapshot).toBe(true);
        expect(result.errors).toHaveLength(0);
    });

    // ── 2. Healthy via DB fallback ───────────────────────────────────────

    it('returns healthy when runbook file is missing but runbook_json exists in DB', () => {
        const db = createMockArtifactDB([
            {
                sessionDirName: SESSION_DIR_NAME,
                sessionId: 'sid-2',
                prompt: 'plan something',
                createdAt: Date.now(),
                runbookJson: '{"phases":[]}',
                status: 'running',
            },
        ]);

        existsSyncMock.mockImplementation((p: fs.PathLike) => {
            if (p === expectedSessionDir) { return true; }
            if (p === expectedRunbookPath) { return false; }
            return false;
        });

        const validator = new SessionHealthValidator(db, storageBase);
        const result = validator.validate(SESSION_DIR_NAME);

        expect(result.status).toBe('healthy');
        expect(result.hasMetadata).toBe(true);
        expect(result.hasSnapshot).toBe(true);
        expect(result.hasRunbookInDB).toBe(true);
        expect(result.errors).toHaveLength(0);
    });

    // ── 3. Degraded session ──────────────────────────────────────────────

    it('returns degraded when metadata exists but no runbook on disk or in DB', () => {
        const db = createMockArtifactDB([
            {
                sessionDirName: SESSION_DIR_NAME,
                sessionId: 'sid-3',
                prompt: 'build feature',
                createdAt: Date.now(),
                runbookJson: null,
                status: 'running',
            },
        ]);

        existsSyncMock.mockImplementation((p: fs.PathLike) => {
            if (p === expectedSessionDir) { return true; }
            if (p === expectedRunbookPath) { return false; }
            return false;
        });

        const validator = new SessionHealthValidator(db, storageBase);
        const result = validator.validate(SESSION_DIR_NAME);

        expect(result.status).toBe('degraded');
        expect(result.hasMetadata).toBe(true);
        expect(result.hasSnapshot).toBe(true);
        expect(result.hasRunbookInDB).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors.some(e => e.includes('No runbook found'))).toBe(true);
    });

    // ── 4. Invalid session ───────────────────────────────────────────────

    it('returns invalid when no metadata exists in SessionRepository', () => {
        const db = createMockArtifactDB([]); // empty — no sessions

        existsSyncMock.mockImplementation((p: fs.PathLike) => {
            if (p === expectedSessionDir) { return true; }
            if (p === expectedRunbookPath) { return true; }
            return false;
        });

        const validator = new SessionHealthValidator(db, storageBase);
        const result = validator.validate(SESSION_DIR_NAME);

        expect(result.status).toBe('invalid');
        expect(result.hasMetadata).toBe(false);
        expect(result.errors.some(e => e.includes('No session metadata found'))).toBe(true);
    });

    // ── 5. Missing session directory ─────────────────────────────────────

    it('returns degraded when metadata exists but session directory does not', () => {
        const db = createMockArtifactDB([
            {
                sessionDirName: SESSION_DIR_NAME,
                sessionId: 'sid-5',
                prompt: 'fix bug',
                createdAt: Date.now(),
                runbookJson: null,
                status: 'running',
            },
        ]);

        existsSyncMock.mockImplementation(() => false); // nothing exists on disk

        const validator = new SessionHealthValidator(db, storageBase);
        const result = validator.validate(SESSION_DIR_NAME);

        expect(result.status).toBe('degraded');
        expect(result.hasMetadata).toBe(true);
        expect(result.hasSnapshot).toBe(false);
        expect(result.errors.some(e => e.includes('Session directory does not exist'))).toBe(true);
        expect(result.errors.some(e => e.includes('No runbook found'))).toBe(true);
    });
});
