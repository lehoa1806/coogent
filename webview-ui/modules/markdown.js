// @ts-check
/// <reference lib="dom" />

// ─────────────────────────────────────────────────────────────────────────────
// webview-ui/modules/markdown.js — Markdown rendering with Mermaid.js support
//
// Replaces the naive regex-based markdownToHtml() in renderers.js with a
// full `marked`-based parser, Mermaid diagram rendering, and a Raw/Rendered
// toggle UI.
// ─────────────────────────────────────────────────────────────────────────────

import { marked } from 'marked';
import mermaid from 'mermaid';
import { escapeHtml } from './utils.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  1. renderMarkdown(mdString)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Custom marked renderer that intercepts fenced code blocks to produce
 * Mermaid placeholders for `mermaid` language blocks.
 */
const renderer = new marked.Renderer();

/**
 * Override the `code` method to handle Mermaid blocks.
 * @param {string} code - The raw code content.
 * @param {string | undefined} lang - The language identifier.
 * @returns {string}
 */
renderer.code = function (code, lang) {
    if (lang === 'mermaid') {
        return `<div class="mermaid-container"><div class="mermaid">${code}</div></div>`;
    }
    const langClass = lang ? ` class="language-${escapeHtml(lang)}"` : '';
    return `<pre><code${langClass}>${escapeHtml(code)}</code></pre>`;
};

// Configure marked with GFM + line-break support
marked.setOptions({
    renderer,
    gfm: true,
    breaks: false,
});

/**
 * Parse a Markdown string into an HTML string using `marked` with GFM,
 * line-break support, and Mermaid placeholder injection.
 *
 * @param {string} mdString - Raw Markdown source.
 * @returns {string} Rendered HTML.
 */
export function renderMarkdown(mdString) {
    if (!mdString) return '';
    return /** @type {string} */ (marked.parse(mdString));
}

// ═══════════════════════════════════════════════════════════════════════════════
//  2. initMermaid()
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Read a VS Code CSS custom property from the document root.
 * @param {string} varName - CSS variable name (e.g. `--vscode-editor-background`).
 * @returns {string}
 */
function readCssVar(varName) {
    return getComputedStyle(document.documentElement)
        .getPropertyValue(varName)
        .trim();
}

/**
 * Build a Mermaid `themeVariables` object by mapping VS Code CSS variables
 * to Mermaid's theming tokens.
 * @returns {Record<string, string>}
 */
function buildThemeVariables() {
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

/**
 * Initialize Mermaid with VS Code theme–aware variables.
 * Call this once at application boot time.
 */
export function initMermaid() {
    mermaid.initialize({
        startOnLoad: false,
        theme: 'base',
        themeVariables: buildThemeVariables(),
        securityLevel: 'strict',
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  3. renderMermaidBlocks()
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Find all `.mermaid` elements that have not yet been rendered and render
 * them using `mermaid.render()`.
 *
 * Successfully rendered diagrams have their `innerHTML` replaced with SVG
 * and are marked with `data-mermaid-rendered="true"` to prevent re-processing.
 *
 * Invalid Mermaid syntax is caught gracefully and displayed as a fallback
 * `<pre>` block with an error notice.
 *
 * @returns {Promise<void>}
 */
export async function renderMermaidBlocks() {
    const elements = document.querySelectorAll('.mermaid:not([data-mermaid-rendered])');

    for (let i = 0; i < elements.length; i++) {
        const el = /** @type {HTMLElement} */ (elements[i]);
        const source = el.textContent || '';
        const id = `mermaid-${Date.now()}-${i}`;

        try {
            const { svg } = await mermaid.render(id, source);
            el.innerHTML = svg;
            el.setAttribute('data-mermaid-rendered', 'true');
        } catch (_err) {
            el.innerHTML =
                `<pre class="mermaid-error"><code>${escapeHtml(source)}</code></pre>` +
                `<div class="mermaid-error-notice">⚠ Invalid Mermaid syntax</div>`;
            el.setAttribute('data-mermaid-rendered', 'true');
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  4. createMarkdownContainer(mdString, containerId)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build the HTML string for a Markdown container with a Raw/Preview toggle.
 *
 * The container includes:
 *   - A toggle button bar (top-right) with Preview and Raw buttons.
 *   - A `.md-rendered` div with the parsed Markdown HTML (visible by default).
 *   - A `.md-raw` `<pre>` block with the escaped source (hidden by default).
 *
 * @param {string} mdString - Raw Markdown source.
 * @param {string} containerId - DOM id for the outer wrapper.
 * @returns {string} HTML string.
 */
export function createMarkdownContainer(mdString, containerId) {
    const rendered = renderMarkdown(mdString);
    const raw = escapeHtml(mdString || '');

    return `
        <div class="md-container" id="${escapeHtml(containerId)}">
            <div class="md-toggle-bar">
                <button class="md-toggle-btn active" data-mode="preview" title="Rendered preview">
                    <span aria-hidden="true">👁</span> Preview
                </button>
                <button class="md-toggle-btn" data-mode="raw" title="Raw Markdown source">
                    <span aria-hidden="true">{ }</span> Raw
                </button>
            </div>
            <div class="md-rendered">${rendered}</div>
            <div class="md-raw" style="display:none;"><pre>${raw}</pre></div>
        </div>
    `;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  5. attachMarkdownToggleHandlers(container)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Attach click handlers to `.md-toggle-btn` buttons inside all
 * `.md-container` elements found within the given parent.
 *
 * - "Preview" button → shows `.md-rendered`, hides `.md-raw`, re-renders
 *   any un-rendered Mermaid diagrams.
 * - "Raw" button → hides `.md-rendered`, shows `.md-raw`.
 *
 * @param {HTMLElement} container - Parent element containing `.md-container`s.
 */
export function attachMarkdownToggleHandlers(container) {
    const mdContainers = container.querySelectorAll('.md-container');

    mdContainers.forEach((mdContainer) => {
        // Guard: skip if handlers already attached (#Issue-10)
        if (mdContainer.dataset.toggleWired) return;
        mdContainer.dataset.toggleWired = 'true';

        const btns = mdContainer.querySelectorAll('.md-toggle-btn');
        const renderedDiv = /** @type {HTMLElement | null} */ (
            mdContainer.querySelector('.md-rendered')
        );
        const rawDiv = /** @type {HTMLElement | null} */ (
            mdContainer.querySelector('.md-raw')
        );

        btns.forEach((btn) => {
            btn.addEventListener('click', () => {
                const mode = btn.getAttribute('data-mode');

                // Toggle active class on buttons
                btns.forEach((b) => b.classList.remove('active'));
                btn.classList.add('active');

                if (mode === 'preview') {
                    if (renderedDiv) renderedDiv.style.display = 'block';
                    if (rawDiv) rawDiv.style.display = 'none';
                    // Re-render any Mermaid blocks that appeared in view
                    renderMermaidBlocks();
                } else {
                    // Issue 10 fix: use explicit 'block' instead of '' (empty
                    // string) because the CSS rule `.md-raw { display: none }`
                    // would override a cleared inline style.
                    if (renderedDiv) renderedDiv.style.display = 'none';
                    if (rawDiv) rawDiv.style.display = 'block';
                }
            });
        });
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  6. refreshMermaidTheme()
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Re-read VS Code CSS variables, re-initialize Mermaid with updated
 * theme variables, clear the render cache, and re-render all diagrams.
 *
 * Call this when VS Code's color theme changes.
 *
 * @returns {Promise<void>}
 */
export async function refreshMermaidTheme() {
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

    // Re-render all blocks with new theme
    await renderMermaidBlocks();
}
