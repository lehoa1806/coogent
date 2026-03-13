# Storage Topology

> Physical layout of global and workspace-local storage directories.

---

## Overview

Coogent uses a **hybrid storage topology** that splits data between two locations:

1. **Global directory** — durable, shared across all workspaces on the machine
2. **Workspace directory** — operational state scoped to a single workspace

This separation exists because:

- **MCP discoverability** requires artifacts to be accessible from a single, well-known location independent of any workspace
- **Artifact history** must persist across workspace opens/closes and survive workspace deletion
- **Execution-local state** (IPC files, PIDs, logs) is transient and workspace-specific — keeping it local simplifies debugging and cleanup

---

## Global Directory

The global directory stores **durable artifacts** that outlive any single workspace session.

### Location by Platform

| Platform | Path |
|---|---|
| macOS | `~/Library/Application Support/Antigravity/coogent/` |
| Windows | `%APPDATA%/Antigravity/coogent/` |
| Linux | `~/.config/antigravity/coogent/` |

### Contents

| Item | Description | Owner |
|---|---|---|
| `artifacts.db` | Global SQLite database (tenant-scoped via `workspace_id`) | `ArtifactDB` |
| `backups/` | Rotating backup snapshots of `artifacts.db` | `ArtifactDBBackup` |

### Path Builders

```typescript
// src/constants/paths.ts
getGlobalCoogentDir()     // → ~/Library/Application Support/Antigravity/coogent/
getGlobalDatabasePath()   // → <globalCoogentDir>/artifacts.db
getGlobalBackupDir()      // → <globalCoogentDir>/backups/
```

---

## Workspace Directory

The workspace directory stores **operational state** scoped to a single workspace root.

### Location

```
<workspaceRoot>/.coogent/
```

This directory must be gitignored. It is created automatically on first use.

### Contents

| Item | Description | Owner |
|---|---|---|
| `ipc/` | Transient exchange files for master↔worker communication | File I/O |
| `ipc/<sessionDirName>/` | Per-session IPC data (`.task-runbook.json`, WAL, lock files) | `StateManager` |
| `pid/` | Worker PID registry (runtime-only) | File I/O |
| `logs/` | Telemetry JSONL run directories | `LogStream` |
| `debug/` | Debug clone output (prompts, plans) — deletable cache | File I/O |
| `plugins/` | MCP plugin directories | `PluginLoader` |
| `workers.json` | Workspace-level agent profile overrides | Config |
| `coogent.log` | Main log stream (rotated) | `LogStream` |
| `sessions/` | Per-session workspace data | `StorageBase` |

### Path Builders

```typescript
// src/constants/paths.ts
getCoogentDir(workspaceRoot)         // → <workspaceRoot>/.coogent/
getIpcRoot(coogentDir)               // → <coogentDir>/ipc/
getSessionDir(coogentDir, dirName)   // → <coogentDir>/ipc/<dirName>/
getPidDir(workspaceRoot)             // → <workspaceRoot>/.coogent/pid/
getPluginsDir(workspaceRoot)         // → <workspaceRoot>/.coogent/plugins/
getWorkersConfigPath(workspaceRoot)  // → <workspaceRoot>/.coogent/workers.json
getTelemetryLogDir(workspaceRoot)    // → <workspaceRoot>/.coogent/logs/
```

---

## Path Authority

[`src/constants/paths.ts`](../../src/constants/paths.ts) is the **single source of truth** for all filesystem paths, directory names, and file names used by Coogent.

[`src/constants/StorageBase.ts`](../../src/constants/StorageBase.ts) provides the **unified storage-base abstraction** that routes durable paths to the global directory and operational paths to the workspace-local directory.

### Routing Logic (`StorageBase`)

```
StorageBase
  ├── getDurableBase()      → getGlobalCoogentDir()       (global)
  ├── getDBPath()           → getGlobalDatabasePath()     (global)
  ├── getBackupDir()        → getGlobalBackupDir()        (global)
  ├── getWorkspaceBase()    → <workspaceRoot>/.coogent/   (local)
  ├── getLogsDir()          → <workspaceBase>/logs/       (local)
  ├── getSessionDir(id)     → <workspaceBase>/sessions/   (local)
  └── getIPCDir()           → <workspaceBase>/ipc/        (local)
```

---

## Prohibited Shortcuts

> [!CAUTION]
> The following patterns are **prohibited** and will lead to data misplacement or loss.

| Anti-Pattern | Why It's Wrong |
|---|---|
| `path.join(workspaceRoot, '.coogent', 'artifacts.db')` | The database lives in the **global** directory, not the workspace |
| Direct `fs.readFile` / `fs.writeFile` on `artifacts.db` | All database I/O must go through `ArtifactDB` (sql.js in-memory + atomic flush) |
| Hardcoded platform paths (e.g., `~/Library/...`) | Use `getGlobalCoogentDir()` which handles platform detection |
| `path.join()` with string literals for storage paths | Use the path builders in `paths.ts` or `StorageBase` methods |

---

## Related Documentation

- [Tenant Model](tenant-model.md) — How workspaces are identified and scoped
- [Persistence Boundaries](persistence-boundaries.md) — Which subsystem owns which data
- [Data Ownership Matrix](data-ownership-matrix.md) — Complete data class reference
