// ─────────────────────────────────────────────────────────────────────────────
// src/mcp/handlers/SubmitPhaseHandoffHandler.ts
// ─────────────────────────────────────────────────────────────────────────────

import { MCPValidator } from '../MCPValidator.js';
import { validateWorkerOutput } from '../../engine/WorkerOutputValidator.js';
import { ERR_WORKER_OUTPUT_VALIDATION_FAILED } from '../../logger/ErrorCodes.js';
import log from '../../logger/log.js';
import type { PhaseHandoff } from '../types.js';
import type { ToolHandlerDeps, MCPTextContent } from '../tool-schemas.js';

export function handleSubmitPhaseHandoff(
    deps: ToolHandlerDeps,
    args: Record<string, unknown>,
): MCPTextContent {
    const masterTaskId = MCPValidator.validateMasterTaskId(args['masterTaskId']);
    const phaseId = MCPValidator.validatePhaseId(args['phaseId']);
    // D-3: Pass enforcement opts so the runtime gate matches the schema declaration.
    const decisions = MCPValidator.validateStringArray(
        args['decisions'], 'decisions',
        { maxItemLength: 500, maxItems: 50 }
    );
    const modifiedFiles = MCPValidator.validateStringArray(
        args['modified_files'], 'modified_files',
        { maxItemLength: 260, maxItems: 200, pathLike: true }
    );
    const blockers = MCPValidator.validateStringArray(
        args['blockers'], 'blockers',
        { maxItemLength: 500, maxItems: 20 }
    );

    // M2 audit fix: extract optional next_steps_context
    const nextStepsContext = typeof args['next_steps_context'] === 'string'
        ? args['next_steps_context'].slice(0, 4096)
        : undefined;

    // P7: Extract enrichment fields
    const summary = typeof args['summary'] === 'string'
        ? args['summary'].slice(0, 4096) : undefined;
    const rationale = typeof args['rationale'] === 'string'
        ? args['rationale'].slice(0, 4096) : undefined;
    const constraints = args['constraints'] != null
        ? MCPValidator.validateStringArray(args['constraints'], 'constraints', { maxItemLength: 500, maxItems: 50 })
        : undefined;
    const remainingWork = args['remainingWork'] != null
        ? MCPValidator.validateStringArray(args['remainingWork'], 'remainingWork', { maxItemLength: 500, maxItems: 50 })
        : undefined;
    const symbolsTouched = args['symbolsTouched'] != null
        ? MCPValidator.validateStringArray(args['symbolsTouched'], 'symbolsTouched', { maxItemLength: 500, maxItems: 200 })
        : undefined;
    const warnings = args['warnings'] != null
        ? MCPValidator.validateStringArray(args['warnings'], 'warnings', { maxItemLength: 500, maxItems: 50 })
        : undefined;
    const workspaceFolder = typeof args['workspaceFolder'] === 'string'
        ? args['workspaceFolder'].slice(0, 500) : undefined;
    const changedFilesJson = typeof args['changedFilesJson'] === 'string'
        ? args['changedFilesJson'].slice(0, 65536) : undefined;

    // P0.1: Validate handoff payload before persistence
    const handoffValidation = validateWorkerOutput('phase_handoff', {
        decisions,
        modified_files: modifiedFiles,
        blockers,
        next_steps_context: nextStepsContext,
        summary,
        rationale,
        constraints,
        remainingWork,
        symbolsTouched,
        warnings,
        workspaceFolder,
        changedFilesJson,
    });
    if (!handoffValidation.success) {
        log.warn(
            `[MCPToolHandler] ${handoffValidation.error.code}: ${handoffValidation.error.message}`,
        );
        deps.telemetryLogger?.logBoundaryEvent(ERR_WORKER_OUTPUT_VALIDATION_FAILED, {
            contractType: 'phase_handoff',
            validationCode: handoffValidation.error.code,
            message: handoffValidation.error.message,
        });
        throw new Error(
            `Phase handoff validation failed: ${handoffValidation.error.message}`
        );
    }

    const handoff: PhaseHandoff = {
        phaseId,
        masterTaskId,
        decisions,
        modifiedFiles,
        blockers,
        completedAt: Date.now(),
        nextStepsContext,
        summary,
        rationale,
        constraints,
        remainingWork,
        symbolsTouched,
        warnings,
        workspaceFolder,
        changedFilesJson,
    };

    // Persist handoff to DB — upsertHandoff ensures parent task/phase rows exist
    deps.db.handoffs.upsert(handoff);

    log.info(
        `[MCPToolHandler] Phase handoff saved: ${masterTaskId} / ${phaseId} — ` +
        `${decisions.length} decisions, ${modifiedFiles.length} files, ${blockers.length} blockers`
    );

    // Fire the phaseCompleted event
    deps.emitter.emit('phaseCompleted', handoff);

    return {
        content: [
            {
                type: 'text',
                text: `Phase handoff saved for ${phaseId}. Phase marked as complete.`,
            },
        ],
    };
}
