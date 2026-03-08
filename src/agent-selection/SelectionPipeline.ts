// ─────────────────────────────────────────────────────────────────────────────
// src/agent-selection/SelectionPipeline.ts — Top-level orchestrator for the
// full agent selection → compilation → validation flow.
// ─────────────────────────────────────────────────────────────────────────────

import type {
    SubtaskSpec,
    SelectionResult,
    CompiledWorkerPrompt,
    ValidationResult,
    SelectionAuditRecord,
} from './types.js';
import { AgentRegistry } from './AgentRegistry.js';
import { AgentSelector } from './AgentSelector.js';
import { WorkerPromptCompiler } from './WorkerPromptCompiler.js';
import { PromptValidator } from './PromptValidator.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Pipeline Result
// ═══════════════════════════════════════════════════════════════════════════════

/** Bundled output from a full selection pipeline run. */
export interface PipelineResult {
    /** The agent selection result with scoring and rationale. */
    readonly selection: SelectionResult;
    /** The compiled worker prompt ready for dispatch. */
    readonly prompt: CompiledWorkerPrompt;
    /** Validation results for the compiled prompt. */
    readonly validation: ValidationResult;
    /** Full audit record for debugging and analytics. */
    readonly audit: SelectionAuditRecord;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SelectionPipeline
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Orchestrates the full agent selection flow:
 *
 * 1. Select the best-fit agent for a subtask specification.
 * 2. Compile the worker prompt from templates.
 * 3. Validate the compiled prompt against structural rules.
 * 4. Build an audit record capturing the full decision trail.
 *
 * Throws if validation fails with hard errors.
 */
export class SelectionPipeline {
    private readonly registry: AgentRegistry;
    private readonly selector: AgentSelector;
    private readonly compiler: WorkerPromptCompiler;
    private readonly validator: PromptValidator;

    constructor(registry?: AgentRegistry) {
        this.registry = registry ?? AgentRegistry.loadDefault();
        this.selector = new AgentSelector(this.registry);
        this.compiler = new WorkerPromptCompiler();
        this.validator = new PromptValidator();
    }

    /**
     * Run the full pipeline for a subtask:
     *
     * 1. Select best agent from registry.
     * 2. Compile worker prompt from templates.
     * 3. Validate compiled prompt.
     * 4. Build audit record.
     * 5. Return all results.
     *
     * @param spec - The subtask specification to process.
     * @returns A {@link PipelineResult} containing selection, prompt, validation, and audit.
     * @throws Error if validation fails with hard errors.
     */
    run(spec: SubtaskSpec): PipelineResult {
        // Step 1: Select best agent
        const selection = this.selector.select(spec);

        // Step 2: Compile worker prompt
        const profile = this.registry.getByType(selection.selected_agent);
        if (!profile) {
            throw new Error(
                `Selected agent type "${selection.selected_agent}" not found in registry.`,
            );
        }
        const prompt = this.compiler.compile(spec, profile);

        // Step 3: Validate compiled prompt
        const validation = this.validator.validate(prompt, spec);

        // Step 4: Build audit record
        const audit: SelectionAuditRecord = {
            subtask_id: spec.subtask_id,
            subtask_spec: spec,
            candidate_agents: selection.candidate_agents,
            selected_agent: selection.selected_agent,
            selection_rationale: selection.selection_rationale,
            compiled_prompt_id: prompt.prompt_id,
            fallback_agent: selection.fallback_agent,
            timestamp: Date.now(),
        };

        // Step 5: Throw on validation failure
        if (!validation.valid) {
            const errorMessages = validation.errors
                .map((e) => `[${e.field}] ${e.message}`)
                .join('\n  ');
            throw new Error(
                `Prompt validation failed for subtask "${spec.subtask_id}":\n  ${errorMessages}`,
            );
        }

        return { selection, prompt, validation, audit };
    }
}
