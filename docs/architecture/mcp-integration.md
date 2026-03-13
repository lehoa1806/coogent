# MCP Integration Architecture

> How Coogent implements and exposes the Model Context Protocol for artifact persistence, tool execution, and external agent connectivity.

---

## Table of Contents

1. [Overview](#overview)
2. [Server Architecture](#server-architecture)
3. [Transport Modes](#transport-modes)
4. [Resources (Read)](#resources-read)
5. [Tools (Write)](#tools-write)
6. [Prompts](#prompts)
7. [Sampling](#sampling)
8. [Validation Boundary](#validation-boundary)
9. [Plugin System](#plugin-system)
10. [Repository Layer](#repository-layer)
11. [Related Documents](#related-documents)

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

`CoogentMCPServer` (`src/mcp/CoogentMCPServer.ts`, ~455 lines) is the lifecycle owner. It delegates protocol handling to three extracted handler classes:

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

---

## Transport Modes

### In-Process (Extension Host)

`MCPClientBridge` (`src/mcp/MCPClientBridge.ts`, ~281 lines) connects to the server via `InMemoryTransport` — a zero-latency, in-memory channel provided by the MCP SDK.

| Method | Purpose |
|---|---|
| `connect()` | Creates a linked `InMemoryTransport` pair and connects both ends |
| `readResource(uri)` | Reads a `coogent://` URI and returns text content |
| `callTool(name, args)` | Invokes an MCP tool by name |
| `buildWarmStartPrompt()` | Generates context-injection prompt for worker agents |
| `submitImplementationPlan()` | Convenience wrapper for `submit_execution_plan` |
| `submitPhaseHandoff()` | Convenience wrapper for `submit_phase_handoff` |
| `submitConsolidationReport()` | Convenience wrapper for `submit_consolidation_report` |
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

## Resources (Read)

All resources are exposed under the `coogent://` URI scheme.

### Task-Level Resources

| URI Pattern | MIME Type | Content |
|---|---|---|
| `coogent://tasks/{id}/summary` | `text/plain` | User's original prompt |
| `coogent://tasks/{id}/execution_plan` | `text/markdown` | Master-level execution plan |
| `coogent://tasks/{id}/consolidation_report` | `text/markdown` | Final aggregated report |
| `coogent://tasks/{id}/consolidation_report_json` | `application/json` | Structured report (typed) |

### Phase-Level Resources

| URI Pattern | MIME Type | Content |
|---|---|---|
| `coogent://tasks/{id}/phases/{phaseId}/execution_plan` | `text/markdown` | Phase-level plan |
| `coogent://tasks/{id}/phases/{phaseId}/handoff` | `application/json` | Handoff artifact (decisions, modified files, blockers) |

### ID Formats

- **Master Task ID**: `YYYYMMDD-HHMMSS-<uuid>` (e.g., `20260305-173000-a1b2c3d4-...`)
- **Phase ID**: `phase-<index>-<uuid>` (e.g., `phase-001-a1b2c3d4-...`)

---

## Tools (Write)

Seven tools are registered, each delegated to a dedicated handler in `src/mcp/handlers/`:

| Tool | Handler | Purpose |
|---|---|---|
| `submit_execution_plan` | `SubmitImplementationPlanHandler` | Persist a Markdown execution plan (task or phase level) |
| `submit_phase_handoff` | `SubmitPhaseHandoffHandler` | Record phase completion artifacts (decisions, files, blockers) |
| `submit_consolidation_report` | `SubmitConsolidationReportHandler` | Store the final aggregated session report |
| `get_modified_file_content` | `GetModifiedFileContentHandler` | Read file content from workspace (path-traversal protected) |
| `get_file_slice` | `GetFileSliceHandler` | Read a line range from a workspace file |
| `get_phase_handoff` | `GetPhaseHandoffHandler` | Retrieve a specific phase's handoff data |
| `get_symbol_context` | `GetSymbolContextHandler` | Extract symbol definitions from source files |

All tool schemas are defined in `tool-schemas.ts` and registered via `ALL_TOOL_SCHEMAS`.

### Security

- **Path traversal protection**: `MCPToolHandler.resolveWorkspaceRoot()` validates that any `workspaceFolder` argument falls within the allowed workspace roots
- **Boundary event logging**: Structured telemetry via `TelemetryLogger.logBoundaryEvent()` for all validation failures

---

## Prompts

`MCPPromptHandler` exposes 5 discoverable prompt templates for MCP clients:

| Prompt | Key Arguments | Use Case |
|---|---|---|
| `plan_repo_task` | `objective`, `workspace_root`, `tech_stack` | Generate a phased implementation plan |
| `review_generated_runbook` | `runbook_json`, `risk_tolerance` | Validate an AI-generated runbook |
| `repair_failed_phase` | `phase_id`, `failure_reason`, `prior_output` | Diagnose and repair a failed phase |
| `consolidate_session` | `session_id`, `unresolved_issues` | Aggregate phase handoffs into a final report |
| `architecture_review_workspace` | `workspace_root`, `focus_areas`, `output_style` | Review workspace architecture |

Each prompt includes a `_version` metadata field (currently `1.0.0`) for contract tracking.

---

## Sampling

`SamplingProvider` (`src/mcp/SamplingProvider.ts`) provides feature-gated LLM inference via MCP Sampling:

| Implementation | Behaviour |
|---|---|
| `NoopSamplingProvider` | Always reports unavailable; callers fall back to non-sampling paths |
| `MCPSamplingProvider` | Delegates to MCP Server's `createMessage` API when the client advertises sampling support |

**Constraints**: Gated by `coogent.enableSampling`, never used for control-plane logic (routing, scheduling, state transitions), all invocations are logged.

---

## Validation Boundary

`MCPValidator` (`src/mcp/MCPValidator.ts`, ~102 lines) provides stateless validation helpers because the MCP SDK does **not** validate tool arguments against declared JSON Schemas at runtime.

| Method | Validates |
|---|---|
| `validateMasterTaskId(value)` | `YYYYMMDD-HHMMSS-<uuid>` format |
| `validatePhaseId(value)` | `phase-<index>-<uuid>` format |
| `validateString(value, field, maxLen)` | Type + length bound |
| `validateStringArray(value, field, opts)` | Array type + per-item length + optional path-safety regex |

All validation failures log structured boundary events with canonical error codes.

---

## Plugin System

`PluginLoader` (`src/mcp/PluginLoader.ts`, ~230 lines) discovers and manages third-party plugins from `.coogent/plugins/`:

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

> **Note**: The plugin system is functional but has zero production implementations. The API may change.

---

## Repository Layer

`ArtifactDB` delegates typed data access to 7 repository classes in `src/mcp/repositories/`:

| Repository | Table | Key Operations |
|---|---|---|
| `TaskRepository` | `tasks` | `upsert`, `get`, `delete`, `listIds` |
| `PhaseRepository` | `phases`, `worker_outputs`, `phase_logs` | `upsert`, `upsertOutput`, `upsertLog`, `getLog`, `listIds` |
| `HandoffRepository` | `handoffs` | `upsert`, `get`, `getAll`, `delete` |
| `VerdictRepository` | `evaluation_results`, `healing_attempts` | `upsertEvaluation`, `upsertHealing` |
| `SessionRepository` | `sessions` | `upsert`, `list`, `getLatest`, `delete`, `search` |
| `AuditRepository` | `plan_revisions`, `selection_audits` | `insertRevision`, `insertSelectionAudit` |
| `ContextManifestRepository` | `context_manifests` | `upsert`, `get` |

All repositories enforce workspace tenanting — every query includes a `workspace_id` filter.

---

## Related Documents

- [Architecture](../architecture.md) — System architecture overview (FSM, DAG, MCP sections)
- [API Reference](../api-reference.md) — Full MCP URI and tool contract reference
- [Storage Topology](storage-topology.md) — Physical directory layout
- [Tenant Model](tenant-model.md) — Workspace identity and tenant scoping
- [Data Ownership Matrix](data-ownership-matrix.md) — Complete data class reference
