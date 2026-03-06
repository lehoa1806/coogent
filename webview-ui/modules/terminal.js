// ─────────────────────────────────────────────────────────────────────────────
// webview-ui/modules/terminal.js — Terminal output management
// ─────────────────────────────────────────────────────────────────────────────

// @ts-check
/// <reference lib="dom" />

import { renderMarkdown, renderMermaidBlocks } from './markdown.js';

const MAX_LOG_NODES = 5000;

/** @type {HTMLElement | null} */
let $output = null;
/** @type {HTMLElement | null} */
let $outputRendered = null;
/** @type {HTMLElement | null} */
let $btnScrollBottom = null;
/** @type {HTMLElement | null} */
let $btnPreview = null;
/** @type {HTMLElement | null} */
let $btnRaw = null;
/** @type {'raw' | 'preview'} */
let terminalMode = 'raw';

/**
 * Initialize terminal DOM references and scroll listeners.
 */
export function initTerminal() {
    $output = document.getElementById('output');
    $outputRendered = document.getElementById('output-rendered');
    $btnScrollBottom = document.getElementById('btn-scroll-bottom');
    $btnPreview = document.getElementById('btn-terminal-preview');
    $btnRaw = document.getElementById('btn-terminal-raw');

    // Scroll-to-bottom button click
    $btnScrollBottom?.addEventListener('click', () => {
        if ($output) $output.scrollTop = $output.scrollHeight;
    });

    // Toggle scroll-to-bottom button visibility on scroll
    $output?.addEventListener('scroll', () => {
        if (!$output || !$btnScrollBottom) return;
        const atBottom = ($output.scrollHeight - $output.scrollTop - $output.clientHeight) < 40;
        $btnScrollBottom.classList.toggle('visible', !atBottom);
    });

    // Preview/Raw toggle for global terminal
    $btnPreview?.addEventListener('click', () => {
        terminalMode = 'preview';
        $btnPreview?.classList.add('active');
        $btnRaw?.classList.remove('active');
        if ($output) $output.style.display = 'none';
        if ($btnScrollBottom) $btnScrollBottom.style.display = 'none';
        if ($outputRendered) {
            $outputRendered.style.display = 'block';
            $outputRendered.innerHTML = renderMarkdown($output?.textContent || '');
            renderMermaidBlocks();
        }
    });

    $btnRaw?.addEventListener('click', () => {
        terminalMode = 'raw';
        $btnRaw?.classList.add('active');
        $btnPreview?.classList.remove('active');
        if ($output) $output.style.display = 'block';
        if ($btnScrollBottom) $btnScrollBottom.style.display = '';
        if ($outputRendered) $outputRendered.style.display = 'none';
    });
}

/**
 * Append text to the terminal output.
 * Auto-scrolls if the user is near the bottom.
 * @param {string} text
 * @param {'stdout' | 'stderr'} stream
 */
export function appendOutput(text, stream) {
    if (!$output) return;

    const span = document.createElement('span');
    if (stream === 'stderr') span.className = 'stderr';
    span.textContent = text;
    $output.appendChild(span);

    // Truncate if over limit
    while ($output.childNodes.length > MAX_LOG_NODES) {
        $output.removeChild(/** @type {Node} */($output.firstChild));
    }

    // Auto-scroll to bottom (only if user is near bottom)
    const atBottom = ($output.scrollHeight - $output.scrollTop - $output.clientHeight) < 80;
    if (atBottom) {
        $output.scrollTop = $output.scrollHeight;
    }
}

/**
 * Clear all terminal output.
 */
export function clearOutput() {
    if ($output) $output.textContent = 'Consolidation report will appear here when all phases complete.\n';
    if ($outputRendered) $outputRendered.innerHTML = '';
}
