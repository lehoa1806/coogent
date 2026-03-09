// ─────────────────────────────────────────────────────────────────────────────
// src/context/TiktokenEncoder.ts — Precise token counting via js-tiktoken
// ─────────────────────────────────────────────────────────────────────────────

import { CharRatioEncoder, type TokenEncoder } from './ContextScoper.js';
import log from '../logger/log.js';

/**
 * Token encoder backed by js-tiktoken's cl100k_base encoding.
 *
 * - **Lazy initialization**: the tiktoken encoder is created on the first
 *   call to `countTokens()`, not at construction time. This avoids paying
 *   the WASM / dictionary init cost if the encoder is never used.
 * - **Graceful fallback**: if js-tiktoken fails to initialize for any reason,
 *   this transparently falls back to `CharRatioEncoder` (chars / 4) and logs
 *   a warning.
 */
export class TiktokenEncoder implements TokenEncoder {
    private encoder: { encode: (text: string) => number[] } | null = null;
    private fallback: CharRatioEncoder | null = null;
    private initialized = false;

    countTokens(text: string): number {
        if (!this.initialized) {
            this.initEncoder();
        }

        if (this.encoder) {
            return this.encoder.encode(text).length;
        }

        // Fallback path — CharRatioEncoder is guaranteed to be set when
        // this.encoder is null after initialization.
        return this.fallback!.countTokens(text);
    }

    private initEncoder(): void {
        this.initialized = true;
        try {
            // Dynamic import is not needed here because js-tiktoken is a
            // pure-JS package (no native bindings). Static import at the
            // top level is fine; lazy init only defers the getEncoding() call.
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { getEncoding } = require('js-tiktoken') as { getEncoding: (encoding: string) => { encode: (text: string) => number[] } };
            this.encoder = getEncoding('cl100k_base');
            log.info('[TiktokenEncoder] Initialized with cl100k_base encoding');
        } catch (err) {
            log.warn(
                `[TiktokenEncoder] Failed to initialize js-tiktoken, falling back to CharRatioEncoder: ${err instanceof Error ? err.message : String(err)
                }`
            );
            this.fallback = new CharRatioEncoder();
        }
    }
}
