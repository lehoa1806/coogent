// ─────────────────────────────────────────────────────────────────────────────
// src/failure-console/__tests__/FailureClassifier.test.ts
// ─────────────────────────────────────────────────────────────────────────────

import { FailureClassifier } from '../FailureClassifier.js';
import type { FailurePacket, FailureEventRef } from '../../types/failure-console.js';
import type { ErrorCode } from '../../types/ipc.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════════════════════════════════

function makeEvent(overrides: Partial<FailureEventRef> = {}): FailureEventRef {
    return {
        eventId: 'evt-1',
        timestamp: Date.now(),
        source: 'worker',
        summary: 'Worker failed',
        isRootCandidate: false,
        ...overrides,
    };
}

function makePacket(overrides: Partial<FailurePacket> = {}): FailurePacket {
    return {
        runId: 'run-001',
        sessionId: 'session-001',
        timeline: [],
        ...overrides,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ErrorCode → Classification mapping tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('FailureClassifier — ErrorCode mapping', () => {
    const classifier = new FailureClassifier();

    const errorCodeMappings: Array<{
        errorCode: ErrorCode;
        expectedCategory: string;
        expectedSeverity: string;
        expectedScope: string;
    }> = [
        { errorCode: 'WORKER_TIMEOUT', expectedCategory: 'timeout', expectedSeverity: 'recoverable', expectedScope: 'worker' },
        { errorCode: 'WORKER_CRASH', expectedCategory: 'worker_execution_error', expectedSeverity: 'hard_failure', expectedScope: 'worker' },
        { errorCode: 'PHASE_FAILED', expectedCategory: 'worker_execution_error', expectedSeverity: 'recoverable', expectedScope: 'phase' },
        { errorCode: 'TOKEN_OVER_BUDGET', expectedCategory: 'context_budget_exceeded', expectedSeverity: 'recoverable', expectedScope: 'context' },
        { errorCode: 'CONTEXT_ERROR', expectedCategory: 'context_assembly_error', expectedSeverity: 'recoverable', expectedScope: 'context' },
        { errorCode: 'VALIDATION_ERROR', expectedCategory: 'success_criteria_mismatch', expectedSeverity: 'recoverable', expectedScope: 'phase' },
        { errorCode: 'PLAN_ERROR', expectedCategory: 'planner_invalid_output', expectedSeverity: 'hard_failure', expectedScope: 'run' },
        { errorCode: 'CYCLE_DETECTED', expectedCategory: 'scheduler_stall', expectedSeverity: 'hard_failure', expectedScope: 'run' },
        { errorCode: 'COMMAND_ERROR', expectedCategory: 'tool_invocation_error', expectedSeverity: 'recoverable', expectedScope: 'tool' },
    ];

    it.each(errorCodeMappings)(
        'maps $errorCode → category=$expectedCategory, severity=$expectedSeverity, scope=$expectedScope',
        ({ errorCode, expectedCategory, expectedSeverity, expectedScope }) => {
            const packet = makePacket({
                timeline: [makeEvent({ isRootCandidate: true })],
            });
            const result = classifier.classify(packet, errorCode);

            expect(result.category).toBe(expectedCategory);
            expect(result.severity).toBe(expectedSeverity);
            expect(result.scope).toBe(expectedScope);
        }
    );
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Fallback classification (no ErrorCode)
// ═══════════════════════════════════════════════════════════════════════════════

describe('FailureClassifier — fallback classification', () => {
    const classifier = new FailureClassifier();

    it('infers tool_invocation_error when a tool-sourced root candidate exists', () => {
        const packet = makePacket({
            timeline: [
                makeEvent({ eventId: 'evt-tool', source: 'tool', isRootCandidate: true }),
            ],
        });

        const result = classifier.classify(packet);
        expect(result.category).toBe('tool_invocation_error');
        expect(result.severity).toBe('recoverable');
        expect(result.scope).toBe('tool');
    });

    it('infers evaluation_rejection when evaluator events exist but no tool root', () => {
        const packet = makePacket({
            timeline: [
                makeEvent({ eventId: 'evt-eval', source: 'evaluator', isRootCandidate: false }),
            ],
        });

        const result = classifier.classify(packet);
        expect(result.category).toBe('evaluation_rejection');
        expect(result.severity).toBe('recoverable');
        expect(result.scope).toBe('phase');
    });

    it('falls back to unknown when no recognisable signals exist', () => {
        const packet = makePacket({
            timeline: [
                makeEvent({ eventId: 'evt-unknown', source: 'unknown', isRootCandidate: false }),
            ],
        });

        const result = classifier.classify(packet);
        expect(result.category).toBe('unknown');
        expect(result.severity).toBe('recoverable');
        expect(result.scope).toBe('run');
    });

    it('falls back to unknown with empty timeline', () => {
        const packet = makePacket({ timeline: [] });
        const result = classifier.classify(packet);
        expect(result.category).toBe('unknown');
    });

    it('uses an unmapped ErrorCode as fallback (e.g. UNKNOWN)', () => {
        const packet = makePacket({
            timeline: [makeEvent()],
        });
        // UNKNOWN is a valid ErrorCode but not in ERROR_CODE_MAP
        const result = classifier.classify(packet, 'UNKNOWN');
        // Should hit the inferFromTimeline path
        expect(result.category).toBeDefined();
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Root event selection
// ═══════════════════════════════════════════════════════════════════════════════

describe('FailureClassifier — root event selection', () => {
    const classifier = new FailureClassifier();

    it('selects the first isRootCandidate event as rootEventId', () => {
        const packet = makePacket({
            timeline: [
                makeEvent({ eventId: 'non-root-1', isRootCandidate: false }),
                makeEvent({ eventId: 'root-1', isRootCandidate: true }),
                makeEvent({ eventId: 'root-2', isRootCandidate: true }),
            ],
        });

        const result = classifier.classify(packet, 'PHASE_FAILED');
        expect(result.rootEventId).toBe('root-1');
    });

    it('falls back to the last event when no root candidate exists', () => {
        const packet = makePacket({
            timeline: [
                makeEvent({ eventId: 'evt-a', isRootCandidate: false }),
                makeEvent({ eventId: 'evt-b', isRootCandidate: false }),
            ],
        });

        const result = classifier.classify(packet, 'PHASE_FAILED');
        expect(result.rootEventId).toBe('evt-b');
    });

    it('returns undefined rootEventId for empty timeline', () => {
        const packet = makePacket({ timeline: [] });
        const result = classifier.classify(packet, 'PHASE_FAILED');
        expect(result.rootEventId).toBeUndefined();
    });

    it('uses the single event both as root and last event', () => {
        const packet = makePacket({
            timeline: [makeEvent({ eventId: 'only-one', isRootCandidate: false })],
        });

        const result = classifier.classify(packet, 'PHASE_FAILED');
        expect(result.rootEventId).toBe('only-one');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Message generation
// ═══════════════════════════════════════════════════════════════════════════════

describe('FailureClassifier — message generation', () => {
    const classifier = new FailureClassifier();

    it('uses latestError when available', () => {
        const packet = makePacket({
            timeline: [makeEvent()],
            latestError: 'Something went wrong',
        });

        const result = classifier.classify(packet, 'PHASE_FAILED');
        expect(result.message).toContain('Something went wrong');
        expect(result.message).toContain('worker execution error');
    });

    it('falls back to root event summary when no latestError', () => {
        const packet = makePacket({
            timeline: [makeEvent({ summary: 'Root event summary', isRootCandidate: true })],
        });

        const result = classifier.classify(packet, 'PHASE_FAILED');
        expect(result.message).toContain('Root event summary');
    });

    it('uses generic fallback message for empty timeline and no latestError', () => {
        const packet = makePacket({
            runId: 'run-xyz',
            timeline: [],
        });

        const result = classifier.classify(packet, 'PHASE_FAILED');
        expect(result.message).toContain('run-xyz');
    });

    it('formats category with spaces (underscores replaced)', () => {
        const packet = makePacket({
            timeline: [makeEvent()],
            latestError: 'err',
        });

        const result = classifier.classify(packet, 'WORKER_CRASH');
        // category is 'worker_execution_error', should appear as 'worker execution error'
        expect(result.message).toMatch(/^worker execution error:/);
    });
});
