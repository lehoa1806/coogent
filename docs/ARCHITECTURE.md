# Architecture & Technical Design

> Coogent system internals: FSM engine, DAG scheduling, MCP server, persistence, and tech stack.

---

## Table of Contents

1. [System Architecture](#system-architecture)
2. [Finite State Machine (Engine)](#finite-state-machine-engine)
3. [DAG-Aware Parallel Scheduling](#dag-aware-parallel-scheduling)
4. [In-Process MCP Server](#in-process-mcp-server)
5. [Context Diffusion Pipeline](#context-diffusion-pipeline)
6. [Pluggable Evaluator System (V2)](#pluggable-evaluator-system-v2)
7. [Prompt Compiler Pipeline](#prompt-compiler-pipeline)
8. [Agent Registry & Selection Pipeline](#agent-registry--selection-pipeline)
9. [Persistence & Crash Recovery](#persistence--crash-recovery)
10. [Git Sandboxing](#git-sandboxing)
11. [Tech Stack](#tech-stack)

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        VS Code Extension Host                          │
│                                                                        │
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │  Engine   │  │  State   │  │  Telemetry   │  │   GitSandbox      │  │
│  │  (FSM)   │──│ Manager  │  │   Logger     │  │   Manager         │  │
│  │          │  │ (WAL)    │  │  (JSONL)     │  │  (Branch Iso.)    │  │
│  └────┬─────┘  └──────────┘  └──────────────┘  └───────────────────┘  │
│       │                                                                │
│       ├─── phase:execute ──► ┌──────────────┐                         │
│       │                      │ ADKController │ ──► Ephemeral Workers   │
│       │                      │ (Spawn/Kill)  │     (AI Agent Sessions) │
│       │                      │ OutputBuffer  │     (100ms / 4KB batch) │
│       │                      └──────────────┘                         │
│       │                                                                │
│       ├─── ui:message ─────► ┌──────────────────────────────────────┐  │
│       │                      │ MissionControlPanel (IPC Proxy)      │  │
│       │                      │   ↕ postMessage / onDidReceiveMsg    │  │
│       │                      └──────────────────┬───────────────────┘  │
│       │                                         │                      │
│       └─── data:read ──────► ┌──────────────────┴───────────────────┐  │
│                              │ CoogentMCPServer (In-Process)        │  │
│                              │   Resources: coogent://tasks/...     │  │
│                              │   Tools: submit_phase_handoff, etc.  │  │
│                              │   ┌────────────────────────────────┐ │  │
│                              │   │ ArtifactDB (SQLite via sql.js) │ │  │
│                              │   └────────────────────────────────┘ │  │
│                              └──────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
                    │ IPC (postMessage)
                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                   Svelte 5 Webview (Mission Control)                    │
│                                                                        │
│  ┌──────────────┐  ┌─────────────┐  ┌───────────────────────────────┐  │
│  │  appState     │  │  mcpStore   │  │  Components                   │  │
│  │  ($state)     │  │  ($state    │  │  PlanReview, PhaseDetails,    │  │
│  │  ($derived)   │  │   factory)  │  │  PhaseHeader, PhaseActions,   │  │
│  │  ($effect)    │  │             │  │  PhaseHandoff, Terminal, ...   │  │
│  └──────────────┘  └─────────────┘  └───────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

### Component Wiring (Decomposed Architecture)

`extension.ts` (~270 lines) delegates to five extracted modules:

- **`ServiceContainer`** — Typed registry holding all service instances (replaces 18 module-level `let` variables)
- **`CommandRegistry`** — Registers all 14+ VS Code commands via `registerAll()`
- **`EngineWiring`** — Connects Engine ↔ ADK ↔ MCP ↔ Consolidation events
- **`PlannerWiring`** — Connects PlannerAgent ↔ Engine events
- **`agent-selection/`** — `AgentRegistry`, `AgentSelector`, `SelectionPipeline`, `WorkerPromptCompiler`, `PromptValidator`

Key event flows:

- **Engine → Webview**: Engine emits `ui:message` events that `MissionControlPanel` broadcasts to the UI
- **Worker ↔ UI Piping**: ADK worker output is batched via `OutputBufferRegistry` (100ms / 4KB) before broadcasting `PHASE_OUTPUT`
- **Engine ↔ ADK**: `phase:execute` events trigger `ADKController.spawnWorker()`

### Hybrid State Distribution

Coogent uses a two-tier strategy to balance reactivity with IPC efficiency:

- **Push Model** (small state): Lightweight metadata (engine state, phase statuses, token budgets) pushed proactively via `STATE_SNAPSHOT`
- **Pull Model** (large artifacts): Heavy Markdown (plans, reports, handoffs) fetched on-demand via `coogent://` URIs through the MCP IPC bridge

---

## Finite State Machine (Engine)

The `Engine` class implements a strict 9-state FSM governing the entire task lifecycle:

| State | Description |
|---|---|
| `IDLE` | No runbook loaded. Waiting for user action. |
| `PLANNING` | PlannerAgent generating a runbook from user prompt. |
| `PLAN_REVIEW` | AI-generated plan awaiting user approval. |
| `PARSING` | Validating and loading the approved runbook. |
| `READY` | Runbook loaded; phases ready for dispatch. |
| `EXECUTING_WORKER` | One or more workers actively running. |
| `EVALUATING` | Last worker finished; checking success criteria. |
| `ERROR_PAUSED` | Phase failed or worker crashed; halted for user decision. |
| `COMPLETED` | All phases passed. Terminal state. |

### Transition Events (18 `EngineEvent` values)

| Event | Trigger |
|---|---|
| `PLAN_REQUEST` | User submits a prompt |
| `PLAN_GENERATED` | PlannerAgent produces a draft |
| `PLAN_APPROVED` | User approves the plan |
| `PLAN_REJECTED` | User rejects with feedback → re-plan |
| `LOAD_RUNBOOK` | Existing runbook loaded from disk |
| `PARSE_SUCCESS` | Runbook validated and parsed |
| `PARSE_FAILURE` | Validation failed (schema or cycle) |
| `START` | First dispatch of ready phases |
| `RESUME` | Resume after pause (semantically distinct from `START`) |
| `WORKER_EXITED` | Last active worker finished |
| `ALL_PHASES_PASS` | All phases completed successfully |
| `PHASE_PASS` | Current phase passed, more phases remain |
| `PHASE_FAIL` | Phase evaluation failed |
| `WORKER_TIMEOUT` | Worker exceeded time limit |
| `WORKER_CRASH` | Worker process crashed unexpectedly |
| `RETRY` | User or self-healer triggers retry |
| `SKIP_PHASE` | User skips a phase |
| `ABORT` | User aborts the entire run |
| `RESET` | Reset engine to IDLE |

### State Transition Diagram

```
IDLE ──PLAN_REQUEST──► PLANNING ──PLAN_GENERATED──► PLAN_REVIEW ──PLAN_APPROVED──► PARSING
         ▲                ▲                              │                            │
       RESET         PLAN_REJECTED                       │                      PARSE_SUCCESS
         │                                               │                            │
COMPLETED ◄──ALL_PHASES_PASS── EVALUATING ◄──WORKER_EXITED── EXECUTING_WORKER ◄──START── READY
                                   │                                ▲       │
                              PHASE_FAIL                            │       │
                              WORKER_TIMEOUT                  (frontier     │
                              WORKER_CRASH                    dispatch)     │
                                   │                                        │
                                   ▼                                        │
                             ERROR_PAUSED ──RETRY──► READY ─────────────────┘
```

---

## DAG-Aware Parallel Scheduling

When phases define `depends_on` arrays, the `Scheduler` enables concurrent execution.

### Readiness Criteria

A phase is "ready" when:
1. Its status is `pending`
2. ALL dependency phases have reached `completed` status

### AB-1 Strategy (Parallel FSM)

To maintain a deterministic state machine during concurrent execution:

1. **Shared State**: FSM stays in `EXECUTING_WORKER` as long as *any* worker is active (`activeWorkerCount > 0`)
2. **In-Place Evaluation**: When a worker exits, the engine updates phase status directly
3. **Frontier Dispatch**: Phase completion immediately dispatches newly unblocked DAG neighbors
4. **Terminal Transition**: Only transitions to `EVALUATING` when the **last** active worker finishes

### Concurrency Limit

Default: **4 simultaneous workers**. Prevents resource exhaustion.

### Safety Requirements

| Requirement | Detail |
|---|---|
| **Cycle Detection** | Kahn's algorithm validates the DAG on runbook load — cyclic dependencies deadlock |
| **Cancellable Backoff** | Self-healing timers tracked and cancelled on `ABORT`/`RESET` |
| **Strict Transition Guards** | State-modifying methods verify FSM acceptance before proceeding |

---

## In-Process MCP Server

The `CoogentMCPServer` is the single source of truth for all runtime artifacts.

### State Store (ArtifactDB)

Artifacts are persisted in a **SQLite database** (via `sql.js` WASM) managed by `ArtifactDB`:

- **Durability**: Database file (`artifacts.db`) stored under extension-managed storage for cross-session access
- **Schema**: 11 tables with monotonic `schema_version` tracking
- **In-Memory Cache**: Reads are served from an in-memory `sql.js` instance; writes flush to disk via `db.export()`

#### Tables

| Table | Purpose |
|---|---|
| `tasks` | Master task state (summary, implementation plan, consolidation report) |
| `phases` | Per-phase metadata and context |
| `handoffs` | Phase completion artifacts (decisions, modified files, blockers) |
| `worker_outputs` | Raw worker stdout/stderr capture |
| `evaluation_results` | Evaluator outcomes (passed, reason, retryPrompt) |
| `healing_attempts` | Self-healing retry records |
| `sessions` | Session history and metadata |
| `phase_logs` | Structured per-phase event log |
| `plan_revisions` | Plan revision history for audit trail |
| `selection_audits` | Agent selection decision records |
| `schema_version` | Migration version tracking |

```typescript
// Dual-layer architecture:
const db = await ArtifactDB.create(dbPath);    // SQLite via sql.js WASM
await db.upsertTask(masterTaskId, { summary }); // Write → SQLite + in-memory
const task = db.getTask(masterTaskId);          // Read ← in-memory cache
```

### Resources (Read)

Exposed via `coogent://` URIs — see [API Reference](API_REFERENCE.md).

### Tools (Write)

`submit_phase_handoff`, `submit_implementation_plan`, `submit_consolidation_report`, `get_modified_file_content`

---

## Context Diffusion Pipeline

Each phase follows a 5-step pipeline:

| Step | Component | Action |
|---|---|---|
| 1. Planning | `PlannerAgent` | Generates `.task-runbook.json` from user objective |
| 2. Execution | `ADKController` | Spawns ephemeral workers with curated file context |
| 3. Checkpointing | `GitManager` | Creates Git snapshot commits after successful exits |
| 4. Distillation | `HandoffExtractor` / MCP | Extracts decisions, modified files, and blockers |
| 5. Consolidation | `ConsolidationAgent` | Aggregates all phase handoffs into a final report |

### Context Scoping

The `ContextScoper` prepares minimal file payloads for workers:

- **Discovery**: Reads paths from the runbook phase `context_files` (with AST-based import resolution via `ASTFileResolver`)
- **Guards**: File existence checks + binary detection (null-byte heuristic in first 8KB)
- **Secrets Detection**: `SecretsGuard` scans file content for API keys (AWS, OpenAI, Stripe, Google, JWT), private keys, `.env` patterns, and high-entropy strings (Shannon entropy > 4.5). Detected secrets are redacted with `[REDACTED]`
- **Repo Map**: `RepoMap` generates a lightweight directory listing (~500 tokens) prepended to the file payload, giving workers structural awareness of the repository
- **Formatting**: Each file wrapped in `<<<FILE: path>>>\n{content}\n<<<END FILE>>>`
- **Budget Enforcement**: If assembled payload exceeds `coogent.tokenLimit`, execution halts with user notification
- **Output Scanning**: Worker output streams are scanned by `SecretsGuard` and redacted before broadcasting to the UI
- **Output Batching**: Worker output streams through `OutputBufferRegistry` (100ms timer / 4KB buffer, 1MB upper bound) to prevent IPC channel saturation

### Tokenizers

| Version | Tokenizer | Method |
|---|---|---|
| V1 (current, default) | `TiktokenEncoder` | Model-accurate via `js-tiktoken` WASM (`cl100k_base`), lazy-initialized |
| V1 (fallback) | `CharRatioEncoder` | Fast, dependency-free (~4 chars/token) — used if tiktoken init fails |

### PromptTemplateManager

`PromptTemplateManager` (~440 lines) dynamically discovers the workspace's tech stack from manifest files and injects contextual variables into the Planner's system prompt.

- **Tech Stack Discovery**: Scans root-level manifests (`package.json`, `requirements.txt`, `pyproject.toml`, `go.mod`, `Cargo.toml`) — no directory walking
- **Framework Detection**: Maps dependencies to known frameworks (React, Next.js, Django, FastAPI, Gin, Actix, etc.)
- **Prompt Injection**: Inserts `## Workspace Tech Stack` and `## Available Worker Skills` sections into the planner prompt before the `## User Request` marker
- **Graceful Fallback**: Missing or unreadable manifests are silently skipped; returns sensible defaults

### TokenPruner

`TokenPruner` (~210 lines) implements heuristic strategies for reducing over-budget context payloads to fit within the configured token limit.

**3-tier pruning strategy (in priority order):**

1. **Drop discovered files**: Remove non-explicit (auto-discovered) files by size, largest first
2. **Strip function bodies**: Keep signatures only, using brace-counting heuristic for C-family and Swift
3. **Truncate large files**: Apply a per-file token cap to remaining entries

The pruner is best-effort — callers must check `PruneResult.withinBudget` after pruning.

---

## Pluggable Evaluator System (V2)

The `EvaluatorRegistryV2` implements the **Strategy pattern** for phase success evaluation.

### Evaluator Types

| Type | Criteria Format | Behavior |
|---|---|---|
| `exit_code` | `exit_code:N` | Match worker process exit code (default: 0) |
| `regex` | `regex:<pattern>` or `regex_fail:<pattern>` | Match/reject stdout against a regular expression |
| `toolchain` | `toolchain:<cmd>` | Run a whitelisted binary via `execFile` (no shell) |
| `test_suite` | `test_suite:<cmd>` | Run a test command, parse pass/fail results |

All evaluators return `EvaluationResult { passed, reason, retryPrompt? }`. The optional `retryPrompt` integrates with `SelfHealingController.buildHealingPromptWithContext()` for intelligent retry feedback.

### Composite Evaluation

Phases may define a `evaluators: EvaluatorType[]` array for multi-evaluator assessment. The Engine runs all evaluators in sequence using **fail-fast** semantics — the first failure halts evaluation and aggregates `retryPrompt` strings. When `evaluators` is absent, the single `evaluator` field is used (defaulting to `exit_code`).

### Security Boundaries

- **Binary Whitelist**: `TOOLCHAIN_WHITELIST` restricts executable binaries to `node`, `npm`, `npx`, `python`, `python3`, `cargo`, `go`, `make`
- **Argument Blacklist**: Interpreter binaries (`node`, `python`, `python3`) block `-e`, `-c`, `--eval`, `exec` flags to prevent arbitrary code execution
- **Strict Timeouts**: All evaluator child processes enforce configurable timeouts
- **`execFile`**: All subprocess calls use `execFile` (no shell interpolation)

---

## Prompt Compiler Pipeline

The `src/prompt-compiler/` subsystem (23 items) transforms raw user prompts into fully assembled, auditable master prompts for the Planner agent.

### Architecture

```
Raw User Prompt → PlannerPromptCompiler.compile(prompt, options)
                          │
                          ├─ Step 1: RequirementNormalizer.normalize(prompt)
                          │   └─ Extracts scope, autonomy prefs, constraints
                          │
                          ├─ Step 2: TaskClassifier.classify(normalizedSpec)
                          │   └─ Determines TaskFamily (feature, bug-fix, refactor, etc.)
                          │
                          ├─ Step 3: TemplateLoader.load(taskFamily)
                          │   └─ Loads family-specific prompt template
                          │
                          ├─ Step 4: RepoFingerprinter.fingerprint(workspaceRoot)
                          │   └─ Scans repo structure, tech stack, conventions
                          │
                          ├─ Step 5: PolicyEngine.evaluate(normalizedSpec)
                          │   └─ Applies policy modules (safety, style, scope)
                          │
                          └─ Step 6: assemblePrompt() → CompiledPrompt
                              └─ Merges skeleton, template, fingerprint, policies
```

### Modules

| Module | Lines | Purpose |
|---|---|---|
| `PlannerPromptCompiler` | ~325 | Top-level orchestrator, runs all pipeline stages |
| `RequirementNormalizer` | ~271 | Extracts structured `NormalizedTaskSpec` from raw text |
| `TaskClassifier` | ~139 | Maps normalized specs to `TaskFamily` enum |
| `TemplateLoader` | ~86 | Loads Markdown templates from `templates/` (inlined at build time) |
| `RepoFingerprinter` | ~623 | Scans workspace for tech stack, file patterns, conventions |
| `PolicyEngine` | ~217 | Evaluates and applies policy modules to the prompt |
| `types.ts` | ~189 | Shared type definitions (`TaskFamily`, `RepoFingerprint`, `CompiledPrompt`, etc.) |
| `templates.ts` | ~25 | Template registry mapping task families to template IDs |

### Prompt Templates

8 family-specific Markdown templates in `prompt-compiler/templates/`:

| Template | Task Family |
|---|---|
| `feature-implementation.md` | New feature development |
| `bug-fix.md` | Bug investigation and fixing |
| `refactor.md` | Code refactoring |
| `migration.md` | Framework/version migration |
| `documentation-synthesis.md` | Documentation writing |
| `review-only.md` | Code review and analysis |
| `repo-analysis.md` | Repository structure analysis |
| `orchestration-skeleton.md` | Multi-phase task orchestration |

Templates are **inlined at build time** via esbuild's text loader to ensure portability in the bundled VSIX.

---

## Agent Registry & Selection Pipeline

The `agent-selection/` module replaces the legacy `WorkerRegistry` with a structured, auditable pipeline for matching subtasks to specialized agent profiles.

### Architecture Overview

```
SubtaskSpec → SelectionPipeline.run(spec)
                   │
                   ├─ Step 1: AgentSelector.select(spec)
                   │   ├─ Hard Filter  (reject incompatible agents)
                   │   ├─ Weighted Scoring (7 weighted dimensions)
                   │   ├─ Tie-Break (prefer simpler/default agents)
                   │   └─ Fallback (code_editor generalist)
                   │
                   ├─ Step 2: WorkerPromptCompiler.compile(spec, profile)
                   │   ├─ Load base-worker.md template
                   │   ├─ Load agent-specific template (e.g. CodeEditor.md)
                   │   └─ Interpolate {{placeholders}} with spec data
                   │
                   ├─ Step 3: PromptValidator.validate(prompt, spec)
                   │   └─ Structural validation (length, required sections)
                   │
                   └─ Step 4: Build SelectionAuditRecord → ArtifactDB
```

### AgentRegistry — Three-Level Cascading Configuration

Agent profiles are loaded and merged in priority order:

| Priority | Source | Location |
|---|---|---|
| 1 (lowest) | Built-in defaults | `agent-selection/registry.json` |
| 2 | VS Code settings | `coogent.customWorkers` |
| 3 (highest) | Workspace file | `.coogent/workers.json` |

Higher-priority profiles with matching `id` values override lower-priority ones. Non-overlapping profiles are merged into a single collection.

### AgentSelector — Four-Pass Algorithm

1. **Hard Filter**: Reject agents whose `handles` array excludes the task type, or whose `avoid_when` keywords match the subtask
2. **Weighted Scoring**: Seven weighted dimensions:

| Dimension | Weight | Description |
|---|---|---|
| `task_type_match` | 4 | Does the agent handle this task type? |
| `reasoning_type_match` | 3 | Does the reasoning style match? |
| `skill_match` | 2 | Proportion overlap of required vs. available skills |
| `context_fit` | 3 | Context window and input format compatibility |
| `output_fit` | 2 | Deliverable type compatibility |
| `risk_fit` | 2 | Risk tolerance alignment (exact=1.0, ±1 tier=0.5) |
| `avoid_when_penalty` | 6 | Negative weight for matching avoid keywords |

3. **Tie-Break**: When top two candidates score identically, prefer the simpler/default agent
4. **Fallback**: If no candidate passes the hard filter, use the `code_editor` generalist profile

### Prompt Templates

Templates live in `agent-selection/templates/`:

| Template | Purpose |
|---|---|
| `base-worker.md` | Common preamble for all agents |
| `CodeEditor.md` | Code editing and implementation |
| `Debugger.md` | Bug investigation and fixing |
| `Planner.md` | Task decomposition and planning |
| `Researcher.md` | Information gathering and analysis |
| `Reviewer.md` | Code review and quality assessment |
| `TestWriter.md` | Test creation and validation |

### Data Flow

```
User Prompt → PlannerAgent
                │
                ├── AgentRegistry.getAvailableTags() → Injects skill tags into planner prompt
                │
                └── Generates phases with required_skills: [...]
                                │
                                ▼
                          DispatchController
                                │
                                ├── SelectionPipeline.run(subtaskSpec)
                                │        │
                                │        └── PipelineResult { selection, prompt, validation, audit }
                                │
                                └── ADKController.spawnWorker()
                                         │
                                         └── Injects compiled prompt
                                             into the AI agent session
```

### Worker Studio UI

The Mission Control webview includes a **Workers** tab that displays all loaded profiles:

- Profile name and unique ID
- Description of capabilities
- Skill tags (used for selection scoring)

The tab sends `workers:request` → receives `workers:loaded` via the standard IPC contract.

---

## Persistence & Crash Recovery

### Write-Ahead Log (WAL) Pattern

Every mutation follows this sequence (within `storageBase/ipc/<sessionDirName>/`, rooted under extension-managed storage):

1. **Acquire Lock** — `.lock` file via `wx` flag (O_CREAT | O_EXCL)
2. **Write WAL Entry** — Snapshot to `.wal.json`
3. **Write to Temp** — Data to `.task-runbook.json.tmp`
4. **Atomic Rename** — Move `.tmp` over the real file
5. **Remove WAL** — Delete journal entry
6. **Release Lock**

### Crash Recovery

On activation, `StateManager` checks for `.wal.json`. If found:
1. Reads the WAL snapshot
2. Re-applies to the runbook file
3. Cleans up the WAL
4. Transitions engine to `ERROR_PAUSED`

### Schema Validation

AJV validates the runbook schema on every disk load. The schema is **inlined as a TypeScript constant** (not read from file) to survive esbuild single-file bundling.

---

## Git Sandboxing

### Pre-Flight Check

Before execution, `GitSandboxManager` checks for uncommitted changes:

- **Clean tree**: Sandbox branch created automatically (`coogent/<task-slug>`)
- **Dirty tree**: User prompted to commit/stash or explicitly bypass

### Sandbox Properties

- Branch created once per session (tracked via `branchCreated` flag)
- Always branches from current HEAD
- No automatic rebase/merge — user controls via PR or manual commit
- Pre-flight check uses VS Code Git API (non-destructive, no disk modification)

---

## Multi-Root Workspace Support

Coogent fully supports VS Code [multi-root workspaces](https://code.visualstudio.com/docs/editor/multi-root-workspaces), where multiple top-level folders are open simultaneously.

### State Storage Isolation

Session state and artifacts are stored in **extension-managed storage** (`ExtensionContext.storageUri`) rather than inside any workspace folder:

- The `.coogent/` directory is no longer created in the workspace root.
- `ArtifactDB`, WAL files, and session data live under the extension's `storageUri`, typically `~/.vscode/extensions/storage/coogent/`.
- This prevents state collisions when multiple workspace roots share the same parent directory.

### Cross-Root File Resolution

The `ExplicitFileResolver` and `ASTFileResolver` probe **all workspace roots** when resolving relative paths specified in runbook `context_files`:

1. **Exact match** — If the path exists under one root, use it.
2. **Multi-match** — If multiple roots contain the same relative path, the **primary root** (first workspace folder) wins. A warning is logged.
3. **No match** — The path is skipped with an error logged.

`WorkspaceHelper.resolveFileAcrossRoots(relativePath)` centralizes this logic.

### Multi-Repo Git Sandboxing

`GitSandboxManager` provides multi-repo methods alongside the existing single-repo API:

| Method | Scope | Behavior |
|---|---|---|
| `preFlightCheck()` | Single repo (best-match) | Returns clean/dirty for the matched repository |
| `preFlightCheckAll()` | All repos | Returns per-repo clean/dirty status + aggregate `allClean` flag |
| `createSandboxBranch()` | Single repo | Creates `coogent/<task-slug>` on the matched repository |
| `createSandboxBranchAll()` | All repos | Two-phase commit: preflight all → create branch in each repo with consistent naming |
| `returnToOriginalBranchAll()` | All repos | Checks out original branches for each repository |

Branch naming is **consistent** across all repositories: `coogent/<sanitized-task-slug>`.

If one repository fails during `createSandboxBranchAll`, the result reports which repos succeeded and which failed — there is **no automatic rollback**.

### Workspace-Qualified Paths

To unambiguously reference files across roots, Coogent supports a **workspace-qualified path** format:

```
<workspaceName>:relative/path/to/file.ts
```

For example, in a workspace with roots `frontend` and `backend`:
- `frontend:src/App.tsx` — resolves to the `src/App.tsx` file under the `frontend` root
- `backend:src/server.ts` — resolves to `src/server.ts` under the `backend` root

`WorkspaceHelper.parseQualifiedPath()` and `WorkspaceHelper.resolveQualifiedPath()` handle parsing and resolution.

### Ambiguity Handling Rules

| Scenario | Resolution |
|---|---|
| Path found in exactly one root | Use that root |
| Path found in multiple roots | Primary root (first workspace folder) wins; warning logged |
| Qualified path provided | Exact root used; error if root name not found |
| Path found in no root | Error logged; file skipped |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Language | TypeScript 5.4 (strict mode) |
| Runtime | Node.js 18+ (VS Code Extension Host) |
| IDE | Antigravity IDE / VS Code ≥ 1.85 |
| MCP | `@modelcontextprotocol/sdk` ^1.27 |
| Persistence | `sql.js` (SQLite WASM) via `ArtifactDB` (11 tables) |
| Tokenizer | `js-tiktoken` (`cl100k_base`) with `CharRatioEncoder` fallback |
| Schema Validation | AJV ^8.18 (inlined), Zod (handoff validation) |
| Markdown | `marked` ^17.0 |
| Diagrams | `mermaid` ^11.12 |
| UI | Svelte 5 + Vite |
| Bundler (Host) | esbuild ^0.20 |
| Testing (Host) | Jest ^29.7 + ts-jest |
| Testing (Webview) | Vitest |
| Linting | ESLint ^8.57 + `@typescript-eslint` ^8.0 |
| Pre-commit | Husky ^9.1 + lint-staged ^16.3 |

### Key Architecture Decisions

| Decision | Rationale |
|---|---|
| WAL + atomic rename | Crash-safe persistence without external dependencies |
| `execFile` over `exec` | Prevents shell injection in Git/evaluators |
| `activeWorkerCount` over hierarchical FSM | Simpler parallel tracking without breaking the 9-state model |
| Branded types (`PhaseId`, `UnixTimestampMs`) | Compile-time safety against numeric confusion |
| UUIDv7 for session IDs | Lexicographically sortable, embeds creation timestamp |
| Inlined JSON schema | Survives esbuild bundling; no ENOENT on `schemas/` path |
| Native VS Code Git API | No `child_process` dependency for sandbox checks |
