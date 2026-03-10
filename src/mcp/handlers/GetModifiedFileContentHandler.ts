// ─────────────────────────────────────────────────────────────────────────────
// src/mcp/handlers/GetModifiedFileContentHandler.ts
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { MCPValidator } from '../MCPValidator.js';
import { safeTruncate } from '../CoogentMCPServer.js';
import { ERR_MCP_PATH_TRAVERSAL_BLOCKED } from '../../logger/ErrorCodes.js';
import log from '../../logger/log.js';
import type { ToolHandlerDeps, MCPTextContent } from '../tool-schemas.js';

export async function handleGetModifiedFileContent(
    deps: ToolHandlerDeps,
    args: Record<string, unknown>,
): Promise<MCPTextContent> {
    const masterTaskId = MCPValidator.validateMasterTaskId(args['masterTaskId']);
    const phaseId = MCPValidator.validatePhaseId(args['phaseId']);
    const filePath = MCPValidator.validateString(args['file_path'], 'file_path');

    // MF-2 FIX: pathLike validation for defense-in-depth parity with
    // submit_phase_handoff's modified_files. The realpath boundary check
    // (below) is the true security gate, but this catches malformed inputs early.
    if (filePath.length > 260) {
        throw new Error('Invalid file_path: exceeds maximum length (260)');
    }
    if (!/^[\w\-./]+$/.test(filePath)) {
        throw new Error('Invalid file_path: contains disallowed characters');
    }

    /**
     * @security R-3 Authorization Gate
     *
     * Verifies the masterTaskId belongs to an active session before
     * performing any file I/O. Prevents IDOR by callers with fabricated but
     * syntactically valid masterTaskId values.
     */
    const task = deps.db.tasks.get(masterTaskId);
    if (!task) {
        log.warn(`[MCPToolHandler] R-3: Unauthorized file read attempt for task ${masterTaskId}.`);
        throw new Error('Unauthorized');
    }

    // B-2: Resolve symlinks before boundary check to prevent symlink-based path traversal
    let resolved: string;
    let realWorkspaceRoot: string;
    try {
        resolved = await fs.realpath(path.resolve(deps.workspaceRoot, filePath));
        realWorkspaceRoot = await fs.realpath(deps.workspaceRoot);
    } catch {
        log.warn(`[MCPToolHandler] File not found (realpath): ${filePath}`);
        throw new Error('File not found');
    }
    if (!resolved.startsWith(realWorkspaceRoot + path.sep) && resolved !== realWorkspaceRoot) {
        log.warn(`[MCPToolHandler] Path traversal blocked: ${filePath}`);
        deps.telemetryLogger?.logBoundaryEvent(ERR_MCP_PATH_TRAVERSAL_BLOCKED, {
            filePath,
            resolved,
            workspaceRoot: deps.workspaceRoot,
        });
        throw new Error('Access denied');
    }

    try {
        const rawContent = await fs.readFile(resolved, 'utf-8');
        const MAX_FILE_CHARS = 32_000;
        const isTruncated = rawContent.length > MAX_FILE_CHARS;
        let safeContent: string;
        if (isTruncated) {
            const lineCount = rawContent.split('\n').length;
            // R-2: Use surrogate-pair-safe truncation.
            safeContent = safeTruncate(rawContent, MAX_FILE_CHARS) +
                `\n\n[TRUNCATED: ${rawContent.length} chars / ~${lineCount} lines total; showing first ${MAX_FILE_CHARS} chars. Re-invoke with a narrower file_path or specific line range.]`;
            log.warn('[MCPToolHandler] File truncated:', filePath, rawContent.length, 'chars');
        } else {
            safeContent = rawContent;
        }
        log.info(
            `[MCPToolHandler] File read: ${filePath} (task=${masterTaskId}, phase=${phaseId})`
        );
        return {
            content: [{ type: 'text', text: safeContent }],
        };
    } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
            log.warn(`[MCPToolHandler] File not found (readFile): ${filePath}`);
            throw new Error('File not found');
        }
        log.warn(`[MCPToolHandler] File read error: ${filePath}`, (err as Error).message);
        throw new Error('Failed to read file');
    }
}
