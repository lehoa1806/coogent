// ─────────────────────────────────────────────────────────────────────────────
// src/mcp/handlers/GetSymbolContextHandler.ts
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { MCPValidator } from '../MCPValidator.js';
import log from '../../logger/log.js';
import type { ToolHandlerDeps, MCPTextContent } from '../tool-schemas.js';

export async function handleGetSymbolContext(
    deps: ToolHandlerDeps,
    args: Record<string, unknown>,
): Promise<MCPTextContent> {
    const filePath = MCPValidator.validateString(args['path'], 'path');
    const symbol = MCPValidator.validateString(args['symbol'], 'symbol');

    if (filePath.length > 260 || !/^[\w\-./]+$/.test(filePath)) {
        throw new Error('Invalid path: contains disallowed characters or exceeds maximum length.');
    }
    if (symbol.length > 200) {
        throw new Error('Invalid symbol: exceeds maximum length (200).');
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
        const matchIndex = lines.findIndex(line => line.includes(symbol));
        if (matchIndex === -1) {
            return {
                content: [{ type: 'text', text: `Symbol "${symbol}" not found in ${filePath}.` }],
            };
        }

        const CONTEXT_LINES = 25; // 25 before + 25 after = ~50 lines
        const start = Math.max(0, matchIndex - CONTEXT_LINES);
        const end = Math.min(lines.length, matchIndex + CONTEXT_LINES + 1);
        const slice = lines.slice(start, end);

        log.info(
            `[MCPToolHandler] Symbol context read: ${symbol} in ${filePath} (L${start + 1}-${end})`
        );
        return {
            content: [{ type: 'text', text: slice.join('\n') }],
        };
    } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') { throw new Error('File not found'); }
        throw new Error('Failed to read file');
    }
}
