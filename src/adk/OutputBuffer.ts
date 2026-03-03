// ─────────────────────────────────────────────────────────────────────────────
// src/adk/OutputBuffer.ts — Buffered output streaming to Webview
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Buffers rapid output chunks and flushes in batches to prevent
 * UI thread congestion from high-frequency postMessage calls.
 *
 * Strategy:
 * - Flush immediately if buffer exceeds MAX_BUFFER_SIZE.
 * - Otherwise flush after FLUSH_INTERVAL_MS of inactivity.
 *
 * See TDD §3.3 for the specification.
 */
export class OutputBuffer {
    private buffer = '';
    private flushTimer: ReturnType<typeof setTimeout> | null = null;

    private static readonly FLUSH_INTERVAL_MS = 100;
    private static readonly MAX_BUFFER_SIZE = 4096;

    constructor(
        private readonly phaseId: number,
        private readonly stream: 'stdout' | 'stderr',
        private readonly onFlush: (phaseId: number, stream: 'stdout' | 'stderr', chunk: string) => void
    ) { }

    /**
     * Append a chunk of output. May trigger an immediate flush.
     */
    append(chunk: string): void {
        this.buffer += chunk;

        if (this.buffer.length >= OutputBuffer.MAX_BUFFER_SIZE) {
            this.flush();
        } else if (!this.flushTimer) {
            this.flushTimer = setTimeout(
                () => this.flush(),
                OutputBuffer.FLUSH_INTERVAL_MS
            );
        }
    }

    /**
     * Force flush the buffer immediately.
     * Safe to call multiple times (no-ops if buffer is empty).
     */
    flush(): void {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }

        if (this.buffer.length > 0) {
            this.onFlush(this.phaseId, this.stream, this.buffer);
            this.buffer = '';
        }
    }

    /**
     * Dispose the buffer — flushes remaining content and clears timers.
     */
    dispose(): void {
        this.flush();
    }
}
