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
    getAsObject(): Record<string, unknown>;
    free(): void;
}
