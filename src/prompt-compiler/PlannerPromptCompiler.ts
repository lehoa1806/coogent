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
    testing: 'testing.md',
    ci_cd: 'ci-cd.md',
    performance: 'performance.md',
    security_audit: 'security-audit.md',
    dependency_management: 'dependency-management.md',
    devops_infra: 'devops-infra.md',
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



        // ── g. Evaluate policy modules ────────────────────────────────────
        const policyEngine = new PolicyEngine();
        const policyResult = policyEngine.evaluate(fingerprint, enrichedSpec);

        // ── h. Assemble the final prompt ──────────────────────────────────
        const text = this.assemblePrompt(
            skeleton,
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
     *
     * Instead of pasting repo profile, normalized task, and worker skills as
     * free-text markdown sections, we serialize them into a single JSON object
     * under `## INPUT DATA`. This prevents the raw user prompt from bleeding
     * into the planner's instruction space — JSON escaping neutralizes any
     * markdown headings or instruction-like content inside the user text.
     */
    private assemblePrompt(
        skeleton: string,
        fingerprint: RepoFingerprint,
        taskSpec: NormalizedTaskSpec,
        _policyBlocks: string[],
        _rawPrompt: string,
        options?: CompileOptions,
    ): string {
        const sections: string[] = [];

        // 1. Orchestration skeleton (instructions + rules)
        sections.push(skeleton);

        // 2. Build the INPUT DATA JSON object
        const inputData = this.buildInputData(fingerprint, taskSpec);
        sections.push(`## INPUT DATA\nINPUT_DATA_JSON: ${JSON.stringify(inputData)}`);

        // 3. Feedback section (if provided) — kept separate since it is
        //    planner-to-planner communication, not user-controlled content.
        if (options?.feedback) {
            sections.push(`## Feedback from Previous Run\n${options.feedback}`);
        }

        return sections.join('\n\n');
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Private — INPUT DATA builder
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Build the INPUT DATA object that encapsulates all task context as
     * structured data. The raw user prompt is safely contained inside a
     * JSON string value, preventing instruction bleed.
     */
    private buildInputData(
        fp: RepoFingerprint,
        taskSpec: NormalizedTaskSpec,
    ): Record<string, unknown> {
        // ── Repo profile ─────────────────────────────────────────────────
        const repoProfile: Record<string, unknown> = {
            primary_languages: [...fp.primaryLanguages],
            key_frameworks: [...fp.keyFrameworks],
            package_manager: fp.packageManager,
            test_stack: [...fp.testStack],
            lint_stack: [...fp.lintStack],
            typecheck_stack: [...fp.typecheckStack],
            build_stack: [...fp.buildStack],
            architecture_hints: [...fp.architectureHints],
            high_risk_surfaces: [...fp.highRiskSurfaces],
        };

        if (fp.subprojects && fp.subprojects.length > 0) {
            repoProfile.subprojects = fp.subprojects.map(sub => ({
                name: sub.name,
                primary_languages: [...sub.primaryLanguages],
                key_frameworks: [...sub.keyFrameworks],
                package_manager: sub.packageManager,
                test_stack: [...sub.testStack],
                lint_stack: [...sub.lintStack],
                typecheck_stack: [...sub.typecheckStack],
                build_stack: [...sub.buildStack],
            }));
        }

        // ── Normalized task ──────────────────────────────────────────────
        const normalizedTask: Record<string, unknown> = {
            task_type: taskSpec.taskType,
            artifact_type: taskSpec.artifactType,
            constraints: [...taskSpec.constraints],
            known_inputs: [...taskSpec.knownInputs],
            success_criteria: [...taskSpec.successCriteria],
            decomposition_hints: [...taskSpec.decompositionHints],
            raw_user_prompt_text: taskSpec.rawUserPrompt,
        };

        return {
            workspace_type: fp.workspaceType,
            workspace_folders: [...fp.workspaceFolders],
            repo_profile: repoProfile,
            normalized_task: normalizedTask,
        };
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
