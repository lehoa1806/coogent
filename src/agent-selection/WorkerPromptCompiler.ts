// ─────────────────────────────────────────────────────────────────────────────
// src/agent-selection/WorkerPromptCompiler.ts — Compiles worker prompts from
// templates, SubtaskSpec, and AgentProfile.
// ─────────────────────────────────────────────────────────────────────────────

import type {
    SubtaskSpec,
    AgentProfile,
    CompiledWorkerPrompt,
    AssumptionPolicy,
    Deliverable,
    AgentType,
} from './types.js';
import type { ExecutionMode } from '../adk/AntigravityADKAdapter.js';
import {
    BASE_WORKER,
    PLANNER,
    CODE_EDITOR,
    REVIEWER,
    TEST_WRITER,
    RESEARCHER,
    DEBUGGER,
} from './templates.js';

/** Current prompt template version. */
const PROMPT_VERSION = '1';

/**
 * Maps each agent type to its inlined template content.
 */
const AGENT_TEMPLATES: ReadonlyMap<AgentType, string> = new Map<AgentType, string>([
    ['Planner', PLANNER],
    ['CodeEditor', CODE_EDITOR],
    ['Reviewer', REVIEWER],
    ['TestWriter', TEST_WRITER],
    ['Researcher', RESEARCHER],
    ['Debugger', DEBUGGER],
]);

/**
 * Compiles fully assembled worker prompts from structured inputs.
 *
 * Templates are inlined at build time by esbuild's `loader: { '.md': 'text' }`
 * option, so no filesystem access is required at runtime.
 *
 * Steps:
 * 1. Load the base-worker template and the agent-specific template.
 * 2. Interpolate all `{{placeholder}}` tokens with SubtaskSpec data.
 * 3. Return a {@link CompiledWorkerPrompt} with prompt_id and version.
 */
export class WorkerPromptCompiler {
    // ─── Public ──────────────────────────────────────────────────────────────

    /**
     * Compile a fully assembled worker prompt from structured inputs.
     *
     * @param spec - The subtask specification containing goals, constraints, and policies.
     * @param profile - The agent profile selected for this subtask.
     * @param contextPackage - Optional pre-scoped context lines to embed.
     * @param executionMode - Determines IPC instructions: `'primary'` (default) injects
     *   prompt directly (no request.md), `'fallback'` appends request.md read instructions.
     *   Both modes append response.md write instructions.
     * @returns A {@link CompiledWorkerPrompt} ready for injection into a worker agent.
     */
    compile(
        spec: SubtaskSpec,
        profile: AgentProfile,
        contextPackage?: readonly string[],
        executionMode: ExecutionMode = 'primary',
    ): CompiledWorkerPrompt {
        const values: Record<string, string> = {
            agent_type: profile.agent_type,
            mode: profile.mode ?? '',
            title: spec.title,
            goal: spec.goal,
            subtask_id: spec.subtask_id,
            task_type: spec.task_type,
            reasoning_type: spec.reasoning_type.join(', '),
            required_skills: spec.required_skills.join(', '),
            required_inputs: this.formatList(spec.required_inputs),
            dependency_inputs: this.formatList(spec.dependency_inputs),
            assumptions_allowed: this.formatList(spec.assumptions_allowed),
            assumptions_forbidden: this.formatList(spec.assumptions_forbidden),
            required_confirmations: this.formatList(spec.required_confirmations),
            risk_level: spec.risk_level,
            failure_cost: spec.failure_cost,
            deliverable: this.formatDeliverable(spec.deliverable),
            verification_needed: this.formatList(spec.verification_needed),
            fallback_strategy: spec.fallback_strategy,
            assumption_policy: this.formatAssumptionPolicy({
                allowed: spec.assumptions_allowed,
                forbidden: spec.assumptions_forbidden,
                must_confirm: spec.required_confirmations,
                escalate_if_missing: spec.context_requirements.must_include,
            }),
            context_package: contextPackage ? contextPackage.join('\n') : '',
        };

        const agentTemplate = AGENT_TEMPLATES.get(profile.agent_type);
        if (!agentTemplate) {
            throw new Error(
                `No template found for agent type: ${profile.agent_type}`,
            );
        }

        const interpolatedBase = this.interpolate(BASE_WORKER, values);
        const interpolatedAgent = this.interpolate(agentTemplate, values);

        // Assemble IPC contract instructions based on execution mode
        const ipcInstructions = this.buildIpcInstructions(executionMode);
        const text = `${interpolatedBase}\n${interpolatedAgent}\n${ipcInstructions}`;

        const promptId = this.generatePromptId(
            spec.subtask_id,
            profile.agent_type,
            PROMPT_VERSION,
        );

        const assumptionPolicy: AssumptionPolicy = {
            allowed: spec.assumptions_allowed,
            forbidden: spec.assumptions_forbidden,
            must_confirm: spec.required_confirmations,
            escalate_if_missing: spec.context_requirements.must_include,
        };

        const base: Omit<CompiledWorkerPrompt, 'mode'> = {
            prompt_id: promptId,
            subtask_id: spec.subtask_id,
            agent_type: profile.agent_type,
            text,
            assumption_policy: assumptionPolicy,
            output_contract: spec.deliverable,
            version: PROMPT_VERSION,
        };

        if (profile.mode !== undefined) {
            return { ...base, mode: profile.mode };
        }
        return base;
    }

