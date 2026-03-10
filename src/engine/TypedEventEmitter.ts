// ─────────────────────────────────────────────────────────────────────────────
// src/engine/TypedEventEmitter.ts — Reusable typed EventEmitter base class
// ─────────────────────────────────────────────────────────────────────────────
// Extracted from Engine.ts to provide a generic typed EventEmitter that enforces
// event name and listener signature safety at compile time.
//
// Usage:
//   interface MyEvents {
//       'data': (payload: Buffer) => void;
//       'error': (err: Error) => void;
//   }
//   class MyEmitter extends TypedEventEmitter<MyEvents> { ... }

import { EventEmitter } from 'node:events';
import log from '../logger/log.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  TypedEventEmitter<T>
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Generic typed EventEmitter that provides compile-time safety for event
 * names and listener signatures.
 *
 * Subclasses define their event map via the generic parameter `T`:
 *
 * ```ts
 * interface MyEvents {
 *     'data': (payload: Buffer) => void;
 *     'error': (err: Error) => void;
 * }
 * class MyEmitter extends TypedEventEmitter<MyEvents> { ... }
 * ```
 *
 * Features:
 * - Type-safe `on()`, `once()`, `off()`, and `emit()` methods.
 * - Built-in listener error fencing: if a listener throws during `emit()`,
 *   the error is caught, logged, and a diagnostic event is emitted without
 *   crashing the process.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
export class TypedEventEmitter<T extends Record<string, (...args: any[]) => any>> extends EventEmitter {
    /** Guard against recursive emit when the error handler itself throws. */
    private _emittingError = false;

    constructor() {
        super();

        // Override emit() to fence listener errors.
        // This prevents a single bad listener from crashing the entire process.
        const origEmit = super.emit.bind(this);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (this as any).emit = (
            event: string,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ...args: any[]
        ): boolean => {
            try {
                return origEmit(event, ...args);
            } catch (err) {
                log.error(`[TypedEventEmitter] Listener error on '${event}':`, err);
                if (!this._emittingError) {
                    this._emittingError = true;
                    try {
                        origEmit('engine:listener-error', event, err);
                    } catch { /* swallow recursive error */ }
                    this._emittingError = false;
                }
                return true;
            }
        };
    }
}

// Type-safe method declarations via interface merging.
// This avoids the "override" keyword issues with generic constraints while
// still providing full compile-time type safety for callers.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export declare interface TypedEventEmitter<T extends Record<string, (...args: any[]) => any>> {
    on<K extends keyof T & string>(event: K, listener: T[K]): this;
    once<K extends keyof T & string>(event: K, listener: T[K]): this;
    off<K extends keyof T & string>(event: K, listener: T[K]): this;
    emit<K extends keyof T & string>(event: K, ...args: Parameters<T[K]>): boolean;
}
