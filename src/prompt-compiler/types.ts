// ─────────────────────────────────────────────────────────────────────────────
// src/prompt-compiler/types.ts — Type definitions for the Compiled Master Prompt System
// ─────────────────────────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════════
//  1. Task Classification — TaskFamily
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Classified task family used to select the appropriate orchestration template.
 * Each family maps to a distinct planning strategy and prompt skeleton.
 */
export type TaskFamily =
    | 'feature_implementation'
    | 'bug_fix'
    | 'refactor'
    | 'migration'
    | 'documentation_synthesis'
    | 'repo_analysis'
    | 'review_only';

// ═══════════════════════════════════════════════════════════════════════════════
//  2. Task Scope — Where in the repo work should happen
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Defines the spatial boundaries of a task within the repository.
 * Used by the prompt compiler to inject path-aware constraints.
 */
export interface TaskScope {
    /** Primary files or directories that serve as entry points for the task. */
    readonly entryPoints: readonly string[];
    /** Folders the task is permitted to touch. */
    readonly allowedFolders: readonly string[];
    /** Folders the task must never modify. */
    readonly forbiddenFolders: readonly string[];
}

// ═══════════════════════════════════════════════════════════════════════════════
//  3. Autonomy Preferences — What the system is allowed to do
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Controls the level of autonomy granted to the orchestration engine.
 * These flags determine which self-directed actions are permitted.
 */
export interface AutonomyPreferences {
    /** Whether the engine may trigger a code-review pass after execution. */
    readonly allowReview: boolean;
    /** Whether the engine may spawn a multi-worker squad for parallel execution. */
    readonly allowSquad: boolean;
    /** Whether the engine may autonomously replan on failure. */
    readonly allowReplan: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  4. Normalized Task Spec — Structured representation of a user's request
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Structured, normalized representation of the user's original request.
 * Produced by the task normalizer and consumed by the prompt compiler
 * to select templates, inject policies, and generate the master prompt.
 */
export interface NormalizedTaskSpec {
    /** Clear statement of what the user wants to achieve. */
    readonly objective: string;
    /** The type of artifact this task will produce. */
    readonly artifactType: 'code_change' | 'documentation' | 'analysis' | 'configuration' | 'test' | 'other';
    /** The classified task family, used for template selection. */
    readonly taskType: TaskFamily;
    /** Spatial scope of the task within the repository. */
    readonly scope: TaskScope;
    /** User-specified constraints that must be respected. */
    readonly constraints: readonly string[];
    /** Criteria for verifying the work is done correctly. */
    readonly successCriteria: readonly string[];
    /** Information the user has already provided. */
    readonly knownInputs: readonly string[];
    /** Information the system could not determine and may need to ask about. */
    readonly missingInformation: readonly string[];
    /** Known risk factors that could cause the task to fail. */
    readonly riskFactors: readonly string[];
    /** Suggestions for how to decompose the work into phases. */
    readonly decompositionHints: readonly string[];
    /** Autonomy preferences controlling what the system is allowed to do. */
    readonly autonomy: AutonomyPreferences;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  5. Repo Fingerprint — Compact planning-oriented repo representation
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * A compact, planning-oriented fingerprint of the repository.
 * Captured once at task start and used by policy modules to inject
 * repo-aware prompt blocks into the compiled master prompt.
 */
export interface RepoFingerprint {
    /** The workspace layout type. */
    readonly workspaceType: 'single' | 'multi-root' | 'monorepo';
    /** Root folders in the workspace. */
    readonly workspaceFolders: readonly string[];
    /** Primary programming languages detected (e.g., ['typescript', 'python']). */
    readonly primaryLanguages: readonly string[];
    /** Key frameworks and libraries detected (e.g., ['react', 'express']). */
    readonly keyFrameworks: readonly string[];
    /** Package manager in use (e.g., 'npm', 'pnpm', 'yarn'). */
    readonly packageManager: string;
    /** Test frameworks detected (e.g., ['jest', 'vitest']). */
    readonly testStack: readonly string[];
    /** Lint tools detected (e.g., ['eslint', 'prettier']). */
    readonly lintStack: readonly string[];
    /** Type-checking tools detected (e.g., ['tsc']). */
    readonly typecheckStack: readonly string[];
    /** Build tools detected (e.g., ['esbuild', 'vite']). */
    readonly buildStack: readonly string[];
    /** High-level architectural hints (e.g., ['monorepo', 'microservices']). */
    readonly architectureHints: readonly string[];
    /** Surfaces with elevated risk of breakage (e.g., ['public API', 'database schema']). */
    readonly highRiskSurfaces: readonly string[];
    /** If the project was detected in a subdirectory, its relative path (e.g., 'coogent'). */
    readonly detectedSubdirectory?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  6. Policy Module — Pluggable prompt block injector
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * A policy module that conditionally injects a prompt block into the
 * compiled master prompt based on the repo fingerprint and task spec.
 *
 * Policies are evaluated in registration order; each returns either a
 * prompt block string or `null` if the policy does not apply.
 */
export interface PolicyModule {
    /** Unique identifier for the policy (e.g., 'multi-root-workspace'). */
    readonly id: string;
    /** Human-readable description of what this policy injects and why. */
    readonly description: string;
    /**
     * Evaluate this policy against the current repo and task.
     * @param fingerprint - The repo fingerprint.
     * @param taskSpec - The normalized task specification.
     * @returns A prompt block string to inject, or `null` if not applicable.
     */
    readonly apply: (fingerprint: RepoFingerprint, taskSpec: NormalizedTaskSpec) => string | null;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  7. Compilation Manifest — Observability record
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * An observability record produced alongside every compiled prompt.
 * Enables auditing, cache invalidation, and debugging of prompt compilation.
 */
export interface CompilationManifest {
    /** Unix timestamp (ms) when the prompt was compiled. */
    readonly timestamp: number;
    /** The task family used for template selection. */
    readonly taskFamily: TaskFamily;
    /** Identifier of the orchestration template that was selected. */
    readonly templateId: string;
    /** IDs of policy modules whose blocks were injected into the prompt. */
    readonly appliedPolicies: readonly string[];
    /** Version string of the orchestration skeleton used. */
    readonly promptVersion: string;
    /** Hash of the repo fingerprint, for cache-keying and change detection. */
    readonly fingerprintHash: string;
    /** Validation failures encountered during compilation (empty if clean). */
    readonly validationFailures: readonly string[];
}

// ═══════════════════════════════════════════════════════════════════════════════
//  8. Compiled Prompt — The final output of the prompt compiler
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The final compiled prompt, ready to be sent to the master planning agent.
 * Bundles the prompt text with its compilation manifest for full traceability.
 */
export interface CompiledPrompt {
    /** The fully assembled prompt string. */
    readonly text: string;
    /** The compilation manifest recording how this prompt was built. */
    readonly manifest: CompilationManifest;
}
