// ─────────────────────────────────────────────────────────────────────────────
// src/mcp/handlers/GetPhaseHandoffHandler.ts
// ─────────────────────────────────────────────────────────────────────────────

import { MCPValidator } from '../MCPValidator.js';
import log from '../../logger/log.js';
import type { ToolHandlerDeps, MCPTextContent } from '../tool-schemas.js';

export function handleGetPhaseHandoff(
    deps: ToolHandlerDeps,
    args: Record<string, unknown>,
): MCPTextContent {
    const masterTaskId = MCPValidator.validateMasterTaskId(args['masterTaskId']);
    const phaseId = MCPValidator.validatePhaseId(args['phaseId']);

    const handoff = deps.db.handoffs.get(masterTaskId, phaseId);
    if (!handoff) {
        return {
            content: [{ type: 'text', text: `No handoff found for phase ${phaseId} in task ${masterTaskId}.` }],
        };
    }

    log.info(
        `[MCPToolHandler] Phase handoff retrieved: ${masterTaskId} / ${phaseId}`
    );
    return {
        content: [{ type: 'text', text: JSON.stringify(handoff, null, 2) }],
    };
}
