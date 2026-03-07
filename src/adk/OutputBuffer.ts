// ─────────────────────────────────────────────────────────────────────────────
// src/adk/OutputBuffer.ts — Buffered output streaming to Webview
// ─────────────────────────────────────────────────────────────────────────────

import { SecretsGuard } from '../context/SecretsGuard.js';

/**
 * Buffers rapid output chunks and flushes in batches to prevent
 * UI thread congestion from high-frequency postMessage calls.
 *
 * Strategy:
 * - Flush immediately if buffer exceeds MAX_BUFFER_SIZE.
 * - Otherwise flush after FLUSH_INTERVAL_MS of inactivity.
 * - Truncate oldest content when buffer exceeds MAX_TOTAL_BUFFER_SIZE.
 * - Redact detected secrets before broadcasting to UI.
 *
 * See TDD §3.3 for the specification.
 */
export class OutputBuffer {
    private buffer = '';
    private flushTimer: ReturnType<typeof setTimeout> | null = null;

    private static readonly FLUSH_INTERVAL_MS = 100;
    private static readonly MAX_BUFFER_SIZE = 4096;

    /** Upper bound cap to prevent unbounded memory growth (1 MB). */
    private static readonly MAX_TOTAL_BUFFER_SIZE = 1_048_576;

    constructor(
        private readonly phaseId: number,
        private readonly stream: 'stdout' | 'stderr',
        private readonly onFlush: (phaseId: number, stream: 'stdout' | 'stderr', chunk: string) => void
    ) { }

    /**
     * Append a chunk of output. May trigger an immediate flush.
     * When the buffer exceeds MAX_TOTAL_BUFFER_SIZE, the oldest content
     * is truncated and a [TRUNCATED] marker is prepended.
     */
    append(chunk: string): void {
        this.buffer += chunk;

        // Cap total buffer size to prevent unbounded growth
        if (this.buffer.length > OutputBuffer.MAX_TOTAL_BUFFER_SIZE) {
            const excess = this.buffer.length - OutputBuffer.MAX_TOTAL_BUFFER_SIZE;
            this.buffer = '[TRUNCATED]\n' + this.buffer.slice(excess + '[TRUNCATED]\n'.length);
        }

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
     * Redacts detected secrets before broadcasting to the UI.
     */
    flush(): void {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }

        if (this.buffer.length > 0) {
            // Redact secrets before broadcasting to UI and logs
            const redacted = SecretsGuard.redact(this.buffer);
            this.onFlush(this.phaseId, this.stream, redacted);
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
