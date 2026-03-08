// ─────────────────────────────────────────────────────────────────────────────
// src/declarations.d.ts — Ambient module declarations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Allows importing `.md` files as string constants.
 * esbuild's `loader: { '.md': 'text' }` inlines the file content at build time.
 */
declare module '*.md' {
    const content: string;
    export default content;
}
