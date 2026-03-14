// ─────────────────────────────────────────────────────────────────────────────
// src/mcp/repositories/__tests__/FailureConsoleRepository.test.ts
// ─────────────────────────────────────────────────────────────────────────────

import initSqlJs from 'sql.js';
import { initializeSchema } from '../../ArtifactDBSchema.js';
import { FailureConsoleRepository } from '../FailureConsoleRepository.js';

jest.mock('../../../logger/log.js', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// ═══════════════════════════════════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════════════════════════════════

const WORKSPACE_ID = 'test-workspace';
const TASK_ID = 'test-task-001';

function makeRecord(id: string, overrides: Record<string, unknown> = {}) {
    return {
        id,
        masterTaskId: TASK_ID,
        sessionId: 'session-001',
        severity: 'recoverable' as const,
        scope: 'phase' as const,
        category: 'worker_execution_error' as const,
        contributingEventIds: ['evt-1', 'evt-2'],
        message: `Failure record ${id}`,
        evidenceJson: JSON.stringify({ latestErrorText: 'test error' }),
        suggestedActionsJson: JSON.stringify([]),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ...overrides,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Test Suite
// ═══════════════════════════════════════════════════════════════════════════════

describe('FailureConsoleRepository — DB CRUD', () => {
    let db: any;
    let repo: FailureConsoleRepository;
    const noop = () => {};

    beforeAll(async () => {
        const SQL = await initSqlJs();
        db = new SQL.Database();
        initializeSchema(db);
        // Insert a parent task row for FK constraints
        db.run('INSERT INTO tasks (master_task_id, workspace_id, status) VALUES (?, ?, ?)', [TASK_ID, WORKSPACE_ID, 'running']);
    });

    beforeEach(() => {
        repo = new FailureConsoleRepository(db, noop, WORKSPACE_ID);
        // Clean up any records from previous tests
        db.run('DELETE FROM failure_console_records WHERE master_task_id = ?', [TASK_ID]);
    });

    afterAll(() => {
        db.close();
    });

    // ─────────────────────────────────────────────────────────────────────
    //  upsert() — insert
    // ─────────────────────────────────────────────────────────────────────

    it('inserts a new failure record', () => {
        const record = makeRecord('fc-001');
        repo.upsert(record);

        const row = repo.get('fc-001');
        expect(row).not.toBeNull();
        expect(row!.id).toBe('fc-001');
        expect(row!.master_task_id).toBe(TASK_ID);
        expect(row!.session_id).toBe('session-001');
        expect(row!.workspace_id).toBe(WORKSPACE_ID);
        expect(row!.severity).toBe('recoverable');
        expect(row!.scope).toBe('phase');
        expect(row!.category).toBe('worker_execution_error');
        expect(row!.message).toContain('fc-001');
    });

    // ─────────────────────────────────────────────────────────────────────
    //  upsert() — update (replace)
    // ─────────────────────────────────────────────────────────────────────

    it('replaces an existing record on upsert with same id', () => {
        repo.upsert(makeRecord('fc-002', { message: 'original' }));
        repo.upsert(makeRecord('fc-002', { message: 'updated' }));

        const row = repo.get('fc-002');
        expect(row).not.toBeNull();
        expect(row!.message).toBe('updated');
    });

    // ─────────────────────────────────────────────────────────────────────
    //  upsert() — optional fields
    // ─────────────────────────────────────────────────────────────────────

    it('stores phaseId and workerId when provided', () => {
        repo.upsert(makeRecord('fc-003', { phaseId: 'p-1', workerId: 'w-1' }));

        const row = repo.get('fc-003');
        expect(row).not.toBeNull();
        expect(row!.phase_id).toBe('p-1');
        expect(row!.worker_id).toBe('w-1');
    });

    it('stores null for phaseId and workerId when not provided', () => {
        repo.upsert(makeRecord('fc-004'));

        const row = repo.get('fc-004');
        expect(row).not.toBeNull();
        expect(row!.phase_id).toBeNull();
        expect(row!.worker_id).toBeNull();
    });

    // ─────────────────────────────────────────────────────────────────────
    //  get() — existing and non-existing
    // ─────────────────────────────────────────────────────────────────────

    it('returns the correct row for an existing record', () => {
        repo.upsert(makeRecord('fc-005', { rootEventId: 'root-xyz' }));

        const row = repo.get('fc-005');
        expect(row).not.toBeNull();
        expect(row!.root_event_id).toBe('root-xyz');
        expect(row!.contributing_event_ids).toBe(JSON.stringify(['evt-1', 'evt-2']));
    });

    it('returns null for a non-existing record', () => {
        const row = repo.get('non-existent-id');
        expect(row).toBeNull();
    });

    // ─────────────────────────────────────────────────────────────────────
    //  listByTask() — multiple records and ordering
    // ─────────────────────────────────────────────────────────────────────

    it('lists all records for a task ordered by created_at DESC', () => {
        const now = Date.now();
        repo.upsert(makeRecord('fc-oldest', { createdAt: now - 2000, updatedAt: now - 2000 }));
        repo.upsert(makeRecord('fc-middle', { createdAt: now - 1000, updatedAt: now - 1000 }));
        repo.upsert(makeRecord('fc-newest', { createdAt: now, updatedAt: now }));

        const rows = repo.listByTask(TASK_ID);
        expect(rows).toHaveLength(3);
        // Newest first
        expect(rows[0].id).toBe('fc-newest');
        expect(rows[1].id).toBe('fc-middle');
        expect(rows[2].id).toBe('fc-oldest');
    });

    it('returns empty array when no records exist for the task', () => {
        const rows = repo.listByTask('non-existent-task');
        expect(rows).toEqual([]);
    });

    // ─────────────────────────────────────────────────────────────────────
    //  updateChosenAction() — updates only the correct fields
    // ─────────────────────────────────────────────────────────────────────

    it('updates only chosen_action_json and updated_at', () => {
        const originalCreated = Date.now() - 5000;
        repo.upsert(makeRecord('fc-action', { createdAt: originalCreated, updatedAt: originalCreated }));

        const chosenAction = JSON.stringify({
            action: 'retry',
            initiatedBy: 'user',
            suggestedByModel: false,
            selectedAt: Date.now(),
            previousFailureRecordId: 'fc-action',
        });
        const newUpdatedAt = Date.now();

        repo.updateChosenAction('fc-action', chosenAction, newUpdatedAt);

        const row = repo.get('fc-action');
        expect(row).not.toBeNull();
        expect(row!.chosen_action_json).toBe(chosenAction);
        expect(row!.updated_at).toBe(newUpdatedAt);
        // Other fields should be unchanged
        expect(row!.message).toContain('fc-action');
        expect(row!.severity).toBe('recoverable');
    });

    // ─────────────────────────────────────────────────────────────────────
    //  Workspace isolation
    // ─────────────────────────────────────────────────────────────────────

    it('does not return records from a different workspace', () => {
        // Insert with current workspace
        repo.upsert(makeRecord('fc-ws-001'));

        // Create a repo for a different workspace
        const otherRepo = new FailureConsoleRepository(db, noop, 'other-workspace');

        expect(otherRepo.get('fc-ws-001')).toBeNull();
        expect(otherRepo.listByTask(TASK_ID)).toEqual([]);
    });
});
