// ─────────────────────────────────────────────────────────────────────────────
// lib/mermaid.ts — Mermaid diagram rendering with VS Code theme awareness
//
// Uses dynamic import('mermaid') so the heavy library is code-split into a
// separate chunk, reducing the main bundle size by ~60%.
// ─────────────────────────────────────────────────────────────────────────────

import { escapeHtml } from './markdown.js';

// ─── Lazy Module Cache ───────────────────────────────────────────────────────

/** Cached mermaid default export, resolved once on first use. */
let _mermaid: typeof import('mermaid').default | undefined;

/** Lazily load and cache the mermaid module. */
async function getMermaid() {
    if (!_mermaid) {
        const mod = await import('mermaid');
        _mermaid = mod.default;
    }
    return _mermaid;
}

// ─── Theme Helpers ───────────────────────────────────────────────────────────

/**
 * Read a VS Code CSS custom property from the document root.
 */
function readCssVar(varName: string): string {
    return getComputedStyle(document.documentElement)
        .getPropertyValue(varName)
        .trim();
}

/**
 * Build Mermaid `themeVariables` by mapping VS Code CSS custom properties
 * to Mermaid's theming tokens.
 */
function buildThemeVariables(): Record<string, string> {
    return {
        primaryColor: readCssVar('--vscode-editor-background'),
        primaryTextColor: readCssVar('--vscode-editor-foreground'),
        primaryBorderColor: readCssVar('--vscode-editorWidget-border'),
        lineColor: readCssVar('--vscode-editor-foreground'),
        secondaryColor: readCssVar('--vscode-sideBar-background'),
        tertiaryColor: readCssVar('--vscode-editor-background'),
        fontFamily: readCssVar('--vscode-font-family'),
    };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Initialize Mermaid with VS Code theme–aware variables.
 * Call once at application boot time (inside `onMount`).
 *
 * Lazily loads the mermaid library on first call.
 */
export async function initMermaid(): Promise<void> {
    const mermaid = await getMermaid();
    mermaid.initialize({
        startOnLoad: false,
        theme: 'base',
        themeVariables: buildThemeVariables(),
        securityLevel: 'strict',
    });
}

/**
 * Find all un-rendered `.mermaid` elements within the given container and
 * render them using `mermaid.render()`.
 *
 * Successfully rendered diagrams have their `innerHTML` replaced with SVG
 * and are marked with `data-mermaid-rendered="true"` to prevent reprocessing.
 *
 * Invalid Mermaid syntax is caught gracefully with a fallback display.
 */
export async function renderMermaidBlocks(container: HTMLElement): Promise<void> {
    const elements = container.querySelectorAll<HTMLElement>(
        '.mermaid:not([data-mermaid-rendered])',
    );

    if (elements.length === 0) return;

    const mermaid = await getMermaid();

    for (let i = 0; i < elements.length; i++) {
        const el = elements[i];
        const source = el.textContent || '';
        const id = `mermaid-${Date.now()}-${i}`;

        try {
            const { svg } = await mermaid.render(id, source);
            el.innerHTML = svg;
            el.setAttribute('data-mermaid-rendered', 'true');
        } catch {
            el.innerHTML =
                `<pre class="mermaid-error"><code>${escapeHtml(source)}</code></pre>` +
                `<div class="mermaid-error-notice">⚠ Invalid Mermaid syntax</div>`;
            el.setAttribute('data-mermaid-rendered', 'true');
        }
    }
}

/**
 * Re-read VS Code CSS variables, re-initialize Mermaid with updated
 * theme variables, clear the render cache, and re-render all blocks.
 *
 * Call when VS Code's color theme changes.
 */
export async function refreshMermaidTheme(): Promise<void> {
    const mermaid = await getMermaid();

    // Re-initialize with fresh theme variables
    mermaid.initialize({
        startOnLoad: false,
        theme: 'base',
        themeVariables: buildThemeVariables(),
        securityLevel: 'strict',
    });

    // Clear rendered state so blocks will be re-processed
    document.querySelectorAll('.mermaid[data-mermaid-rendered]').forEach((el) => {
        el.removeAttribute('data-mermaid-rendered');
    });

    // Re-render all mermaid blocks on the page
    await renderMermaidBlocks(document.body);
}
