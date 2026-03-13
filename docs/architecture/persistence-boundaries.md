# Persistence Boundaries

> Which subsystem owns which data, and the rules governing persistence responsibilities.

---

## Overview

Coogent's persistence is divided across four subsystems, each with a clear ownership boundary. No subsystem reads or writes data owned by another — all cross-subsystem access goes through defined interfaces.

---

## StateManager — Runbook & Session Durability

**Source**: [`src/state/StateManager.ts`](../../src/state/StateManager.ts)

**Owns**: Runbook persistence, session state, crash recovery.

**Storage location**: Workspace-local `.coogent/ipc/<sessionDirName>/`

### Managed Files

| File | Purpose | Durability |
|---|---|---|
| `.task-runbook.json` | Current runbook state | Durable (atomic rename) |
| `.wal.json` | Write-ahead log for crash recovery | Transient (deleted after successful write) |
| `.lock` | Advisory file lock (PID-based stale detection) | Runtime-only |
| `.task-runbook.json.tmp` | Intermediate atomic-write target | Transient |

### Write Protocol

All mutations follow the WAL + atomic rename pattern:

1. Acquire `.lock` (via `wx` flag — `O_CREAT | O_EXCL`)
2. Write WAL entry to `.wal.json`
3. Write runbook to `.task-runbook.json.tmp`
4. Atomic rename `.tmp` → `.task-runbook.json`
5. Delete `.wal.json`
6. Release `.lock`

### Crash Recovery

On activation, `StateManager.recoverFromCrash()`:
1. Cleans stale lock files from crashed processes
2. Checks for `.wal.json` existence
3. Validates the WAL snapshot against the runbook schema
4. Re-applies the snapshot via atomic write
5. Promotes recovered data to ArtifactDB (if available)

### Dual-Write with ArtifactDB

When an `ArtifactDB` instance is attached via `setArtifactDB()`:
- **Writes**: DB first (authoritative, throws on failure), then IPC file (best-effort crash-recovery backup)
- **Reads**: DB first (authoritative), falls back to IPC file only for WAL/crash-recovery scenarios
- IPC data is promoted to DB on fallback read to restore the authoritative path

---

## ArtifactDB — Artifact Persistence

**Source**: [`src/mcp/ArtifactDB.ts`](../../src/mcp/ArtifactDB.ts)

**Owns**: All artifact persistence (tasks, phases, handoffs, evaluations, healing attempts, plan revisions, selection audits, worker outputs, phase logs, context manifests, sessions).

**Storage location**: Global `~/…/coogent/artifacts.db`

### Characteristics

| Property | Detail |
|---|---|
| **Engine** | sql.js (SQLite compiled to WASM) |
| **In-memory cache** | All reads served from in-memory sql.js instance |
| **Flush strategy** | Debounced async flush (500ms window), coalesced writes |
| **Atomic writes** | Write to `.tmp`, then `fs.rename` |
| **Multi-window safety** | Reload-before-write merge strategy |
| **Tenant scoping** | All queries filtered by `workspace_id` |
| **Backup** | Periodic snapshots via `ArtifactDBBackup` (5-min interval, max 3 retained) |

### Repository Layer

Seven repository classes provide typed data access, each constructed with the `workspace_id`:

| Repository | Tables |
|---|---|
| `TaskRepository` | `tasks` |
| `PhaseRepository` | `phases`, `worker_outputs`, `phase_logs` |
| `HandoffRepository` | `handoffs` |
| `VerdictRepository` | `evaluation_results`, `healing_attempts` |
| `SessionRepository` | `sessions` |
| `AuditRepository` | `plan_revisions`, `selection_audits` |
| `ContextManifestRepository` | `context_manifests` |

---

## MCP Server — Access Path, Not Persistence

**Source**: `src/mcp/CoogentMCPServer.ts`

The MCP server provides **read and write access** to artifacts via `coogent://` URIs and tool calls. It is **not** a persistence layer — all data flows through to `ArtifactDB`.

| MCP Role | Description |
|---|---|
| **Resources** | Expose artifact data via `coogent://` URIs (read) |
| **Tools** | Accept structured submissions (`submit_phase_handoff`, etc.) that write to ArtifactDB |
| **Tenant resolution** | Resolves workspace context per-operation |

> [!NOTE]
> The MCP server is discoverable globally and bridges the global ArtifactDB with workspace-scoped operations.

---

## IPC — Transient File Exchange

**Source**: Path builders in [`src/constants/paths.ts`](../../src/constants/paths.ts)

IPC files are **transient** — they exist only for the duration of a master↔worker communication cycle.

| Item | Path | Lifecycle |
|---|---|---|
| Request context | `<ipcRoot>/<masterTaskId>/<phaseId>/` | Created before worker spawn |
| Response file | `<ipcRoot>/<masterTaskId>/<phaseId>/response.md` | Written by worker |
| Session runbook | `<ipcRoot>/<sessionDirName>/.task-runbook.json` | Managed by StateManager |

IPC data is cleaned up via TTL and must **never** be treated as durable state.

---

## Persistence Rules

> [!IMPORTANT]
> These rules define the boundaries between subsystems.

| Rule | Description |
|---|---|
| **MCP-first for artifact state** | All artifact reads and writes go through MCP tools/resources → ArtifactDB. No direct DB access from engine or UI |
| **WAL is authoritative for runbook state** | During active execution, the WAL + IPC file is the crash-recovery fallback; DB is the authoritative store |
| **IPC is transient** | IPC exchange files are ephemeral. Never read IPC files as a source of truth for artifact data |
| **No cross-subsystem writes** | StateManager never writes to ArtifactDB tables directly (it uses the repository API). ArtifactDB never touches IPC files |
| **Backups are separate** | `ArtifactDBBackup` manages backup lifecycle independently from `ArtifactDB`'s flush cycle |

---

## Related Documentation

- [Storage Topology](storage-topology.md) — Physical directory layout
- [Tenant Model](tenant-model.md) — Workspace identity and scoping
- [Data Ownership Matrix](data-ownership-matrix.md) — Complete data class reference
