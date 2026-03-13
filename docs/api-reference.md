# API & Integration Reference

> MCP URIs, tools, IPC message contracts, and data model schemas.

---

## Table of Contents

1. [MCP Resource URIs](#mcp-resource-uris)
2. [MCP Tools](#mcp-tools)
3. [IPC Message Contracts](#ipc-message-contracts)
4. [Data Models](#data-models)

---

## MCP Resource URIs

All runtime artifacts are addressed via a RESTful `coogent://` URI schema. The Extension Host enforces strict regex matching.

### Task-Level Resources

| URI | Returns | Content Type |
|---|---|---|
| `coogent://tasks/{taskId}/summary` | Task overview | Markdown |
| `coogent://tasks/{taskId}/execution_plan` | Execution plan | Markdown |
| `coogent://tasks/{taskId}/consolidation_report` | Final report | Markdown |

### Phase-Level Resources

| URI | Returns | Content Type |
|---|---|---|
| `coogent://tasks/{taskId}/phases/{phaseId}/execution_plan` | Phase plan | Markdown |
| `coogent://tasks/{taskId}/phases/{phaseId}/handoff` | Phase handoff | JSON |

### ID Formats

| Segment | Format | Example |
|---|---|---|
| `{taskId}` | `YYYYMMDD-HHMMSS-<uuid>` | `20260306-153847-a3b8d1b6-0b3b-4b1a-9c1a-1a2b3c4d5e6f` |
| `{phaseId}` | `phase-<index>-<uuid>` | `phase-001-3be30b9e-7c42-4f12-b8a1-...` |

### URI Builder Functions

```typescript
import { RESOURCE_URIS } from './mcp/types';

RESOURCE_URIS.taskSummary(taskId)                   // → coogent://tasks/{taskId}/summary
RESOURCE_URIS.taskPlan(taskId)                       // → coogent://tasks/{taskId}/execution_plan
RESOURCE_URIS.taskReport(taskId)                     // → coogent://tasks/{taskId}/consolidation_report
RESOURCE_URIS.phasePlan(taskId, phaseId)             // → coogent://tasks/{taskId}/phases/{phaseId}/execution_plan
RESOURCE_URIS.phaseHandoff(taskId, phaseId)          // → coogent://tasks/{taskId}/phases/{phaseId}/handoff
```

---

## MCP Tools

| Tool | Direction | Description |
|---|---|---|
| `submit_execution_plan` | Agent → Server | Submit a generated execution plan for a task |
| `submit_phase_handoff` | Agent → Server | Submit phase completion artifacts |
| `submit_consolidation_report` | Agent → Server | Submit the final aggregated report |
| `get_modified_file_content` | Agent ← Server | Retrieve file content from the Git sandbox (read-only, truncated) |

### `submit_phase_handoff` Schema

```typescript
{
    phaseId: string;           // MCP phase ID (phase-NNN-<uuid>)
    masterTaskId: string;      // Master task ID
    decisions: string[];       // Key decisions made during phase
    modifiedFiles: string[];   // Paths of files modified (pointers, not content)
    blockers: string[];        // Unresolved issues (may be empty)
    completedAt: number;       // Unix timestamp in ms
}
```

### `get_modified_file_content` Behavior

- Reads files **only** within the Git sandbox (workspace root)
- Returns truncated content to respect token limits
- Returns an error if the file does not exist (no ENOENT disclosure of full path)

---

## IPC Message Contracts

Communication between the Extension Host and the Svelte Webview uses `postMessage` with typed discriminators and `requestId` correlation.

### Host → Webview (Push)

| `type` | Payload | When Sent |
|---|---|---|
| `STATE_SNAPSHOT` | `{ runbook, engineState, masterTaskId? }` | State change, panel reveal, panel init |
| `PHASE_STATUS` | `{ phaseId, status, durationMs? }` | Phase transition |
| `PHASE_OUTPUT` | `{ phaseId, stream, chunk }` | Real-time worker stdout/stderr |
| `TOKEN_BUDGET` | `{ phaseId, breakdown[], totalTokens, limit }` | After context scoping |
| `ERROR` | `{ code, message, phaseId? }` | Engine errors (typed `ErrorCode`) |
| `LOG_ENTRY` | `{ timestamp, level, message }` | Structured log events |
| `PLAN_DRAFT` | `{ draft: Runbook, fileTree[] }` | Planner agent produced a runbook draft |
| `PLAN_STATUS` | `{ status, message? }` | Planning spinner updates |
| `PLAN_SUMMARY` | `{ summary }` | Planning phase output for review |
| `IMPLEMENTATION_PLAN` | `{ plan }` | Implementation plan markdown |
| `SESSION_LIST` | `{ sessions[] }` | Recent session list for history drawer |
| `SESSION_SEARCH_RESULTS` | `{ query, sessions[] }` | Filtered search results |
| `CONVERSATION_MODE` | `{ mode, smartSwitchTokenThreshold }` | Conversation mode sync |
| `CONSOLIDATION_REPORT` | `{ report }` | Final report after all phases pass |
| `MCP_RESOURCE_DATA` | `{ requestId, data, error? }` | Response to `MCP_FETCH_RESOURCE` |
| `SUGGESTION_DATA` | `{ mentions[], workflows[] }` | @ mention and / workflow popups |
| `ATTACHMENT_SELECTED` | `{ paths[] }` | File/image attachment selection result |
| `workers:loaded` | `{ workers: AgentProfile[] }` | Loaded worker profiles |

### Webview → Host (Request)

| `type` | Payload | Purpose |
|---|---|---|
| `CMD_START` | — | Start or resume execution |
| `CMD_ABORT` | — | Abort the entire run |
| `CMD_RETRY` | `{ phaseId }` | Retry a failed phase |
| `CMD_SKIP_PHASE` | `{ phaseId }` | Skip a phase |
| `CMD_PAUSE_PHASE` | `{ phaseId }` | Pause a running phase |
| `CMD_STOP_PHASE` | `{ phaseId }` | Stop a running phase |
| `CMD_RESTART_PHASE` | `{ phaseId }` | Restart a phase from scratch |
| `CMD_EDIT_PHASE` | `{ phaseId, patch }` | Edit phase prompt/context/criteria |
| `CMD_LOAD_RUNBOOK` | `{ filePath? }` | Load a runbook from disk |
| `CMD_RESET` | — | Full reset to IDLE |
| `CMD_REQUEST_STATE` | — | Request full state snapshot |
| `CMD_PLAN_REQUEST` | `{ prompt, feedback? }` | Submit prompt for planning |
| `CMD_PLAN_APPROVE` | — | Approve AI-generated plan |
| `CMD_PLAN_REJECT` | `{ feedback }` | Reject plan with feedback |
| `CMD_PLAN_EDIT_DRAFT` | `{ draft: Runbook }` | Edit draft runbook directly |
| `CMD_PLAN_RETRY_PARSE` | — | Re-parse cached timeout output |
| `CMD_SET_CONVERSATION_MODE` | `{ mode }` | Set conversation mode |
| `CMD_REQUEST_REPORT` | — | Request consolidation report |
| `CMD_REQUEST_PLAN` | — | Request execution plan |
| `CMD_REVIEW_DIFF` | `{ phaseId }` | Review diff for a phase |
| `CMD_RESUME_PENDING` | — | Resume all pending phases |
| `MCP_FETCH_RESOURCE` | `{ uri, requestId }` | Fetch an artifact by URI |
| `CMD_UPLOAD_FILE` | — | Attach a file from workspace |
| `CMD_UPLOAD_IMAGE` | — | Attach an image from workspace |
| `workers:request` | — | Request loaded worker profiles |
| `CMD_LIST_SESSIONS` | — | Request recent session list |
| `CMD_SEARCH_SESSIONS` | `{ query }` | Search past sessions |
| `CMD_LOAD_SESSION` | `{ sessionId }` | Load a specific session |
| `CMD_DELETE_SESSION` | `{ sessionId }` | Delete a session |

---

## Data Models

### Runbook (`.task-runbook.json`)

The persistent state file for the execution engine. Validated by AJV on every load.

```jsonc
{
    "project_id": "string",                    // Unique run identifier
    "status": "idle | running | paused_error | completed",
    "current_phase": 0,                        // Index of current/next phase
    "summary": "string",                       // High-level task summary (optional)
    "execution_plan": "string",           // Detailed markdown plan (optional)
    "phases": [
        {
            "id": 0,                           // Sequential integer ID
            "status": "pending | running | completed | failed",
            "prompt": "string",                // Worker instruction
            "context_files": ["src/foo.ts"],    // Files to inject (workspace-relative)
            "success_criteria": "exit_code:0",  // Completion condition
            "depends_on": [0, 1],              // DAG dependencies (optional)
            "evaluator": "exit_code",          // Evaluator type (optional)
            "max_retries": 3,                  // Phase retry limit (optional)
            "context_summary": "string",       // Downstream context (optional)
            "mcpPhaseId": "phase-001-<uuid>"   // Assigned at dispatch (optional)
        }
    ]
}
```

> **Full schema**: [`schemas/runbook.schema.json`](../schemas/runbook.schema.json)

### Phase Handoff

Produced by each completed worker phase. Stored in the MCP server state.

```jsonc
{
    "phaseId": "phase-001-<uuid>",
    "masterTaskId": "20260306-153847-<uuid>",
    "decisions": [
        "Refactored auth to use JWT",
        "Added refresh token rotation"
    ],
    "modifiedFiles": [
        "src/auth/jwt.ts",
        "src/auth/refresh.ts"
    ],
    "blockers": [],
    "completedAt": 1741283847123               // Unix timestamp (ms)
}
```

### MCP State Store (In-Memory)

```typescript
interface TaskState {
    masterTaskId: string;
    summary?: string;
    implementationPlan?: string;
    consolidationReport?: string;
    phases: Map<string, PhaseArtifacts>;
}

interface PhaseArtifacts {
    implementationPlan?: string;
    handoff?: PhaseHandoff;
}
```

### Branded Types

Coogent uses nominal branded types for compile-time safety:

```typescript
type PhaseId = number & { readonly __brand: 'PhaseId' };
type UnixTimestampMs = number & { readonly __brand: 'UnixTimestampMs' };

// Safe casts
const id = asPhaseId(0);
const ts = asTimestamp(Date.now());
```

### Engine States (Enum)

```typescript
enum EngineState {
    IDLE = 'IDLE',
    PLANNING = 'PLANNING',
    PLAN_REVIEW = 'PLAN_REVIEW',
    PARSING = 'PARSING',
    READY = 'READY',
    EXECUTING_WORKER = 'EXECUTING_WORKER',
    EVALUATING = 'EVALUATING',
    ERROR_PAUSED = 'ERROR_PAUSED',
    COMPLETED = 'COMPLETED',
}
```
