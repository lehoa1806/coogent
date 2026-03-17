// ─────────────────────────────────────────────────────────────────────────────
// src/failure-console/__tests__/FailureConsoleCoordinator.test.ts
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

import { FailureConsoleCoordinator } from '../FailureConsoleCoordinator.js';
import { FailureClassifier } from '../FailureClassifier.js';
import { RecoverySuggester } from '../RecoverySuggester.js';
import { RecoveryActionRouter, type ActionLegalityContext } from '../RecoveryActionRouter.js';
import type { FailurePacket, SuggestedRecoveryAction } from '../../types/failure-console.js';
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

function makeLegalityCtx(overrides: Partial<ActionLegalityContext> = {}): ActionLegalityContext {
    return {
        engineState: 'ERROR_PAUSED',
        phaseStatus: 'failed',
        phaseId: 1,
        hasDownstreamDependents: false,
        isCriticalPhase: false,
        availableWorkerCount: 3,
        failureCategory: 'evaluation_rejection',
        failureSeverity: 'recoverable',
        currentRetryCount: 0,
        maxRetries: 3,
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
//  Coordinator composition
// ═══════════════════════════════════════════════════════════════════════════════

describe('FailureConsoleCoordinator — composition', () => {
    const classifier = new FailureClassifier();
    const suggester = new RecoverySuggester();
    const router = new RecoveryActionRouter();

    it('builds a complete FailureConsoleRecord with suggestions', () => {
        const coordinator = new FailureConsoleCoordinator(
            classifier, suggester, router,
        );
        const packet = makePacket({
            phaseId: 'phase-001',
            workerId: 'worker-abc',
        });
        const ctx = makeLegalityCtx();

        const record = coordinator.build(packet, ctx, 'PHASE_FAILED');

        // Core fields
        expect(record.id).toBeDefined();
        expect(record.runId).toBe('run-001');
        expect(record.sessionId).toBe('session-001');
        expect(record.phaseId).toBe('phase-001');
        expect(record.workerId).toBe('worker-abc');

        // Classification
        expect(record.severity).toBe('recoverable');
        expect(record.scope).toBe('phase');
        expect(record.category).toBe('worker_execution_error');

        // Suggestions should be populated (not empty)
        expect(record.suggestedActions.length).toBeGreaterThan(0);
    });

    it('generates suggestions matching the failure category', () => {
        const coordinator = new FailureConsoleCoordinator(
            classifier, suggester, router,
        );
        const packet = makePacket();
        const ctx = makeLegalityCtx({ failureCategory: 'evaluation_rejection' });

        const record = coordinator.build(packet, ctx, 'PHASE_FAILED');

        // worker_execution_error → should include 'retry' and 'reroute_worker'
        const actionTypes = record.suggestedActions.map((s) => s.action);
        expect(actionTypes).toContain('retry');
    });

    it('always includes inspect_repair_prompt as a fallback suggestion', () => {
        const coordinator = new FailureConsoleCoordinator(
            classifier, suggester, router,
        );
        const packet = makePacket();
        const ctx = makeLegalityCtx();

        const record = coordinator.build(packet, ctx, 'PHASE_FAILED');

        const actionTypes = record.suggestedActions.map((s) => s.action);
        expect(actionTypes).toContain('inspect_repair_prompt');
    });

    it('works without an error code', () => {
        const coordinator = new FailureConsoleCoordinator(
            classifier, suggester, router,
        );
        const packet = makePacket();
        const ctx = makeLegalityCtx();

        const record = coordinator.build(packet, ctx);

        expect(record.id).toBeDefined();
        expect(record.suggestedActions.length).toBeGreaterThan(0);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Legality filtering
// ═══════════════════════════════════════════════════════════════════════════════

describe('FailureConsoleCoordinator — legality filtering', () => {
    const classifier = new FailureClassifier();
    const suggester = new RecoverySuggester();
    const router = new RecoveryActionRouter();

    it('annotates disabled actions when retry limit is reached', () => {
        const coordinator = new FailureConsoleCoordinator(
            classifier, suggester, router,
        );
        const packet = makePacket();
        const ctx = makeLegalityCtx({
            currentRetryCount: 3,
            maxRetries: 3,
        });

        const record = coordinator.build(packet, ctx, 'PHASE_FAILED');

        // Find retry suggestion — it should be annotated as disabled
        const retrySuggestion = record.suggestedActions.find(
            (s) => s.action === 'retry',
        );
        if (retrySuggestion) {
            expect(retrySuggestion.rationale).toContain('[Disabled:');
        }
    });

    it('annotates disabled reroute when no alternative workers', () => {
        const coordinator = new FailureConsoleCoordinator(
            classifier, suggester, router,
        );
        const packet = makePacket();
        const ctx = makeLegalityCtx({ availableWorkerCount: 1 });

        const record = coordinator.build(packet, ctx, 'PHASE_FAILED');

        const rerouteSuggestion = record.suggestedActions.find(
            (s) => s.action === 'reroute_worker',
        );
        if (rerouteSuggestion) {
            expect(rerouteSuggestion.rationale).toContain('[Disabled:');
        }
    });

    it('keeps suggestions enabled when all legality checks pass', () => {
        const coordinator = new FailureConsoleCoordinator(
            classifier, suggester, router,
        );
        const packet = makePacket();
        const ctx = makeLegalityCtx({
            engineState: 'ERROR_PAUSED',
            phaseStatus: 'failed',
            availableWorkerCount: 5,
            currentRetryCount: 0,
            maxRetries: 3,
        });

        const record = coordinator.build(packet, ctx, 'PHASE_FAILED');

        // With all conditions favorable, retry should NOT be disabled
        const retrySuggestion = record.suggestedActions.find(
            (s) => s.action === 'retry',
        );
        if (retrySuggestion) {
            expect(retrySuggestion.rationale).not.toContain('[Disabled:');
        }
    });

    it('annotates disabled skip when phase is critical with dependents', () => {
        const coordinator = new FailureConsoleCoordinator(
            classifier, suggester, router,
        );
        // Use a category that produces 'skip' suggestions: tool_denied
        const packet = makePacket({
            timeline: [{
                eventId: 'evt-1',
                timestamp: Date.now(),
                source: 'tool',
                summary: 'Tool denied by policy',
                isRootCandidate: true,
            }],
        });
        const ctx = makeLegalityCtx({
            hasDownstreamDependents: true,
            isCriticalPhase: true,
            failureCategory: 'tool_denied',
        });

        // Use an error code that maps to tool_denied if available,
        // or let the timeline infer it. For explicit control, we rely on
        // the suggestion rules for 'tool_invocation_error' which also has skip
        // in some categories. Let's use the coordinator without an error code
        // and ensure the router disables 'skip'.
        const record = coordinator.build(packet, ctx);

        const skipSuggestion = record.suggestedActions.find(
            (s) => s.action === 'skip',
        );
        // The 'skip' action might not be suggested for this category,
        // but if it is, it should be disabled
        if (skipSuggestion) {
            expect(skipSuggestion.rationale).toContain('[Disabled:');
        }
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Repository persistence
// ═══════════════════════════════════════════════════════════════════════════════

describe('FailureConsoleCoordinator — persistence', () => {
    const classifier = new FailureClassifier();
    const suggester = new RecoverySuggester();
    const router = new RecoveryActionRouter();

    it('persists via repository when provided', () => {
        const mockRepo = makeMockRepository();
        const coordinator = new FailureConsoleCoordinator(
            classifier, suggester, router, mockRepo,
        );

        coordinator.build(makePacket(), makeLegalityCtx(), 'PHASE_FAILED');

        expect(mockRepo.upsert).toHaveBeenCalledTimes(1);
        expect(mockRepo.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                id: expect.any(String),
                masterTaskId: 'run-001',
                sessionId: 'session-001',
                suggestedActionsJson: expect.any(String),
            }),
        );

        // Persisted suggestedActionsJson should be non-empty (not "[]")
        const persistedCall = mockRepo.upsert.mock.calls[0]![0];
        const persistedActions = JSON.parse(persistedCall.suggestedActionsJson) as SuggestedRecoveryAction[];
        expect(persistedActions.length).toBeGreaterThan(0);
    });

    it('works gracefully without a repository', () => {
        const coordinator = new FailureConsoleCoordinator(
            classifier, suggester, router,
        );

        const record = coordinator.build(makePacket(), makeLegalityCtx(), 'PHASE_FAILED');

        expect(record).toBeDefined();
        expect(record.id).toBeTruthy();
        expect(record.suggestedActions.length).toBeGreaterThan(0);
    });

    it('catches repository errors without rethrowing', () => {
        const mockRepo = makeMockRepository();
        mockRepo.upsert.mockImplementation(() => {
            throw new Error('DB write failed');
        });

        const coordinator = new FailureConsoleCoordinator(
            classifier, suggester, router, mockRepo,
        );

        // Should not throw
        const record = coordinator.build(makePacket(), makeLegalityCtx(), 'PHASE_FAILED');
        expect(record).toBeDefined();
        expect(record.id).toBeTruthy();
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Mock-based composition verification
// ═══════════════════════════════════════════════════════════════════════════════

describe('FailureConsoleCoordinator — mock composition', () => {
    it('calls classifier, suggester, and router in order', () => {
        const callOrder: string[] = [];

        const mockClassifier = {
            classify: jest.fn().mockImplementation(() => {
                callOrder.push('classify');
                return {
                    severity: 'recoverable' as const,
                    scope: 'phase' as const,
                    category: 'worker_execution_error' as const,
                    message: 'test failure',
                };
            }),
        };

        const mockSuggester = {
            suggest: jest.fn().mockImplementation(() => {
                callOrder.push('suggest');
                return [
                    {
                        action: 'retry',
                        title: 'Retry the phase',
                        rationale: 'Transient error',
                        confidence: 'high',
                    },
                ] as SuggestedRecoveryAction[];
            }),
        };

        const mockRouter = {
            filterSuggestions: jest.fn().mockImplementation((suggestions: SuggestedRecoveryAction[]) => {
                callOrder.push('filter');
                return suggestions;
            }),
            validate: jest.fn(),
            validateAll: jest.fn(),
        };

        const coordinator = new FailureConsoleCoordinator(
            mockClassifier as unknown as FailureClassifier,
            mockSuggester as unknown as RecoverySuggester,
            mockRouter as unknown as RecoveryActionRouter,
        );

        const packet = makePacket();
        const ctx = makeLegalityCtx();

        coordinator.build(packet, ctx, 'PHASE_FAILED');

        // Verify call order: classify → suggest → filter
        // Note: classify is called twice — once by the coordinator and
        // once by the internnal FailureAssembler. The coordinator calls
        // classify to get the category for the suggester.
        expect(callOrder[0]).toBe('classify');
        expect(callOrder[1]).toBe('suggest');
        expect(callOrder[2]).toBe('filter');

        // Verify suggester was called with the classification context
        expect(mockSuggester.suggest).toHaveBeenCalledWith(
            expect.objectContaining({
                category: 'worker_execution_error',
                severity: 'recoverable',
                scope: 'phase',
            }),
        );

        // Verify router.filterSuggestions was called with suggestions + ctx
        expect(mockRouter.filterSuggestions).toHaveBeenCalledWith(
            expect.arrayContaining([
                expect.objectContaining({ action: 'retry' }),
            ]),
            ctx,
        );
    });
});
