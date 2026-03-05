# Coogent — Technical Architecture

## System Overview

Coogent implements an **Event-Driven Master-Worker** architecture inside the Antigravity IDE (VS Code fork). The system is composed of the following decoupled subsystems:

| Component | Process | Responsibility |
|---|---|---|
| **Extension Host** | Node.js (VS Code Extension API) | Business logic: state machine, runbook I/O, agent lifecycle, logging |
| **Webview Panel** | Sandboxed iframe | Mission Control UI — pure state projection, sends commands via `postMessage` |
| **ADK Controller** | Extension Host | Adapter over the Antigravity ADK — spawns/terminates ephemeral worker agents (parallel pool) |
| **Scheduler** | Extension Host | DAG-aware phase scheduler with topological ordering and concurrency limits |
| **Evaluator Registry** | Extension Host | Pluggable success evaluation: exit code, regex, toolchain commands, test suites |
| **Self-Healing Controller** | Extension Host | Auto-retry on failure with exponential backoff and error-injected prompts |
| **Git Manager** | Extension Host | Automated snapshot commits, clean-room rollback, stash/unstash |
| **File System Watcher** | Extension Host | Monitors `.task-runbook.json` for external edits, triggers re-parsing |

### Boundary Rules

- The **Webview** is a read-only projection. It never mutates the runbook or spawns agents directly.
- All user commands are validated by the Extension Host before execution.
- The Extension Host is the **single source of truth** for execution state.

---

## State Machine

The Engine implements a deterministic finite state machine with 7 states:

```
                        ┌──────────┐
              ┌────────►│   Idle   │◄───────────────────────┐
              │         └────┬─────┘                        │
              │  RESET       │ LOAD_RUNBOOK                 │ ABORT
              │              ▼                              │
              │         ┌──────────┐                        │
              │         │ Parsing  │                        │
              │         └──┬───┬───┘                        │
              │   PARSE_OK │   │ PARSE_FAIL                 │
              │            ▼   └────► (back to Idle)        │
              │         ┌──────────┐                        │
              │         │  Ready   │◄────── SKIP_PHASE ─────┤
              │         └────┬─────┘                        │
              │    START     │                              │
              │              ▼                              │
         ┌────┴────┐   ┌───────────────┐                   │
         │Completed│◄──│Executing_Worker│──── TIMEOUT ─────►│
         └─────────┘   └──────┬────────┘    CRASH          │
         ALL_PHASES_PASS      │ WORKER_EXITED          ┌───┴───────┐
                              ▼                        │Error_Paused│
                         ┌───────────┐                 └───┬───────┘
                         │ Evaluating│──── PHASE_FAIL ─────┘
                         └─────┬─────┘     RETRY ──────────►(Executing_Worker)
                               │ PHASE_PASS
                               └──────────►(Executing_Worker)  [next phase]
```

### States

| State | Description |
|---|---|
| `IDLE` | No runbook loaded. Waiting for user action. |
| `PARSING` | Validating `.task-runbook.json` schema and checking file existence. |
| `READY` | Runbook parsed. Awaiting `START` command. |
| `EXECUTING_WORKER` | A worker agent is alive and processing the current phase. |
| `EVALUATING` | Worker exited. Checking `success_criteria`. |
| `ERROR_PAUSED` | Phase failed or worker crashed. Halted for user decision. |
| `COMPLETED` | All phases passed. Terminal state. |

---

## Persistence Strategy

### Runbook File: `.task-runbook.json`

The runbook is the system's single source of truth. Schema:

```json
{
  "project_id": "uuid",
  "status": "idle | running | paused_error | completed",
  "current_phase": 0,
  "phases": [
    {
      "id": 0,
      "status": "pending | running | completed | failed",
      "prompt": "Implement the user authentication module",
      "context_files": ["src/auth/handler.ts", "src/types/user.ts"],
      "success_criteria": "exit_code:0"
    }
  ]
}
```

### Write Safety: WAL + Atomic Rename

To prevent corruption from IDE crashes mid-write:

