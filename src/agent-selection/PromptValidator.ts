// ─────────────────────────────────────────────────────────────────────────────
// src/agent-selection/PromptValidator.ts — Validates compiled worker prompts
// for required sections before dispatch.
// ─────────────────────────────────────────────────────────────────────────────

import type {
    CompiledWorkerPrompt,
    ValidationResult,
    ValidationError,
    SubtaskSpec,
    TaskType,
    RiskLevel,
} from './types.js';

/** Task types that are classified as "planning" and exempt from required_inputs checks. */
const PLANNING_TASK_TYPES: ReadonlySet<TaskType> = new Set<TaskType>([
    'task_decomposition',
    'dependency_mapping',
    'execution_planning',
]);

/** Risk levels that mandate verification focus in the prompt text. */
const VERIFICATION_REQUIRED_RISK_LEVELS: ReadonlySet<RiskLevel> = new Set<RiskLevel>([
    'medium',
    'high',
]);

/**
 * Validates compiled worker prompts against required structural and content rules.
 *
 * Hard errors block dispatch; soft warnings are advisory.
 */
export class PromptValidator {
    // ─── Public ──────────────────────────────────────────────────────────────

    /**
     * Validate a compiled worker prompt against required rules.
     *
     * **Hard errors:**
     * 1. Goal must be present in the prompt text.
     * 2. Agent type must be present in the prompt text.
     * 3. Required inputs must not be empty for non-planning tasks.
     * 4. Forbidden assumptions must be present in the prompt text.
     * 5. Deliverable must be present in the prompt text.
     * 6. Verification focus must be present for medium/high-risk tasks.
     * 7. Escalation behavior must be present in the prompt text.
     * 8. Dependency references must be resolved (all deps from SubtaskSpec.dependency_inputs mentioned).
     *
     * **Soft warnings:**
     * 1. Medium-risk task with fewer than 2 verification targets.
     * 2. No allowed assumptions specified.
     * 3. No required confirmations.
     *
     * @param prompt - The compiled worker prompt to validate.
     * @param spec   - The subtask specification the prompt was compiled from.
     * @returns A {@link ValidationResult} with hard errors and soft warnings.
     */
    validate(
        prompt: CompiledWorkerPrompt,
        spec: SubtaskSpec,
    ): ValidationResult {
        const errors: ValidationError[] = [];
        const warnings: ValidationError[] = [];

        // ── Hard errors ──────────────────────────────────────────────────

        // Rule 1: Goal must be present in the prompt text
        if (!this.textContains(prompt.text, spec.goal)) {
            errors.push({
                field: 'goal',
                message: 'Subtask goal is not present in the compiled prompt text.',
            });
        }

        // Rule 2: Agent type must be present
        if (!this.textContains(prompt.text, prompt.agent_type)) {
            errors.push({
                field: 'agent_type',
                message: `Agent type "${prompt.agent_type}" is not mentioned in the compiled prompt text.`,
            });
        }

        // Rule 3: Required inputs must not be empty for non-planning tasks
        if (
            !PLANNING_TASK_TYPES.has(spec.task_type) &&
            spec.required_inputs.length === 0
        ) {
            errors.push({
                field: 'required_inputs',
                message: `No target file or dependency handoff included for ${spec.task_type} task.`,
            });
        }

        // Rule 4: Forbidden assumptions must be present in the prompt text
        if (spec.assumptions_forbidden.length > 0) {
            const hasForbiddenSection = this.textContains(prompt.text, 'Forbidden assumptions')
                || this.textContains(prompt.text, 'assumptions_forbidden');
            if (!hasForbiddenSection) {
                errors.push({
                    field: 'assumptions_forbidden',
                    message: 'Forbidden assumptions section is missing from the compiled prompt text.',
                });
            }
        }

        // Rule 5: Deliverable must be present
        if (!this.textContains(prompt.text, spec.deliverable.type)) {
            errors.push({
                field: 'deliverable',
                message: `Deliverable type "${spec.deliverable.type}" is not mentioned in the compiled prompt text.`,
            });
        }

        // Rule 6: Verification focus must be present for medium/high-risk tasks
        if (
            VERIFICATION_REQUIRED_RISK_LEVELS.has(spec.risk_level) &&
            !this.textContains(prompt.text, 'verification')
        ) {
            errors.push({
                field: 'verification_needed',
                message: `Verification focus is missing from the prompt text for a ${spec.risk_level}-risk task.`,
            });
        }

        // Rule 7: Escalation behavior must be present
        if (
            !this.textContains(prompt.text, 'escalat') // matches escalate, escalation
        ) {
            errors.push({
                field: 'escalation',
                message: 'Escalation behavior section is missing from the compiled prompt text.',
            });
        }

        // Rule 8: Dependency references must be resolved
        for (const dep of spec.dependency_inputs) {
            if (!this.textContains(prompt.text, dep)) {
                errors.push({
                    field: 'dependency_inputs',
                    message: `Dependency reference "${dep}" from SubtaskSpec is not mentioned in the prompt text.`,
                });
            }
        }

        // ── Soft warnings ────────────────────────────────────────────────

        // Warning 1: Medium-risk task with fewer than 2 verification targets
        if (
            spec.risk_level === 'medium' &&
            spec.verification_needed.length < 2
        ) {
            warnings.push({
                field: 'verification_needed',
                message: `Medium-risk task has only ${spec.verification_needed.length === 0 ? 'no' : 'one'} verification target.`,
            });
        }

        // Warning 2: No allowed assumptions specified
        if (spec.assumptions_allowed.length === 0) {
            warnings.push({
                field: 'assumptions_allowed',
                message: 'No allowed assumptions specified; the agent has zero assumption latitude.',
            });
        }

        // Warning 3: No required confirmations
        if (spec.required_confirmations.length === 0) {
            warnings.push({
                field: 'required_confirmations',
                message: 'No required confirmations specified; the agent can proceed without any confirmation gates.',
            });
        }

        return {
            prompt_id: prompt.prompt_id,
            valid: errors.length === 0,
            errors,
            warnings,
        };
    }

    // ─── Private ─────────────────────────────────────────────────────────────

    /**
     * Case-insensitive substring check against the prompt text.
     */
    private textContains(text: string, needle: string): boolean {
        return text.toLowerCase().includes(needle.toLowerCase());
    }
}
