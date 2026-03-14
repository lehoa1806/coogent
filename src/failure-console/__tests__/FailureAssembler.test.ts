// ─────────────────────────────────────────────────────────────────────────────
// src/failure-console/__tests__/FailureAssembler.test.ts
// ─────────────────────────────────────────────────────────────────────────────

jest.mock('vscode', () => ({
    commands: { registerCommand: jest.fn() },
    window: { showWarningMessage: jest.fn(), showErrorMessage: jest.fn(), showInformationMessage: jest.fn() },
    workspace: { workspaceFolders: [] },
    Uri: { file: jest.fn() },
}), { virtual: true });

jest.mock('../../logger/log.js', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { FailureAssembler } from '../FailureAssembler.js';
import { FailureClassifier } from '../FailureClassifier.js';
import type { FailurePacket } from '../../types/failure-console.js';
import type { FailureConsoleRepository } from '../../mcp/repositories/FailureConsoleRepository.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════════════════════════════════

function makePacket(overrides: Partial<FailurePacket> = {}): FailurePacket {
    return {
        runId: 'run-001',
        sessionId: 'session-001',
        timeline: [{
            eventId: 'evt-1',
            timestamp: Date.now(),
            source: 'evaluator',
            summary: 'Phase 1 failed',
            isRootCandidate: true,
        }],
        ...overrides,
    };
}

function makeMockRepository(): jest.Mocked<FailureConsoleRepository> {
    return {
        upsert: jest.fn(),
        get: jest.fn(),
        listByTask: jest.fn(),
        updateChosenAction: jest.fn(),
    } as unknown as jest.Mocked<FailureConsoleRepository>;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Record assembly
// ═══════════════════════════════════════════════════════════════════════════════

describe('FailureAssembler — record assembly', () => {
    const classifier = new FailureClassifier();

    it('builds a complete FailureConsoleRecord with correct fields', () => {
        const assembler = new FailureAssembler(classifier);
        const packet = makePacket({
            phaseId: 'phase-001',
            workerId: 'worker-abc',
        });

        const record = assembler.assemble(packet, 'PHASE_FAILED');

        // Core fields
        expect(record.id).toBeDefined();
        expect(record.id.length).toBeGreaterThan(0);
        expect(record.runId).toBe('run-001');
        expect(record.sessionId).toBe('session-001');
        expect(record.phaseId).toBe('phase-001');
        expect(record.workerId).toBe('worker-abc');

        // Classification
        expect(record.severity).toBe('recoverable');
        expect(record.scope).toBe('phase');
        expect(record.category).toBe('worker_execution_error');

        // Timeline mapping
        expect(record.contributingEventIds).toEqual(['evt-1']);

        // Stage 1 — no suggested actions
        expect(record.suggestedActions).toEqual([]);

        // Message
        expect(record.message).toBeTruthy();
    });

    it('generates a unique ID for each record', () => {
        const assembler = new FailureAssembler(classifier);
        const packet = makePacket();

        const record1 = assembler.assemble(packet, 'PHASE_FAILED');
        const record2 = assembler.assemble(packet, 'PHASE_FAILED');

        expect(record1.id).not.toBe(record2.id);
    });

    it('sets createdAt and updatedAt to the same timestamp', () => {
        const assembler = new FailureAssembler(classifier);
        const record = assembler.assemble(makePacket(), 'PHASE_FAILED');

        expect(record.createdAt).toBe(record.updatedAt);
        expect(record.createdAt).toBeGreaterThan(0);
    });

    it('omits optional fields when not present in packet', () => {
        const assembler = new FailureAssembler(classifier);
        // Packet without phaseId/workerId — they're simply absent
        const packet = makePacket();

        const record = assembler.assemble(packet, 'PHASE_FAILED');

        expect(record.phaseId).toBeUndefined();
        expect(record.workerId).toBeUndefined();
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Evidence mapping
// ═══════════════════════════════════════════════════════════════════════════════

describe('FailureAssembler — evidence mapping', () => {
    const classifier = new FailureClassifier();

    it('maps latestOutput → latestWorkerOutput', () => {
        const assembler = new FailureAssembler(classifier);
        const packet = makePacket({ latestOutput: 'worker output text' });

        const record = assembler.assemble(packet, 'PHASE_FAILED');
        expect(record.evidence.latestWorkerOutput).toBe('worker output text');
    });

    it('maps latestError → latestErrorText', () => {
        const assembler = new FailureAssembler(classifier);
        const packet = makePacket({ latestError: 'error message' });

        const record = assembler.assemble(packet, 'PHASE_FAILED');
        expect(record.evidence.latestErrorText).toBe('error message');
    });

    it('maps contextBudget.used → contextBudget.estimatedUsed', () => {
        const assembler = new FailureAssembler(classifier);
        const packet = makePacket({
            contextBudget: { tokenLimit: 100000, used: 95000, remaining: 5000 },
        });

        const record = assembler.assemble(packet, 'TOKEN_OVER_BUDGET');
        expect(record.evidence.contextBudget).toEqual({
            tokenLimit: 100000,
            estimatedUsed: 95000,
            remaining: 5000,
        });
    });

    it('copies toolActions into evidence', () => {
        const assembler = new FailureAssembler(classifier);
        const packet = makePacket({
            toolActions: [
                { toolId: 'read_file', outcome: 'success', timestamp: 1000 },
                { toolId: 'write_file', outcome: 'failure', timestamp: 2000 },
            ],
        });

        const record = assembler.assemble(packet, 'COMMAND_ERROR');
        expect(record.evidence.toolActions).toHaveLength(2);
        expect(record.evidence.toolActions![0].toolId).toBe('read_file');
        expect(record.evidence.toolActions![1].outcome).toBe('failure');
    });

    it('copies successCriteria into evidence', () => {
        const assembler = new FailureAssembler(classifier);
        const packet = makePacket({
            successCriteria: ['exit_code:0', 'output contains "OK"'],
        });

        const record = assembler.assemble(packet, 'VALIDATION_ERROR');
        expect(record.evidence.successCriteria).toEqual(['exit_code:0', 'output contains "OK"']);
    });

    it('omits evidence fields when packet lacks them', () => {
        const assembler = new FailureAssembler(classifier);
        // Packet without optional evidence fields — they're simply absent
        const packet = makePacket();

        const record = assembler.assemble(packet, 'PHASE_FAILED');
        expect(record.evidence.latestWorkerOutput).toBeUndefined();
        expect(record.evidence.latestErrorText).toBeUndefined();
        expect(record.evidence.contextBudget).toBeUndefined();
        expect(record.evidence.toolActions).toBeUndefined();
        expect(record.evidence.successCriteria).toBeUndefined();
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Repository persistence
// ═══════════════════════════════════════════════════════════════════════════════

describe('FailureAssembler — persistence', () => {
    const classifier = new FailureClassifier();

    it('calls repository.upsert when repository is provided', () => {
        const mockRepo = makeMockRepository();
        const assembler = new FailureAssembler(classifier, mockRepo);

        assembler.assemble(makePacket(), 'PHASE_FAILED');

        expect(mockRepo.upsert).toHaveBeenCalledTimes(1);
        expect(mockRepo.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                id: expect.any(String),
                masterTaskId: 'run-001',
                sessionId: 'session-001',
                severity: 'recoverable',
                scope: 'phase',
                category: 'worker_execution_error',
                contributingEventIds: ['evt-1'],
                message: expect.any(String),
                evidenceJson: expect.any(String),
                suggestedActionsJson: expect.any(String),
                createdAt: expect.any(Number),
                updatedAt: expect.any(Number),
            })
        );
    });

    it('does not throw when repository is not provided', () => {
        const assembler = new FailureAssembler(classifier);
        expect(() => assembler.assemble(makePacket(), 'PHASE_FAILED')).not.toThrow();
    });

    it('catches and logs repository errors without rethrowing', () => {
        const mockRepo = makeMockRepository();
        mockRepo.upsert.mockImplementation(() => {
            throw new Error('DB write failed');
        });

        const assembler = new FailureAssembler(classifier, mockRepo);

        // Should not throw
        const record = assembler.assemble(makePacket(), 'PHASE_FAILED');
        expect(record).toBeDefined();
        expect(record.id).toBeTruthy();
    });

    it('still returns the record even when persistence fails', () => {
        const mockRepo = makeMockRepository();
        mockRepo.upsert.mockImplementation(() => {
            throw new Error('Connection lost');
        });

        const assembler = new FailureAssembler(classifier, mockRepo);
        const record = assembler.assemble(makePacket(), 'PHASE_FAILED');

        expect(record.runId).toBe('run-001');
        expect(record.category).toBe('worker_execution_error');
    });
});
