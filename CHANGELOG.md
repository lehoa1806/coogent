# Changelog

All notable changes to Coogent are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

### Changed

- **ARCHITECTURE.md** — Added sections for Context Pack Assembly, Worker Output Validation, MCP Prompts, MCP Sampling, Storage & Path Management, and ArtifactDB Backup & Recovery
- **README.md** — Added LLM prerequisites note, MCP Prompts/Sampling features, and backup/recovery capability
- **OPERATIONS.md** — Updated test suite counts and added backup/recovery runbook
- **Test suite** expanded from ~57 suites / ~692 tests to 75 suites

### Fixed

- **MCPValidator** path traversal now logs structured boundary events with canonical error codes
- **DispatchController** validates worker output before persistence via `WorkerOutputValidator`
- **TokenPruner** enforces budget even in irreducible scenarios (logs warning, does not block)

### Security

- **WorkerOutputValidator** prevents unbounded payloads with explicit `.max()` bounds on all Zod schemas
- **SecretsGuard** output scanning applied to worker stdout before UI broadcast
- **Fail-closed validation** — null/undefined worker input is rejected before reaching the persistence layer
