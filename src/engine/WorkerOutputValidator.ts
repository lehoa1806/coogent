// ─────────────────────────────────────────────────────────────────────────────
// src/engine/WorkerOutputValidator.ts — Structured output validation for worker results
// ─────────────────────────────────────────────────────────────────────────────
// P0.1: Validates worker LLM output before persistence.
// All schemas use Zod (v4) for runtime type safety. The validator is stateless
// and pure — no side effects, no I/O.

import { z } from 'zod';

// ═══════════════════════════════════════════════════════════════════════════════
//  Contract Type Enum
// ═══════════════════════════════════════════════════════════════════════════════

export type ContractType =
    | 'phase_handoff'
    | 'execution_plan'
    | 'consolidation_report'
    | 'fit_assessment';

// ═══════════════════════════════════════════════════════════════════════════════
//  Error Codes
// ═══════════════════════════════════════════════════════════════════════════════

export const VALIDATION_ERROR_CODES = {
    WORKER_OUTPUT_INVALID_HANDOFF: 'WORKER_OUTPUT_INVALID_HANDOFF',
    WORKER_OUTPUT_INVALID_PLAN: 'WORKER_OUTPUT_INVALID_PLAN',
    WORKER_OUTPUT_INVALID_REPORT: 'WORKER_OUTPUT_INVALID_REPORT',
    WORKER_OUTPUT_INVALID_FIT: 'WORKER_OUTPUT_INVALID_FIT',
    WORKER_OUTPUT_NULL_INPUT: 'WORKER_OUTPUT_NULL_INPUT',
    WORKER_OUTPUT_UNEXPECTED_ERROR: 'WORKER_OUTPUT_UNEXPECTED_ERROR',
} as const;

export type ValidationErrorCode = typeof VALIDATION_ERROR_CODES[keyof typeof VALIDATION_ERROR_CODES];

// ═══════════════════════════════════════════════════════════════════════════════
//  Validation Error
// ═══════════════════════════════════════════════════════════════════════════════

