import { Scheduler } from '../Scheduler.js';
import { asPhaseId, type Phase } from '../../types/index.js';

describe('Scheduler', () => {
    let scheduler: Scheduler;

    beforeEach(() => {
        scheduler = new Scheduler({ maxConcurrent: 2 });
    });

    test('isDAGMode returns false for sequential phases', () => {
        const phases: Phase[] = [
            { id: asPhaseId(0), status: 'pending', prompt: '', context_files: [], success_criteria: '' },
        ];
        expect(scheduler.isDAGMode(phases)).toBe(false);
    });

    test('isDAGMode returns true when depends_on is used', () => {
        const phases: Phase[] = [
            { id: asPhaseId(0), status: 'pending', prompt: '', context_files: [], success_criteria: '' },
            { id: asPhaseId(1), status: 'pending', prompt: '', context_files: [], success_criteria: '', depends_on: [asPhaseId(0)] },
        ];
        expect(scheduler.isDAGMode(phases)).toBe(true);
    });

    test('getReadyPhases returns next pending phase in sequential mode', () => {
        const phases: Phase[] = [
            { id: asPhaseId(0), status: 'completed', prompt: '', context_files: [], success_criteria: '' },
            { id: asPhaseId(1), status: 'pending', prompt: '', context_files: [], success_criteria: '' },
        ];
        const ready = scheduler.getReadyPhases(phases);
        expect(ready.length).toBe(1);
        expect(ready[0].id).toBe(1);
    });

    test('getReadyPhases returns multiple phases if dependencies met in DAG mode', () => {
        const phases: Phase[] = [
            { id: asPhaseId(0), status: 'completed', prompt: '', context_files: [], success_criteria: '' },
            { id: asPhaseId(1), status: 'pending', prompt: '', context_files: [], success_criteria: '', depends_on: [asPhaseId(0)] },
            { id: asPhaseId(2), status: 'pending', prompt: '', context_files: [], success_criteria: '', depends_on: [asPhaseId(0)] },
        ];
        const ready = scheduler.getReadyPhases(phases);
        expect(ready.length).toBe(2);
        expect(ready[0].id).toBe(1);
        expect(ready[1].id).toBe(2);
    });

    test('getReadyPhases respects maxConcurrent limit', () => {
        const phases: Phase[] = [
            { id: asPhaseId(0), status: 'completed', prompt: '', context_files: [], success_criteria: '' },
            { id: asPhaseId(1), status: 'pending', prompt: '', context_files: [], success_criteria: '', depends_on: [asPhaseId(0)] },
            { id: asPhaseId(2), status: 'pending', prompt: '', context_files: [], success_criteria: '', depends_on: [asPhaseId(0)] },
            { id: asPhaseId(3), status: 'pending', prompt: '', context_files: [], success_criteria: '', depends_on: [asPhaseId(0)] },
        ];
        const ready = scheduler.getReadyPhases(phases);
        expect(ready.length).toBe(2); // limit is 2
    });

    test('getReadyPhases counts running phases against maxConcurrent', () => {
        const phases: Phase[] = [
            { id: asPhaseId(0), status: 'running', prompt: '', context_files: [], success_criteria: '' },
            { id: asPhaseId(1), status: 'pending', prompt: '', context_files: [], success_criteria: '', depends_on: [] },
        ];
        const ready = scheduler.getReadyPhases(phases);
        expect(ready.length).toBe(1); // 1 running + 1 pending = 2
    });

    test('detectCycles returns empty array for valid DAG', () => {
        const phases: Phase[] = [
            { id: asPhaseId(0), status: 'pending', prompt: '', context_files: [], success_criteria: '' },
            { id: asPhaseId(1), status: 'pending', prompt: '', context_files: [], success_criteria: '', depends_on: [asPhaseId(0)] },
            { id: asPhaseId(2), status: 'pending', prompt: '', context_files: [], success_criteria: '', depends_on: [asPhaseId(1)] },
        ];
        expect(scheduler.detectCycles(phases)).toEqual([]);
    });

    test('detectCycles returns cycle members for invalid DAG', () => {
        const phases: Phase[] = [
            { id: asPhaseId(0), status: 'pending', prompt: '', context_files: [], success_criteria: '', depends_on: [asPhaseId(2)] },
            { id: asPhaseId(1), status: 'pending', prompt: '', context_files: [], success_criteria: '', depends_on: [asPhaseId(0)] },
            { id: asPhaseId(2), status: 'pending', prompt: '', context_files: [], success_criteria: '', depends_on: [asPhaseId(1)] },
        ];
        const cycles = scheduler.detectCycles(phases);
        expect(cycles.sort()).toEqual([0, 1, 2]);
    });
});
