# Coogent V2 — Architectural Handoff Document

> **Author**: Principal Systems Architect / Lead Technical Founder
> **Date**: 2026-03-07
> **Audience**: Senior Engineers implementing the V2 transition
> **Prerequisite Reading**: [ARCHITECTURE.md](./ARCHITECTURE.md), [Comprehensive Audit (March 2026)](../docs/review.md), [Refactoring Plan](./refactoring-plan.md)

---

## V1 → V2 Context

V1 shipped a working Master-Worker orchestrator: a deterministic 9-state FSM (`Engine.ts`, 493 lines post-decomposition) dispatching ephemeral workers through a DAG scheduler, with state durability via WAL + ArtifactDB (sql.js/WASM), a Svelte 5 webview, and Jaccard-based skill routing. The March 2026 audit confirmed structural soundness but identified scaling ceilings that V2 aims to demolish.

This document is the canonical engineering blueprint for V2. Every section follows the same contract:

1. **Technical Approach** — How it's built.
2. **Rationale** — Why this, not something else.
3. **Pros** — What we gain.
4. **Cons / Risks** — What we accept or must mitigate.

---

## Table of Contents

1. [SQLite Persistence Layer](#1-sqlite-persistence-layer)
2. [AST-Based Intelligent Context](#2-ast-based-intelligent-context)
3. [Svelte 5 Webview Migration](#3-svelte-5-webview-migration)
4. [Pluggable Evaluators](#4-pluggable-evaluators)
5. [Multi-Root Workspace Support](#5-multi-root-workspace-support)
6. [Prompt Queue & Scheduled Execution](#6-prompt-queue--scheduled-execution)
7. [Specialized Worker Library & Skill-Based Routing](#7-specialized-worker-library--skill-based-routing)
8. [Autonomous Review Loops (Maker-Checker)](#8-autonomous-review-loops-maker-checker)
9. [IPC-Routed Squads (Concurrent Teams)](#9-ipc-routed-squads-concurrent-teams)

---

## 1. SQLite Persistence Layer

### V1 Baseline

V1 uses a split persistence model:
- **Session state** (`.task-runbook.json`): WAL + atomic-rename via `StateManager` in `.coogent/ipc/<uuid>/`
- **Artifacts** (plans, handoffs, reports): `ArtifactDB` using `sql.js` (WASM-compiled SQLite, in-memory with `flush()` to disk)

The WASM approach was chosen for V1 because sql.js is pure JavaScript — no native binaries, no `node-gyp`, zero VSIX packaging friction. But it has a hard ceiling: the entire database lives in a single `Uint8Array` in memory, and `flush()` serializes the full blob via `fs.writeFileSync`, which blocks the extension host event loop for databases >5 MB.

### Technical Approach

Replace `sql.js` with [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) for the `ArtifactDB` layer, **and** migrate the WAL-based `StateManager` into the same SQLite database — unifying all persistence into a single `.coogent/storage/coogent.db` file.

#### Migration Path

1. **Native module bundling**: `better-sqlite3` is a native Node addon. VS Code extensions CAN load native modules, but the VSIX must ship platform-specific `.node` binaries. Use [`@vscode/vsce`](https://github.com/microsoft/vscode-vsce) with `--target` flags to produce per-platform VSIXes (linux-x64, darwin-arm64, win32-x64, etc.), or use [`prebuild-install`](https://github.com/prebuild/prebuild-install) to download prebuilt binaries at install time.

   **Alternative considered**: [`sql.js-httpvfs`](https://github.com/niccokunzmann/sql.js-httpvfs) or staying with sql.js + async flush. Rejected because sql.js's in-memory model fundamentally cannot do incremental I/O — every write re-serializes the entire database. `better-sqlite3` uses true file-backed storage with SQLite's native page cache.

2. **Schema design**: Two core tables replace the dual persistence model:

   ```sql
   -- Replaces StateManager's WAL + .task-runbook.json
   CREATE TABLE sessions (
       session_id    TEXT PRIMARY KEY,
       workspace_uri TEXT NOT NULL,
       runbook       TEXT NOT NULL,            -- JSON-serialized runbook
       engine_state  TEXT NOT NULL DEFAULT 'IDLE',
       created_at    INTEGER NOT NULL,
       updated_at    INTEGER NOT NULL
   );

   -- Replaces ArtifactDB's in-memory tables
   CREATE TABLE artifacts (
       id             INTEGER PRIMARY KEY AUTOINCREMENT,
       session_id     TEXT NOT NULL REFERENCES sessions(session_id),
       artifact_type  TEXT NOT NULL,           -- 'plan' | 'handoff' | 'report' | 'log'
       phase_id       TEXT,
       payload        TEXT NOT NULL,            -- JSON blob
       created_at     INTEGER NOT NULL,
       UNIQUE(session_id, artifact_type, phase_id)
   );

   CREATE INDEX idx_artifacts_session ON artifacts(session_id);
   CREATE INDEX idx_artifacts_type    ON artifacts(session_id, artifact_type);
   ```

3. **WAL mode**: Enable SQLite's own WAL mode (`PRAGMA journal_mode=WAL`) — this gives us concurrent reads + serialized writes without blocking the event loop, and survives process crashes (SQLite replays its own WAL on next open). This **eliminates** our custom WAL implementation entirely.

4. **Startup recovery**: On extension activation, `better-sqlite3` opens the database file. If the previous process crashed, SQLite automatically replays its WAL — no custom crash-recovery code needed. We transition the engine to `ERROR_PAUSED` only if the recovered `engine_state` indicates an incomplete execution.

5. **Encryption**: Replace the current PBKDF2-derived AES-256-CBC file encryption with [SQLCipher](https://github.com/niccokunzmann/sqlcipher) (fork of better-sqlite3 with transparent encryption), or encrypt at the column level using VS Code's `SecretStorage` API for key management (as recommended in the March audit).

### Rationale

The core problem is **split-brain persistence**. V1 has two independent durable stores (`StateManager` files + `ArtifactDB` WASM) that can diverge after a crash. Unifying into a single SQLite database with ACID transactions makes atomicity trivial: a single `BEGIN...COMMIT` can update both the session state and its associated artifacts. SQLite's built-in WAL is also strictly superior to our hand-rolled WAL — it handles page-level journaling, crash recovery, and concurrent access patterns that we'd spend months reimplementing correctly.

### Pros

- **Crash-safe by default**: SQLite's WAL mode provides durable, atomic writes without our custom 6-step atomic-rename ceremony.
- **Survives IDE reloads**: The database file persists on disk; re-opening recovers the full state graph.
- **Incremental I/O**: Only dirty pages are written, not the entire database blob. Eliminates the `flush()` event-loop blocking.
- **Single transaction boundary**: Runbook mutations and artifact writes can share a transaction.
- **Query power**: Enables V2 features like scheduled queues and multi-session management via SQL queries rather than in-memory scanning.

### Cons / Risks

- **Native module packaging**: `better-sqlite3` requires platform-specific `.node` binaries in the VSIX. This complicates CI/CD — we must build and test per-platform bundles (linux-x64, darwin-arm64, darwin-x64, win32-x64). If a user's architecture isn't covered, the extension fails to activate.
- **VSIX size increase**: Each platform-specific binary adds ~5–8 MB. With 4 targets, the universal VSIX could reach ~30 MB (vs. ~3 MB for sql.js WASM).
- **SQLite version drift**: VS Code ships its own SQLite (Electron), but `better-sqlite3` bundles its own. Two SQLite engines in the same process. No functional conflict, but it's architecturally inelegant.
- **Migration path**: Existing V1 users have data in `ArtifactDB` (sql.js format) and `StateManager` files. A one-time migration routine must read the old format and insert into the new schema. If the migration fails mid-way, we need a rollback strategy.
- **Write contention under Squads**: When multiple concurrent workers submit handoffs simultaneously, all writes funnel through a single `better-sqlite3` connection (which is synchronous in Node). Under high concurrency (Feature 9), this could become a bottleneck. Mitigation: use SQLite WAL mode (concurrent reads, serialized writes) and batch writes via prepared statements.

---

## 2. AST-Based Intelligent Context

### V1 Baseline

V1 already implements `ASTFileResolver` using the TypeScript Compiler API for transitive dependency walking, with `tsconfig` path alias support and DFS cycle detection. `TiktokenEncoder` (via `js-tiktoken`, cl100k_base) provides exact token counting, with `CharRatioEncoder` (4:1) as a fast fallback. When AST-resolved imports exceed the 100K token budget, the system falls back to explicit `context_files` only.

### Technical Approach

V2 extends the resolver in three directions:

1. **Multi-language AST support**: The current `ASTFileResolver` only handles TypeScript/JavaScript via the TS Compiler API. V2 adds language-specific resolvers behind a `FileResolverStrategy` interface:

   ```typescript
   interface FileResolverStrategy {
       readonly supportedExtensions: ReadonlySet<string>;
       resolveImports(filePath: string, content: string): string[];
   }

   class TypeScriptResolver implements FileResolverStrategy { /* existing TS Compiler API logic */ }
   class PythonResolver   implements FileResolverStrategy { /* regex for import/from statements */ }
   class GoResolver       implements FileResolverStrategy { /* regex for import blocks */ }
   class CSSResolver      implements FileResolverStrategy { /* regex for @import/@use */ }
   ```

   The `ASTFileResolver` dispatches to the correct strategy based on file extension. TypeScript/JavaScript continues to use the full Compiler API. Python/Go/CSS use regex-based extraction — less precise but sufficient for dependency discovery (not type-checking).

2. **Exact token budgeting with `js-tiktoken`**: V1 already uses `js-tiktoken` with `cl100k_base`. V2 pins to the model-specific encoding for the configured provider (e.g., `o200k_base` for GPT-4o, `cl100k_base` for Claude). The `TiktokenEncoder` gains a `setEncoding(model: string)` method called during provider configuration. Rationale: different models have different tokenizers, and a 100K token budget means different things under different encodings.

3. **Incremental resolution cache**: V2 introduces a file-hash-based cache for resolved import graphs. The first resolution of a file stores `{ hash: sha256(content), imports: string[] }` in the SQLite `artifacts` table. Subsequent resolutions check the hash first — if unchanged, skip the AST parse entirely. Cache invalidation is triggered by `fs.watch` events routed through the Extension Host.

### Rationale

The TypeScript Compiler API is the gold standard for JS/TS resolution — it handles path aliases, barrel exports, re-exports, and conditional imports correctly. For other languages, we pragmatically accept regex-based extraction because the cost of integrating language servers (LSP) for dependency walking is disproportionate to the benefit. The cache is critical for large monorepos where re-parsing hundreds of files per phase dispatch adds 2–5 seconds of latency.

### Pros

- **Language-agnostic context assembly**: Workers get relevant transitive dependencies regardless of project language.
- **Exact token budgets**: Model-specific tokenizers prevent over/under-budgeting. A 100K budget with `o200k_base` encodes ~30% more text than with `cl100k_base`.
- **Sub-second re-resolution**: The SHA-256 cache makes repeated resolutions O(1) for unchanged files, reducing dispatch latency from seconds to milliseconds in steady-state.
- **Graceful degradation**: If no resolver matches, the system falls back to explicit `context_files` only — never fails silently.

### Cons / Risks

- **Regex resolvers are imprecise**: Python's `import` semantics (relative imports, `__init__.py` re-exports, namespace packages) are notoriously hard to parse with regex. We will miss some dependencies and occasionally include false positives. Acceptable trade-off: the worker can always `get_modified_file_content` for files it discovers it needs.
- **Cache invalidation complexity**: `fs.watch` is unreliable across platforms (especially on networked filesystems and WSL2). A stale cache entry could cause a worker to receive outdated dependency context. Mitigation: add a TTL (5 minutes) and force-invalidate on session start.
- **Memory pressure from tokenizer vocabularies**: Loading multiple tokenizer vocabularies (`cl100k_base` + `o200k_base`) consumes ~15 MB each. Lazy-load and dispose after token counting to avoid permanent memory overhead.
- **TypeScript Compiler API startup cost**: Creating a `ts.Program` for large projects (>1000 files) takes 3–8 seconds on first invocation. The cache mitigates this for subsequent calls, but the cold-start cost remains.

---

## 3. Svelte 5 Webview Migration

### V1 Baseline

V1 already uses Svelte 5 with Runes API (`$state`, `$derived`, `$effect`) for the Mission Control webview. The `mcpStore` implements a correlation-aware IPC bridge using the hybrid Push/Pull model: lightweight state updates via `postMessage`, heavy artifact retrieval via `coogent://` MCP resource URIs.

### Technical Approach

V2 is not a "migration" but a **hardening** of the existing Svelte 5 webview for high-frequency FSM event streaming, required by new features (Squads, Review Loops, Scheduled Queues).

1. **Fine-grained reactive stores per phase**: Replace the current monolithic `$state` runbook object with per-phase reactive atoms. When 8 concurrent Squad workers update their phases simultaneously, only the affected `PhaseAtom` triggers re-renders — not the entire runbook tree.

   ```typescript
   // V1: single monolithic state
   let runbook = $state<Runbook | null>(null);

   // V2: per-phase atoms with derived aggregation
   const phaseAtoms = new Map<PhaseId, { status: string; output: string; worker: string }>();

   function getPhaseAtom(id: PhaseId) {
       if (!phaseAtoms.has(id)) {
           phaseAtoms.set(id, $state({ status: 'pending', output: '', worker: '' }));
       }
       return phaseAtoms.get(id)!;
   }

   // Derived global state (lazy, cached)
   let activeWorkerCount = $derived(
       [...phaseAtoms.values()].filter(p => p.status === 'executing').length
   );
   ```

2. **Batched `postMessage` processing**: V1's `OutputBufferRegistry` batches worker output at 100ms / 4KB intervals on the extension host side. V2 adds a corresponding **webview-side accumulation buffer** that collects incoming messages for 16ms (one animation frame) before applying state mutations. This prevents the webview from thrashing on rapid-fire FSM events during parallel execution.

   ```typescript
   // webview-ui/src/stores/messageBuffer.ts
   let pendingMessages: UIMessage[] = [];
   let rafId: number | null = null;

   function onMessage(msg: UIMessage) {
       pendingMessages.push(msg);
       if (!rafId) {
           rafId = requestAnimationFrame(() => {
               applyBatch(pendingMessages);
               pendingMessages = [];
               rafId = null;
           });
       }
   }
   ```

3. **Virtual scrolling for phase lists**: With Squads and Review Loops, a single session could have 50+ phases with real-time output streams. V2 implements windowed rendering — only phases visible in the viewport are fully rendered. Off-screen phases render a lightweight placeholder with status badge only.

4. **Theme-aware Mermaid DAG visualization**: Render the phase dependency graph as an inline Mermaid diagram in the webview, using `$derived` to recompute node colors based on real-time phase status. This replaces the current flat list view with a spatial representation of the DAG topology.

### Rationale

Svelte 5's Runes are already the right abstraction. The issue is not the framework — it's that V1's state granularity was designed for sequential, single-worker execution. V2's concurrency features (Squads, Review Loops) multiply event frequency by 4–8×. Without per-phase reactivity and frame-aligned batching, the webview will drop frames and feel sluggish.

### Pros

- **O(1) per-phase updates**: Only the affected phase component re-renders, not the entire tree. Critical when 8 workers report progress simultaneously.
- **Frame-aligned batching eliminates jank**: Grouping mutations into `requestAnimationFrame` cadence keeps the UI at 60 FPS even under heavy event load.
- **Virtual scrolling scales to 100+ phases**: Memory and DOM footprint stays constant regardless of total phase count.
- **DAG visualization provides spatial awareness**: Users can see the dependency topology and identify bottlenecks at a glance.

### Cons / Risks

- **Increased complexity in state management**: Per-phase atoms require careful cleanup on session switch (dispose atoms for phases that no longer exist). Leaking reactive subscriptions will cause memory growth.
- **`requestAnimationFrame` batching introduces 16ms latency**: Fast-typing users sending commands may perceive a slight delay. Acceptable trade-off vs. jank.
- **Mermaid rendering performance**: Complex DAGs (30+ nodes) may take >100ms to re-render via Mermaid's layout engine. Mitigation: debounce status-change-driven re-renders to 500ms, and cache the SVG output.
- **Testing complexity**: Svelte 5 Runes don't have a mature testing story yet. Component tests require `@testing-library/svelte` with Vitest, but `$state` and `$effect` behave differently in test harnesses vs. browser contexts.

---

## 4. Pluggable Evaluators

### V1 Baseline

V1's `EvaluationOrchestrator` supports phase-level `success_criteria` with a limited set of evaluators. The current implementation uses a simple conditional chain: if the criteria specifies a test command, run it; otherwise, assume success from a clean worker exit (exit code 0).

### Technical Approach

V2 introduces a **Strategy Pattern registry** for evaluators, allowing phases to declare arbitrary evaluation strategies via `success_criteria.evaluator` in the runbook.

1. **Evaluator interface and registry**:

   ```typescript
   // src/evaluators/types.ts
   interface EvaluatorContext {
       phase: Phase;
       workspaceRoot: string;
       workerOutput: string;
       exitCode: number;
       handoff: PhaseHandoff | null;
   }

   interface EvaluatorResult {
       pass: boolean;
       message: string;
       details?: Record<string, unknown>;
   }

   interface Evaluator {
       readonly id: string;
       evaluate(ctx: EvaluatorContext): Promise<EvaluatorResult>;
   }

   // src/evaluators/EvaluatorRegistry.ts
   class EvaluatorRegistry {
       private evaluators = new Map<string, Evaluator>();

       register(evaluator: Evaluator): void { ... }
       get(id: string): Evaluator | undefined { ... }

       async evaluate(id: string, ctx: EvaluatorContext): Promise<EvaluatorResult> {
           const evaluator = this.evaluators.get(id);
           if (!evaluator) {
               return { pass: false, message: `Unknown evaluator: ${id}` };
           }
           return evaluator.evaluate(ctx);
       }
   }
   ```

2. **Built-in evaluators**:

   | Evaluator ID | Trigger | Behavior |
   |---|---|---|
   | `exit_code` | Default | Pass if worker exit code === 0 |
   | `regex` | `success_criteria.pattern` | Match a regex against worker output or modified file contents |
   | `toolchain` | `success_criteria.command` | Execute a shell command (e.g., `npm run build`); pass if exit code 0 |
   | `test_suite` | `success_criteria.test_command` | Run test command, parse JUnit/TAP output for pass/fail counts |
   | `lint` | `success_criteria.lint_command` | Run linter, fail if error count > threshold |
   | `type_check` | `success_criteria.type_check = true` | Run `tsc --noEmit`; pass if 0 errors |

3. **Runbook schema extension**:

   ```json
   {
       "id": 3,
       "prompt": "Refactor the authentication module",
       "success_criteria": {
           "evaluator": "test_suite",
           "test_command": "npm test -- --testPathPattern=auth",
           "min_pass_rate": 0.95
       }
   }
   ```

4. **Timeout and sandboxing**: All `toolchain`/`test_suite`/`lint`/`type_check` evaluators execute via `child_process.execFile` (not `exec`) with a configurable timeout (default: 60s) and inherit the workspace's `PATH`. The existing argument blacklist (`-e`, `-c` flags) is enforced.

5. **Custom evaluators via `.coogent/evaluators/`**: Users can add custom evaluator scripts. A `.coogent/evaluators/custom-check.js` file that exports an `evaluate(ctx)` function is auto-registered with id `custom:custom-check`. Scripts are loaded in a `vm.runInNewContext` sandbox with no access to `require`, `process`, or `fs`.

### Rationale

V1's binary pass/fail (exit code 0 or not) is insufficient for real-world CI pipelines. A phase that "succeeds" by exit code but introduces type errors or test regressions should fail evaluation. The Strategy Pattern was chosen over a plugin system because evaluators are stateless, synchronous decision functions — they don't need lifecycle management, event subscriptions, or inter-evaluator communication. The registry is flat and deterministic.

### Pros

- **Composable quality gates**: Each phase can enforce project-specific standards (tests, types, lints) without manual intervention.
- **Self-healing integration**: Failed evaluator results feed into `SelfHealingController`'s retry loop with the specific error output, enabling targeted fix attempts rather than blind retries.
- **Extensible without core changes**: New evaluators are added by implementing the interface and calling `registry.register()`. No engine modifications needed.
- **Deterministic**: Each evaluator produces a `{ pass, message }` result. No probabilistic scoring, no ambiguity.

### Cons / Risks

- **Subprocess execution is inherently risky**: Running `npm test` or arbitrary user-defined commands gives Coogent's evaluator pipeline the same attack surface as a CI system. Malicious runbooks could specify `success_criteria.command: "rm -rf /"`. Mitigation: existing `execFile` argument blacklist, command allowlisting (optional), and a `coogent.evaluators.allowShellCommands` setting that defaults to `false` (requiring explicit user opt-in).
- **Test suite parsing fragility**: JUnit XML and TAP output formats vary across test runners. A parser that works for Jest may fail for Vitest or pytest. We'll need adapter functions per runner or rely on exit codes as fallback.
- **Custom evaluator sandboxing is limited**: `vm.runInNewContext` is not a security boundary — a determined adversary can escape it. This is acceptable for local extensions (the user runs the code on their own machine), but warrants a warning in the docs.
- **Timeout tuning**: A 60s default may be too short for large test suites or too long for simple type checks. Need per-evaluator timeout overrides in `success_criteria`.

---

## 5. Multi-Root Workspace Support

### V1 Baseline

V1 assumes a single `workspaceRoot` — the first `vscode.workspace.workspaceFolders[0].uri.fsPath`. All file resolution, Git sandboxing, and state storage is scoped to this single root.

### Technical Approach

V2 treats each workspace folder as an independent orchestration domain with shared session coordination.

1. **Workspace-aware `ServiceContainer`**: The `ServiceContainer` instantiates per-workspace-folder instances of:
   - `GitSandboxManager` (each folder gets its own branch)
   - `ContextScoper` (file resolution is folder-scoped)
   - `StateManager` (each folder's `.coogent/` directory is independent)

   The `Engine` and `PlannerAgent` remain singletons — there's one FSM governing the entire session, but phases declare a `workspace_folder` field indicating which root they target.

2. **Phase-level folder scoping**:

   ```json
   {
       "id": 1,
       "prompt": "Update the API routes",
       "workspace_folder": "packages/api",
       "context_files": ["src/routes/index.ts"]
   }
   ```

   If `workspace_folder` is omitted, the phase targets the first workspace folder (backward-compatible).

3. **Cross-folder file references**: When a phase in `packages/api` depends on a phase in `packages/shared`, the `HandoffExtractor` resolves `modified_files` paths relative to the declaring phase's `workspace_folder`. The `get_modified_file_content` MCP tool gains a `workspace_folder` parameter to disambiguate.

4. **Git sandboxing per folder**: Each workspace folder gets its own `coogent/<task-slug>` branch. The `GitSandboxManager` iterates `workspaceFolders` and creates branches independently. This handles monorepos where sub-packages have separate Git histories (submodules) and polyrepos where folders are distinct repositories.

5. **Unified `.coogent/` storage**: Despite per-folder contexts, the SQLite database remains at the **first workspace folder's** `.coogent/storage/coogent.db`. This prevents orphaned databases when folders are added/removed, and ensures a single source of truth for session state.

### Rationale

Monorepos are the norm for any team that would benefit from Coogent's orchestration. A refactoring task that touches `packages/api`, `packages/shared`, and `packages/web` simultaneously is the exact use case Coogent is built for. We chose the "single FSM, per-folder contexts" model over "one engine per folder" because the DAG dependencies cross folder boundaries — phase 2 in `packages/api` may depend on phase 1 in `packages/shared`. A multi-engine model would require cross-engine IPC coordination, which is strictly more complex.

### Pros

- **Monorepo-native**: Workers scoped to their relevant sub-package avoid scanning irrelevant code.
- **Cross-folder DAGs**: Dependencies between folders are first-class citizens in the runbook.
- **Backward-compatible**: Single-folder workspaces behave identically to V1.
- **Independent Git branches**: A failed refactoring in `packages/api` doesn't dirty `packages/web`'s working tree.

### Cons / Risks

- **Path resolution ambiguity**: A relative path like `src/utils.ts` is ambiguous when multiple workspace folders exist. Every file-touching API must accept or infer the `workspace_folder` context. This is a pervasive change — `ContextScoper`, `HandoffExtractor`, `MCPToolHandler`, and `ADKController` all need folder-aware overloads.
- **Database ownership during folder addition/removal**: If the user adds a workspace folder mid-session, the existing database doesn't know about it. We need a `workspaceFoldersChanged` event handler that updates the session metadata without disrupting running workers.
- **Git submodule edge cases**: Workspace folders that are Git submodules have separate `.git` directories. Our `GitSandboxManager` uses the VS Code Git API, which handles this, but branch creation in submodules has different semantics (detached HEAD tracking).
- **Cognitive load on runbook authors**: Users must now think about `workspace_folder` when writing runbooks. The Planner Agent must also understand the workspace structure to assign folders correctly.

---

## 6. Prompt Queue & Scheduled Execution

### V1 Baseline

V1 is entirely interactive. The user submits a prompt, the PlannerAgent generates a runbook, the user approves, and execution begins immediately. There is no concept of deferred or batch execution.

### Technical Approach

V2 introduces a database-backed FIFO queue that allows users to enqueue prompts for later execution. The queue processor runs as a background service within the Extension Host.

1. **Queue schema** (extends the SQLite persistence layer from Feature 1):

   ```sql
   CREATE TABLE prompt_queue (
       id            INTEGER PRIMARY KEY AUTOINCREMENT,
       prompt        TEXT NOT NULL,
       workspace_uri TEXT NOT NULL,
       priority      INTEGER NOT NULL DEFAULT 0,    -- higher = sooner
       scheduled_at  INTEGER,                        -- NULL = immediate, epoch ms otherwise
       status        TEXT NOT NULL DEFAULT 'pending', -- pending | planning | executing | completed | failed | cancelled
       session_id    TEXT REFERENCES sessions(session_id),
       created_at    INTEGER NOT NULL,
       started_at    INTEGER,
       completed_at  INTEGER,
       error_message TEXT
   );

   CREATE INDEX idx_queue_status ON prompt_queue(status, priority DESC, created_at ASC);
   ```

2. **Queue processor**: A singleton `QueueProcessor` polls the queue every 30 seconds (configurable). When the engine is `IDLE` and a pending item exists with `scheduled_at <= now()`:
   - Transition engine state: `IDLE → PLANNING`
   - Create a new session
   - Feed the prompt to the `PlannerAgent`
   - Auto-approve the generated plan (configurable: `coogent.queue.autoApprove`)
   - Execute through the normal FSM lifecycle
   - On completion: update queue status, emit notification

3. **User controls**:
   - **Enqueue**: Via command palette (`Coogent: Queue Prompt`) or webview "Add to Queue" button
   - **Schedule**: Optional datetime picker for deferred execution
   - **Priority**: Drag-and-drop reordering in the webview queue panel
   - **Cancel**: Cancel pending/planning items; abort executing items
   - **Auto-approve toggle**: When enabled, the queue processor skips `PLAN_REVIEW` and transitions directly to `PARSING`. When disabled, the queue item enters `planning` status and waits for the user to approve the plan next time they open VS Code.

4. **Overnight execution safety**: Before auto-executing a queued item, the processor:
   - Verifies the workspace is in a clean Git state (or creates a sandbox branch)
   - Checks that no other session is active
   - Sets a session-level timeout (default: 2 hours, configurable) as a circuit breaker
   - Persists all output to `.coogent/logs/` for post-hoc review

### Rationale

The primary use case is overnight refactoring: a developer queues 5 large refactoring tasks at EOD, and Coogent works through them sequentially overnight. Sequential execution (not parallel) is deliberate — running multiple sessions simultaneously would create Git branch conflicts and context failures. The FIFO queue with priority is the simplest model that satisfies this use case without introducing a full-blown job scheduler.

### Pros

- **Async developer workflow**: Queue tasks and review results in the morning. Maximizes LLM compute utilization outside working hours.
- **Priority control**: Urgent refactorings jump the queue without cancelling pending items.
- **Crash-resilient**: Queue state is in SQLite. If VS Code crashes, the queue survives. On restart, the processor resumes from the last `pending` item.
- **Observable**: Queue status is visible in the webview and persisted in the database for historical analysis.

### Cons / Risks

- **Auto-approve is dangerous**: A bad plan executed without review can cause widespread code damage across the workspace. Mitigation: auto-approve defaults to `false`; when enabled, the system creates a Git branch per queue item and surfaces a diff summary notification on completion.
- **Extension host lifecycle**: VS Code can deactivate extensions after periods of inactivity. If the extension is deactivated mid-execution, the queue processor dies. Mitigation: use `vscode.window.withProgress` to keep the extension alive during active execution, but this doesn't help for queued items waiting for their scheduled time.
- **Single-tenant execution**: Only one queue item executes at a time (engine is a singleton). A large refactoring that takes 2 hours blocks all subsequent queue items. No parallelism at the session level.
- **Scheduled execution requires VS Code to be running**: There's no daemon mode. If the user closes VS Code before the scheduled time, the item executes on next launch — which may be days later, on a now-stale codebase.

---

## 7. Specialized Worker Library & Skill-Based Routing

### V1 Baseline

V1 implements the Worker Library with Jaccard similarity matching via `WorkerRegistry`. Workers are loaded from a 3-tier cascade: built-in defaults → VS Code global settings → workspace `.coogent/workers.json`. The Planner outputs `required_skills` tags, and the Matchmaker selects the highest-scoring worker. Fallback is always the `generalist` profile.

### Technical Approach

V2 hardens the routing algorithm and expands worker profiles with execution-affecting metadata.

1. **Weighted Jaccard scoring**: V1's Jaccard similarity treats all tags equally. V2 adds tag weights:

   ```typescript
   interface WorkerProfile {
       id: string;
       name: string;
       description: string;
       system_prompt: string;
       tags: string[];
       tag_weights?: Record<string, number>;  // NEW: { "react": 2.0, "css": 0.5 }
       max_tokens?: number;                    // NEW: per-worker token budget override
       preferred_model?: string;               // NEW: route to specific model if available
       tools_whitelist?: string[];             // NEW: restrict MCP tools available to this worker
   }

   // Weighted Jaccard:
   // score = Σ(weight[tag] for tag in intersection) / Σ(weight[tag] for tag in union)
   ```

   This allows domain experts (e.g., a `database_expert` with high weight on `sql`) to score higher for SQL tasks even when a `backend_expert` shares some overlapping tags.

2. **Planner-emitted skill requirements**: The `PlannerAgent`'s output schema gains a `required_skills` field per phase. V2 makes this field mandatory in the runbook schema (V1 had it optional):

   ```json
   {
       "id": 2,
       "prompt": "Optimize the database queries in the reporting module",
       "required_skills": ["sql", "postgres", "query-optimization"],
       "context_files": ["src/reports/queries.ts"]
   }
   ```

3. **Deterministic tie-breaking**: When multiple workers score identically, V1 returns the first match (insertion order). V2 breaks ties by: (a) specificity (fewer total tags = more specialized = preferred), then (b) alphabetical ID. This ensures routing is fully deterministic regardless of configuration order.

4. **Worker profile validation on load**: V2 validates all worker profiles against a JSON Schema on load, rejecting profiles with missing fields, empty `tags`, or `system_prompt` shorter than 50 characters. Invalid profiles emit a warning and are excluded from the registry.

5. **Routing telemetry**: Every routing decision logs the candidate scores, the selected worker, and the input skills. This is persisted in the session's `engine.jsonl` for post-hoc analysis of routing quality.

### Rationale

The fundamental insight is that LLM performance varies dramatically based on system prompt specialization. A worker prompted as a "React optimization expert" produces measurably better React code than a generalist, but performs worse on SQL tasks. Jaccard similarity is the right algorithm for tag matching because it's symmetric, bounded [0, 1], and trivially explainable. The weights extension handles the reality that not all skills are equally discriminating.

### Pros

- **Reduced hallucination**: Domain-specific system prompts ground the worker's behavior in relevant expertise.
- **Model routing**: A `preferred_model` field enables cost optimization (use cheaper models for documentation tasks, expensive models for architecture).
- **Tool restriction**: A `tools_whitelist` prevents a documentation worker from calling `submit_phase_handoff` with code changes — enforcing separation of concerns at the tool level.
- **Fully deterministic**: Given the same skills and registry, the same worker is always selected.

### Cons / Risks

- **Configuration burden**: Users must curate worker profiles to benefit from specialized routing. Poor profiles (overly broad tags, generic prompts) are worse than the generalist fallback.
- **Planner skill extraction accuracy**: The Planner must correctly infer `required_skills` from a natural-language prompt. A prompt like "fix the bug" gives the Planner no signal. Mitigation: the Planner's system prompt includes guidance on skill extraction, and the UI shows the extracted skills for user review during `PLAN_REVIEW`.
- **Tag vocabulary drift**: There's no controlled vocabulary for tags. `"react"`, `"React"`, and `"reactjs"` are three different tags. Mitigation: normalize tags to lowercase during profile loading, and document a recommended tag taxonomy.
- **Over-specialization risk**: If the registry contains only narrow specialists with no generalist fallback, a task with unusual skill requirements may route to an unsuitable worker. The generalist fallback must never be removed from built-in defaults.

---

## 8. Autonomous Review Loops (Maker-Checker)

### V1 Baseline

V1's evaluation is a single pass: worker completes → `EvaluationOrchestrator` runs success criteria → pass/fail. On failure, `SelfHealingController` retries with error context, but there's no concept of an independent reviewer.

### Technical Approach

V2 introduces a dual-role phase execution model: an `engineer` worker produces code, and a `reviewer` worker evaluates it. This creates a closed loop that iterates until the reviewer approves or a circuit breaker trips.

1. **Phase schema extension**:

   ```json
   {
       "id": 4,
       "prompt": "Implement the caching layer",
       "required_skills": ["backend", "redis"],
       "review": {
           "enabled": true,
           "reviewer_skills": ["backend", "code-review", "security"],
           "max_iterations": 3,
           "review_prompt": "Review the implementation for correctness, performance, and security. Focus on cache invalidation and TTL strategies."
       }
   }
   ```

2. **Execution flow**:

   ```
   EXECUTING_WORKER (engineer)
       ↓ worker exits
   EVALUATING (evaluator runs success_criteria)
       ↓ evaluator passes
   REVIEWING (reviewer worker spawned)     ← NEW STATE
       ↓ reviewer submits review handoff
   REVIEW_EVALUATION                       ← NEW STATE
       ├── review.approved = true → phase COMPLETED
       └── review.approved = false → EXECUTING_WORKER (engineer, iteration N+1)
                                     with review feedback injected into prompt
   ```

3. **FSM extension**: Two new states are added to the 9-state FSM:
   - `REVIEWING`: A reviewer worker is active for the phase
   - `REVIEW_EVALUATION`: Processing the reviewer's output

   These states are phase-scoped — the engine's global state remains `EXECUTING_WORKER` as long as any phase is in an active sub-state. The review loop lifecycle is managed by a new `ReviewController` that orchestrates the Maker-Checker cycle.

4. **Circuit breaker**: `review.max_iterations` (default: 3) caps the loop. After the final iteration, if the reviewer still disapproves, the phase transitions to `ERROR_PAUSED` with the full review history attached. The user decides whether to accept, revise, or abort.

5. **Review handoff schema**: The reviewer submits via a new MCP tool `submit_review`:

   ```typescript
   {
       name: 'submit_review',
       inputSchema: {
           type: 'object',
           required: ['masterTaskId', 'phaseId', 'approved', 'feedback'],
           properties: {
               approved:   { type: 'boolean' },
               feedback:   { type: 'array', items: { type: 'string', maxLength: 1000 }, maxItems: 30 },
               severity:   { type: 'string', enum: ['critical', 'major', 'minor', 'nitpick'] },
           }
       }
   }
   ```

6. **Feedback injection**: On review rejection, the engineer's next iteration prompt includes:

   ```
   ## Review Feedback (Iteration 2/3)
   The following issues were identified by the code reviewer:
   - [CRITICAL] Cache invalidation logic does not account for concurrent writes
   - [MAJOR] TTL is hardcoded — should be configurable via environment variable
   Address ALL critical and major issues. Minor and nitpick items are recommended but optional.
   ```

### Rationale

The Maker-Checker pattern is standard in financial systems, avionics, and any domain where single-agent output is insufficient for correctness assurance. In LLM terms, a second model call with a different persona (reviewer vs. engineer) provides adversarial challenge that catches errors the engineer's confirmation bias misses. The circuit breaker prevents infinite loops — if 3 iterations can't satisfy the reviewer, human judgment is needed.

### Pros

- **Higher code quality**: Two independent LLM passes catch more bugs than one. The reviewer can identify issues the engineer introduced.
- **Feedback-driven improvement**: Each iteration is informed by specific, structured feedback, not generic "try again."
- **Configurable rigor**: Simple phases can skip review (`review.enabled: false`); critical phases can require it.
- **Full audit trail**: Every iteration's engineer output and reviewer feedback is persisted in ArtifactDB, providing a complete review history.

### Cons / Risks

- **Token cost multiplication**: Each review iteration doubles the LLM token spend for a phase. A 3-iteration loop = 6× the cost of a single pass (3 engineer + 3 reviewer calls). This must be clearly communicated to users.
- **Latency multiplication**: Each iteration adds a full worker spawn + execution cycle (typically 30–120 seconds). A 3-iteration loop can take 6+ minutes for a single phase.
- **Reviewer hallucination**: The reviewer itself is an LLM and can produce false negatives (rejecting correct code) or false positives (approving buggy code). There's no guarantee that the reviewer is more competent than the engineer.
- **FSM complexity**: Adding 2 states (REVIEWING, REVIEW_EVALUATION) to the FSM increases the transition matrix. The existing 9-state FSM has ~25 valid transitions; 11 states could have ~35+. Each new transition needs test coverage.
- **Convergence is not guaranteed**: The engineer may "fix" one issue and introduce another, while the reviewer cycles between different complaints. The circuit breaker is the only safety net.

---

## 9. IPC-Routed Squads (Concurrent Teams)

### V1 Baseline

V1's parallel execution dispatches independent phases concurrently via the DAG scheduler (Kahn's algorithm). Each worker is fully isolated — no inter-worker communication, no shared file access coordination. The `Scheduler` respects a max concurrency of 4 workers.

### Technical Approach

V2 introduces **Squads**: multiple workers collaborating on a single phase. The Extension Host acts as a central message broker and file-lock manager, enabling coordinated concurrent work without workers directly communicating.

1. **Squad phase schema**:

   ```json
   {
       "id": 5,
       "prompt": "Refactor the authentication module",
       "squad": {
           "enabled": true,
           "workers": [
               { "role": "implementer", "skills": ["backend", "auth"], "files": ["src/auth/"] },
               { "role": "test_writer", "skills": ["testing", "jest"], "files": ["src/auth/__tests__/"] },
               { "role": "docs_writer", "skills": ["documentation"], "files": ["docs/auth/"] }
           ],
           "coordination": "mutex"  // "mutex" | "optimistic" | "none"
       }
   }
   ```

2. **Extension Host as Pub/Sub broker**: Workers in a squad communicate indirectly via IPC messages routed through the Extension Host:

   ```typescript
   // Worker A publishes an event
   mcp.tool('squad_publish', {
       channel: 'phase-5-updates',
       event: 'file_written',
       payload: { file: 'src/auth/middleware.ts' }
   });

   // Extension Host routes to all other workers in the squad
   // Worker B receives via a poll-based tool
   mcp.tool('squad_subscribe', {
       channel: 'phase-5-updates',
       since: lastSeenTimestamp
   });
   ```

   The broker is implemented as an in-memory `Map<channel, Event[]>` with TTL-based cleanup. Events persist only for the duration of the squad execution.

3. **Mutex file-lock manager**: When `coordination: "mutex"` is set, the Extension Host maintains a `Map<filePath, workerId>` lock table. Workers must acquire a lock before writing:

   ```typescript
   // Worker requests lock
   mcp.tool('file_lock', { action: 'acquire', path: 'src/auth/middleware.ts' });
   // → { granted: true, lock_id: "..." } or { granted: false, held_by: "implementer" }

   // Worker releases lock
   mcp.tool('file_lock', { action: 'release', lock_id: "..." });
   ```

   Locks have a 60-second timeout to prevent deadlocks from crashed workers. If a worker exits while holding a lock, the Extension Host automatically releases it.

4. **File scope isolation**: Each worker in a squad declares its `files` scope (glob patterns). The `ContextScoper` and `MCPToolHandler` enforce that workers can only read/write within their declared scope. This prevents the `implementer` from modifying test files and vice versa.

5. **Squad completion logic**: The phase transitions to `EVALUATING` only when ALL workers in the squad have exited. If any worker fails, the entire squad is aborted (fail-fast), and the phase is marked as failed with the failing worker's output.

6. **Max squad size**: Capped at 4 workers per squad (matching the existing max concurrency). Squads count against the global concurrency limit — a 3-worker squad + a 1-worker phase = 4 total, hitting the cap.

### Rationale

The motivating scenario is a large refactoring where implementation, tests, and documentation can be written in parallel by specialized workers. Without coordination, concurrent file access causes race conditions (two workers modifying the same file). The Pub/Sub + Mutex model was chosen over direct worker-to-worker IPC because workers are ephemeral child processes with no ability to discover or connect to each other. The Extension Host is the natural coordination point — it already manages the workers' lifecycle.

### Pros

- **Wall-clock time reduction**: A phase that takes 5 minutes sequentially (implement + test + docs) can complete in ~2 minutes with 3 concurrent workers.
- **Specialization within a phase**: Each squad member has a domain-specific system prompt and file scope, reducing context pollution.
- **No direct worker-to-worker coupling**: Workers are unaware of each other. The broker pattern means adding or removing squad members requires no changes to worker implementations.
- **Deadlock prevention**: The 60-second lock timeout and automatic release on worker exit guarantee liveness.

### Cons / Risks

- **Coordination overhead**: The Pub/Sub and file-lock tools add IPC round-trips that slow individual workers. Each lock acquisition is a synchronous MCP tool call.
- **LLM tool-use reliability**: Workers must correctly use `file_lock` and `squad_publish` tools. LLMs sometimes skip tool calls or call them with wrong arguments. A worker that writes without acquiring a lock defeats the coordination model. Mitigation: the `MCPToolHandler` can enforce lock-before-write by rejecting `submit_phase_handoff` calls that include `modified_files` not covered by an active lock.
- **Stall detection complexity**: V1's stall watchdog (30s) assumes one worker per phase. With squads, a stall could be caused by one worker waiting for a lock held by a slower worker — a legitimate coordination delay, not a stall. The watchdog needs squad-aware heuristics.
- **Resource consumption**: 4 concurrent LLM workers consume significant API tokens and compute. For expensive models, a 4-worker squad on a single phase could cost 4× what a sequential execution costs, for marginal wall-clock savings.
- **Merge conflicts within a squad**: Even with file-scope isolation, workers may declare overlapping glob patterns (e.g., `src/auth/` and `src/auth/middleware.ts`). The lock manager handles write conflicts, but `ContextScoper` must also prevent overlapping read scopes from causing token budget bloat (reading the same file in multiple workers' contexts).
- **Cognitive complexity**: This is the most complex feature in V2. The interaction between Squads, Review Loops, and the existing DAG scheduler creates a combinatorial explosion of states. A squad phase with review loops on each squad member would spawn up to `4 workers × 3 iterations × 2 roles (engineer + reviewer) = 24 worker sessions` for a single phase. This must be explicitly forbidden or carefully gated.

---

## Cross-Cutting Concerns

### FSM State Count

V1: 9 states. V2 additions:

| Feature | New States | Notes |
|---|---|---|
| Review Loops | `REVIEWING`, `REVIEW_EVALUATION` | Phase-scoped sub-states |
| Squads | None | Reuses `EXECUTING_WORKER` with squad-aware semantics |
| Queue | None | Queue processing happens in `IDLE`; active execution uses existing states |

**V2 total: 11 states**. The transition matrix must be updated and all new transitions unit-tested.

### Migration Strategy

All V2 features are additive — no V1 schema fields are removed. The migration path:

1. **Database migration**: On first V2 activation, detect the old `ArtifactDB` (sql.js blob) and `StateManager` files. Run a one-time migration script that reads old data and inserts into the new SQLite schema. Rename old files to `.v1-backup` for safety.
2. **Runbook compatibility**: V1 runbooks without `review`, `squad`, or `workspace_folder` fields work identically under V2 (defaults to V1 behavior).
3. **Feature flags**: All V2 features are behind `coogent.v2.*` settings, defaulting to `false` for the initial release. This allows staged rollout and quick disable if issues arise.

### Observability

V2 extends the existing JSONL telemetry (`engine.jsonl`) with:

- **Routing decisions**: Worker ID, candidate scores, input skills
- **Queue events**: Enqueue, dequeue, start, complete, fail
- **Review loop iterations**: Engineer output hash, reviewer feedback summary, iteration count
- **Squad coordination**: Lock acquisitions, releases, timeouts, pub/sub message counts
- **Token budgets**: Per-phase actual vs. budgeted tokens (including handoff context)

### Testing Strategy

| Feature | Test Type | Coverage Target |
|---|---|---|
| SQLite Persistence | Unit (better-sqlite3 in-memory) | Schema DDL, CRUD, WAL replay, migration |
| AST Context | Unit (fixture files) | TS/JS/Python/Go/CSS resolver, cache invalidation |
| Svelte 5 Webview | Component (Vitest + @testing-library/svelte) | Per-phase atoms, batch processing, virtual scroll |
| Evaluators | Unit + Integration | Each built-in evaluator, custom evaluator sandbox |
| Multi-Root | Integration (VS Code Test Runner) | Cross-folder DAG, Git branching per folder |
| Queue | Unit + Integration | FIFO ordering, priority, schedule, crash recovery |
| Worker Routing | Unit | Weighted Jaccard, tie-breaking, telemetry |
| Review Loops | Integration | Full Maker-Checker 3-iteration cycle, circuit breaker |
| Squads | Integration | Pub/Sub delivery, Mutex lifecycle, stall detection |

---

## Implementation Priority (Recommended)

| Phase | Features | Rationale |
|---|---|---|
| **P0 (Foundation)** | 1 (SQLite), 2 (AST Context) | All other features depend on unified persistence and reliable context |
| **P1 (Core UX)** | 3 (Svelte 5 hardening), 4 (Evaluators), 7 (Worker Routing) | Immediate quality-of-life improvements for existing users |
| **P2 (Autonomy)** | 6 (Queue), 8 (Review Loops) | Enables unattended execution — the primary V2 value proposition |
| **P3 (Scale)** | 5 (Multi-Root), 9 (Squads) | Highest complexity, highest risk. Ship only after P0–P2 are stable |

---

*End of V2 Architectural Handoff.*
