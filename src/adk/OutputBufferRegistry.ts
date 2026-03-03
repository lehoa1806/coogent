// ─────────────────────────────────────────────────────────────────────────────
// src/adk/OutputBufferRegistry.ts — Encapsulated output buffer management
// See 02-review.md § R11 — replaces module-level Map in extension.ts
// ─────────────────────────────────────────────────────────────────────────────

import { OutputBuffer } from './OutputBuffer.js';

type FlushCallback = (phaseId: number, stream: 'stdout' | 'stderr', chunk: string) => void;

/**
 * Manages OutputBuffer instances per phase/stream pair.
 *
 * Encapsulates the lifecycle of buffers so they are properly cleaned up
 * when phases complete (preventing memory leaks) and when the extension
 * deactivates (preventing orphaned timers).
 *
 * Implements `Disposable` for registration in `context.subscriptions`.
 */
export class OutputBufferRegistry {
    private readonly buffers = new Map<string, OutputBuffer>();
    private readonly onFlush: FlushCallback;

    constructor(onFlush: FlushCallback) {
        this.onFlush = onFlush;
    }

    /**
     * Get or create a buffer for a given phase + stream pair.
     */
    getOrCreate(phaseId: number, stream: 'stdout' | 'stderr'): OutputBuffer {
        const key = `${phaseId}-${stream}`;
        let buffer = this.buffers.get(key);
        if (!buffer) {
            buffer = new OutputBuffer(phaseId, stream, this.onFlush);
            this.buffers.set(key, buffer);
        }
        return buffer;
    }

    /**
     * Flush and remove buffers for a completed/failed phase.
     * Prevents memory leaks from accumulated OutputBuffer instances.
     */
    flushAndRemove(phaseId: number): void {
        for (const stream of ['stdout', 'stderr'] as const) {
            const key = `${phaseId}-${stream}`;
            this.buffers.get(key)?.dispose();
            this.buffers.delete(key);
        }
    }

    /**
     * Dispose all buffers — flushes remaining content and clears the map.
     * Called on extension deactivation.
     */
    dispose(): void {
        for (const buffer of this.buffers.values()) {
            buffer.dispose();
        }
        this.buffers.clear();
    }
}