1. **Write WAL** — Serialize the intended state to `.coogent/ipc/<id>/.wal.json`
2. **Atomic write** — Write to `.task-runbook.json.tmp`, then `rename()` over the real file
3. **Clear WAL** — Delete the WAL file

On restart: if WAL exists, recover from it (the last write was interrupted).

### Concurrency: File Locking

All reads/writes to the runbook are serialized through a `StateManager` singleton that acquires a POSIX `flock` (exclusive lock) before any mutation. Timeout: 5 seconds.

---

## IPC Message Contract

All communication between Webview and Extension Host uses typed `postMessage` payloads with a `type` discriminator.

### Extension Host → Webview (State Projections)

| Message Type | Payload | Description |
|---|---|---|
| `STATE_SNAPSHOT` | `RunbookState` | Full runbook state on load or major change |
| `PHASE_STATUS` | `{ phaseId, status, durationMs? }` | Single phase status update |
| `WORKER_OUTPUT` | `{ phaseId, stream, chunk }` | Live stdout/stderr from the active worker |
| `TOKEN_BUDGET` | `{ phaseId, breakdown, total, limit }` | Per-file token counts before execution |
| `ERROR` | `{ code, message, phaseId? }` | Error notification |

### Webview → Extension Host (User Commands)

| Message Type | Payload | Description |
|---|---|---|
| `CMD_START` | — | Begin execution from current phase |
| `CMD_PAUSE` | — | Pause after current phase completes |
| `CMD_ABORT` | — | Terminate active worker, halt execution |
| `CMD_RETRY` | `{ phaseId }` | Retry a failed phase |
| `CMD_SKIP_PHASE` | `{ phaseId }` | Skip a failed phase, advance |
| `CMD_EDIT_PHASE` | `{ phaseId, patch }` | Update phase prompt/files before execution |
| `CMD_LOAD_RUNBOOK` | `{ filePath }` | Load a runbook from disk |
| `CMD_REQUEST_STATE` | — | Request a full state snapshot |

---

## Agent Lifecycle (ADK Integration)

Each phase triggers a 7-step deterministic lifecycle:

```
Init → Scope Context → Token Check → Spawn Worker → Inject Payload → Monitor → Evaluate → Terminate
```

### Context Scoper (with Pillar 2 Extensions)

Before spawning a worker, the Context Scoper:

1. **Resolves files** via a pluggable `FileResolver` interface:
   - `ExplicitFileResolver` (V1) — uses the `context_files` array directly.
   - `ASTFileResolver` (V2) — crawls import/require/include statements recursively from `context_files`, with cycle detection and configurable depth limits.
2. Validates each file exists and is not binary.
3. Reads file contents and calculates token count (via `CharRatioEncoder` or pluggable `TokenEncoder`).
4. **Prunes via `TokenPruner`** if total exceeds the configured `TOKEN_LIMIT`:
   - Strategy 1: Drop discovered (non-explicit) files, largest first.
   - Strategy 2: Strip function/method bodies (brace-counting heuristic).
   - Strategy 3: Proportional truncation of remaining large files.
5. Assembles a delimited payload:
   ```
   <<<FILE: src/auth/handler.ts>>>
   [file content]
   <<<END FILE>>>
   ```

If pruning still cannot bring the payload under budget, execution halts with a `TOKEN_BUDGET` error.

### Worker Isolation

Workers are spawned with:
- **`ephemeral: true`** — No conversation history, no prior file access
- **Scoped injection** — Only the assembled file payload + phase prompt
- **Timeout** — Default 5 minutes, configurable per phase
- **Output streaming** — stdout/stderr piped to the Extension Host in real-time
- **Parallel pool** — Up to `MAX_CONCURRENT_WORKERS` (default 4) can run simultaneously for DAG phases

### Process Registry

The ADK Controller maintains a `Map<phaseId, WorkerHandle>` of active workers and their PIDs. On extension deactivation, all workers are force-terminated via `terminateAll()`. On activation, stale PID files from `.coogent/pid/` are cleaned up.

---

## Success Evaluation (Pillar 3)

After a worker exits, the `EvaluatorRegistry` determines phase success:

