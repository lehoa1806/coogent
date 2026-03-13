// ─────────────────────────────────────────────────────────────────────────────
// src/mcp/handlers/SubmitImplementationPlanHandler.ts
// ─────────────────────────────────────────────────────────────────────────────

import { MCPValidator } from '../MCPValidator.js';
import { validateWorkerOutput } from '../../engine/WorkerOutputValidator.js';
import { ERR_WORKER_OUTPUT_VALIDATION_FAILED } from '../../logger/ErrorCodes.js';
import log from '../../logger/log.js';
import type { ToolHandlerDeps, MCPTextContent } from '../tool-schemas.js';

export function handleSubmitImplementationPlan(
    deps: ToolHandlerDeps,
    args: Record<string, unknown>,
): MCPTextContent {
    const masterTaskId = MCPValidator.validateMasterTaskId(args['masterTaskId']);
    const markdownContent = MCPValidator.validateString(args['markdown_content'], 'markdown_content', 500_000);
    const phaseId = args['phaseId'] != null
        ? MCPValidator.validatePhaseId(args['phaseId'])
        : undefined;

    // P0.1: Validate execution plan content before persistence
    const planValidation = validateWorkerOutput('execution_plan', {
        markdown_content: markdownContent,
    });
    if (!planValidation.success) {
        log.warn(
            `[MCPToolHandler] ${planValidation.error.code}: ${planValidation.error.message}`,
        );
        deps.telemetryLogger?.logBoundaryEvent(ERR_WORKER_OUTPUT_VALIDATION_FAILED, {
            contractType: 'execution_plan',
            validationCode: planValidation.error.code,
            message: planValidation.error.message,
        });
        throw new Error(
            `Implementation plan validation failed: ${planValidation.error.message}`
        );
    }

    if (phaseId) {
        // Phase-level plan → persist via DB
        deps.db.phases.upsertPlan(masterTaskId, phaseId, markdownContent);
        log.info(
            `[MCPToolHandler] Phase implementation plan saved: ${masterTaskId} / ${phaseId}`
        );
    } else {
        // Master-level plan → persist via DB
        deps.db.tasks.upsert(masterTaskId, { implementationPlan: markdownContent });
        log.info(
            `[MCPToolHandler] Master implementation plan saved: ${masterTaskId}`
        );
    }

    return {
        content: [
            {
                type: 'text',
                text: `Implementation plan saved for ${phaseId ? `phase ${phaseId}` : `task ${masterTaskId}`
                    }.`,
            },
        ],
    };
}
