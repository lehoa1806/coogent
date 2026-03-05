// ─────────────────────────────────────────────────────────────────────────────
// webview-ui/modules/terminal.js — Terminal output management
// ─────────────────────────────────────────────────────────────────────────────

// @ts-check
/// <reference lib="dom" />

const MAX_LOG_NODES = 5000;

/** @type {HTMLElement | null} */
let $output = null;
/** @type {HTMLElement | null} */
let $btnScrollBottom = null;

/**
 * Initialize terminal DOM references and scroll listeners.
 */
export function initTerminal() {
    $output = document.getElementById('output');
    $btnScrollBottom = document.getElementById('btn-scroll-bottom');

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
}

