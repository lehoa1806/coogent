# Tenant Model

> Workspace identity derivation, tenant scoping rules, and context flow.

---

## Overview

Coogent uses a **single global database** shared across all workspaces on a machine. Data isolation is achieved through a `workspace_id` column present in every tenant-owned table. This model enables MCP discoverability from a known location while maintaining strict per-workspace data boundaries.

---

## Workspace Identity

### `workspace_id` Definition

A `workspace_id` is a **16-hex-character prefix** of the SHA-256 hash of the canonicalized workspace root path. This provides 64 bits of collision resistance — more than sufficient for per-machine workspace scoping.

**Example**: `/Users/dev/projects/my-app` → `a3b8d1f0e9c7254b`

### Derivation Algorithm

The derivation is implemented in [`src/constants/WorkspaceIdentity.ts`](../../src/constants/WorkspaceIdentity.ts):

```typescript
function canonicalize(workspaceRoot: string): string {
    let resolved = path.resolve(workspaceRoot).toLowerCase();
    while (resolved.length > 1 && resolved.endsWith(path.sep)) {
        resolved = resolved.slice(0, -1);
    }
    return resolved;
}

function deriveWorkspaceId(workspaceRoot: string): string {
    const canonical = canonicalize(workspaceRoot);
    return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}
```

| Step | Action | Example |
|---|---|---|
| 1. Resolve | `path.resolve(workspaceRoot)` | `/Users/dev/projects/my-app` |
| 2. Lowercase | `.toLowerCase()` | `/users/dev/projects/my-app` |
| 3. Strip trailing separator | Remove trailing `/` or `\` | `/users/dev/projects/my-app` |
| 4. Hash | SHA-256 of canonical string | `a3b8d1f0e9c7254b...` |
| 5. Truncate | First 16 hex characters | `a3b8d1f0e9c7254b` |

---

## `WorkspaceIdentity` Type

```typescript
interface WorkspaceIdentity {
    readonly workspaceId: string;       // 16-hex-char SHA-256 prefix
    readonly workspaceRootUri: string;  // Canonicalized absolute path
    readonly workspaceName: string;     // basename of the root path
}
```

Create a full identity descriptor via `createWorkspaceIdentity(workspaceRoot)`.

---

## Canonical Access Points

### `StorageBase.getWorkspaceId()`

[`StorageBase`](../../src/constants/StorageBase.ts) is the **canonical access point** for the workspace ID at runtime. It derives the ID in its constructor and exposes it via `getWorkspaceId()`.

```typescript
const storage = createStorageBase(storageUri, workspaceRoot);
const workspaceId = storage.getWorkspaceId();
```

### `deriveWorkspaceId()` for Direct Computation

For contexts where a full `StorageBase` instance isn't available (e.g., CLI tools, tests), use `deriveWorkspaceId()` directly:

```typescript
import { deriveWorkspaceId } from './constants/WorkspaceIdentity.js';
const id = deriveWorkspaceId('/path/to/workspace');
```

---

## Tenant Context Flow

The workspace identity flows through the system in this sequence:

```
Extension Activation
  │
  ├─ 1. StorageBase constructed with workspaceRoot
  │     └─ deriveWorkspaceId(workspaceRoot) → workspaceId stored
  │
  ├─ 2. ArtifactDB.create(dbPath, workspaceId)
  │     └─ workspaceId stored on the ArtifactDB instance
  │
  ├─ 3. Repository constructors receive workspaceId
  │     └─ new TaskRepository(db, flushFn, workspaceId)
  │     └─ new PhaseRepository(db, flushFn, workspaceId)
  │     └─ ... (all 7 repository classes)
  │
  └─ 4. All SQL queries filter by workspace_id
        └─ SELECT ... WHERE workspace_id = ? AND ...
        └─ INSERT ... (workspace_id, ...)
        └─ DELETE ... WHERE workspace_id = ? AND ...
```

---

## Rules

> [!IMPORTANT]
> These rules ensure stable, collision-free tenant identity.

| Rule | Rationale |
|---|---|
| **Never use display names as keys** | Display names can change; the SHA-256 hash of the canonical path is stable |
| **Never use folder order** | In multi-root workspaces, folder order is user-configurable and non-deterministic |
| **Multi-root canonicalization** | Each root in a multi-root workspace gets its own `workspace_id` derived from its individual path |
| **Case-insensitive hashing** | Paths are lowercased before hashing to ensure case-insensitive filesystem parity |
| **Trailing separator stripping** | Removes trailing `/` or `\` so `/foo/bar` and `/foo/bar/` produce the same ID |

---

## Tenant-Owned Tables

All 12 tenant-owned tables include a `workspace_id` column with indexes:

`tasks`, `phases`, `handoffs`, `evaluation_results`, `healing_attempts`, `plan_revisions`, `selection_audits`, `worker_outputs`, `phase_logs`, `context_manifests`, `sessions`, `consolidation_reports`

The sole **non-tenant table** is `schema_version` (system-level migration tracking).

---

## Related Documentation

- [Storage Topology](storage-topology.md) — Physical directory layout
- [Persistence Boundaries](persistence-boundaries.md) — Subsystem data ownership
- [Data Ownership Matrix](data-ownership-matrix.md) — Complete data class reference
