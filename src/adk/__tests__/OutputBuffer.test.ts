// ─────────────────────────────────────────────────────────────────────────────
// src/adk/__tests__/OutputBuffer.test.ts — OutputBuffer unit tests (#72)
// ─────────────────────────────────────────────────────────────────────────────

import { OutputBuffer } from '../OutputBuffer.js';

describe('OutputBuffer', () => {
    let flushSpy: jest.Mock;

    beforeEach(() => {
        flushSpy = jest.fn();
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('flushes on timer after FLUSH_INTERVAL_MS of inactivity', () => {
        const buffer = new OutputBuffer(1, 'stdout', flushSpy);
        buffer.append('hello');
        expect(flushSpy).not.toHaveBeenCalled();

        jest.advanceTimersByTime(101);
        expect(flushSpy).toHaveBeenCalledWith(1, 'stdout', 'hello');
    });

    it('flushes immediately when buffer exceeds MAX_BUFFER_SIZE (4096)', () => {
        const buffer = new OutputBuffer(2, 'stderr', flushSpy);
        const bigChunk = 'x'.repeat(4096);
        buffer.append(bigChunk);
        expect(flushSpy).toHaveBeenCalledWith(2, 'stderr', bigChunk);
    });

    it('no-ops when flushing an empty buffer', () => {
        const buffer = new OutputBuffer(3, 'stdout', flushSpy);
        buffer.flush();
        expect(flushSpy).not.toHaveBeenCalled();
    });

    it('dispose flushes remaining content', () => {
        const buffer = new OutputBuffer(4, 'stdout', flushSpy);
        buffer.append('remaining');
        buffer.dispose();
        expect(flushSpy).toHaveBeenCalledWith(4, 'stdout', 'remaining');
    });

    it('double flush after dispose is a no-op', () => {
        const buffer = new OutputBuffer(5, 'stdout', flushSpy);
        buffer.append('data');
        buffer.dispose();
        expect(flushSpy).toHaveBeenCalledTimes(1);
        buffer.flush();
        expect(flushSpy).toHaveBeenCalledTimes(1);
    });

    it('accumulates multiple small chunks before flush', () => {
        const buffer = new OutputBuffer(6, 'stdout', flushSpy);
        buffer.append('a');
        buffer.append('b');
        buffer.append('c');
        expect(flushSpy).not.toHaveBeenCalled();

        jest.advanceTimersByTime(101);
        expect(flushSpy).toHaveBeenCalledWith(6, 'stdout', 'abc');
    });
});
