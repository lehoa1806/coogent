// ─────────────────────────────────────────────────────────────────────────────
// src/state/RunbookValidator.ts — JSON Schema validation for runbook files
// ─────────────────────────────────────────────────────────────────────────────
// R4 refactor: Extracted from StateManager.ts to isolate validation concerns.

import Ajv from 'ajv';
import type { Runbook } from '../types/index.js';

// Inline JSON Schema — no external file dependency (esbuild-safe)
const runbookSchema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'Coogent Task Runbook',
    type: 'object',
    required: ['project_id', 'status', 'current_phase', 'phases'],
    additionalProperties: false,
    properties: {
        project_id: { type: 'string', minLength: 1 },
        status: { type: 'string', enum: ['idle', 'running', 'paused_error', 'completed'] },
        current_phase: { type: 'integer', minimum: 0 },
        summary: { type: 'string' },
        implementation_plan: { type: 'string' },
        phases: {
            type: 'array',
            minItems: 1,
            items: {
                type: 'object',
                required: ['id', 'status', 'prompt', 'context_files', 'success_criteria'],
                additionalProperties: false,
                properties: {
                    id: { type: 'integer' },
                    status: { type: 'string', enum: ['pending', 'running', 'completed', 'failed'] },
                    prompt: { type: 'string', minLength: 1 },
                    context_files: { type: 'array', items: { type: 'string', minLength: 1 } },
                    success_criteria: { type: 'string', minLength: 1 },
                    depends_on: { type: 'array', items: { type: 'integer' } },
                    evaluator: { type: 'string', enum: ['exit_code', 'regex', 'toolchain', 'test_suite'] },
                    max_retries: { type: 'integer', minimum: 0 },
                    context_summary: { type: 'string' },
                    mcpPhaseId: { type: 'string' },
                },
            },
        },
    },
} as const;

const ajv = new Ajv({ allErrors: true });
const validateRunbook = ajv.compile<Runbook>(runbookSchema);

/**
 * Validate parsed JSON against the runbook JSON Schema.
 * @throws {RunbookValidationError} With human-readable error details.
 */
export function validateRunbookSchema(data: unknown): Runbook {
    if (validateRunbook(data)) {
        return data;
    }

    const errors = (validateRunbook.errors ?? [])
        .map(e => `  ${e.instancePath || '/'}: ${e.message}`)
        .join('\n');

    throw new RunbookValidationError(
        `Runbook schema validation failed:\n${errors}`,
        validateRunbook.errors ?? []
    );
}

/**
 * Error thrown when a runbook file fails JSON Schema validation.
 */
export class RunbookValidationError extends Error {
    constructor(
        message: string,
        public readonly validationErrors: readonly object[]
    ) {
        super(message);
        this.name = 'RunbookValidationError';
    }
}
