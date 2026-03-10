// ─────────────────────────────────────────────────────────────────────────────
// src/mcp/handlers/SubmitConsolidationReportHandler.ts
// ─────────────────────────────────────────────────────────────────────────────

import { MCPValidator } from '../MCPValidator.js';
import { validateWorkerOutput } from '../../engine/WorkerOutputValidator.js';
import { ERR_WORKER_OUTPUT_VALIDATION_FAILED } from '../../logger/ErrorCodes.js';
import log from '../../logger/log.js';
import type { ToolHandlerDeps, MCPTextContent } from '../tool-schemas.js';

export function handleSubmitConsolidationReport(
    deps: ToolHandlerDeps,
    args: Record<string, unknown>,
): MCPTextContent {
    const masterTaskId = MCPValidator.validateMasterTaskId(args['masterTaskId']);
    const markdownContent = MCPValidator.validateString(args['markdown_content'], 'markdown_content', 500_000);

    // P0.1: Validate consolidation report content before persistence
    const reportValidation = validateWorkerOutput('consolidation_report', {
        markdown_content: markdownContent,
    });
    if (!reportValidation.success) {
        log.warn(
            `[MCPToolHandler] ${reportValidation.error.code}: ${reportValidation.error.message}`,
        );
        deps.telemetryLogger?.logBoundaryEvent(ERR_WORKER_OUTPUT_VALIDATION_FAILED, {
            contractType: 'consolidation_report',
            validationCode: reportValidation.error.code,
            message: reportValidation.error.message,
        });
        throw new Error(
            `Consolidation report validation failed: ${reportValidation.error.message}`
        );
    }

    // Persist consolidation report to DB
    deps.db.tasks.upsert(masterTaskId, { consolidationReport: markdownContent });

    log.info(
        `[MCPToolHandler] Consolidation report saved: ${masterTaskId}`
    );

    return {
        content: [
            {
                type: 'text',
                text: `Consolidation report saved for task ${masterTaskId}.`,
            },
        ],
    };
}
