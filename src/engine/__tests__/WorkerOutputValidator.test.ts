import {
    validateWorkerOutput,
    VALIDATION_ERROR_CODES,
} from '../WorkerOutputValidator.js';

describe('WorkerOutputValidator', () => {
    // ═══════════════════════════════════════════════════════════════════════
    //  PhaseHandoffContract
    // ═══════════════════════════════════════════════════════════════════════

    describe('phase_handoff', () => {
        const validHandoff = {
            decisions: ['Used React for frontend', 'Chose PostgreSQL'],
            modified_files: ['src/App.tsx', 'src/db/schema.ts'],
            blockers: [],
        };

        it('should pass validation for a valid handoff', () => {
            const result = validateWorkerOutput('phase_handoff', validHandoff);
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data).toEqual(validHandoff);
            }
        });

        it('should pass validation for handoff with optional enrichment fields', () => {
            const enriched = {
                ...validHandoff,
                summary: 'Completed migration',
                rationale: 'Postgres offers better JSON support',
                next_steps_context: 'Run integration tests next',
                constraints: ['Must maintain backward compat'],
                remainingWork: ['Add tests'],
                symbolsTouched: ['App.tsx:render'],
                warnings: ['Migration not reversible'],
                workspaceFolder: '/workspace/app',
                changedFilesJson: '[]',
            };
            const result = validateWorkerOutput('phase_handoff', enriched);
            expect(result.success).toBe(true);
        });

        it('should fail when required field "decisions" is missing', () => {
            const invalid = {
                modified_files: ['src/App.tsx'],
                blockers: [],
            };
            const result = validateWorkerOutput('phase_handoff', invalid);
            expect(result.success).toBe(false);
            if (!result.success) {
                expect(result.error.code).toBe(
                    VALIDATION_ERROR_CODES.WORKER_OUTPUT_INVALID_HANDOFF
                );
                expect(result.error.message).toContain('phase_handoff');
                expect(result.error.details.length).toBeGreaterThan(0);
            }
        });

        it('should fail when decisions contains non-string items', () => {
            const invalid = {
                decisions: [123, true],
                modified_files: [],
                blockers: [],
            };
            const result = validateWorkerOutput('phase_handoff', invalid);
            expect(result.success).toBe(false);
            if (!result.success) {
                expect(result.error.code).toBe(
                    VALIDATION_ERROR_CODES.WORKER_OUTPUT_INVALID_HANDOFF
                );
            }
        });

        it('should fail when modified_files exceeds maxItems (200)', () => {
            const tooMany = {
                decisions: [],
                modified_files: Array.from({ length: 201 }, (_, i) => `file${i}.ts`),
                blockers: [],
            };
            const result = validateWorkerOutput('phase_handoff', tooMany);
            expect(result.success).toBe(false);
            if (!result.success) {
                expect(result.error.code).toBe(
                    VALIDATION_ERROR_CODES.WORKER_OUTPUT_INVALID_HANDOFF
                );
            }
        });

        it('should fail when a decision string exceeds maxLength (500)', () => {
            const tooLong = {
                decisions: ['x'.repeat(501)],
                modified_files: [],
                blockers: [],
            };
            const result = validateWorkerOutput('phase_handoff', tooLong);
            expect(result.success).toBe(false);
            if (!result.success) {
                expect(result.error.code).toBe(
                    VALIDATION_ERROR_CODES.WORKER_OUTPUT_INVALID_HANDOFF
                );
            }
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    //  ImplementationPlanContract
    // ═══════════════════════════════════════════════════════════════════════

    describe('execution_plan', () => {
        it('should pass validation for valid markdown content', () => {
            const result = validateWorkerOutput('execution_plan', {
                markdown_content: '# Plan\n\n## Step 1\n\nDo the thing.',
            });
            expect(result.success).toBe(true);
        });

        it('should fail when markdown_content is empty', () => {
            const result = validateWorkerOutput('execution_plan', {
                markdown_content: '',
            });
            expect(result.success).toBe(false);
            if (!result.success) {
                expect(result.error.code).toBe(
                    VALIDATION_ERROR_CODES.WORKER_OUTPUT_INVALID_PLAN
                );
            }
        });

        it('should fail when markdown_content exceeds max length (512 KB)', () => {
            const result = validateWorkerOutput('execution_plan', {
                markdown_content: 'x'.repeat(524_289),
            });
            expect(result.success).toBe(false);
            if (!result.success) {
                expect(result.error.code).toBe(
                    VALIDATION_ERROR_CODES.WORKER_OUTPUT_INVALID_PLAN
                );
            }
        });

        it('should fail when markdown_content is missing', () => {
            const result = validateWorkerOutput('execution_plan', {});
            expect(result.success).toBe(false);
            if (!result.success) {
                expect(result.error.code).toBe(
                    VALIDATION_ERROR_CODES.WORKER_OUTPUT_INVALID_PLAN
                );
            }
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    //  ConsolidationReportContract
    // ═══════════════════════════════════════════════════════════════════════

    describe('consolidation_report', () => {
        it('should pass validation for valid markdown content', () => {
            const result = validateWorkerOutput('consolidation_report', {
                markdown_content: '# Report\n\nAll phases completed successfully.',
            });
            expect(result.success).toBe(true);
        });

        it('should fail when markdown_content exceeds max length', () => {
            const result = validateWorkerOutput('consolidation_report', {
                markdown_content: 'y'.repeat(524_289),
            });
            expect(result.success).toBe(false);
            if (!result.success) {
                expect(result.error.code).toBe(
                    VALIDATION_ERROR_CODES.WORKER_OUTPUT_INVALID_REPORT
                );
            }
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    //  FitAssessmentContract
    // ═══════════════════════════════════════════════════════════════════════

    describe('fit_assessment', () => {
        it('should pass validation for valid fit assessment', () => {
            const result = validateWorkerOutput('fit_assessment', {
                score: 0.85,
                workerId: 'code-editor',
                matchedTags: ['typescript', 'react'],
                confidence: 0.9,
                reasoning: 'Strong match on language and framework tags.',
            });
            expect(result.success).toBe(true);
        });

        it('should pass validation for empty fit assessment (all optional)', () => {
            const result = validateWorkerOutput('fit_assessment', {});
            expect(result.success).toBe(true);
        });

        it('should fail when score exceeds 1', () => {
            const result = validateWorkerOutput('fit_assessment', {
                score: 1.5,
            });
            expect(result.success).toBe(false);
            if (!result.success) {
                expect(result.error.code).toBe(
                    VALIDATION_ERROR_CODES.WORKER_OUTPUT_INVALID_FIT
                );
            }
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    //  Null / Undefined Input — fail closed
    // ═══════════════════════════════════════════════════════════════════════

    describe('null/undefined input', () => {
        it('should fail closed on null input', () => {
            const result = validateWorkerOutput('phase_handoff', null);
            expect(result.success).toBe(false);
            if (!result.success) {
                expect(result.error.code).toBe(
                    VALIDATION_ERROR_CODES.WORKER_OUTPUT_NULL_INPUT
                );
                expect(result.error.message).toContain('null or undefined');
            }
        });

        it('should fail closed on undefined input', () => {
            const result = validateWorkerOutput('execution_plan', undefined);
            expect(result.success).toBe(false);
            if (!result.success) {
                expect(result.error.code).toBe(
                    VALIDATION_ERROR_CODES.WORKER_OUTPUT_NULL_INPUT
                );
            }
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    //  Non-object Input — fail closed
    // ═══════════════════════════════════════════════════════════════════════

    describe('non-object input', () => {
        it('should fail on string input for handoff', () => {
            const result = validateWorkerOutput('phase_handoff', 'not an object');
            expect(result.success).toBe(false);
        });

        it('should fail on number input for plan', () => {
            const result = validateWorkerOutput('execution_plan', 42);
            expect(result.success).toBe(false);
        });

        it('should fail on array input for report', () => {
            const result = validateWorkerOutput('consolidation_report', [1, 2, 3]);
            expect(result.success).toBe(false);
        });
    });
});
