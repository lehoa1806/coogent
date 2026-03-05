# Coogent User Guide

> **Audience**: Developers using the Coogent extension in Antigravity IDE.

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

### 4. Load or Create a Runbook

Place `.task-runbook.json` in the workspace root, or load one via the Mission Control UI.

### 5. Start Execution

Click **Start** — the engine handles the rest.

---

## Writing a Runbook

A runbook is a JSON file defining a sequence of micro-tasks. Place it at your workspace root as `.task-runbook.json`.

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

---

## Schema Reference

### Runbook Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `project_id` | `string` | ✅ | Unique identifier for this run |
| `status` | `string` | ✅ | `idle`, `running`, `paused_error`, or `completed` |
| `current_phase` | `integer` | ✅ | Index of active/next phase |
| `phases` | `array` | ✅ | Array of phase objects (min 1) |

### Phase Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | `integer` | ✅ | Unique phase identifier |
| `status` | `string` | ✅ | `pending`, `running`, `completed`, or `failed` |
| `prompt` | `string` | ✅ | Instruction injected into the worker agent |
| `context_files` | `string[]` | ✅ | Files to inject (relative to workspace root) |
| `success_criteria` | `string` | ✅ | How to verify success (see Evaluators below) |
| `depends_on` | `integer[]` | ❌ | Phase IDs that must complete first (enables DAG mode) |
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

## Settings

Configure via **Settings** → **Extensions** → **Coogent**, or in `settings.json`:

| Setting | Default | Description |
|---|---|---|
| `coogent.tokenLimit` | `100000` | Max tokens per phase context injection |
| `coogent.workerTimeoutMs` | `300000` | Worker timeout (5 min default) |
| `coogent.maxRetries` | `3` | Default auto-retry count |
| `coogent.logDirectory` | `.coogent/logs` | Session log directory |

---

## Execution Lifecycle

```
User clicks Start
       │
       ▼
1. Load & validate runbook (AJV schema check)
2. For each ready phase:
   a. Resolve context files (AST auto-discovery if imports detected)
   b. Assemble token-counted payload (prune if over budget)
   c. Spawn ephemeral worker agent (zero context, scoped injection)
   d. Stream stdout/stderr to Mission Control
   e. On exit: evaluate success criteria
   f. On pass: Git checkpoint → advance to next phase(s)
   g. On fail: Self-healing retry (if retries remain) → or ERROR_PAUSED
3. All phases complete → COMPLETED state
```

### Crash Recovery

If the IDE crashes mid-execution:
- On restart, the extension detects the write-ahead log (WAL)
- Replays the WAL to restore the last known state
- Cleans stale lockfiles (PID-checked)
- Transitions to `ERROR_PAUSED` — review state before continuing

### Self-Healing

When a phase fails and `max_retries > 0`:
1. Stderr from the failure is captured
2. An augmented prompt is built: original prompt + error context
3. After exponential backoff delay, a fresh worker retries
4. If all retries exhaust: pauses for user decision

---

## Commands

| Command | Description |
|---|---|
| `Coogent: Open Mission Control` | Open the Mission Control dashboard |

### Mission Control Actions

| Button | Action |
|---|---|
| **Start** | Begin (or resume) execution |
| **Pause** | Halt after current phase completes |
| **Abort** | Stop execution, return to IDLE |
| **Retry** | Retry a failed phase |
| **Skip** | Skip a failed phase, advance to next |
| **Edit** | Modify phase prompt/files/criteria before execution |

---

## Logs & Debugging

Session logs are written as JSONL to `<workspace>/.coogent/logs/`:

```
session_<timestamp>.jsonl
```

Each line is a JSON object with:
```json
{"timestamp": 1709456789000, "level": "info", "event": "state_changed", "data": {...}}
```

View live output in the **Mission Control** dashboard's output panel.

---

## Tips

- **Keep phases atomic** — one clear task per phase. If a prompt is doing 2 things, split it.
- **Scope context tightly** — only inject files the worker actually needs. Less context = better output.
- **Use `depends_on`** for independent work — parallel execution saves time.
- **Set `max_retries: 2`** for phases with external toolchain checks — compiler errors often self-resolve on retry.
- **Review the sample** — see `examples/sample.task-runbook.json` for a working example.