export interface ValidationError {
    /** Machine-readable error code. */
    code: ValidationErrorCode;
    /** Human-readable description. */
    message: string;
    /** Zod error details (issue array). */
    details: z.ZodIssue[];
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Result Type
// ═══════════════════════════════════════════════════════════════════════════════

export type ValidationResult<T> =
    | { success: true; data: T }
    | { success: false; error: ValidationError };

// ═══════════════════════════════════════════════════════════════════════════════
//  Zod Schemas — Contract Definitions
// ═══════════════════════════════════════════════════════════════════════════════

/** Maximum markdown content length: 512 KB */
const MAX_MARKDOWN_LENGTH = 524_288;

/**
 * PhaseHandoffContract — validates handoff data submitted by a worker.
 * Mirrors the required fields in the MCP tool schema for submit_phase_handoff.
 */
export const PhaseHandoffSchema = z.object({
    decisions: z.array(z.string().max(500)).max(50),
    modified_files: z.array(z.string().max(260)).max(200),
    blockers: z.array(z.string().max(500)).max(20),
    // Optional enrichment fields
    next_steps_context: z.string().max(4096).optional(),
    summary: z.string().max(4096).optional(),
    rationale: z.string().max(4096).optional(),
    constraints: z.array(z.string().max(500)).max(50).optional(),
    remainingWork: z.array(z.string().max(500)).max(50).optional(),
    symbolsTouched: z.array(z.string().max(500)).max(200).optional(),
    warnings: z.array(z.string().max(500)).max(50).optional(),
    workspaceFolder: z.string().max(500).optional(),
    changedFilesJson: z.string().max(65536).optional(),
});

/**
 * ImplementationPlanContract — validates markdown content with max length.
 */
export const ImplementationPlanSchema = z.object({
    markdown_content: z.string().min(1).max(MAX_MARKDOWN_LENGTH),
});

/**
 * ConsolidationReportContract — validates markdown content with max length.
 */
export const ConsolidationReportSchema = z.object({
    markdown_content: z.string().min(1).max(MAX_MARKDOWN_LENGTH),
});

/**
 * FitAssessmentContract — validates optional worker metadata/fit scores.
 */
export const FitAssessmentSchema = z.object({
    score: z.number().min(0).max(1).optional(),
    workerId: z.string().max(200).optional(),
    matchedTags: z.array(z.string().max(100)).max(50).optional(),
    confidence: z.number().min(0).max(1).optional(),
    reasoning: z.string().max(4096).optional(),
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Inferred Types
// ═══════════════════════════════════════════════════════════════════════════════

export type PhaseHandoffData = z.infer<typeof PhaseHandoffSchema>;
export type ImplementationPlanData = z.infer<typeof ImplementationPlanSchema>;
export type ConsolidationReportData = z.infer<typeof ConsolidationReportSchema>;
export type FitAssessmentData = z.infer<typeof FitAssessmentSchema>;

export type ValidatedOutput =
    | PhaseHandoffData
    | ImplementationPlanData
    | ConsolidationReportData
    | FitAssessmentData;

// ═══════════════════════════════════════════════════════════════════════════════
//  Error Code Mapping
// ═══════════════════════════════════════════════════════════════════════════════

const ERROR_CODE_MAP: Record<ContractType, ValidationErrorCode> = {
    phase_handoff: VALIDATION_ERROR_CODES.WORKER_OUTPUT_INVALID_HANDOFF,
    execution_plan: VALIDATION_ERROR_CODES.WORKER_OUTPUT_INVALID_PLAN,
    consolidation_report: VALIDATION_ERROR_CODES.WORKER_OUTPUT_INVALID_REPORT,
    fit_assessment: VALIDATION_ERROR_CODES.WORKER_OUTPUT_INVALID_FIT,
};

const SCHEMA_MAP: Record<ContractType, z.ZodType> = {
    phase_handoff: PhaseHandoffSchema,
    execution_plan: ImplementationPlanSchema,
    consolidation_report: ConsolidationReportSchema,
    fit_assessment: FitAssessmentSchema,
};

// ═══════════════════════════════════════════════════════════════════════════════
//  Public API
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Validate worker output against the specified contract type.
 *
 * Fail-closed semantics:
 *   - `null` / `undefined` input → failure
 *   - Unexpected exceptions during validation → failure
 *   - Schema mismatch → failure with structured Zod details
 *
 * @param type - The contract type to validate against.
 * @param raw  - The raw worker output (unknown shape).
 * @returns A discriminated union: `{ success: true, data }` or `{ success: false, error }`.
 */
export function validateWorkerOutput(
    type: ContractType,
    raw: unknown,
): ValidationResult<ValidatedOutput> {
    // Fail closed on null/undefined input
    if (raw == null) {
        return {
            success: false,
            error: {
                code: VALIDATION_ERROR_CODES.WORKER_OUTPUT_NULL_INPUT,
                message: `Worker output is null or undefined for contract type "${type}".`,
                details: [],
            },
        };
    }

    try {
        const schema = SCHEMA_MAP[type];
        const result = schema.safeParse(raw);

        if (result.success) {
            return { success: true, data: result.data as ValidatedOutput };
        }

        return {
            success: false,
            error: {
                code: ERROR_CODE_MAP[type],
                message: `Worker output validation failed for contract type "${type}".`,
                details: result.error.issues,
            },
        };
    } catch (_err: unknown) {
        // Fail closed: unexpected exceptions are treated as invalid
        return {
            success: false,
            error: {
                code: VALIDATION_ERROR_CODES.WORKER_OUTPUT_UNEXPECTED_ERROR,
                message: `Unexpected error during validation of contract type "${type}": ${(_err as Error).message}`,
                details: [],
            },
        };
    }
}
