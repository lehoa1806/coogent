# Data Ownership Matrix

> Complete reference of every data class, its owner, scope, location, and source of truth.

---

## Artifact Data (ArtifactDB — Global, Tenant-Scoped)

All rows in these tables are scoped by `workspace_id` and persisted in the global SQLite database.

| Data Class | Owner | Scope | Location | Source of Truth |
|---|---|---|---|---|
| Task/phase artifacts | `ArtifactDB` | Global (tenant-scoped) | `~/…/coogent/artifacts.db` | SQLite row |
| Handoff records | `ArtifactDB` | Global (tenant-scoped) | `~/…/coogent/artifacts.db` | SQLite row |
| Evaluation results | `ArtifactDB` | Global (tenant-scoped) | `~/…/coogent/artifacts.db` | SQLite row |
| Healing attempts | `ArtifactDB` | Global (tenant-scoped) | `~/…/coogent/artifacts.db` | SQLite row |
| Plan revisions | `ArtifactDB` | Global (tenant-scoped) | `~/…/coogent/artifacts.db` | SQLite row |
| Selection audits | `ArtifactDB` | Global (tenant-scoped) | `~/…/coogent/artifacts.db` | SQLite row |
| Context manifests | `ArtifactDB` | Global (tenant-scoped) | `~/…/coogent/artifacts.db` | SQLite row |
| Session metadata | `ArtifactDB` | Global (tenant-scoped) | `~/…/coogent/artifacts.db` | SQLite row |
| Worker outputs | `ArtifactDB` | Global (tenant-scoped) | `~/…/coogent/artifacts.db` | SQLite row |
| Phase logs | `ArtifactDB` | Global (tenant-scoped) | `~/…/coogent/artifacts.db` | SQLite row |
| Consolidation reports | `ArtifactDB` | Global (tenant-scoped) | `~/…/coogent/artifacts.db` | SQLite row |

---

## Runbook & Session State (StateManager — Workspace-Local)

| Data Class | Owner | Scope | Location | Source of Truth |
|---|---|---|---|---|
| Runbook/session persistence | `StateManager` | Workspace | `.coogent/ipc/<session>/` | WAL file |

---

## Infrastructure Data (Global)

| Data Class | Owner | Scope | Location | Source of Truth |
|---|---|---|---|---|
| Database backups | `ArtifactDBBackup` | Global | `~/…/coogent/backups/` | Backup files |
| Schema version | `ArtifactDBSchema` | Global | `~/…/coogent/artifacts.db` | `schema_version` table |

---

## Operational Data (Workspace-Local)

| Data Class | Owner | Scope | Location | Source of Truth |
|---|---|---|---|---|
| IPC exchange files | File I/O | Workspace | `.coogent/ipc/` | Transient files |
| PID files | File I/O | Workspace | `.coogent/pid/` | Runtime-only |
| Logs | `LogStream` | Workspace | `.coogent/logs/` | Log files |
| Debug output | File I/O | Workspace | `.coogent/debug/` | Deletable cache |
| Worker overrides | Config | Workspace | `.coogent/workers.json` | JSON file |
| Plugins | `PluginLoader` | Workspace | `.coogent/plugins/` | Plugin manifest |

---

## Key Source Files

| File | Role |
|---|---|
| [`src/constants/paths.ts`](../src/constants/paths.ts) | Single source of truth for all filesystem paths |
| [`src/constants/StorageBase.ts`](../src/constants/StorageBase.ts) | Hybrid routing abstraction (global vs. local) |
| [`src/constants/WorkspaceIdentity.ts`](../src/constants/WorkspaceIdentity.ts) | `workspace_id` derivation |
| [`src/mcp/ArtifactDB.ts`](../src/mcp/ArtifactDB.ts) | SQLite data-access layer |
| [`src/mcp/ArtifactDBBackup.ts`](../src/mcp/ArtifactDBBackup.ts) | Backup snapshot/restore system |
| [`src/mcp/ArtifactDBSchema.ts`](../src/mcp/ArtifactDBSchema.ts) | DDL, migrations, table definitions |
| [`src/state/StateManager.ts`](../src/state/StateManager.ts) | WAL-backed runbook persistence |

---

## Related Documentation

- [Storage Topology](storage-topology.md) — Physical directory layout
- [Tenant Model](tenant-model.md) — Workspace identity and scoping
- [Persistence Boundaries](persistence-boundaries.md) — Subsystem data ownership
