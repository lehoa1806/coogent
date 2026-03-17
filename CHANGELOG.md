# Changelog

All notable changes to Coogent are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
## [Unreleased]

### Added

- **RecoveryActionRouter** (`src/failure-console/RecoveryActionRouter.ts`) — Pure-logic action legality validator; checks engine state, retry limits, phase criticality, and worker availability per recovery action
- **RecoverySuggester** (`src/failure-console/RecoverySuggester.ts`) — Heuristic rule-table engine generating ranked recovery suggestions (high/medium/low confidence) per failure category
- **FailureConsoleCoordinator** (`src/failure-console/FailureConsoleCoordinator.ts`) — Composes classifier → suggester → router → assembler pipeline with error-safe fallback
- **Recovery action buttons** (`webview-ui/src/components/FailureConsole.svelte`) — Actionable recovery buttons with confidence badges and rationale tooltips in the failure console UI
- **`CMD_RECOVERY_ACTION` IPC message** (`src/types/ipc.ts`) — New webview→host message type for dispatching recovery commands from the UI
- **Session restore for failure records** (`src/engine/EvaluationOrchestrator.ts`) — `restoreFailureRecords()` rehydrates persisted failure records from `FailureConsoleRepository` on session load

### Changed

- **FailureAssembler** — `assemble()` now accepts optional `suggestedActions` parameter (default `[]`) for backward compatibility
- **EvaluationOrchestrator** — Replaced direct `FailureAssembler` usage with `FailureConsoleCoordinator` for the full classify→suggest→route→assemble pipeline
- **PlannerWiring** — Instantiates the full coordinator pipeline (classifier → suggester → router → coordinator)
- **Failure console webview store** (`webview-ui/src/stores/failureConsole.svelte.ts`) — Updated types to include `SuggestedRecoveryAction` with availability/disabledReason fields
- **IPC exhaustiveness guards** — `ipcValidator`, `messageRouter`, and `ipcContract` test updated for `CMD_RECOVERY_ACTION`

---

## [0.3.0] — 2026-03-14

### Added

- **MCP Auto-Config Deployment** (`src/mcp/MCPServerDeployer.ts`) — Copies stdio server bundle to global Antigravity directory for external MCP client access; `mcp-config.json` auto-generated at well-known path
- **Hybrid Storage Topology** — Global storage for ArtifactDB, backups, and MCP runtime identity (`~/Library/Application Support/Antigravity/coogent/`); workspace-local `.coogent/` retained for IPC sessions and operational state
- **Workspace Tenanting** — `workspace_id` filtering added to all 7 repository read/delete methods (Task, Handoff, Verdict, Phase, Audit, ContextManifest, Session) for cross-workspace data isolation; DB migration renames `implementation_plan` → `execution_plan`
- **Capability Inference** — Planner now infers `required_capabilities` per-phase from task context instead of selecting from a fixed skill registry; `available_worker_skills` removed from INPUT DATA contract
- **MCP Integration Architecture Doc** (`docs/architecture/mcp-integration.md`) — Comprehensive documentation covering server architecture, transport modes, 7 supported workflows, resources, tools, prompts, sampling, validation, plugin system, and repository layer
- **Architecture Sub-Docs** — Added `storage-topology.md`, `tenant-model.md`, `persistence-boundaries.md`, and `data-ownership-matrix.md` under `docs/architecture/`

### Changed

- **Direct prompt injection** — Default input path for planner and worker agents switched from `request.md` file-based IPC to direct prompt injection; `request.md` retained as fallback execution mode
- **Planner output contract** — Simplified to raw JSON output; `RunbookParser` reordered to try raw JSON first, fenced fallback second; IPC contract instructions removed from `WorkerPromptCompiler`
- **Planner prompt hardening** — Raw user prompt moved from inline markdown into fenced `## INPUT DATA` JSON block to prevent instruction bleed; `WorkspaceScanner` output renamed to "Top-Level Structure"
- **CommandRegistry decomposition** — Split 457-line monolith into 5 focused domain modules: `sessionCommands`, `executionCommands`, `gitCommands`, `diagnosticCommands`, and `helpers`
- **Security defaults** — `blockOnSecretsDetection`, `blockOnPromptInjection`, and `enableEncryption` defaults flipped to `true`
- **ArtifactDB backup consolidation** — `ArtifactDB.backupIfDue()` delegates to injected `ArtifactDBBackup` instance, removing ~25 lines of duplicated snapshot + rotation logic
- **Multi-window ArtifactDB** — Reload-before-write merge strategy for concurrent Antigravity windows sharing a global SQLite database
- **Documentation** — All top-level docs renamed from UPPER_SNAKE_CASE to kebab-case; cross-references updated across README, CONTRIBUTING, CHANGELOG, and 3 TypeScript source files

### Fixed

