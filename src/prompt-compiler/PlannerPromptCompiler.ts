// ─────────────────────────────────────────────────────────────────────────────
// src/prompt-compiler/PromptCompiler.ts — Top-level orchestrator for the
//   Compiled Master Prompt pipeline
// ─────────────────────────────────────────────────────────────────────────────

import type {
    NormalizedTaskSpec,
    RepoFingerprint,
    TaskFamily,
    CompilationManifest,
    CompiledPrompt,
} from './types.js';

import { RequirementNormalizer } from './RequirementNormalizer.js';
import { RepoFingerprinter } from './RepoFingerprinter.js';
import { TaskClassifier } from './TaskClassifier.js';
import { TemplateLoader } from './TemplateLoader.js';
import { PolicyEngine } from './PolicyEngine.js';
import type { TechStackInfo } from '../context/PromptTemplateManager.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  CompileOptions
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Optional parameters to customize prompt compilation.
 */
export interface CompileOptions {
    /** Pre-collected workspace file tree (relative paths). */
    readonly fileTree?: string[];
    /** Pre-discovered tech stack info (overrides built-in discovery). */
    readonly techStack?: TechStackInfo;
    /** Available worker skill tags for assignment in phases. */
    readonly availableTags?: string[];
    /** Feedback from a previous run to inject into the prompt. */
    readonly feedback?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Template filename mapping (mirrors TemplateLoader's internal mapping)
// ═══════════════════════════════════════════════════════════════════════════════

const FAMILY_TO_TEMPLATE_FILE: Record<TaskFamily, string> = {
    feature_implementation: 'feature-implementation.md',
    bug_fix: 'bug-fix.md',
    refactor: 'refactor.md',
    migration: 'migration.md',
    documentation_synthesis: 'documentation-synthesis.md',
    repo_analysis: 'repo-analysis.md',
    review_only: 'review-only.md',
};

// ═══════════════════════════════════════════════════════════════════════════════
//  PlannerPromptCompiler — Orchestrates the full compilation pipeline
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Top-level orchestrator for the Compiled Master Prompt pipeline.
 *
 * Transforms a raw user prompt into a fully assembled, auditable
 * {@link CompiledPrompt} by running each pipeline stage in sequence:
 *
 * 1. **Fingerprint** the workspace (cached after first call).
 * 2. **Normalize** the raw prompt into a {@link NormalizedTaskSpec}.
 * 3. **Classify** the normalized spec into a {@link TaskFamily}.
 * 4. **Load** the orchestration skeleton and task-family template.
 * 5. **Evaluate** policy modules for conditional prompt blocks.
 * 6. **Assemble** all sections into the final prompt string.
 * 7. **Build** a {@link CompilationManifest} for observability.
 *
 * @example
 * ```ts
 * const compiler = new PlannerPromptCompiler('/path/to/workspace');
 * const result = await compiler.compile('Add user authentication using JWT');
 * console.log(result.text);
 * console.log(result.manifest);
 * ```
 */
export class PlannerPromptCompiler {
    private readonly workspaceRoot: string;
    private cachedFingerprint: RepoFingerprint | null = null;

    constructor(workspaceRoot: string) {
        this.workspaceRoot = workspaceRoot;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Public API
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Compile a raw user prompt into a fully assembled master prompt.
     *
     * @param rawPrompt - The user's unstructured request string.
     * @param options   - Optional compilation parameters.
     * @returns A {@link CompiledPrompt} containing the assembled text and manifest.
     */
    async compile(rawPrompt: string, options?: CompileOptions): Promise<CompiledPrompt> {
        // ── a. Repo fingerprinting (cached) ───────────────────────────────
        const fingerprint = await this.getFingerprint();

        // ── b. Normalize the raw prompt ───────────────────────────────────
        const normalizer = new RequirementNormalizer();
        const taskSpec = normalizer.normalize(rawPrompt, fingerprint);

        // ── c. Classify the task family ───────────────────────────────────
        const classifier = new TaskClassifier();
        const classifiedFamily = classifier.classify(taskSpec);

        // ── d. Update taskSpec with classified family ─────────────────────
        const enrichedSpec: NormalizedTaskSpec = {
            ...taskSpec,
            taskType: classifiedFamily,
        };

        // ── e. Load orchestration skeleton ────────────────────────────────
        const templateLoader = new TemplateLoader();
        const skeleton = templateLoader.loadSkeleton();

        // ── f. Load task-family template ──────────────────────────────────
        const familyTemplate = templateLoader.loadTemplate(classifiedFamily);

        // ── g. Evaluate policy modules ────────────────────────────────────
        const policyEngine = new PolicyEngine();
        const policyResult = policyEngine.evaluate(fingerprint, enrichedSpec);

        // ── h. Assemble the final prompt ──────────────────────────────────
        const text = this.assemblePrompt(
            skeleton,
            familyTemplate,
            fingerprint,
            enrichedSpec,
            policyResult.promptBlocks,
            rawPrompt,
            options,
        );

        // ── i. Build and return CompiledPrompt with manifest ─────────────
        const templateId = FAMILY_TO_TEMPLATE_FILE[classifiedFamily] ?? 'feature-implementation.md';
        const manifest = this.buildManifest(classifiedFamily, templateId, policyResult.appliedPolicies, fingerprint);

        return { text, manifest };
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Private — Fingerprint caching
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Get the repo fingerprint, using a cached value if available.
     */
    private async getFingerprint(): Promise<RepoFingerprint> {
        if (this.cachedFingerprint) {
            return this.cachedFingerprint;
        }
        const fingerprinter = new RepoFingerprinter(this.workspaceRoot);
        this.cachedFingerprint = await fingerprinter.fingerprint();
        return this.cachedFingerprint;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Private — Prompt assembly
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Assemble the full prompt from all pipeline outputs in the prescribed order.
     */
    private assemblePrompt(
        skeleton: string,
        familyTemplate: string,
        fingerprint: RepoFingerprint,
        taskSpec: NormalizedTaskSpec,
        policyBlocks: string[],
        rawPrompt: string,
        options?: CompileOptions,
    ): string {
        const sections: string[] = [];

        // 1. Orchestration skeleton
        sections.push(skeleton);

        // 2. Task-family template as "## Planning Strategy"
        sections.push(`## Planning Strategy\n${familyTemplate}`);

        // 3. Repo fingerprint as "## Repo Profile"
        sections.push(`## Repo Profile\n${this.formatFingerprint(fingerprint)}`);

        // 4. Normalized task spec as "## Normalized Task"
        sections.push(`## Normalized Task\n${this.formatTaskSpec(taskSpec)}`);

        // 5. Policy blocks as "## Planning Policies"
        if (policyBlocks.length > 0) {
            const policyBullets = policyBlocks.map(block => `- ${block.replace(/\n/g, '\n  ')}`).join('\n');
            sections.push(`## Planning Policies\n${policyBullets}`);
        }

        // 6. Workspace file tree (if provided)
        if (options?.fileTree && options.fileTree.length > 0) {
            sections.push(`## Workspace File Tree\n${options.fileTree.join('\n')}`);
        }

        // 7. Available worker skills (if provided)
        if (options?.availableTags && options.availableTags.length > 0) {
            const sorted = [...options.availableTags].sort();
            sections.push(
                `## Available Worker Skills\nWhen assigning phases, you may specify \`required_skills\` from this list:\n${sorted.join(', ')}`,
            );
        }

        // 8. User request
        sections.push(`## User Request\n${rawPrompt}`);

        // 9. Feedback section (if provided)
        if (options?.feedback) {
            sections.push(`## Feedback from Previous Run\n${options.feedback}`);
        }

        // 10. Footer
        sections.push('## Generate the Runbook Now');

        return sections.join('\n\n');
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Private — Manifest construction
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Build the {@link CompilationManifest} for observability and cache keying.
     */
    private buildManifest(
        taskFamily: TaskFamily,
        templateId: string,
        appliedPolicies: string[],
        fingerprint: RepoFingerprint,
    ): CompilationManifest {
        return {
            timestamp: Date.now(),
            taskFamily,
            templateId,
            appliedPolicies,
            promptVersion: '1.0.0',
            fingerprintHash: this.hashFingerprint(fingerprint),
            validationFailures: [],
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Private — Formatters
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Render a {@link RepoFingerprint} as a compact, readable text block.
     *
     * When subprojects are present, renders a per-repo profile section
     * so the planner can see each repo's independent tech stack.
     */
    private formatFingerprint(fp: RepoFingerprint): string {
        const lines: string[] = [];
        lines.push(`workspace_type: ${fp.workspaceType}`);
        lines.push(`workspace_folders: ${fp.workspaceFolders.join(', ')}`);
        if (fp.detectedSubdirectory) {
            lines.push(`detected_project_root: ${fp.detectedSubdirectory}`);
        }

        // ── Multi-repo: render per-subproject sections ────────────────────
        if (fp.subprojects && fp.subprojects.length > 0) {
            lines.push('');
            for (const sub of fp.subprojects) {
                lines.push(`### ${sub.name}`);
                lines.push(`primary_languages: ${sub.primaryLanguages.join(', ') || 'none detected'}`);
                lines.push(`key_frameworks: ${sub.keyFrameworks.join(', ') || 'none detected'}`);
                lines.push(`package_manager: ${sub.packageManager}`);
                lines.push(`test_stack: ${sub.testStack.join(', ') || 'none detected'}`);
                lines.push(`lint_stack: ${sub.lintStack.join(', ') || 'none detected'}`);
                lines.push(`typecheck_stack: ${sub.typecheckStack.join(', ') || 'none detected'}`);
                lines.push(`build_stack: ${sub.buildStack.join(', ') || 'none detected'}`);
                lines.push('');
            }

            // Still emit aggregate fields for backward-compatible policy usage
            lines.push(`architecture_hints: ${fp.architectureHints.join(', ') || 'none'}`);
            lines.push(`high_risk_surfaces: ${fp.highRiskSurfaces.join(', ') || 'none'}`);
            return lines.join('\n');
        }

        // ── Single-repo: flat format ─────────────────────────────────────
        lines.push(`primary_languages: ${fp.primaryLanguages.join(', ') || 'none detected'}`);
        lines.push(`key_frameworks: ${fp.keyFrameworks.join(', ') || 'none detected'}`);
        lines.push(`package_manager: ${fp.packageManager}`);
        lines.push(`test_stack: ${fp.testStack.join(', ') || 'none detected'}`);
        lines.push(`lint_stack: ${fp.lintStack.join(', ') || 'none detected'}`);
        lines.push(`typecheck_stack: ${fp.typecheckStack.join(', ') || 'none detected'}`);
        lines.push(`build_stack: ${fp.buildStack.join(', ') || 'none detected'}`);
        lines.push(`architecture_hints: ${fp.architectureHints.join(', ') || 'none'}`);
        lines.push(`high_risk_surfaces: ${fp.highRiskSurfaces.join(', ') || 'none'}`);
        return lines.join('\n');
    }

    /**
     * Render a {@link NormalizedTaskSpec} as a compact, readable text block.
     */
    private formatTaskSpec(spec: NormalizedTaskSpec): string {
        const lines: string[] = [];
        lines.push(`objective: ${spec.objective}`);
        lines.push(`artifact_type: ${spec.artifactType}`);
        lines.push(`task_type: ${spec.taskType}`);

        if (spec.scope.entryPoints.length > 0) {
            lines.push(`entry_points: ${spec.scope.entryPoints.join(', ')}`);
        }
        if (spec.scope.allowedFolders.length > 0) {
            lines.push(`allowed_folders: ${spec.scope.allowedFolders.join(', ')}`);
        }
        if (spec.constraints.length > 0) {
            lines.push(`constraints: ${spec.constraints.join(' | ')}`);
        }
        if (spec.successCriteria.length > 0) {
            lines.push(`success_criteria: ${spec.successCriteria.join(' | ')}`);
        }
        if (spec.knownInputs.length > 0) {
            lines.push(`known_inputs: ${spec.knownInputs.join(', ')}`);
        }
        if (spec.riskFactors.length > 0) {
            lines.push(`risk_factors: ${spec.riskFactors.join(', ')}`);
        }
        if (spec.decompositionHints.length > 0) {
            lines.push(`decomposition_hints: ${spec.decompositionHints.join(' | ')}`);
        }

        lines.push(`autonomy: review=${spec.autonomy.allowReview}, squad=${spec.autonomy.allowSquad}, replan=${spec.autonomy.allowReplan}`);
        return lines.join('\n');
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Private — Hashing
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Produce a simple hash of the fingerprint for cache-keying and change detection.
     * Uses a basic string hash (djb2) — not cryptographic, but sufficient for manifest use.
     */
    private hashFingerprint(fingerprint: RepoFingerprint): string {
        const raw = JSON.stringify(fingerprint);
        let hash = 5381;
        for (let i = 0; i < raw.length; i++) {
            hash = ((hash << 5) + hash + raw.charCodeAt(i)) & 0xFFFFFFFF;
        }
        return (hash >>> 0).toString(16).padStart(8, '0');
    }
}
