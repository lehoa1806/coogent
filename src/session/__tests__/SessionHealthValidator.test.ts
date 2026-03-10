// ─────────────────────────────────────────────────────────────────────────────
// src/session/__tests__/SessionHealthValidator.test.ts
// ─────────────────────────────────────────────────────────────────────────────

import { SessionHealthValidator } from '../SessionHealthValidator.js';
import type { ArtifactDB } from '../../mcp/ArtifactDB.js';

// ── Mocks ────────────────────────────────────────────────────────────────────

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

// ── Test Suite ───────────────────────────────────────────────────────────────

describe('SessionHealthValidator', () => {
    const SESSION_DIR_NAME = 'test-session-001';

    // ── 1. Healthy session ───────────────────────────────────────────────

    it('returns healthy when metadata and runbook_json exist in DB', () => {
        const db = createMockArtifactDB([
            {
                sessionDirName: SESSION_DIR_NAME,
                sessionId: 'sid-1',
                prompt: 'do something',
                createdAt: Date.now(),
                runbookJson: '{"phases":[]}',
                status: 'running',
            },
        ]);

        const validator = new SessionHealthValidator(db);
        const result = validator.validate(SESSION_DIR_NAME);

        expect(result.status).toBe('healthy');
        expect(result.hasMetadata).toBe(true);
        expect(result.hasRunbookInDB).toBe(true);
        expect(result.errors).toHaveLength(0);
    });

    // ── 2. Degraded session ──────────────────────────────────────────────

    it('returns degraded when metadata exists but no runbook_json in DB', () => {
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

        const validator = new SessionHealthValidator(db);
        const result = validator.validate(SESSION_DIR_NAME);

        expect(result.status).toBe('degraded');
        expect(result.hasMetadata).toBe(true);
        expect(result.hasRunbookInDB).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors.some(e => e.includes('No runbook found in DB'))).toBe(true);
    });

    // ── 3. Invalid session ───────────────────────────────────────────────

    it('returns invalid when no metadata exists in SessionRepository', () => {
        const db = createMockArtifactDB([]); // empty — no sessions

        const validator = new SessionHealthValidator(db);
        const result = validator.validate(SESSION_DIR_NAME);

        expect(result.status).toBe('invalid');
        expect(result.hasMetadata).toBe(false);
        expect(result.errors.some(e => e.includes('No session metadata found'))).toBe(true);
    });

    // ── 4. Empty runbook_json string is treated as absent ────────────────

    it('returns degraded when runbook_json is empty string', () => {
        const db = createMockArtifactDB([
            {
                sessionDirName: SESSION_DIR_NAME,
                sessionId: 'sid-4',
                prompt: 'fix bug',
                createdAt: Date.now(),
                runbookJson: '',
                status: 'running',
            },
        ]);

        const validator = new SessionHealthValidator(db);
        const result = validator.validate(SESSION_DIR_NAME);

        expect(result.status).toBe('degraded');
        expect(result.hasMetadata).toBe(true);
        expect(result.hasRunbookInDB).toBe(false);
    });
});