- **MCP data persistence** — Ensure MCP data persistence across processes via durable global storage routing
- **Session cascade delete** — Reorder `SessionDeleteService` cascade so `purgeTask()` (which cascade-deletes all child tables) runs before `deleteSession()` removes the IPC directory; adds `context_manifests` cleanup to `TaskRepository.deleteChildRecords`
- **Sidebar refresh** — Refresh sidebar after session creation and run completion so status updates are visible in history
- **Consolidation report button** — Prevent button from disappearing after modal close by decoupling modal visibility from data presence (`reportModalOpen` flag)
- **MCP resource URIs** — Fix stale URIs in `ReportModal` and `PhaseDetails`; add missing `consolidation_report_json` case in `parseResourceURI`
- **Planner output contract simplification** — Add planner `response.md` persistence on `plan:generated` and `plan:error`; add early `.task-runbook.json` write on `plan:generated` (before approval)

### Security

- **SecretsGuard** — `scan()` now reports all pattern occurrences (not just first)
- **RegexEvaluator** — Rejects ReDoS-vulnerable patterns via shared `isRegexSafe()` utility
- **HandoffExtractor** — JSON fallback uses brace-counting + discriminator keys instead of naive parsing
- **AgentBackendProvider** — Type-safe `getExecutionMode()` added to interface; eliminates `any` cast in `ADKController`

---

## [0.2.0] — 2026-03-09

### Added

- **ContextPackBuilder** (`src/context/ContextPackBuilder.ts`) — 6-step context assembly pipeline with upstream handoff collection, file mode selection, materialization, pruning, and audit manifests
- **FileContextModeSelector** (`src/context/FileContextModeSelector.ts`) — Heuristic engine selecting per-file context granularity across 4 modes (Full, Slice, Patch, Metadata) with budget-aware downgrade
- **TokenPruner budget enforcement** — Deterministic degradation cascade for expensive context modes when token budget is exceeded
- **WorkerOutputValidator** (`src/engine/WorkerOutputValidator.ts`) — Fail-closed Zod-based validation boundary for all worker output (phase handoffs, implementation plans, consolidation reports, fit assessments)
- **Structured error codes** (`src/constants/ErrorCodes.ts`) — Canonical error codes wired into structured log records for boundary failures
- **TelemetryLogger.logBoundaryEvent** — Structured boundary event logging across MCPToolHandler, MCPValidator, DispatchController, and WorkerOutputValidator
- **StorageBase** (`src/constants/StorageBase.ts`) — Unified storage-path abstraction resolving `storageUri` vs workspace-local `.coogent` paths
- **ArtifactDBBackup** (`src/mcp/ArtifactDBBackup.ts`) — Periodic snapshot/backup system with atomic writes, rotation (default 3), and restore
- **MCP Prompts** (`src/mcp/MCPPromptHandler.ts`) — 5 discoverable prompt templates: `plan_repo_task`, `review_generated_runbook`, `repair_failed_phase`, `consolidate_session`, `architecture_review_workspace`
- **MCP Sampling** (`src/mcp/SamplingProvider.ts`) — Feature-gated sampling abstraction with `NoopSamplingProvider` and `MCPSamplingProvider` implementations
- **Integration test suite** (`src/__tests__/integration.test.ts`) — 8+ scenarios covering multi-phase DAG execution, failure/retry, token overflow, path traversal rejection, session persistence, and MCP resource flow
- **PlannerAgent decomposition** — Extracted `WorkspaceScanner`, `RunbookParser`, and `PlannerRetryManager` as focused collaborators with DI
- **EngineWiring decomposition** — Extracted `ContextAssemblyAdapter`, `WorkerLauncher`, and `WorkerResultProcessor` from `executePhase`
- **Multi-window ArtifactDB concurrency** — Reload-before-write merge strategy enables concurrent Antigravity windows to share a global SQLite database without exclusive locks
- **Workspace identity and tenanting** (`src/constants/WorkspaceIdentity.ts`) — Deterministic SHA-256 workspace_id derivation scopes all artifact data per-workspace in the global database

### Changed

- **architecture.md** — Added sections for Multi-Window ArtifactDB Concurrency, Workspace Identity & Tenanting, Context Pack Assembly, Worker Output Validation, MCP Prompts, MCP Sampling, Storage & Path Management, and ArtifactDB Backup & Recovery. Updated table count (11→12), component list (8→16), backup section, and tech stack.
- **developer-guide.md** — Added CI/CD pipeline section, updated project structure with `activation.ts`, `ArtifactDBSchema.ts`, `WorkspaceIdentity.ts`, corrected test suite counts (88 host + 8 webview).
- **user-guide.md** — Fixed `workerProfiles` → `customWorkers` setting name, `defaults.json` → `registry.json` filename.
- **operations.md** — Added CI/CD pipeline section, updated test count references.
- **site-map.md** — Added CI/CD and ADR/PRD sections with cross-references to hybrid storage design documents.
- **README.md** — Added Multi-Window Safety and Workspace Tenanting features.
- **Test suite** expanded from ~57 suites / ~692 tests to 88 host + 8 webview test files

### Fixed

- **MCPValidator** path traversal now logs structured boundary events with canonical error codes
- **DispatchController** validates worker output before persistence via `WorkerOutputValidator`
- **TokenPruner** enforces budget even in irreducible scenarios (logs warning, does not block)

### Security

- **WorkerOutputValidator** prevents unbounded payloads with explicit `.max()` bounds on all Zod schemas
- **SecretsGuard** output scanning applied to worker stdout before UI broadcast
- **Fail-closed validation** — null/undefined worker input is rejected before reaching the persistence layer
