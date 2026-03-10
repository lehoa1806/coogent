// ─────────────────────────────────────────────────────────────────────────────
// src/session/session-utils.ts — Pure session utility functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strip the `YYYYMMDD-HHMMSS-` prefix from a session directory name to get the raw UUID.
 * Returns the input unchanged if no prefix is present.
 */
export function stripSessionDirPrefix(dirName: string): string {
    // Prefix format: 8 digits + dash + 6 digits + dash = 16 chars
    const prefixMatch = dirName.match(/^\d{8}-\d{6}-(.+)$/);
    return prefixMatch ? prefixMatch[1] : dirName;
}

/**
 * Extract the millisecond timestamp embedded in a UUIDv7.
 * Handles both raw UUIDs and prefixed directory names (YYYYMMDD-HHMMSS-<uuid>).
 * UUIDv7 format: `TTTTTTTT-TTTT-7xxx-yxxx-xxxxxxxxxxxx`
 * The first 48 bits (12 hex chars across the first two segments) encode Unix ms.
 */
export function extractUUIDv7Timestamp(dirNameOrUuid: string): number {
    // Strip YYYYMMDD-HHMMSS- prefix if present (Bug 2)
    const uuid = stripSessionDirPrefix(dirNameOrUuid);
    const parts = uuid.split('-');
    if (parts.length < 2) return 0;
    const hex = parts[0] + parts[1]; // 8 + 4 = 12 hex chars = 48 bits
    return parseInt(hex, 16) || 0;
}

/**
 * Format a session directory name as `YYYYMMDD-HHMMSS-<uuid>` (Bug 2).
 */
export function formatSessionDirName(uuid: string, now = new Date()): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-`
        + `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    return `${ts}-${uuid}`;
}
