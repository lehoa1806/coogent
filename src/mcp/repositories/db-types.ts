// ─────────────────────────────────────────────────────────────────────────────
// src/mcp/repositories/db-types.ts — Shared sql.js type definitions
// ─────────────────────────────────────────────────────────────────────────────

export interface Database {
    run(sql: string, params?: unknown[]): void;
    exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>;
    prepare(sql: string): Statement;
    export(): Uint8Array;
    close(): void;
}

export interface Statement {
    bind(params?: unknown[]): boolean;
    step(): boolean;
    /** Return current row as a plain object, keyed by column name. */
    getAsObject(): Record<string, unknown>;
    /**
     * Typed convenience overload — callers supply the expected row shape `T`.
     * @internal Runtime return type is still `Record<string, unknown>`;
     * the generic parameter provides compile-time narrowing only.
     */
    getAsObject<T extends Record<string, unknown>>(): T;
    free(): void;
}
