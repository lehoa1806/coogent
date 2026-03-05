# Coogent User Guide

> **Audience**: Developers using the Coogent extension in the Antigravity IDE.

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [The Mission Control UI](#the-mission-control-ui)
3. [The Plan & Review Workflow](#the-plan--review-workflow)
4. [Monitoring DAG Execution](#monitoring-dag-execution)
5. [Session History](#session-history)
6. [Writing a Runbook](#writing-a-runbook)
7. [Settings & Configuration](#settings--configuration)
8. [Logs & Debugging](#logs--debugging)
9. [Tips & Best Practices](#tips--best-practices)

---

## Quick Start

### 1. Install & Build

```bash
git clone <repo-url> coogent && cd coogent
npm install
npm run build
```

### 2. Launch

Press **F5** in the IDE (or `npm run watch` + Launch Extension from Debug panel).

### 3. Open Mission Control

`Cmd+Shift+P` → **Coogent: Open Mission Control**

### 4. Enter Your Goal

Type a high-level implementation prompt and press **Submit**. The Planner Agent generates a multi-phase runbook for your approval.

### 5. Approve & Execute

Review the plan, click **Approve**, then **Start** — the engine handles the rest.

---

## The Mission Control UI

The Mission Control dashboard is organized into **6 visual zones**, each with a distinct responsibility:

### Zone 1: Global Controls (Top Bar)

| Element | Purpose |
|---|---|
| **New Chat** button | Reset the engine to `IDLE`, clear the current session, and start fresh |
| **Session History** drawer | Browse, search, and reload past sessions |
| **Conversation Mode** toggle | Switch between `isolated` (default), `continuous`, or `smart` context modes |

The global controls are always visible regardless of engine state.

### Zone 2: Master Task (Prompt Area)

The central prompt input area where you enter your high-level implementation goal.

| State | Behavior |
|---|---|
| `IDLE` | Text input is enabled. Type your prompt and click **Submit** |
| `PLANNING` | Spinner shows "Generating plan…" while the Planner Agent works |
| `PLAN_REVIEW` | Prompt area is disabled — focus shifts to the Plan Review zone |
| `EXECUTING` | Shows the project summary from the runbook |
| `COMPLETED` | Shows final status with the consolidation report |

### Zone 3: Phase Navigator (Left Sidebar)

A vertical list of all phases in the runbook, each with a status indicator:

| Icon | Status | Meaning |
|---|---|---|
| ⏳ | `pending` | Waiting for dependencies or turn |
| 🔄 | `running` | Worker agent is actively executing |
| ✅ | `completed` | Phase passed evaluation |
| ❌ | `failed` | Phase failed after all retries |

**Click any phase** to view its details in Zone 4. Phases with `depends_on` relationships display as a visual DAG — independent phases appear at the same level.

### Zone 4: Phase Details (Main Content)

When a phase is selected in the Navigator, this zone shows:

| Section | Content |
|---|---|
| **Phase Prompt** | The exact instruction that will be injected into the worker agent |
| **Context Files** | List of files scoped for this phase (with token counts) |
| **Success Criteria** | How the phase will be evaluated (`exit_code:0`, `regex:...`, etc.) |
| **Dependencies** | Which phases must complete before this one starts |
| **Live Output** | Real-time stdout/stderr streaming from the active worker |
| **Duration** | Elapsed time for the active or completed phase |

### Zone 5: Action Bar (Bottom Controls)

Context-sensitive buttons that change based on engine state:

| State | Available Actions |
|---|---|
| `IDLE` | — (use the prompt area) |
| `PLAN_REVIEW` | **Approve**, **Reject** (with feedback), **Edit Draft** |
| `READY` | **Start** |
| `EXECUTING_WORKER` | **Abort** |
| `ERROR_PAUSED` | **Retry**, **Skip Phase**, **Abort** |
| `COMPLETED` | **View Report**, **View Plan**, **Review Diff**, **New Chat** |

### Zone 6: Consolidation Report (Post-Execution)

After all phases complete, the Consolidation Agent aggregates:

- **Phase Results** — status, decisions, and modified files per phase
- **All Modified Files** — complete list of files touched across all phases
- **All Decisions** — architectural and implementation decisions made by workers
- **Unresolved Issues** — any flagged concerns from phase handoffs

The report is saved as `consolidation-report.md` in the session directory and rendered as formatted Markdown in the UI.

---

## The Plan & Review Workflow

Coogent uses a **"Plan & Review" gate** to ensure the AI's decomposition strategy is sound before committing execution resources.

### Step 1: Submit Your Prompt

Enter a high-level goal in the Master Task area. Example:

```
Add JWT authentication to the Express API: middleware, login/register endpoints,
password hashing with bcrypt, and protected route guards.
```

### Step 2: Planner Agent Generates the Runbook

The engine transitions to `PLANNING` state. The Planner Agent:

1. Scans your workspace file tree
2. Analyzes the codebase structure
3. Decomposes the goal into sequential/parallel micro-tasks
4. Assigns context files, success criteria, and dependencies to each phase
5. Generates a `.task-runbook.json` and an `implementation_plan.md`

### Step 3: Review the Plan

The engine transitions to `PLAN_REVIEW` state. You see:

- **Implementation Plan** — A detailed Markdown document describing the approach, architecture decisions, and phase-by-phase walkthrough
- **Phase List** — Each phase with its prompt, context files, evaluator type, and dependency graph
- **File Tree** — Which workspace files the planner identified as relevant

### Step 4: Approve, Reject, or Edit

| Action | What Happens |
|---|---|
| **Approve** | Engine transitions to `PARSING` → `READY` → auto-starts execution |
| **Reject** (with feedback) | Engine returns to `PLANNING`. The Planner re-generates with your feedback injected as constraints |
| **Edit Draft** | Modify phase prompts, context files, or dependencies directly in the UI before approving |

### Step 5: Git Sandbox Setup

Before execution begins, the engine performs a **pre-flight check**:

1. Verifies the Git working tree is clean (no uncommitted changes)
2. Records your current branch name
3. Creates a sandbox branch: `coogent/<sanitized-task-slug>`
4. Checks out the sandbox branch

> **If the working tree is dirty**, execution is blocked with a `GIT_DIRTY` error. Commit or stash your changes first.

### Step 6: Monitor Execution

See [Monitoring DAG Execution](#monitoring-dag-execution) below.

### Step 7: Review the Git Diff

When all phases complete:

1. The engine transitions to `COMPLETED`
2. Click **Review Diff** to open the VS Code Source Control panel
3. The native Git diff shows all changes made by AI workers on the `coogent/*` branch vs. your original branch
4. Merge, cherry-pick, or discard as needed using standard Git workflows

---

## Monitoring DAG Execution

### Sequential vs. Parallel Phases

| Mode | Trigger | Behavior |
|---|---|---|
| **Sequential** | No `depends_on` fields | Phases execute in array order, one at a time |
| **DAG (Parallel)** | Any phase has `depends_on` | Independent phases run concurrently (up to `MAX_CONCURRENT_WORKERS`, default 4) |

### Tracking Progress

During execution:

- The **Phase Navigator** (Zone 3) updates in real-time as phases transition through `pending → running → completed/failed`
- Click any phase to see its **Live Output** in Phase Details
- Each completed phase receives a Git snapshot commit: `coogent: auto-checkpoint phase <id>`

### Self-Healing Retries

If a phase fails and `max_retries > 0`:

1. The engine captures stderr from the failure
2. Builds an augmented prompt: original instruction + error context
3. After exponential backoff delay (2s → 4s → 8s…), spawns a fresh worker
4. If all retries exhaust → `ERROR_PAUSED` state

### Handling Errors

When execution pauses on error:

| Action | Effect |
|---|---|
| **Retry** | Re-spawn the worker with the same prompt (or augmented prompt if self-healing) |
| **Skip** | Mark the phase as skipped, advance to the next ready phase |
| **Abort** | Terminate all workers, return to `IDLE` |

---

## Session History

Coogent persists every session in `.coogent/ipc/<YYYYMMDD-HHMMSS-uuid>/`.

### Browsing Past Sessions

1. Click the **Session History** button in the Global Controls
2. Browse sessions sorted by most recent first
3. Each session shows: project ID, phase count, completion status, first prompt

### Searching Sessions

Use the search bar to filter sessions by project ID or phase prompt text (case-insensitive).

### Loading a Past Session

Click any session to reload its runbook state into Mission Control. The engine transitions to the session's last known state.

### Session Pruning

Sessions beyond the configured maximum are automatically pruned (oldest first) to prevent disk bloat.

---

## Writing a Runbook

A runbook is a JSON file defining a sequence of micro-tasks. You can create one manually or let the Planner Agent generate it.

### Minimal Example (Sequential)

```json
{
  "project_id": "my-feature",
  "status": "idle",
  "current_phase": 0,
  "phases": [
    {
      "id": 0,
      "status": "pending",
      "prompt": "Create src/models/User.ts with a TypeScript interface.",
      "context_files": [],
      "success_criteria": "exit_code:0"
    },
    {
      "id": 1,
      "status": "pending",
      "prompt": "Create src/services/UserService.ts implementing CRUD.",
      "context_files": ["src/models/User.ts"],
      "success_criteria": "exit_code:0"
    }
  ]
}
```

### DAG Example (Parallel Execution)

Use `depends_on` to define dependencies. Independent phases run in parallel:

```json
{
  "project_id": "parallel-build",
  "status": "idle",
  "current_phase": 0,
  "phases": [
    {
      "id": 0,
      "status": "pending",
      "prompt": "Create shared data models.",
      "context_files": [],
      "success_criteria": "exit_code:0"
    },
    {
      "id": 1,
      "status": "pending",
      "prompt": "Build the API layer using the data models.",
      "context_files": ["src/models/index.ts"],
      "success_criteria": "exit_code:0",
      "depends_on": [0]
    },
    {
      "id": 2,
      "status": "pending",
      "prompt": "Build the CLI tool using the data models.",
      "context_files": ["src/models/index.ts"],
      "success_criteria": "exit_code:0",
      "depends_on": [0]
    },
    {
      "id": 3,
      "status": "pending",
      "prompt": "Write integration tests covering API and CLI.",
      "context_files": ["src/api/index.ts", "src/cli/index.ts"],
      "success_criteria": "exit_code:0",
      "depends_on": [1, 2]
    }
  ]
}
```

Phases 1 and 2 run in parallel (both depend only on 0). Phase 3 waits for both.

### Phase Fields Reference

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | `integer` | ✅ | Unique phase identifier |
| `status` | `string` | ✅ | `pending`, `running`, `completed`, or `failed` |
| `prompt` | `string` | ✅ | Instruction injected into the worker agent |
| `context_files` | `string[]` | ✅ | Files to inject (relative to workspace root) |
| `success_criteria` | `string` | ✅ | How to verify success (see Evaluators below) |
| `depends_on` | `integer[]` | ❌ | Phase IDs that must complete first (enables DAG mode) |
| `context_summary` | `string` | ❌ | Semantic summary for downstream phase handoffs |
| `evaluator` | `string` | ❌ | `exit_code` (default), `regex`, `toolchain`, `test_suite` |
| `max_retries` | `integer` | ❌ | Auto-retry count (default: from settings) |

### Evaluator Types

| Type | `success_criteria` Format | Example |
|---|---|---|
| `exit_code` | `exit_code:<N>` | `"exit_code:0"` |
| `regex` | `regex:<pattern>` | `"regex:BUILD SUCCEEDED"` |
| `toolchain` | `toolchain:<command>` | `"toolchain:npm run build"` |
| `test_suite` | `test_suite:<command>` | `"test_suite:npm test"` |

> **Security**: `toolchain` and `test_suite` evaluators only allow whitelisted binaries: `make`, `npm`, `npx`, `yarn`, `pnpm`, `tsc`, `cargo`, `go`, `python`, `pytest`, `jest`, `xcodebuild`, `swift`, `gradle`, `mvn`.

---

## Settings & Configuration

Configure via **Settings** → **Extensions** → **Coogent**, or in `settings.json`:

| Setting | Default | Description |
|---|---|---|
| `coogent.tokenLimit` | `100000` | Max tokens per phase context injection |
| `coogent.workerTimeoutMs` | `300000` | Worker timeout (5 min default) |
| `coogent.maxRetries` | `3` | Default auto-retry count per phase |
| `coogent.logDirectory` | `.coogent/logs` | Session log directory |

---

## Logs & Debugging

Session logs are written as JSONL to `<workspace>/.coogent/logs/`:

```
session_<timestamp>.jsonl
```

Each line is a JSON object:
```json
{"timestamp": 1709456789000, "level": "info", "event": "state_changed", "data": {...}}
```

View live output in the Mission Control dashboard's Phase Details panel.

### Crash Recovery

If the IDE crashes mid-execution:
- On restart, the extension detects the write-ahead log (WAL)
- Replays the WAL to restore the last known state
- Cleans stale lockfiles (PID-checked)
- Transitions to `ERROR_PAUSED` — review state before continuing

---

## Tips & Best Practices

- **Keep phases atomic** — one clear task per phase. If a prompt is doing 2 things, split it.
- **Scope context tightly** — only inject files the worker actually needs. Less context = better output.
- **Use `depends_on` for independent work** — parallel execution saves significant time.
- **Set `max_retries: 2`** for phases with external toolchain checks — compiler errors often self-resolve on retry.
- **Commit before running** — Coogent requires a clean Git working tree. Always commit or stash first.
- **Review the diff, not the output** — The real value is the native Git diff after execution. Agent output is informational only.
- **Use context_summary** — For long pipelines, add `context_summary` to phases so downstream agents know what previous phases accomplished without needing the raw code.