| Evaluator | Trigger | Behavior |
|---|---|---|
| `ExitCodeEvaluator` | Default | Pass if exit code = 0 |
| `RegexEvaluator` | `success_criteria: "regex:pattern"` | Pass if stdout matches pattern |
| `ToolchainEvaluator` | `evaluator: { type: "toolchain", ... }` | Runs a shell command (e.g., `make test`) and checks exit code |
| `TestSuiteEvaluator` | `evaluator: { type: "test_suite", ... }` | Runs test command and parses pass/fail counts |

### Self-Healing

If evaluation fails and `max_retries > 0`:
1. `SelfHealingController.recordFailure()` logs the attempt.
2. If retries remain: builds an augmented prompt injecting stderr context → emits `phase:heal` → worker re-spawns after exponential backoff delay.
3. If retries exhausted: transitions to `ERROR_PAUSED`.

### Git Checkpoints

On each phase success, `extension.ts` intercepts the `phase:checkpoint` event and calls `GitManager.snapshotCommit()`. On failure, `GitManager.rollback()` resets to the last clean state.

---

## Directory Layout

```
coogent/
├── README.md
├── docs/
│   ├── PRD.md
│   ├── ARCHITECTURE.md
│   ├── TDD.md
│   └── IMPLEMENTATION_PLAN.md
├── schemas/
│   └── runbook.schema.json        # AJV-validated JSON Schema
├── package.json
├── tsconfig.json
├── esbuild.js
├── .gitignore
├── src/
│   ├── extension.ts               # activate/deactivate + event wiring
│   ├── types/
│   │   └── index.ts               # All TypeScript interfaces
│   ├── state/
│   │   └── StateManager.ts        # Runbook I/O, locking, WAL
│   ├── engine/
│   │   ├── Engine.ts  # 7-state FSM
│   │   ├── Scheduler.ts           # DAG scheduler (Pillar 2)
│   │   └── SelfHealing.ts         # Auto-retry controller (Pillar 3)
│   ├── adk/
│   │   ├── ADKController.ts       # Parallel worker pool
│   │   └── OutputBuffer.ts        # 100ms batched stream flush
│   ├── context/
│   │   ├── ContextScoper.ts       # File reading + tokenization
│   │   ├── FileResolver.ts        # AST auto-discovery (Pillar 2)
│   │   └── TokenPruner.ts         # Heuristic token pruning (Pillar 2)
│   ├── evaluators/
│   │   └── CompilerEvaluator.ts   # Pluggable success evaluators (Pillar 3)
│   ├── git/
│   │   └── GitManager.ts          # Snapshot commits & rollback (Pillar 3)
│   ├── logger/
│   │   └── TelemetryLogger.ts     # Append-only JSONL session logging
│   └── webview/
│       └── MissionControlPanel.ts # Webview lifecycle + IPC bridge
├── webview-ui/
│   ├── index.html
│   ├── app.js
│   └── styles.css
└── .coogent/                # All runtime state (gitignored)
    ├── ipc/<id>/                   # Session-scoped runbook + WAL + lock
    ├── logs/                       # JSONL session logs
    └── pid/                        # PID files for orphan recovery
```

---

## Extensibility Hooks

The architecture is designed for incremental capability upgrades via pluggable interfaces:

| Extension Point | V1 (Pillar 1) | V2 (Pillars 2 & 3) — ✅ Implemented |
|---|---|---|
| Phase scheduling | Sequential (`current_phase++`) | DAG with `depends_on` field via `Scheduler` |
| File resolution | Explicit `context_files` array | AST auto-discovery via `ASTFileResolver` (regex-based; `tree-sitter` upgrade path) |
| Token management | Hard limit with error halt | 3-tier pruning via `TokenPruner` |
| Success evaluation | Exit code check | Pluggable `EvaluatorRegistry` (exit code, regex, toolchain, test suite) |
| Worker concurrency | Single active worker | Concurrent pool (`Map<phaseId, WorkerHandle>`, max 4) |
| Retry strategy | Manual user action | `SelfHealingController` with exponential backoff + error-injected prompts |
| Version control | None | `GitManager` with snapshot commits, rollback, and stash |
