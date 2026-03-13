# MCP Integration Architecture

> How Coogent implements and exposes the Model Context Protocol for artifact persistence, tool execution, and external agent connectivity.

---

## Table of Contents

1. [Overview](#overview)
2. [Server Architecture](#server-architecture)
3. [Transport Modes](#transport-modes)
4. [Supported Workflows](#supported-workflows)
5. [Data Flow Reference](#data-flow-reference)
6. [Resources (Read)](#resources-read)
7. [Tools (Write)](#tools-write)
8. [Prompts](#prompts)
9. [Sampling](#sampling)
10. [Validation Boundary](#validation-boundary)
11. [Security Model](#security-model)
12. [Plugin System](#plugin-system)
13. [Repository Layer](#repository-layer)
14. [Server Deployment](#server-deployment)
15. [Related Documents](#related-documents)

---

## Overview

Coogent's MCP layer serves as the **single source of truth** for all runtime artifacts. It wraps a persistent SQLite database (`ArtifactDB`) and exposes it through the [Model Context Protocol](https://modelcontextprotocol.io/) via three capability surfaces: **Resources** (read), **Tools** (write), and **Prompts** (discoverable templates).

The server runs in two modes:
- **In-process** — inside the VS Code Extension Host via `InMemoryTransport`
- **Standalone** — as a Node.js stdio process for external MCP clients

```
┌──────────────────────────────────────────────────────────────┐
│                     CoogentMCPServer                          │
│                                                               │
│  ┌──────────────────┐  ┌──────────────────┐  ┌────────────┐  │
│  │ MCPResourceHandler│  │  MCPToolHandler   │  │MCPPrompt   │  │
│  │ (ListResources,   │  │ (ListTools,       │  │Handler     │  │
│  │  ReadResource)    │  │  CallTool)        │  │(5 prompts) │  │
│  └────────┬─────────┘  └────────┬─────────┘  └────────────┘  │
│           │                      │                             │
│           └──────────┬───────────┘                             │
│                      ▼                                        │
│           ┌─────────────────────┐    ┌───────────────────┐    │
│           │     ArtifactDB      │    │  SamplingProvider  │    │
│           │  (sql.js WASM)      │    │  (feature-gated)   │    │
│           │  11 tenant tables   │    └───────────────────┘    │
│           │  + 7 repositories   │                             │
│           └─────────────────────┘    ┌───────────────────┐    │
│                                      │    PluginLoader    │    │
│                                      │  (.coogent/plugins)│    │
│                                      └───────────────────┘    │
└──────────────────────────────────────────────────────────────┘
          │                                │
   InMemoryTransport                StdioServerTransport
          │                                │
   MCPClientBridge                  External MCP Clients
   (Extension Host)              (Antigravity, Cursor, etc.)
```

---

## Server Architecture

`CoogentMCPServer` (`src/mcp/CoogentMCPServer.ts`) is the lifecycle owner. It delegates protocol handling to three extracted handler classes:

| Handler | Protocol Methods | Scope |
|---|---|---|
| `MCPResourceHandler` | `ListResources`, `ReadResource` | Read-only artifact access via `coogent://` URIs |
| `MCPToolHandler` | `ListTools`, `CallTool` | Mutating operations (submit plans, handoffs, reports) |
| `MCPPromptHandler` | `ListPrompts`, `GetPrompt` | 5 discoverable prompt templates |

### Initialisation Sequence

```
constructor(workspaceRoot)
    └── Creates MCP Server SDK instance with capabilities { resources, tools, prompts }

init(coogentDir, workspaceId)
    ├── ArtifactDB.create(dbPath, workspaceId)     ← SQLite via sql.js WASM
    ├── ArtifactDBBackup(dbPath, backupDir)         ← Periodic snapshot manager
    ├── MCPResourceHandler.register()               ← Wire ListResources + ReadResource
    ├── MCPToolHandler.register()                   ← Wire ListTools + CallTool
    ├── MCPPromptHandler.register()                 ← Wire ListPrompts + GetPrompt
    └── PluginLoader.loadAll()                      ← Discover and activate plugins

dispose()
    ├── PluginLoader.disposeAll()
    └── ArtifactDB.close()                          ← Final sync flush + free WASM
```

### Public API (Direct Access)

Beyond the MCP protocol, `CoogentMCPServer` exposes direct methods for the extension host and engine:

| Method | Purpose |
|---|---|
| `getTaskState(id)` | Read full task state for engine use |
| `upsertSummary(id, text)` | Persist user's original prompt |
| `setTaskCompleted(id)` | Mark task completed with timestamp |
| `upsertWorkerOutput(id, phaseId, out, err)` | Persist worker stdout/stderr |
| `setPhasePlanRequired(id, phaseId, flag)` | Flag whether a phase requires an execution plan |
| `upsertPhaseLog(id, phaseId, fields)` | Store phase execution log (prompt, context, response, timing) |
| `getPhaseLog(id, phaseId)` | Retrieve a phase execution log |
| `getWorkerOutputs(id)` | All worker outputs keyed by phaseId |
| `upsertSession(...)` | Persist session metadata to SQLite |
| `getLatestSession()` | Retrieve most recently created session |
| `purgeTask(id)` | Delete a task from the store |
| `purgeTaskKeepSession(id)` | Switch session without deleting data |
| `createBackup()` / `restoreBackup(path)` | Snapshot and restore the database |

---

## Transport Modes

### In-Process (Extension Host)

`MCPClientBridge` (`src/mcp/MCPClientBridge.ts`) connects to the server via `InMemoryTransport` — a zero-latency, in-memory channel provided by the MCP SDK.

```
Extension Host Process
┌───────────────────────────────────────────────────┐
│  MCPClientBridge ──InMemoryTransport──→ CoogentMCPServer  │
│    (MCP Client)       (pair)              (MCP Server)    │
│       │                                       │           │
│       ├── readResource(uri)                   │           │
│       ├── callTool(name, args)                │           │
│       ├── submitImplementationPlan(...)        ▼           │
│       ├── submitPhaseHandoff(...)          ArtifactDB      │
│       ├── submitConsolidationReport(...)                   │
│       ├── submitConsolidationReportJson(...)  ← direct DB  │
│       └── buildWarmStartPrompt(...)          ← local only  │
└───────────────────────────────────────────────────┘
```

| Method | Purpose |
|---|---|
| `connect()` | Creates a linked `InMemoryTransport` pair and connects both ends |
| `readResource(uri)` | Reads a `coogent://` URI and returns text content |
| `callTool(name, args)` | Invokes an MCP tool by name |
| `buildWarmStartPrompt()` | Generates context-injection prompt for worker agents |
| `submitImplementationPlan()` | Convenience wrapper for `submit_execution_plan` |
| `submitPhaseHandoff()` | Convenience wrapper for `submit_phase_handoff` (with enrichment fields) |
| `submitConsolidationReport()` | Convenience wrapper for `submit_consolidation_report` |
| `submitConsolidationReportJson()` | Direct DB access for structured JSON report |
| `disconnect()` | Tears down the transport |

### Standalone stdio (`stdio-server.ts`)

For external MCP clients (Antigravity, Cursor, Claude Desktop):

```bash
node out/stdio-server.js [--workspace /path/to/workspace] [--data-dir /path/to/data]
```

- Workspace defaults to `process.cwd()`
- Derives `workspaceId` via `WorkspaceIdentity.deriveWorkspaceId()`
- Durable storage routed to global Antigravity directory (or `--data-dir` override)
- stdout reserved for MCP JSON-RPC; all logs go to stderr
- Graceful shutdown on `SIGINT` / `SIGTERM`

---

## Supported Workflows

This section describes the end-to-end flows that traverse the MCP layer. Each workflow documents the actors, the MCP operations involved, and the data lifecycle.

### Workflow 1: Task Planning

**Actors**: Engine → MCPClientBridge → CoogentMCPServer

```
Engine receives user prompt
    │
    ├─ 1. mcpServer.upsertSummary(masterTaskId, prompt)
    │      └── Persists the user's original prompt as the task summary
    │
    ├─ 2. bridge.submitImplementationPlan(masterTaskId, markdown)
    │      └── Calls submit_execution_plan (master level)
    │      └── MCPValidator validates masterTaskId + content
    │      └── WorkerOutputValidator validates plan structure
    │      └── ArtifactDB.tasks.upsert(id, { executionPlan })
    │
    └─ 3. Resource becomes readable:
           coogent://tasks/{id}/summary          → text/plain
           coogent://tasks/{id}/execution_plan    → text/markdown
```

### Workflow 2: Phase Execution & Handoff

**Actors**: Worker Agent → MCPClientBridge → CoogentMCPServer → Engine

```
Worker agent starts phase
    │
    ├─ 1. bridge.buildWarmStartPrompt(masterTaskId, phaseId, parentPhaseIds)
    │      └── Generates context URIs for parent handoffs + global plan
    │      └── Root phases get no upstream handoff URIs
    │
    ├─ 2. Worker reads upstream context (via MCP Resources):
    │      ├── coogent://tasks/{id}/execution_plan         ← global plan
    │      └── coogent://tasks/{id}/phases/{parent}/handoff ← each parent
    │
    ├─ 3. Worker reads workspace files (via MCP Tools):
    │      ├── get_modified_file_content  → full file (32K char cap)
    │      ├── get_file_slice             → line range (2K line cap)
    │      └── get_symbol_context         → ±25 lines around symbol
    │
    ├─ 4. Worker optionally submits a phase-level plan:
    │      └── bridge.submitImplementationPlan(masterTaskId, markdown, phaseId)
    │
    ├─ 5. Worker submits phase handoff:
    │      └── bridge.submitPhaseHandoff(masterTaskId, phaseId, ...)
    │          ├── Required: decisions[], modified_files[], blockers[]
    │          ├── Optional enrichment: summary, rationale, constraints[],
    │          │   remainingWork[], warnings[], symbolsTouched[],
    │          │   workspaceFolder, changedFilesJson, next_steps_context
    │          ├── MCPValidator validates all fields
    │          ├── WorkerOutputValidator validates payload
    │          ├── ArtifactDB.handoffs.upsert(handoff)
    │          └── emitter.emit('phaseCompleted', handoff)
    │
    └─ 6. Engine receives 'phaseCompleted' event
           └── onPhaseCompleted(listener) triggers downstream scheduling
```

### Workflow 3: Consolidation

**Actors**: Reducer Agent → MCPClientBridge → CoogentMCPServer

```
All phases complete → Reducer runs
    │
    ├─ 1. Reducer reads all handoffs:
    │      └── get_phase_handoff tool or ReadResource for each phase
    │
    ├─ 2. Reducer produces final report:
    │      ├── bridge.submitConsolidationReport(masterTaskId, markdown)
    │      │   └── Validates + persists Markdown report
    │      └── bridge.submitConsolidationReportJson(masterTaskId, json)
    │          └── Direct DB write for structured JSON
    │
    ├─ 3. Engine marks task complete:
    │      └── mcpServer.setTaskCompleted(masterTaskId)
    │
    └─ 4. Final resources become readable:
           coogent://tasks/{id}/consolidation_report       → text/markdown
           coogent://tasks/{id}/consolidation_report_json   → application/json
```

### Workflow 4: Session Persistence & Warm Restart

**Actors**: Extension Host → CoogentMCPServer

```
Session lifecycle
    │
    ├─ 1. New session created:
    │      └── mcpServer.upsertSession(dirName, sessionId, prompt, createdAt)
    │
    ├─ 2. Session resume:
    │      └── mcpServer.getLatestSession()
    │      └── mcpServer.getWorkerOutputs(masterTaskId)  ← hydrate webview
    │
    ├─ 3. Session switch:
    │      └── mcpServer.purgeTaskKeepSession(oldId) ← no data deleted
    │
    └─ 4. Session reset:
           └── mcpServer.purgeTask(masterTaskId)     ← full data deletion
```

### Workflow 5: Phase Logging & Diagnostics

**Actors**: Engine → CoogentMCPServer

```
Phase execution tracking
    │
    ├─ 1. Phase starts:
    │      └── mcpServer.upsertPhaseLog(id, phaseId, { prompt, requestContext, startedAt })
    │      └── mcpServer.setPhasePlanRequired(id, phaseId, required)
    │      └── mcpServer.upsertWorkerOutput(id, phaseId, '', '')  ← init
    │
    ├─ 2. Worker produces output:
    │      └── mcpServer.upsertWorkerOutput(id, phaseId, stdout, stderr)
    │
    └─ 3. Phase completes:
           └── mcpServer.upsertPhaseLog(id, phaseId, { response, exitCode, completedAt })
```

### Workflow 6: Backup & Restore

**Actors**: Extension Host → CoogentMCPServer → ArtifactDBBackup

```
Database safety
    │
    ├─ 1. Create snapshot:
    │      └── mcpServer.createBackup()
    │          ├── ArtifactDBBackup.createSnapshot()
    │          └── ArtifactDBBackup.rotateBackups()   ← prune old snapshots
    │
    └─ 2. Restore from snapshot:
           └── mcpServer.restoreBackup(backupPath)
           └── Server must be re-initialised after restore
```

### Workflow 7: External Client Access

**Actors**: External MCP Client → stdio transport → CoogentMCPServer

```
External tool connects via stdio
    │
    ├─ 1. Start: node out/stdio-server.js --workspace /path
    │
    ├─ 2. Client discovers capabilities:
    │      ├── ListTools     → 7 tools (see Tools section)
    │      ├── ListResources → dynamic per-task resource list
    │      └── ListPrompts   → 5 prompt templates
    │
    ├─ 3. Client uses tools/resources/prompts:
    │      └── Same operations as in-process mode
    │      └── Same validation and security gates apply
    │
    └─ 4. Shutdown on SIGINT/SIGTERM
```

---

## Data Flow Reference

### Hierarchical Data Model

```
masterTaskId (YYYYMMDD-HHMMSS-<uuid>)
  ├── summary: string                          ← user prompt
  ├── executionPlan: string (Markdown)          ← master plan
  ├── consolidationReport: string (Markdown)    ← final report
  ├── consolidationReportJson: string (JSON)    ← structured report
  ├── runbookJson: string (JSON)                ← DB mirror of .task-runbook.json
  └── phases: Map<phaseId, PhaseArtifacts>
        ├── executionPlan: string (Markdown)    ← phase plan
        ├── planRequired: boolean               ← agent type flag
        └── handoff: PhaseHandoff
              ├── decisions: string[]
              ├── modifiedFiles: string[]
              ├── blockers: string[]
              ├── completedAt: number
              ├── nextStepsContext?: string
              ├── summary?: string
              ├── rationale?: string
              ├── remainingWork?: string[]
              ├── constraints?: string[]
              ├── warnings?: string[]
              ├── changedFilesJson?: string
              ├── workspaceFolder?: string
              └── symbolsTouched?: string[]
```

### Data Lifecycle

| Artifact | Written By | Read By | Persistence |
|---|---|---|---|
| Task summary | `upsertSummary()` | ReadResource `summary` | SQLite |
| Master plan | `submit_execution_plan` tool | ReadResource `execution_plan` | SQLite |
| Phase plan | `submit_execution_plan` tool (with phaseId) | ReadResource phase `execution_plan` | SQLite |
| Phase handoff | `submit_phase_handoff` tool | ReadResource `handoff`, `get_phase_handoff` tool | SQLite |
| Consolidation report | `submit_consolidation_report` tool | ReadResource `consolidation_report` | SQLite |
| Consolidation JSON | `submitConsolidationReportJson()` (direct) | ReadResource `consolidation_report_json` | SQLite |
| Worker output | `upsertWorkerOutput()` | `getWorkerOutputs()` | SQLite |
| Phase log | `upsertPhaseLog()` | `getPhaseLog()` | SQLite |
| Session metadata | `upsertSession()` | `getLatestSession()` | SQLite |

### ID Formats

- **Master Task ID**: `YYYYMMDD-HHMMSS-<uuid>` — e.g., `20260305-173000-a1b2c3d4-e5f6-7890-abcd-ef1234567890`
- **Phase ID**: `phase-<index>-<uuid>` — e.g., `phase-001-a1b2c3d4-e5f6-7890-abcd-ef1234567890`

---

## Resources (Read)

All resources are exposed under the `coogent://` URI scheme. Resources are dynamically listed — only tasks and phases that exist in the database appear in `ListResources`.

### Task-Level Resources

| URI Pattern | MIME Type | Content | Availability |
|---|---|---|---|
| `coogent://tasks/{id}/summary` | `text/plain` | User's original prompt | After `upsertSummary()` |
| `coogent://tasks/{id}/execution_plan` | `text/markdown` | Master-level execution plan | After `submit_execution_plan` |
| `coogent://tasks/{id}/consolidation_report` | `text/markdown` | Final aggregated report | After `submit_consolidation_report` |
| `coogent://tasks/{id}/consolidation_report_json` | `application/json` | Structured report (typed) | After `submitConsolidationReportJson()` |

### Phase-Level Resources

| URI Pattern | MIME Type | Content | Availability |
|---|---|---|---|
| `coogent://tasks/{id}/phases/{phaseId}/execution_plan` | `text/markdown` | Phase-level plan | After `submit_execution_plan` with phaseId |
| `coogent://tasks/{id}/phases/{phaseId}/handoff` | `application/json` | Handoff artifact (decisions, files, blockers) | After `submit_phase_handoff` |

### Resource Read Behaviour

- **Not-yet-available resources** throw an error with a descriptive message
- **Phase plan when `planRequired=false`**: returns informational message instead of error
- **Phase plan after completion without plan**: returns informational message (many workers skip plan submission)
- **Missing task**: throws `Task not found` error

---

## Tools (Write)

Seven tools are registered, each delegated to a dedicated handler in `src/mcp/handlers/`:

### Mutating Tools (Write Path)

| Tool | Required Args | Optional Args | Effect |
|---|---|---|---|
| `submit_execution_plan` | `masterTaskId`, `markdown_content` | `phaseId` | Persist Markdown plan at task or phase level |
| `submit_phase_handoff` | `masterTaskId`, `phaseId`, `decisions`, `modified_files`, `blockers` | `next_steps_context`, `summary`, `rationale`, `constraints`, `remainingWork`, `symbolsTouched`, `warnings`, `workspaceFolder`, `changedFilesJson` | Record phase completion + emit `phaseCompleted` event |
| `submit_consolidation_report` | `masterTaskId`, `markdown_content` | — | Store final aggregated session report |

### Read Tools (Query Path)

| Tool | Required Args | Optional Args | Returns |
|---|---|---|---|
| `get_modified_file_content` | `masterTaskId`, `phaseId`, `file_path` | — | Full file content (truncated at 32K chars) |
| `get_file_slice` | `path`, `startLine`, `endLine` | `workspaceFolder` | Line range (capped at 2,000 lines) |
| `get_phase_handoff` | `masterTaskId`, `phaseId` | — | JSON-serialized handoff data |
| `get_symbol_context` | `path`, `symbol` | `workspaceFolder` | ±25 lines around first symbol occurrence |

All tool schemas are defined in `tool-schemas.ts` and registered via `ALL_TOOL_SCHEMAS`.

### Validation Pipeline

Every tool call passes through a two-stage validation pipeline:

```
MCP Tool Call
    │
    ├─ Stage 1: MCPValidator (format + bounds)
    │   ├── validateMasterTaskId → YYYYMMDD-HHMMSS-<uuid> regex
    │   ├── validatePhaseId     → phase-<index>-<uuid> regex
    │   ├── validateString      → type + maxLength enforcement
    │   └── validateStringArray → type + maxItems + maxItemLength + optional pathLike regex
    │
    ├─ Stage 2: WorkerOutputValidator (semantic)
    │   └── Validates structural contracts per tool type
    │
    └─ On failure: structured telemetry via TelemetryLogger.logBoundaryEvent()
```

---

## Prompts

`MCPPromptHandler` exposes 5 discoverable prompt templates for MCP clients. Prompts are stateless message composers — they build message arrays from arguments but do **not** execute workflows.

| Prompt | Required Args | Optional Args | Use Case |
|---|---|---|---|
| `plan_repo_task` | `task` | `repo_summary`, `constraints`, `preferred_workers` | Generate a phased implementation plan |
| `review_generated_runbook` | `runbook` | `review_focus`, `risk_tolerance` | Validate an AI-generated runbook |
| `repair_failed_phase` | `phase_context`, `prior_output`, `failure_reason`, `retry_count` | — | Diagnose and repair a failed phase |
| `consolidate_session` | `handoffs`, `modified_files` | `unresolved_issues` | Aggregate phase handoffs into a final report |
| `architecture_review_workspace` | `workspace_summary` | `review_scope`, `output_style` | Review workspace architecture |

Each prompt includes a `_version` metadata field (currently `1.0.0`) for contract tracking.

---

## Sampling

`SamplingProvider` (`src/mcp/SamplingProvider.ts`) provides feature-gated LLM inference via MCP Sampling:

| Implementation | Behaviour |
|---|---|
| `NoopSamplingProvider` | Always reports unavailable; callers fall back to non-sampling paths |
| `MCPSamplingProvider` | Delegates to MCP Server's `createMessage` API when the client advertises sampling support |

**Constraints**:
- Gated by `coogent.enableSampling` configuration flag
- Never used for deterministic control-plane logic (routing, scheduling, state transitions)
- All invocations are logged with request class, model metadata, outcome, and token usage
- Request envelope includes `prompt`, `maxTokens` (default 4096), `systemPrompt`, and `requestClass`

---

## Security Model

### Path Traversal Protection

Three layers protect against workspace escapes:

1. **Schema-level**: `pathLike` regex pattern (`^[\w\-./]+$`) rejects special characters
2. **Length bounds**: Max 260 characters per path
3. **Runtime realpath**: `fs.realpath()` resolves symlinks, then boundary-checks against allowed workspace roots

### Access Controls

| Control | Scope | Detail |
|---|---|---|
| Workspace root validation | `get_file_slice`, `get_symbol_context` | `resolveWorkspaceRoot()` validates `workspaceFolder` against allowed roots |
| Task authorization | `get_modified_file_content` | Verifies `masterTaskId` exists in the DB before file I/O |
| `additionalProperties: false` | `submit_phase_handoff` schema | Rejects unknown properties at the schema level |

### Telemetry

All validation failures log structured boundary events with canonical error codes via `TelemetryLogger.logBoundaryEvent()`.

---

## Plugin System

`PluginLoader` (`src/mcp/PluginLoader.ts`) discovers and manages third-party plugins from `.coogent/plugins/`:

```
.coogent/plugins/
  my-plugin/
    plugin.json    ← manifest (id, name, main, version, description)
    index.js       ← MCPPlugin export with activate() / deactivate()
```

| Feature | Detail |
|---|---|
| **Discovery** | Scans `.coogent/plugins/` subdirectories for `plugin.json` manifests |
| **User approval** | Gated by `coogent.requirePluginApproval` (default: `true`) — modal warning before activation |
| **Error isolation** | Failing plugins never crash the server |
| **Duplicate rejection** | Plugins with duplicate `id` values are skipped |
| **Lifecycle** | `activate(ctx)` on load, `deactivate()` on server shutdown |
| **Context** | Receives `{ server, db, workspaceRoot }` on activation |

> **Note**: The plugin system is functional but has zero production implementations. The API may change.

---

## Repository Layer

`ArtifactDB` delegates typed data access to 7 repository classes in `src/mcp/repositories/`:

| Repository | Table | Key Operations |
|---|---|---|
| `TaskRepository` | `tasks` | `upsert`, `get`, `delete`, `listIds` |
| `PhaseRepository` | `phases`, `worker_outputs`, `phase_logs` | `upsert`, `upsertOutput`, `upsertLog`, `upsertPlan`, `upsertPlanRequired`, `getLog`, `getOutputs`, `listIds` |
| `HandoffRepository` | `handoffs` | `upsert`, `get`, `getAll`, `delete` |
| `VerdictRepository` | `evaluation_results`, `healing_attempts` | `upsertEvaluation`, `upsertHealing` |
| `SessionRepository` | `sessions` | `upsert`, `list`, `getLatest`, `delete`, `search` |
| `AuditRepository` | `plan_revisions`, `selection_audits` | `insertRevision`, `insertSelectionAudit` |
| `ContextManifestRepository` | `context_manifests` | `upsert`, `get` |

All repositories enforce workspace tenanting — every query includes a `workspace_id` filter.

---

## Server Deployment

`MCPServerDeployer` (`src/mcp/MCPServerDeployer.ts`) manages deployment of the stdio server bundle to a global, well-known directory for external clients.

```
Extension out/ directory                  Global Antigravity directory
┌─────────────────────┐                  ┌─────────────────────────────────────┐
│  stdio-server.js    │ ──copy-if-stale→ │  ~/Library/Application Support/     │
│  sql-wasm.wasm      │                  │    Antigravity/coogent/mcp/         │
└─────────────────────┘                  └─────────────────────────────────────┘
```

- Only copies when the target is missing or stale (source is newer)
- Called during extension activation via `deployMCPServer(context.extensionPath)`
- External clients can then start the server at the stable global path

---

## Related Documents

- [Architecture](../architecture.md) — System architecture overview (FSM, DAG, MCP sections)
- [API Reference](../api-reference.md) — Full MCP URI and tool contract reference
- [Storage Topology](storage-topology.md) — Physical directory layout
- [Tenant Model](tenant-model.md) — Workspace identity and tenant scoping
- [Data Ownership Matrix](data-ownership-matrix.md) — Complete data class reference
