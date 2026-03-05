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

/**
 * Render token budget progress bar.
 * @param {{ totalTokens: number, limit: number, breakdown: Array<{ path: string, tokens: number }> }} data
 */
export function renderTokenBudget(data) {
    const $tokenBar = document.getElementById('token-bar');
    const $tokenFill = document.getElementById('token-fill');
    const $tokenLabel = document.getElementById('token-label');
    if (!$tokenBar || !$tokenFill || !$tokenLabel) return;

    $tokenBar.style.display = 'block';
    const pct = Math.min(100, (data.totalTokens / data.limit) * 100);

    $tokenFill.style.width = `${pct}%`;
    // Change fill color based on usage level
    if (pct > 90) {
        $tokenFill.style.background = 'var(--error)';
    } else if (pct > 70) {
        $tokenFill.style.background = 'var(--warning)';
    } else {
        $tokenFill.style.background = '';  // Use CSS default
    }

    $tokenLabel.textContent =
        `${data.totalTokens.toLocaleString()} / ${data.limit.toLocaleString()} tokens (${Math.round(pct)}%) · ${data.breakdown.length} files`;
}
