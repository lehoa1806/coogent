import { SelfHealingController } from '../SelfHealing.js';
import { asPhaseId, type Phase } from '../../types/index.js';

describe('SelfHealingController', () => {
    let healer: SelfHealingController;

    beforeEach(() => {
        healer = new SelfHealingController({ maxRetries: 2, baseDelayMs: 10 });
    });

    test('records failures and counts attempts', () => {
        healer.recordFailure(1, 1, 'Syntax error');
        expect(healer.getAttemptCount(1)).toBe(1);

        healer.recordFailure(1, 1, 'Still syntax error');
        expect(healer.getAttemptCount(1)).toBe(2);
    });

    test('canRetry returns true within limit', () => {
        expect(healer.canRetry(1)).toBe(true);
        healer.recordFailure(1, 1, 'Error 1');
        expect(healer.canRetry(1)).toBe(true);
        healer.recordFailure(1, 1, 'Error 2');
        expect(healer.canRetry(1)).toBe(false);
    });

    test('canRetryWithPhase respects phase level overrides', () => {
        const phase: Phase = {
            id: asPhaseId(1), status: 'failed', prompt: 'Fix it', context_files: [], success_criteria: '', max_retries: 5
        };

        healer.recordFailure(1, 1, 'Error 1');
        healer.recordFailure(1, 1, 'Error 2');
        healer.recordFailure(1, 1, 'Error 3');

        expect(healer.canRetryWithPhase(phase)).toBe(true); // Default maxRetries=2, but override is 5
    });

    test('getRetryDelay uses exponential backoff with ±20% jitter', () => {
        // L-9: Jitter adds ±20% to the base delay, so we check ranges
        const delay0 = healer.getRetryDelay(1);
        expect(delay0).toBeGreaterThanOrEqual(10 * 0.8); // 10 * 0.8 = 8
        expect(delay0).toBeLessThanOrEqual(10 * 1.2);    // 10 * 1.2 = 12

        healer.recordFailure(1, 1, 'Error 1');
        const delay1 = healer.getRetryDelay(1);
        expect(delay1).toBeGreaterThanOrEqual(20 * 0.8); // 20 * 0.8 = 16
        expect(delay1).toBeLessThanOrEqual(20 * 1.2);    // 20 * 1.2 = 24

        healer.recordFailure(1, 1, 'Error 2');
        const delay2 = healer.getRetryDelay(1);
        expect(delay2).toBeGreaterThanOrEqual(40 * 0.8); // 40 * 0.8 = 32
        expect(delay2).toBeLessThanOrEqual(40 * 1.2);    // 40 * 1.2 = 48
    });

    test('buildHealingPrompt injects failure context', () => {
        const phase: Phase = {
            id: asPhaseId(1), status: 'failed', prompt: 'Do math', context_files: [], success_criteria: ''
        };

        healer.recordFailure(1, 127, 'ReferenceError: x is not defined');

        const prompt = healer.buildHealingPrompt(phase);
        expect(prompt).toContain('Do math');
        expect(prompt).toContain('127');
        expect(prompt).toContain('ReferenceError: x is not defined');
        expect(prompt).toContain('Retry 1/2');
    });

    test('clearAttempts removes tracking data', () => {
        healer.recordFailure(1, 1, 'Error');
        expect(healer.getAttemptCount(1)).toBe(1);
        healer.clearAttempts(1);
        expect(healer.getAttemptCount(1)).toBe(0);
    });
});
