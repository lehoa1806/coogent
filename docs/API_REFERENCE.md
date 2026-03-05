# Coogent API Reference

> **Audience**: Extension developers, MCP server integrators, and contributors.

---

## Table of Contents

1. [MCP Resources](#mcp-resources)
2. [MCP Tools](#mcp-tools)
3. [IPC Message Contract](#ipc-message-contract)
4. [Runbook Schema](#runbook-schema)
5. [ADK Integration Contract](#adk-integration-contract)
6. [Module API Reference](#module-api-reference)

---

## MCP Resources

Coogent exposes its internal state as MCP (Model Context Protocol) resources that can be read by agents and tools.

### `coogent://runbook/summary`

Returns a human-readable summary of the current runbook state.

**Response**: Plain text summary including:
- Project ID
- Global status (`idle`, `running`, `paused_error`, `completed`)
- Phase count and current phase index
- Per-phase status breakdown

### `coogent://runbook/full`

Returns the complete `.task-runbook.json` contents as JSON.

**Response**: Full `Runbook` object (see [Runbook Schema](#runbook-schema)).

### `coogent://phases/{id}/handoff`

Returns the handoff report for a completed phase.

**Response** (`HandoffReport`):
```json
{
  "phaseId": 0,
  "status": "completed",
  "decisions": ["Used Zod for validation", "Added input sanitization"],
  "modifiedFiles": ["src/models/User.ts", "src/validation/schema.ts"],
  "summary": "Created User model with TypeScript interface and Zod validation schema.",
  "unresolvedIssues": []
}
```

### `coogent://plan/implementation`

Returns the `implementation_plan.md` content generated during the planning phase.

**Response**: Markdown string with the full implementation plan.

### `coogent://report/consolidation`

Returns the final consolidation report after all phases complete.

**Response**: Markdown-formatted `ConsolidationReport`.

### `coogent://sessions/list`

Returns a list of all past session summaries.

**Response** (`SessionSummary[]`):
```json
[
  {
    "sessionId": "019cbf04-9ee0-7f6d-bc08-f7fec781944a",
    "projectId": "add-auth-module",
    "status": "completed",
    "phaseCount": 4,
    "completedPhases": 4,
    "createdAt": 1709456789000,
    "firstPrompt": "Add JWT authentication..."
  }
]
```

---

## MCP Tools

### `submit_phase_handoff`

Submit a handoff report after completing a phase. Called by the worker agent (or the extension on behalf of the worker).

**Parameters**:
```json
{
  "phaseId": { "type": "integer", "required": true },
  "status": { "type": "string", "enum": ["completed", "failed"], "required": true },
  "decisions": { "type": "string[]", "description": "Key decisions made during execution" },
  "modifiedFiles": { "type": "string[]", "description": "Files created or modified" },
  "summary": { "type": "string", "description": "Semantic summary for downstream phases" },
  "unresolvedIssues": { "type": "string[]", "description": "Open questions or concerns" }
}
```

**Behavior**:
1. Validates the payload structure
2. Writes to `<sessionDir>/handoffs/phase-{id}.json`
3. Updates the phase's `context_summary` field in the runbook
4. Triggers the `phase:handoff` event on the engine

### `get_modified_file_content`

Read the current content of a file modified by a previous phase.

**Parameters**:
```json
{
  "filePath": { "type": "string", "required": true, "description": "Workspace-relative path" }
}
```

**Behavior**:
1. Resolves the absolute path against the workspace root
2. Validates the file exists and is not binary
3. Returns the file content as a string

**Response**:
```json
{
  "content": "// File contents...",
  "tokens": 1234,
  "path": "src/models/User.ts"
}
```

### `get_workspace_file_tree`

Return the file tree of the workspace for planning purposes.

**Parameters**:
```json
{
  "maxDepth": { "type": "integer", "default": 5 },
  "excludePatterns": { "type": "string[]", "default": ["node_modules", ".git", ".coogent"] }
}
```

**Response**: Array of relative file paths.

---

## IPC Message Contract

All communication between the Webview and Extension Host uses typed `postMessage` payloads with a `type` discriminator. Messages are validated at runtime by `ipcValidator.ts`.

### Host → Webview (15 Message Types)

| Type | Payload | Description |
|---|---|---|
| `STATE_SNAPSHOT` | `{ runbook: Runbook, engineState: EngineState }` | Full state projection on load or major change |
| `PHASE_STATUS` | `{ phaseId: PhaseId, status: PhaseStatus, durationMs?: number }` | Single phase status update |
| `WORKER_OUTPUT` | `{ phaseId: PhaseId, stream: 'stdout' \| 'stderr', chunk: string }` | Live stdout/stderr from active worker |
| `PHASE_OUTPUT` | `{ phaseId: PhaseId, stream: 'stdout' \| 'stderr', chunk: string }` | Per-phase output routed to specific detail views |
| `TOKEN_BUDGET` | `{ phaseId: PhaseId, breakdown: FileTokenEntry[], totalTokens: number, limit: number }` | Per-file token counts before execution |
| `ERROR` | `{ code: ErrorCode, message: string, phaseId?: PhaseId }` | Error notification |
| `LOG_ENTRY` | `{ timestamp: UnixTimestampMs, level: 'info' \| 'warn' \| 'error', message: string }` | Log message for Mission Control |
| `PLAN_DRAFT` | `{ draft: Runbook, fileTree: string[] }` | Planner produced a runbook draft |
| `PLAN_STATUS` | `{ status: 'generating' \| 'parsing' \| 'ready' \| 'error' \| 'timeout', message?: string }` | Planning progress updates |
| `PLAN_SUMMARY` | `{ summary: string }` | Planning phase output for the review gate |
| `IMPLEMENTATION_PLAN` | `{ plan: string }` | Markdown content of `implementation_plan.md` |
| `SESSION_LIST` | `{ sessions: SessionSummary[] }` | Recent sessions for the history drawer |
| `SESSION_SEARCH_RESULTS` | `{ query: string, sessions: SessionSummary[] }` | Filtered sessions from search |
| `CONVERSATION_MODE` | `{ mode: ConversationMode, smartSwitchTokenThreshold: number }` | Active conversation mode sync |
| `CONSOLIDATION_REPORT` | `{ report: string }` | Markdown-formatted final report |

### Error Codes

```typescript
type ErrorCode =
  | 'RUNBOOK_NOT_FOUND'
  | 'PARSE_ERROR'
  | 'PHASE_FAILED'
  | 'WORKER_TIMEOUT'
  | 'WORKER_CRASH'
  | 'CYCLE_DETECTED'
  | 'VALIDATION_ERROR'
  | 'CONTEXT_ERROR'
  | 'PLAN_ERROR'
  | 'TOKEN_OVER_BUDGET'
  | 'COMMAND_ERROR'
  | 'GIT_DIRTY'
  | 'UNKNOWN';
```

### Webview → Host (25 Message Types)

| Type | Payload | Description |
|---|---|---|
| `CMD_START` | — | Begin (or resume) execution |
| `CMD_PAUSE` | — | Pause after current phase (deprecated: flag-based) |
| `CMD_ABORT` | — | Terminate active worker, halt execution |
| `CMD_RETRY` | `{ phaseId: PhaseId }` | Retry a failed phase |
| `CMD_SKIP_PHASE` | `{ phaseId: PhaseId }` | Skip a failed phase, advance |
| `CMD_PAUSE_PHASE` | `{ phaseId: PhaseId }` | Pause a specific phase |
| `CMD_STOP_PHASE` | `{ phaseId: PhaseId }` | Stop a specific phase |
| `CMD_RESTART_PHASE` | `{ phaseId: PhaseId }` | Restart a phase from scratch |
| `CMD_EDIT_PHASE` | `{ phaseId: PhaseId, patch: Partial<Phase> }` | Update phase prompt/files/criteria |
| `CMD_LOAD_RUNBOOK` | `{ filePath?: string }` | Load a runbook from disk |
| `CMD_REQUEST_STATE` | — | Request a full state snapshot |
| `CMD_PLAN_REQUEST` | `{ prompt: string, feedback?: string }` | Submit a prompt for runbook generation |
| `CMD_PLAN_APPROVE` | — | Approve the AI-generated plan |
| `CMD_PLAN_REJECT` | `{ feedback: string }` | Reject plan with re-generation feedback |
| `CMD_PLAN_EDIT_DRAFT` | `{ draft: Runbook }` | Edit the draft runbook directly |
| `CMD_PLAN_RETRY_PARSE` | — | Re-parse cached timeout output |
| `CMD_RESET` | — | Full reset (start new chat) |
| `CMD_LIST_SESSIONS` | — | Request list of past sessions |
| `CMD_SEARCH_SESSIONS` | `{ query: string }` | Search past sessions by query |
| `CMD_LOAD_SESSION` | `{ sessionId: string }` | Load a specific past session |
| `CMD_SET_CONVERSATION_MODE` | `{ mode: ConversationMode }` | Set conversation mode |
| `CMD_REQUEST_REPORT` | — | Request consolidation report |
| `CMD_REQUEST_PLAN` | — | Request implementation plan |
| `CMD_DELETE_SESSION` | `{ sessionId: string }` | Delete a session from history |
| `CMD_REVIEW_DIFF` | `{ phaseId: PhaseId }` | Open diff review for a phase |
| `CMD_RESUME_PENDING` | — | Resume all pending phases with satisfied deps |

All incoming messages are runtime-validated by `isValidWebviewMessage()`.

---

## Runbook Schema

The complete JSON Schema for `.task-runbook.json` (validated by AJV at parse time):

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "runbook.schema.json",
  "title": "Coogent Task Runbook",
  "description": "The persistent state file for the Coogent execution engine.",
  "type": "object",
  "required": ["project_id", "status", "current_phase", "phases"],
  "additionalProperties": false,
  "properties": {
    "project_id": {
      "type": "string",
      "minLength": 1,
      "description": "Unique identifier for the execution run."
    },
    "status": {
      "type": "string",
      "enum": ["idle", "running", "paused_error", "completed"],
      "description": "Global execution status."
    },
    "current_phase": {
      "type": "integer",
      "minimum": 0,
      "description": "Index of the currently executing (or next-to-execute) phase."
    },
    "summary": {
      "type": "string",
      "description": "High-level summary of the entire task (generated by the planner)."
    },
    "implementation_plan": {
      "type": "string",
      "description": "Detailed markdown plan describing the approach and key changes."
    },
    "phases": {
      "type": "array",
      "minItems": 1,
      "description": "Ordered collection of micro-tasks.",
      "items": {
        "type": "object",
        "required": ["id", "status", "prompt", "context_files", "success_criteria"],
        "additionalProperties": false,
        "properties": {
          "id":               { "type": "integer", "description": "Sequential phase identifier." },
          "status":           { "type": "string", "enum": ["pending", "running", "completed", "failed"] },
          "prompt":           { "type": "string", "minLength": 1, "description": "Instruction injected into the worker." },
          "context_files":    { "type": "array", "items": { "type": "string", "minLength": 1 }, "description": "File paths relative to workspace root." },
          "success_criteria": { "type": "string", "minLength": 1, "description": "Evaluation condition (e.g., 'exit_code:0')." },
          "depends_on":       { "type": "array", "items": { "type": "integer" }, "description": "Phase IDs that must complete first (DAG mode)." },
          "evaluator":        { "type": "string", "enum": ["exit_code", "regex", "toolchain", "test_suite"] },
          "max_retries":      { "type": "integer", "minimum": 0, "description": "Max self-healing retry attempts." },
          "context_summary":  { "type": "string", "description": "Semantic summary for downstream phase handoffs." }
        }
      }
    }
  }
}
```

---

## ADK Integration Contract

### Injection Payload

```typescript
interface ADKInjectionPayload {
  readonly ephemeral: true;              // MUST be true — zero-context mode
  readonly prompt: string;               // The micro-task instruction
  readonly contextPayload: string;       // Delimited file content (<<<FILE:...>>>)
  readonly workingDirectory: string;     // Workspace root
  readonly timeoutMs: number;            // Max execution time (default: 300_000)
}
```

### Worker Handle

```typescript
interface ADKWorkerHandle {
  readonly sessionId: string;            // ADK session identifier
  readonly pid: number;                  // OS process ID (for orphan cleanup)
  onOutput(cb: (stream: 'stdout' | 'stderr', chunk: string) => void): () => void;
  onExit(cb: (exitCode: number) => void): () => void;
  terminate(): Promise<void>;
}
```

### Context Payload Format

Files are injected using a delimited format:

```
<<<FILE: src/models/User.ts>>>
export interface User {
  id: string;
  name: string;
  email: string;
}
<<<END FILE>>>

<<<FILE: src/services/UserService.ts>>>
import { User } from '../models/User';
// ...
<<<END FILE>>>
```

---

## Module API Reference

### Engine

The deterministic FSM governing the execution lifecycle.

```typescript
new Engine(stateManager: StateManager, options?: {
  scheduler?: Scheduler;
  healer?: SelfHealingController;
  workspaceRoot?: string;
})
```

| Method | Returns | Description |
|---|---|---|
| `getState()` | `EngineState` | Current FSM state |
| `getRunbook()` | `Runbook \| null` | Loaded runbook |
| `transition(event)` | `EngineState \| null` | Attempt FSM transition |
| `loadRunbook(filePath?)` | `Promise<void>` | Load + validate runbook from disk |
| `start()` | `Promise<void>` | Begin execution |
| `pause()` | `void` | Set cooperative pause flag |
| `abort()` | `Promise<void>` | Stop and return to IDLE |
| `retry(phaseId)` | `Promise<void>` | Retry a failed phase |
| `skipPhase(phaseId)` | `void` | Skip a failed phase |
| `editPhase(phaseId, patch)` | `void` | Edit phase prompt/files/criteria |
| `onWorkerExited(phaseId, exitCode, stdout?, stderr?)` | `Promise<void>` | Handle worker completion (parallel-aware) |
| `onWorkerFailed(phaseId, reason)` | `Promise<void>` | Handle timeout/crash |

**Events** (via `EventEmitter`):

| Event | Signature | Description |
|---|---|---|
| `state:changed` | `(from, to, event)` | Every FSM transition |
| `ui:message` | `(message)` | Messages for the Webview |
| `phase:execute` | `(phase)` | Phase ready for dispatch |
| `phase:heal` | `(phase, prompt)` | Self-healing retry request |
| `phase:checkpoint` | `(phaseId)` | Git checkpoint trigger |
| `run:completed` | `(runbook)` | All phases done |
| `error` | `(error)` | Any error |

---

### StateManager

Crash-safe persistence with WAL + atomic rename + in-process async mutex.

| Method | Returns | Description |
|---|---|---|
| `loadRunbook()` | `Promise<Runbook>` | Load and AJV-validate `.task-runbook.json` |
| `saveRunbook(runbook, state)` | `Promise<void>` | WAL → write → atomic rename (mutex-serialized) |
| `recoverFromCrash()` | `Promise<boolean>` | Replay WAL, clean stale locks |

---

### Scheduler

DAG-aware phase scheduling with Kahn's algorithm.

| Method | Returns | Description |
|---|---|---|
| `isDAGMode(phases)` | `boolean` | True if any phase has `depends_on` |
| `getReadyPhases(phases)` | `Phase[]` | Phases whose deps are satisfied (respects `maxConcurrent`) |
| `isAllDone(phases)` | `boolean` | No `pending` or `running` phases remain |
| `detectCycles(phases)` | `PhaseId[]` | Returns cycle member IDs (empty = valid DAG) |
| `getExecutionOrder(phases)` | `Phase[]` | Topological sort for display |

---

### ContextScoper

File reading, tokenization, and payload assembly.

| Method | Returns | Description |
|---|---|---|
| `assemble(files, workspaceRoot)` | `Promise<ContextResult>` | Returns `{ok: true, payload, ...}` or `{ok: false, ...}` |

---

### ADKController

Worker pool lifecycle management with PID-based orphan cleanup.

| Method | Returns | Description |
|---|---|---|
| `spawnWorker(phaseId, payload)` | `Promise<void>` | Spawn ephemeral worker |
| `terminateWorker(phaseId, reason)` | `Promise<void>` | Force-terminate (deletes from map first) |
| `cleanupOrphanedWorkers()` | `Promise<void>` | Kill workers from previous crash |

**Events**: `worker:exited`, `worker:timeout`, `worker:output`

---

### SelfHealingController

Auto-retry with exponential backoff and error-injected prompts.

| Method | Returns | Description |
|---|---|---|
| `recordFailure(phaseId, exitCode, stderr)` | `void` | Log a failure attempt |
| `canRetryWithPhase(phase)` | `boolean` | Check if retries remain |
| `buildHealingPrompt(phase)` | `string` | Build augmented prompt with stderr context |
| `getRetryDelay(phaseId)` | `number` | Exponential backoff delay (ms) |
| `clearAttempts(phaseId)` | `void` | Reset retry state on success |

---

### EvaluatorRegistry

Pluggable success evaluators.

| Evaluator | Criteria Prefix | Description |
|---|---|---|
| `ExitCodeEvaluator` | `exit_code:` | Check process exit code |
| `RegexEvaluator` | `regex:` | Match stdout against pattern |
| `ToolchainEvaluator` | `toolchain:` | Run whitelisted build command |
| `TestSuiteEvaluator` | `test_suite:` | Run whitelisted test command |

---

### GitSandboxManager

Git sandbox branch management via native VS Code Git API (zero `child_process`).

| Method | Returns | Description |
|---|---|---|
| `preFlightCheck()` | `Promise<PreFlightCheckResult>` | Check working tree is clean |
| `createSandboxBranch(options)` | `Promise<GitSandboxResult>` | Create and checkout `coogent/<slug>` branch |
| `openDiffReview()` | `Promise<GitSandboxResult>` | Open VS Code SCM panel for diff review |
| `restoreOriginalBranch()` | `Promise<GitSandboxResult>` | Checkout the pre-sandbox branch |
| `dispose()` | `Promise<void>` | Release resources |

---

### GitManager

File-level Git operations using `execFile` (no shell injection).

| Method | Returns | Description |
|---|---|---|
| `checkpoint(phaseId)` | `Promise<GitOperationResult>` | Snapshot commit after phase success |
| `rollbackToCommit(hash)` | `Promise<GitOperationResult>` | `git reset --hard` to commit |
| `stash()` / `unstash()` | `Promise<GitOperationResult>` | Preserve in-progress work |

---

### ConsolidationAgent

Post-execution report aggregation from phase handoff files.

| Method | Returns | Description |
|---|---|---|
| `generateReport(sessionDir, runbook)` | `Promise<ConsolidationReport>` | Aggregate all handoff files into a report |
| `formatAsMarkdown(report)` | `string` | Render report as human-readable Markdown |
| `saveReport(sessionDir, report)` | `Promise<string>` | Write `consolidation-report.md`, returns path |

---

### SessionManager

Session history discovery, search, and pruning.

| Method | Returns | Description |
|---|---|---|
| `createSession(prompt)` | `Promise<string>` | Create new session, returns session ID |
| `listSessions()` | `Promise<SessionSummary[]>` | All past sessions (most recent first, excludes current) |
| `searchSessions(query)` | `Promise<SessionSummary[]>` | Filter by project ID and phase prompts |
| `deepSearchSessions(query)` | `Promise<SessionSummary[]>` | Full-text search across all phase prompts |
| `loadSession(sessionId)` | `StateManager` | Load a StateManager for a specific session |
| `getSessionRunbook(sessionId)` | `Promise<Runbook \| null>` | Load full runbook for a session |
| `deleteSession(sessionId)` | `Promise<void>` | Delete a session directory |
| `pruneSessions(maxCount)` | `Promise<void>` | Delete oldest sessions beyond limit |
