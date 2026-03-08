// ─────────────────────────────────────────────────────────────────────────────
// src/agent-selection/index.ts — Barrel export for the agent selection module
// ─────────────────────────────────────────────────────────────────────────────

export type {
    ReasoningType,
    TaskType,
    RiskLevel,
    AmbiguityTolerance,
    AgentType,
    AgentMode,
    ContextFormat,
    DeliverableType,
    FitAssessment,
    AssumptionPolicy,
    ContextRequirements,
    Deliverable,
    SubtaskSpec,
    AgentProfile,
    AgentScore,
    SelectionResult,
    CompiledWorkerPrompt,
    ValidationError,
    ValidationResult,
    WorkerRunResult,
    RecoveryAction,
    SelectionAuditRecord,
} from './types.js';

export { AgentRegistry } from './AgentRegistry.js';
export { AgentSelector } from './AgentSelector.js';
export { SubtaskSpecBuilder } from './SubtaskSpecBuilder.js';
export type { SubtaskDraft, NormalizedRequirementContext } from './SubtaskSpecBuilder.js';
export { WorkerPromptCompiler } from './WorkerPromptCompiler.js';
export { PromptValidator } from './PromptValidator.js';
export { WorkerResultHandler } from './WorkerResultHandler.js';
export { SelectionPipeline } from './SelectionPipeline.js';
export type { PipelineResult } from './SelectionPipeline.js';