    // ─── Private ─────────────────────────────────────────────────────────────

    /**
     * Generate a deterministic prompt_id from subtask and agent info.
     *
     * Format: `prompt_${subtaskId}_v${version}`
     */
    private generatePromptId(
        subtaskId: string,
        _agentType: AgentType,
        version: string,
    ): string {
        return `prompt_${subtaskId}_v${version}`;
    }

    /**
     * Interpolate `{{key}}` placeholders in a template string.
     *
     * Unknown keys are replaced with `[MISSING: key]`.
     */
    private interpolate(
        template: string,
        values: Record<string, string>,
    ): string {
        return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
            if (key in values) {
                return values[key];
            }
            return `[MISSING: ${key}]`;
        });
    }

    /**
     * Format an {@link AssumptionPolicy} into a readable prompt block.
     */
    private formatAssumptionPolicy(policy: AssumptionPolicy): string {
        const sections: string[] = [];

        if (policy.allowed.length > 0) {
            sections.push(
                `**Allowed assumptions:**\n${this.formatList(policy.allowed)}`,
            );
        }
        if (policy.forbidden.length > 0) {
            sections.push(
                `**Forbidden assumptions:**\n${this.formatList(policy.forbidden)}`,
            );
        }
        if (policy.must_confirm.length > 0) {
            sections.push(
                `**Must confirm:**\n${this.formatList(policy.must_confirm)}`,
            );
        }
        if (policy.escalate_if_missing.length > 0) {
            sections.push(
                `**Escalate if missing:**\n${this.formatList(policy.escalate_if_missing)}`,
            );
        }

        return sections.length > 0 ? sections.join('\n\n') : '_None._';
    }

    /**
     * Format a {@link Deliverable} into a readable prompt block.
     */
    private formatDeliverable(deliverable: Deliverable): string {
        const lines: string[] = [`**Type:** ${deliverable.type}`];
        if (deliverable.must_include.length > 0) {
            lines.push(
                `**Must include:**\n${this.formatList(deliverable.must_include)}`,
            );
        }
        return lines.join('\n');
    }

    /**
     * Format an array of strings as a markdown bulleted list.
     * Returns `_None._` for empty arrays.
     */
    private formatList(items: readonly string[]): string {
        if (items.length === 0) {
            return '_None._';
        }
        return items.map((item) => `- ${item}`).join('\n');
    }

    // ─── IPC Instructions ────────────────────────────────────────────────────

    /**
     * Build the IPC contract instructions appended to the worker prompt.
     *
     * - **Both modes**: Instruct the agent to write final output to `response.md`.
     * - **Fallback only**: Also instruct the agent to read its task from `request.md`.
     */
    private buildIpcInstructions(executionMode: ExecutionMode): string {
        const sections: string[] = [
            '### IPC Contract',
            '',
        ];

        if (executionMode === 'fallback') {
            sections.push(
                '1. **Read your task** from `request.md` in the current IPC directory.',
            );
        }

        sections.push(
            `${executionMode === 'fallback' ? '2' : '1'}. **Write your COMPLETE response** to \`response.md\` in the current IPC directory.`,
            `${executionMode === 'fallback' ? '3' : '2'}. Output ONLY the content — no explanation, no markdown code fences wrapping the file write.`,
        );

        return sections.join('\n');
    }
}
