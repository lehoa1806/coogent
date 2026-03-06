// ─────────────────────────────────────────────────────────────────────────────
// lib/markdown.ts — Markdown rendering with Mermaid code-fence detection
//
// Configures `marked` with GFM, intercepts ```mermaid fenced code blocks and
// wraps them in <div class="mermaid"> containers for later rendering by
// mermaid.ts.
// ─────────────────────────────────────────────────────────────────────────────

import { marked, type Renderer, type Tokens } from 'marked';

// ─── Utilities ───────────────────────────────────────────────────────────────

const ESCAPE_MAP: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
};

/**
 * Escape HTML special characters to prevent XSS when injecting user content.
 */
export function escapeHtml(str: string): string {
    return str.replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch] ?? ch);
}

// ─── Marked Configuration ────────────────────────────────────────────────────

let initialized = false;

/**
 * Configure `marked` with a custom renderer that intercepts Mermaid fenced
 * code blocks and wraps them in containers for later rendering.
 *
 * Safe to call multiple times — only the first call takes effect.
 */
export function initMarkdown(): void {
    if (initialized) return;
    initialized = true;

    const renderer: Partial<Renderer> = {
        code({ text, lang }: Tokens.Code): string {
            if (lang === 'mermaid') {
                return `<div class="mermaid-container"><div class="mermaid">${text}</div></div>`;
            }
            const langClass = lang ? ` class="language-${escapeHtml(lang)}"` : '';
            return `<pre><code${langClass}>${escapeHtml(text)}</code></pre>`;
        },
    };

    marked.use({
        renderer,
        gfm: true,
        breaks: false,
        async: false,
    });
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Parse a Markdown string into an HTML string.
 *
 * Requires `initMarkdown()` to have been called first (otherwise uses marked
 * defaults, which still work but won't intercept mermaid blocks).
 */
export function renderMarkdown(md: string): string {
    if (!md) return '';
    return marked.parse(md) as string;
}
