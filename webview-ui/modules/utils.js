// ─────────────────────────────────────────────────────────────────────────────
// webview-ui/modules/utils.js — Shared utilities for the Mission Control UI
// ─────────────────────────────────────────────────────────────────────────────

// @ts-check

/**
 * Escape HTML entities to prevent XSS.
 * @param {string} str
 * @returns {string}
 */
export function escapeHtml(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Format a timestamp as relative time (e.g., "5m ago", "2h ago").
 * @param {number} timestamp
 * @returns {string}
 */
export function formatRelativeTime(timestamp) {
    if (!timestamp) return '';
    const diff = Date.now() - timestamp;
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    if (minutes > 0) return `${minutes}m ago`;
    return 'just now';
}

/**
 * Truncate a string to `max` characters, appending an ellipsis when needed.
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
export function truncate(text, max) {
    if (!text) return '';
    return text.length > max ? text.slice(0, max) + '…' : text;
}

/**
 * Format a duration in milliseconds to a human-readable string.
 * Examples: "2.3s", "1m 45s", "1h 2m".
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
    if (!ms || ms < 0) return '0s';
    if (ms < 1000) return `${ms}ms`;
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    // Show one decimal for short durations
    return `${(ms / 1000).toFixed(1)}s`;
}
