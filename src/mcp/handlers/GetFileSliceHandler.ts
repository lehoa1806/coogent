// ─────────────────────────────────────────────────────────────────────────────
// src/mcp/handlers/GetFileSliceHandler.ts
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { MCPValidator } from '../MCPValidator.js';
import log from '../../logger/log.js';
import type { ToolHandlerDeps, MCPTextContent } from '../tool-schemas.js';

export async function handleGetFileSlice(
    deps: ToolHandlerDeps,
    args: Record<string, unknown>,
): Promise<MCPTextContent> {
    const filePath = MCPValidator.validateString(args['path'], 'path');
    const startLine = Number(args['startLine']);
    const endLine = Number(args['endLine']);

    if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
        throw new Error('Invalid line range: startLine and endLine must be positive integers with startLine <= endLine.');
    }

    const MAX_LINE_RANGE = 2000;
    const requestedRange = endLine - startLine + 1;
    const cappedEndLine = requestedRange > MAX_LINE_RANGE ? startLine + MAX_LINE_RANGE - 1 : endLine;

    if (filePath.length > 260 || !/^[\w\-./]+$/.test(filePath)) {
        throw new Error('Invalid path: contains disallowed characters or exceeds maximum length.');
    }

    const rawRoot = typeof args['workspaceFolder'] === 'string'
        ? args['workspaceFolder'] : deps.workspaceRoot;
    const root = deps.resolveWorkspaceRoot(rawRoot);

    let resolved: string;
    let realRoot: string;
    try {
        resolved = await fs.realpath(path.resolve(root, filePath));
        realRoot = await fs.realpath(root);
    } catch {
        throw new Error('File not found');
    }
    if (!resolved.startsWith(realRoot + path.sep) && resolved !== realRoot) {
        throw new Error('Access denied');
    }

    try {
        const rawContent = await fs.readFile(resolved, 'utf-8');
        const lines = rawContent.split('\n');
        const sliced = lines.slice(startLine - 1, cappedEndLine);
        const wasTruncated = cappedEndLine < endLine;
        log.info(
            `[MCPToolHandler] File slice read: ${filePath} L${startLine}-${cappedEndLine}${wasTruncated ? ` (capped from ${endLine})` : ''}`
        );
        let text = sliced.join('\n');
        if (wasTruncated) {
            text += `\n\n[TRUNCATED: Requested L${startLine}-${endLine} (${requestedRange} lines) exceeds max range of ${MAX_LINE_RANGE}. Showing L${startLine}-${cappedEndLine}.]`;
        }
        return {
            content: [{ type: 'text', text }],
        };
    } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') { throw new Error('File not found'); }
        throw new Error('Failed to read file');
    }
}
