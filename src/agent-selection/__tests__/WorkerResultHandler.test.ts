import { WorkerResultHandler } from '../WorkerResultHandler.js';
import type { WorkerRunResult, FitAssessment } from '../types.js';

/** Helper to build a WorkerRunResult with overrides. */
function buildResult(overrides: {
    status?: WorkerRunResult['status'];
    confidence?: number;
    fit_assessment?: Partial<FitAssessment>;
    output?: WorkerRunResult['output'];
} = {}): WorkerRunResult {
    const defaultFit: FitAssessment = {
        task_fit: 'good',
        context_sufficiency: 'adequate',
        agent_mismatch: false,
        recommended_reassignment: null,
    };
    return {
        worker_id: 'worker-001',
        subtask_id: 'subtask-001',
        status: overrides.status ?? 'completed',
        confidence: overrides.confidence ?? 0.9,
        fit_assessment: { ...defaultFit, ...(overrides.fit_assessment ?? {}) },
        missing_context: [],
        warnings: [],
        assumptions_made: [],
        verification_notes: [],
        output: overrides.output !== undefined
            ? overrides.output
            : { type: 'patch_with_summary', patch: '...', summary: '...' },
    };
}

describe('WorkerResultHandler', () => {
    let handler: WorkerResultHandler;

    beforeEach(() => {
        handler = new WorkerResultHandler();
    });

    it('completed, high-confidence, good fit → accept', () => {
        const result = buildResult({
            status: 'completed',
            confidence: 0.9,
            fit_assessment: { task_fit: 'good', context_sufficiency: 'adequate', agent_mismatch: false, recommended_reassignment: null },
        });
        expect(handler.handle(result)).toBe('accept');
    });

    it('completed, low-confidence → accept (still accepted)', () => {
        const result = buildResult({
            status: 'completed',
            confidence: 0.3,
            fit_assessment: { task_fit: 'partial', context_sufficiency: 'partial', agent_mismatch: false, recommended_reassignment: null },
        });
        expect(handler.handle(result)).toBe('accept');
    });

    it('blocked with insufficient context → enrich_context', () => {
        const result = buildResult({
            status: 'blocked',
            confidence: 0.5,
            fit_assessment: { task_fit: 'partial', context_sufficiency: 'insufficient', agent_mismatch: false, recommended_reassignment: null },
        });
        expect(handler.handle(result)).toBe('enrich_context');
    });

    it('mismatch detected → reassign', () => {
        const result = buildResult({
            status: 'blocked',
            confidence: 0.4,
            fit_assessment: { task_fit: 'poor', context_sufficiency: 'adequate', agent_mismatch: true, recommended_reassignment: 'Debugger' },
        });
        expect(handler.handle(result)).toBe('reassign');
    });

    it('failed status → escalate', () => {
        const result = buildResult({
            status: 'failed',
            confidence: 0.1,
            fit_assessment: { task_fit: 'poor', context_sufficiency: 'insufficient', agent_mismatch: false, recommended_reassignment: null },
            output: null,
        });
        expect(handler.handle(result)).toBe('escalate_to_planner');
    });

    it('isCleanSuccess returns true for clean completion', () => {
        const result = buildResult({
            status: 'completed',
            confidence: 0.95,
            fit_assessment: { task_fit: 'good', context_sufficiency: 'adequate', agent_mismatch: false, recommended_reassignment: null },
        });
        expect(handler.isCleanSuccess(result)).toBe(true);
    });

    it('isCleanSuccess returns false for low confidence', () => {
        const result = buildResult({
            status: 'completed',
            confidence: 0.5,
            fit_assessment: { task_fit: 'good', context_sufficiency: 'adequate', agent_mismatch: false, recommended_reassignment: null },
        });
        expect(handler.isCleanSuccess(result)).toBe(false);
    });

    it('getReassignmentTarget extracts recommendation', () => {
        const result = buildResult({
            fit_assessment: { task_fit: 'poor', context_sufficiency: 'adequate', agent_mismatch: true, recommended_reassignment: 'Debugger' },
        });
        expect(handler.getReassignmentTarget(result)).toBe('Debugger');
    });

    it('getReassignmentTarget returns null when no recommendation', () => {
        const result = buildResult({
            fit_assessment: { task_fit: 'good', context_sufficiency: 'adequate', agent_mismatch: false, recommended_reassignment: null },
        });
        expect(handler.getReassignmentTarget(result)).toBeNull();
    });
});
