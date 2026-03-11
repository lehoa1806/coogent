// ─────────────────────────────────────────────────────────────────────────────
// src/constants/WorkspaceIdentity.ts — Workspace tenant identity derivation
// ─────────────────────────────────────────────────────────────────────────────
// ADR-002: workspace_id is a deterministic hash of the canonicalized workspace
// root URI, used as the tenant key for all artifact data in the global DB.

import * as crypto from 'node:crypto';
import * as path from 'node:path';

/**
 * Immutable workspace identity descriptor.
 * Used to scope all tenant-owned data in the global ArtifactDB.
 */
export interface WorkspaceIdentity {
    /** 16-hex-char SHA-256 prefix of the canonicalized workspace URI. */
    readonly workspaceId: string;
    /** Canonicalized absolute path (lowercase, no trailing separator). */
    readonly workspaceRootUri: string;
    /** Human-readable workspace name (basename of the root path). */
    readonly workspaceName: string;
}

/**
 * Canonicalize a workspace root path for stable identity derivation.
 *
 * 1. Resolve to absolute path
 * 2. Lowercase (case-insensitive filesystem parity)
 * 3. Strip trailing path separator
 */
function canonicalize(workspaceRoot: string): string {
    let resolved = path.resolve(workspaceRoot).toLowerCase();
    while (resolved.length > 1 && resolved.endsWith(path.sep)) {
        resolved = resolved.slice(0, -1);
    }
    return resolved;
}

/**
 * Derive a stable `workspace_id` from a workspace root path.
 *
 * Returns a 16-hex-character prefix of the SHA-256 hash of the
 * canonicalized path. This gives 64 bits of collision resistance
 * which is more than sufficient for per-machine workspace scoping.
 *
 * @param workspaceRoot Absolute path to the workspace root directory.
 * @returns A 16-character hex string.
 */
export function deriveWorkspaceId(workspaceRoot: string): string {
    const canonical = canonicalize(workspaceRoot);
    return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/**
 * Create a full workspace identity descriptor from a workspace root path.
 *
 * @param workspaceRoot Absolute path to the workspace root directory.
 */
export function createWorkspaceIdentity(workspaceRoot: string): WorkspaceIdentity {
    const canonical = canonicalize(workspaceRoot);
    return {
        workspaceId: deriveWorkspaceId(workspaceRoot),
        workspaceRootUri: canonical,
        workspaceName: path.basename(canonical),
    };
}
