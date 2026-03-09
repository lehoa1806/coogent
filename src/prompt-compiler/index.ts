// ─────────────────────────────────────────────────────────────────────────────
// src/prompt-compiler/index.ts — Barrel export for the prompt compiler module
// ─────────────────────────────────────────────────────────────────────────────

export type {
    TaskFamily,
    TaskScope,
    AutonomyPreferences,
    NormalizedTaskSpec,
    RepoFingerprint,
    SubprojectProfile,
    PolicyModule,
    CompilationManifest,
    CompiledPrompt,
} from './types.js';

export { RequirementNormalizer } from './RequirementNormalizer.js';
export { RepoFingerprinter } from './RepoFingerprinter.js';
export { TaskClassifier } from './TaskClassifier.js';
export { TemplateLoader } from './TemplateLoader.js';
export { PolicyEngine } from './PolicyEngine.js';
export type { PolicyResult } from './PolicyEngine.js';
export { PlannerPromptCompiler } from './PlannerPromptCompiler.js';
export type { CompileOptions } from './PlannerPromptCompiler.js';
