# Architecture & Technical Design

> Coogent system internals: FSM engine, DAG scheduling, MCP server, persistence, and tech stack.

---

## Table of Contents

1. [System Architecture](#system-architecture)
2. [Finite State Machine (Engine)](#finite-state-machine-engine)
3. [DAG-Aware Parallel Scheduling](#dag-aware-parallel-scheduling)
4. [In-Process MCP Server](#in-process-mcp-server)
5. [Context Diffusion Pipeline](#context-diffusion-pipeline)
6. [Persistence & Crash Recovery](#persistence--crash-recovery)
7. [Git Sandboxing](#git-sandboxing)
8. [Tech Stack](#tech-stack)

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
│  │  (writable)   │  │  (factory)  │  │  PlanReview, PhaseDetails,    │  │
│  │               │  │             │  │  PhaseHeader, PhaseActions,   │  │
│  │               │  │             │  │  PhaseHandoff, Terminal, ...   │  │
│  └──────────────┘  └─────────────┘  └───────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

### Component Wiring (Decomposed Architecture)

`extension.ts` (~270 lines) delegates to four extracted modules:

- **`ServiceContainer`** — Typed registry holding all service instances (replaces 18 module-level `let` variables)
- **`CommandRegistry`** — Registers all 14 VS Code commands via `registerAll()`
- **`EngineWiring`** — Connects Engine ↔ ADK ↔ MCP ↔ Consolidation events
- **`PlannerWiring`** — Connects PlannerAgent ↔ Engine events

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

### Transition Events

`PLAN`, `PLAN_READY`, `APPROVE`, `PARSE_OK`, `START`, `WORKER_EXITED`, `EVALUATE_OK`, `EVALUATE_FAIL`, `RETRY`, `ABORT`, `RESET`

### State Transition Diagram

```
IDLE ──PLAN──► PLANNING ──PLAN_READY──► PLAN_REVIEW ──APPROVE──► PARSING
                                                                     │
                                                                 PARSE_OK
                                                                     │
COMPLETED ◄──EVALUATE_OK── EVALUATING ◄──WORKER_EXITED── EXECUTING_WORKER ◄──START── READY
                              │                                  ▲       │
                         EVALUATE_FAIL                           │       │
                              │                            (frontier     │
                              ▼                             dispatch)    │
                        ERROR_PAUSED ──RETRY──► READY ───────────────────┘
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

- **Durability**: Database file (`artifacts.db`) stored at the workspace `.coogent/` root for cross-session access
- **Schema**: Tasks table (masterTaskId, summary, implementationPlan, consolidationReport) + Phases table (phaseId, handoff data)
- **In-Memory Cache**: Reads are served from an in-memory `sql.js` instance; writes flush to disk via `db.export()`

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
- **Secrets Detection**: `SecretsGuard` scans file content for API keys, private keys, `.env` patterns, and high-entropy strings (Shannon entropy > 4.5). Findings are logged as warnings (non-blocking)
- **Formatting**: Each file wrapped in `<<<FILE: path>>>\n{content}\n<<<END FILE>>>`
- **Budget Enforcement**: If assembled payload exceeds `coogent.tokenLimit`, execution halts with user notification
- **Output Batching**: Worker output streams through `OutputBufferRegistry` (100ms timer / 4KB buffer) to prevent IPC channel saturation

### Tokenizers

| Version | Tokenizer | Method |
|---|---|---|
| V1 (current, default) | `TiktokenEncoder` | Model-accurate via `js-tiktoken` WASM (`cl100k_base`), lazy-initialized |
| V1 (fallback) | `CharRatioEncoder` | Fast, dependency-free (~4 chars/token) — used if tiktoken init fails |

---

## Persistence & Crash Recovery

### Write-Ahead Log (WAL) Pattern

Every mutation follows this sequence (within `.coogent/ipc/<session-id>/`):

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

## Tech Stack

| Layer | Technology |
|---|---|
| Language | TypeScript 5.4 (strict mode) |
| Runtime | Node.js 18+ (VS Code Extension Host) |
| IDE | Antigravity IDE / VS Code ≥ 1.85 |
| MCP | `@modelcontextprotocol/sdk` ^1.27 |
| Persistence | `sql.js` (SQLite WASM) via `ArtifactDB` |
| Tokenizer | `js-tiktoken` (`cl100k_base`) with `CharRatioEncoder` fallback |
| Schema Validation | AJV ^8.18 (inlined) |
| Markdown | `marked` ^17.0 |
| Diagrams | `mermaid` ^11.12 |
| UI | Svelte 5 + Vite |
| Bundler (Host) | esbuild ^0.20 |
| Testing | Jest ^29.7 + ts-jest |

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
