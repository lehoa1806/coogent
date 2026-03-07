// ─────────────────────────────────────────────────────────────────────────────
// src/utils/WorkspaceHelper.ts — Multi-root workspace resolution utilities
// ─────────────────────────────────────────────────────────────────────────────
// Centralises all workspace-root access and storage path resolution so that
// multi-root workspaces can be supported without scattering vscode API calls
// throughout the codebase.

import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ═══════════════════════════════════════════════════════════════════════════════
//  Types
// ═══════════════════════════════════════════════════════════════════════════════

/** Returned when exactly one root matches. */
export interface ResolvedFile {
    resolved: string;
    root: string;
}

/** Returned when multiple roots contain the same relative path. */
export interface AmbiguousFile {
    ambiguous: string[];
}

/** Returned when no root contains the relative path. */
export interface NotFoundFile {
    notFound: true;
}

export type FileResolutionResult = ResolvedFile | AmbiguousFile | NotFoundFile;

/** Parsed workspace-qualified path in `<workspaceName>:relative/path` format. */
export interface WorkspaceQualifiedPath {
    workspaceName: string;
    relativePath: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Functions
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Returns all workspace folder root paths as an array of absolute `fsPath`
 * strings. Returns an empty array if no workspace folders are open.
 */
export function getWorkspaceRoots(): string[] {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        return [];
    }
    return folders.map((f) => f.uri.fsPath);
}

/**
 * Returns the first workspace folder path (backward compat).
 * Used only where a single root is genuinely needed (e.g., logging).
 * Returns `undefined` if no workspace folders are open.
 */
export function getPrimaryRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/**
 * Returns the workspace-scoped extension storage base path.
 *
 * Prefers `context.storageUri?.fsPath` (workspace-scoped) and falls back to
 * `context.globalStorageUri.fsPath` (global-scoped) when the workspace URI is
 * unavailable. This is the recommended location for `.coogent/ipc/` sessions.
 *
 * @param context  The VS Code extension context provided at activation.
 * @returns        An absolute path to the extension storage directory.
 */
export function getStorageBasePath(context: vscode.ExtensionContext): string {
    return context.storageUri?.fsPath ?? context.globalStorageUri.fsPath;
}

/**
 * Given a relative path, check each root for the file's existence.
 *
 * - If exactly **one** root contains the file → return `{ resolved, root }`.
 * - If **multiple** roots contain it → return `{ ambiguous: [...roots] }`.
 * - If **no** root contains it → return `{ notFound: true }`.
 *
 * The check uses `fs.existsSync` so the function remains synchronous and
 * deterministic — suitable for both Node unit tests and VS Code runtime.
 *
 * @param relativePath  A forward-slash relative path (e.g., `src/index.ts`).
 * @param roots         Array of absolute workspace root paths.
 */
export function resolveFileAcrossRoots(
    relativePath: string,
    roots: string[],
): FileResolutionResult {
    const matchingRoots: string[] = [];

    for (const root of roots) {
        const candidate = path.join(root, relativePath);
        if (fs.existsSync(candidate)) {
            matchingRoots.push(root);
        }
    }

    if (matchingRoots.length === 1) {
        return {
            resolved: path.join(matchingRoots[0], relativePath),
            root: matchingRoots[0],
        };
    }

    if (matchingRoots.length > 1) {
        return { ambiguous: matchingRoots };
    }

    return { notFound: true };
}

/**
 * Parse a workspace-qualified path string in the format
 * `<workspaceName>:relative/path`.
 *
 * Returns `null` if the input does not match the expected format.
 * The workspace name must be non-empty and must not itself contain a colon.
 * The relative path must also be non-empty.
 *
 * @param pathStr  The path string to parse.
 */
export function parseWorkspaceQualifiedPath(
    pathStr: string,
): WorkspaceQualifiedPath | null {
    const colonIndex = pathStr.indexOf(':');
    if (colonIndex <= 0) {
        return null;
    }

    const workspaceName = pathStr.slice(0, colonIndex);
    const relativePath = pathStr.slice(colonIndex + 1);

    if (relativePath.length === 0) {
        return null;
    }

    return { workspaceName, relativePath };
}

/**
 * Resolve a workspace-qualified path (`<workspaceName>:relative/path`) to an
 * absolute file-system path by matching the workspace name against the
 * provided `WorkspaceFolder` array.
 *
 * Returns `null` if:
 * - the input string cannot be parsed as a qualified path, or
 * - no workspace folder matches the given name.
 *
 * @param qualifiedPath  A path in `<workspaceName>:relative/path` format.
 * @param folders        The array of currently open workspace folders.
 */
export function resolveQualifiedPath(
    qualifiedPath: string,
    folders: vscode.WorkspaceFolder[],
): string | null {
    const parsed = parseWorkspaceQualifiedPath(qualifiedPath);
    if (!parsed) {
        return null;
    }

    const folder = folders.find((f) => f.name === parsed.workspaceName);
    if (!folder) {
        return null;
    }

    return path.join(folder.uri.fsPath, parsed.relativePath);
}
