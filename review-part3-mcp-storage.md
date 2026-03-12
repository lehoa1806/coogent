# Code Review — Phase 3: MCP Server, Storage & Data Persistence

> **Reviewer:** Senior Full-Stack Engineer  
> **Scope:** `src/mcp/` — MCP server core, ArtifactDB, repositories, handlers, plugins, sampling  
> **Files reviewed:** 30 files, ~4,700 LOC

---

## Executive Summary

The MCP + storage layer is **well-architected overall**. The separation into handler delegation, repository pattern, schema migration module, and typed interfaces is clean and consistent. Security measures — symlink-aware path traversal guards, ID-format validation, workspace-root allow-listing — are meaningfully above average for extension code.

However, the review uncovered **4 critical**, **6 high**, **10 medium**, and **6 low** severity issues. The most important findings are:

1. **TOCTOU race in multi-window merge** — the reload-before-write strategy has no file locking, enabling data loss under concurrent flush.
2. **SQL injection in `getTableColumns`** — table names are interpolated directly into SQL.
3. **Unscoped queries in TaskRepository.get()** — workspace tenant isolation is bypassed for the composite `get()` query.
4. **Plugin code execution from workspace** — despite approval gating, loaded plugins run with full Node.js capability.

---

## 1. Security & Safety

### 1.1 SQL Injection via Unparameterized Table Name — `ArtifactDB.ts:216`

| Attribute | Value |
|-----------|-------|
| **Severity** | Critical |
| **File** | `ArtifactDB.ts` L216 |
| **Root Cause** | Table name string-interpolated into SQL pragma |

```typescript
// ArtifactDB.ts:216
private static getTableColumns(db: Database, table: string): string[] {
    const rows = db.exec(`PRAGMA table_info(${table})`);  // ← unquoted
    ...
}
```

**Why it matters:** The `table` parameter comes from `TENANT_TABLES` (a hardcoded `const` array) and `'schema_version'` — so this is not *currently* exploitable. However, the method is `private static` with no type-narrowing to those constants. If future refactoring passes user-influenced strings, this becomes a direct injection vector.

Similarly at L296:
```typescript
const rows = source.exec(`SELECT ${cols.map(c => `"${c}"`).join(', ')} FROM "${table}"`);
```
Column names from `PRAGMA table_info` are quoted, but the table name in the `FROM` clause relies only on double-quoting, which is not injection-proof if the value contains `"`.

**Remediation:**
- Narrow the `table` parameter type to `typeof TENANT_TABLES[number] | 'schema_version'`.
- Alternatively, validate against `TENANT_TABLES` at runtime before interpolation.

**Tests:** Unit test passing a table name containing `"; DROP TABLE tasks; --` to a public wrapper to confirm rejection.

---

### 1.2 Workspace Tenant Isolation Bypass — `TaskRepository.get()` 

| Attribute | Value |
|-----------|-------|
| **Severity** | Critical |
| **File** | `repositories/TaskRepository.ts` L96–191 |
| **Root Cause** | Composite query does not filter by `workspace_id` |

```typescript
// TaskRepository.ts:96-97
const taskStmt = this.db.prepare(
    'SELECT ... FROM tasks WHERE master_task_id = ?'
    //                          ^^^ no workspace_id filter
);
```

The `get()` method queries tasks, phases, and handoffs by `master_task_id` alone — without the `workspace_id` constraint applied by `listIds()`, `getLatest()`, and other workspace-scoped methods. In a multi-tenant setup, one workspace can read another workspace's full task data if the `masterTaskId` is known or guessable.

The same issue exists for:
- Phase query at L118–136 (no `workspace_id` filter)
- Handoff query at L138–181 (no `workspace_id` filter)

**Remediation:** Add `AND workspace_id = ?` to all three queries and bind `this.workspaceId`.

**Trade-offs:** Cross-workspace reads may be intentional for certain internal flows (e.g., runbook mirroring). If so, create a separate `getUnscoped()` method and document the authorization model.

**Tests:** Integration test inserting tasks with different `workspaceId` values, confirming scoped `get()` only returns the correct tenant's data.

---

### 1.3 Plugin Arbitrary Code Execution — `PluginLoader.ts:216`

| Attribute | Value |
|-----------|-------|
| **Severity** | Critical |
| **File** | `PluginLoader.ts` L216 |
| **Root Cause** | `import(mainPath)` loads and executes arbitrary code from the workspace |

```typescript
const mod = await import(mainPath);
```

While the approval dialog (SEC-5) gates activation, the `import()` call itself executes the module's top-level code *before* `activate()` is called. A malicious plugin's side effects run during `loadPlugin()`, bypassing the approval check.

**Remediation:**
1. Move `requestApproval()` before `import()`.
2. Alternatively, sandbox plugin loading in a worker thread.
3. At minimum, validate that `mainPath` is strictly under the plugin directory to prevent `../../malicious.js` escapes (current `path.resolve` does not prevent upward traversal).

**Tests:** Create a test plugin whose module top-level writes a sentinel file; verify the sentinel is NOT written when approval is denied.

---

### 1.4 Path Traversal in Plugin `main` Field — `PluginLoader.ts:207`

| Attribute | Value |
|-----------|-------|
| **Severity** | High |
| **File** | `PluginLoader.ts` L207 |
| **Root Cause** | `manifest.main` is not validated for path traversal |

```typescript
const mainPath = path.resolve(pluginDir, manifest.main);
```

A `plugin.json` with `"main": "../../out/extension.js"` would resolve outside the plugin directory, loading arbitrary code. There is no check that `mainPath` stays within `pluginDir`.

**Remediation:**
```typescript
const mainPath = path.resolve(pluginDir, manifest.main);
if (!mainPath.startsWith(pluginDir + path.sep)) {
    log.warn(`[PluginLoader] Path traversal in plugin main: ${manifest.main}`);
    return null;
}
```

**Tests:** Test with `manifest.main = '../../etc/passwd'` and confirm null return.

---

### 1.5 `getConsolidationReport` / `getImplementationPlan` Not Scoped by Workspace — `SessionRepository.ts`

| Attribute | Value |
|-----------|-------|
| **Severity** | Medium |
| **File** | `repositories/SessionRepository.ts` L108–149 |
| **Root Cause** | Queries use `session_dir_name = ?` without `workspace_id` filter |

The `getConsolidationReport()` and `getImplementationPlan()` methods query by `session_dir_name` without workspace scoping. This creates an inconsistency with `list()` and `getLatest()`, which properly filter by `workspace_id`.

**Remediation:** Add `AND s.workspace_id = ?` and bind `this.workspaceId`.

**Tests:** Insert two sessions with same `session_dir_name` but different `workspace_id`; confirm only the correct one is returned.

---

### 1.6 MCPValidator Path Pattern Is Restrictive but Inconsistent

| Attribute | Value |
|-----------|-------|
| **Severity** | Low |
| **File** | `MCPValidator.ts` L93, `tool-schemas.ts` L110, L229 |
| **Root Cause** | Pattern `/^[\w\-./]+$/` rejects valid paths like those with spaces |

The `pathLike` pattern `/^[\w\-./]+$/` is used in both runtime validation and JSON Schema declarations. While restrictive is generally safe, the double-escaping in `tool-schemas.ts` (`'^[\\\\\\\\w\\\\\\\\-./]+$'`) produces a mangled regex that may not behave as intended when the MCP SDK parses the schema.

**Remediation:** 
- Test the actual regex produced by the schema declarations.
- Consider adding `@` to support scoped npm packages in paths (`@scope/package`).

---

## 2. Dataflow & State

### 2.1 TOCTOU Race in Multi-Window Merge — `ArtifactDB.ts:236–309`

| Attribute | Value |
|-----------|-------|
| **Severity** | Critical |
| **File** | `ArtifactDB.ts` L236–309 |
| **Root Cause** | No file lock between disk read and write during flush |

```
Window A: readFile(disk)  →  merge  →  writeFile(disk)
Window B:                    readFile(disk)  →  merge  →  writeFile(disk) ← overwrites A's changes
```

The `reloadAndMergeAsync()` reads the disk file, merges in-memory rows, and writes back. If Window B reads between Window A's read and write, Window B's merge will not include Window A's changes, and Window B's write will overwrite them.

The `flushLock` only serializes flushes within a single process — it does not protect against concurrent processes.

**Why it matters:** The codebase explicitly documents multi-window safety, but the current strategy only guarantees that *the last writer's in-memory state* wins. Updates from other windows written between the read and write are silently lost.

**Remediation:**
1. Use advisory file locking (`fs.flock` via `proper-lockfile` or similar) around the read-merge-write cycle.
2. Alternatively, use SQLite's native WAL mode with file-based locking via `better-sqlite3` instead of sql.js's in-memory approach.
3. As a minimum, reduce the race window by reading the file inside the write lock.

**Trade-offs:** File locking adds a dependency and complexity. The TOCTOU window is small (< 100ms typically), so real data loss is rare but possible during rapid multi-window editing.

**Tests:** Spawn two workers doing concurrent flush loops, verify no row loss using a check query after both complete.

---

### 2.2 Duplicate `Database` and `Statement` Interfaces

| Attribute | Value |
|-----------|-------|
| **Severity** | Medium |
| **File** | `ArtifactDBSchema.ts` L17–34 vs `repositories/db-types.ts` L5–25 |
| **Root Cause** | Same interfaces defined in two places |

`Database` and `Statement` are defined identically in both `ArtifactDBSchema.ts` and `repositories/db-types.ts`. This violates DRY and risks drift. The repositories import from `db-types.ts` while `ArtifactDBSchema.ts` defines its own copy.

**Remediation:** Consolidate into a single `db-types.ts` file and import from there everywhere.

**Tests:** Compile-time check only — no runtime tests needed.

---

### 2.3 `TaskRepository.get()` Ignores Enriched Handoff Fields

| Attribute | Value |
|-----------|-------|
| **Severity** | High |
| **File** | `repositories/TaskRepository.ts` L138–181 |
| **Root Cause** | Handoff SELECT only fetches 5 of 16 columns |

```typescript
const handoffStmt = this.db.prepare(
    'SELECT phase_id, decisions, modified_files, blockers, completed_at FROM handoffs ...'
);
```

The `HandoffRepository.get()` returns all enriched fields (`summary`, `rationale`, `remaining_work`, `constraints_json`, `warnings`, `changed_files_json`, `workspace_folder`, `symbols_touched`). But `TaskRepository.get()` only fetches the 5 original columns. Any code consuming `TaskState.phases[phaseId].handoff` via the task repository will see incomplete handoff data.

**Remediation:** Update the handoff query in `TaskRepository.get()` to fetch all columns and build the full `PhaseHandoff` object, matching `HandoffRepository.get()`.

**Trade-offs:** Increases memory footprint of `getTaskState()`. Consider whether a lightweight vs. full query is actually intentional.

**Tests:** Insert a handoff with all enriched fields, retrieve via `TaskRepository.get()`, assert all fields are present.

---

### 2.4 `MCPClientBridge.submitConsolidationReportJson()` Bypasses MCP Protocol

| Attribute | Value |
|-----------|-------|
| **Severity** | Medium |
| **File** | `MCPClientBridge.ts` L255–264 |
| **Root Cause** | Direct DB access circumvents validation/telemetry |

```typescript
async submitConsolidationReportJson(masterTaskId: string, json: string): Promise<void> {
    const db = this.mcpServer.getArtifactDB?.();
    if (db) {
        db.tasks.upsert(masterTaskId, { consolidationReportJson: json });
    }
}
```

This bypasses:
- `MCPValidator` input validation (masterTaskId format check)
- `WorkerOutputValidator` content validation
- Telemetry boundary event logging
- The MCP protocol entirely (no tool call, no handler invocation)

**Remediation:** Create a proper `submit_consolidation_report_json` MCP tool, or at minimum add inline validation before the direct DB write.

**Tests:** Call with a malformed `masterTaskId` and verify it throws.

---

### 2.5 Repository Flush Scheduling After Failed Transactions

| Attribute | Value |
|-----------|-------|
| **Severity** | Medium |
| **File** | `repositories/HandoffRepository.ts` L96, `ContextManifestRepository.ts` L68 |
| **Root Cause** | `scheduleFlush()` called after successful COMMIT only, but some repos don't use transactions |

In `VerdictRepository.upsertEvaluation()` (L39), `scheduleFlush()` is called unconditionally even though there's no explicit transaction wrapping — if the `run()` fails, the error propagates but `scheduleFlush()` is still invoked. This is actually fine because sql.js operations are synchronous, but the pattern is inconsistent with the transaction-using repositories.

**Remediation:** Standardize: either all multi-statement writes use explicit transactions, or document why some don't need them.

---

## 3. Reliability

### 3.1 `flushSync()` Does Not Update _isDirty Flag

| Attribute | Value |
|-----------|-------|
| **Severity** | High |
| **File** | `ArtifactDB.ts` L414–425 |
| **Root Cause** | Successful `flushSync()` doesn't clear `_isDirty` |

```typescript
private flushSync(): void {
    try {
        const mergedData = this.reloadAndMergeSync();
        const buffer = Buffer.from(mergedData);
        // ... write ...
        // ← _isDirty is never set to false
    } catch (err) {
        log.error(`ArtifactDB: flushSync failed: ${err}`);
    }
}
```

After a successful `flushSync()` (used during `close()`), `_isDirty` remains `true`. While this doesn't cause functional issues (the DB is closed immediately after), it means the `isDirty` getter gives incorrect state if inspected between `flushSync()` and `close()`.

**Remediation:** Add `this._isDirty = false;` after the successful rename.

**Tests:** Call `flushSync()`, assert `isDirty === false`.

---

### 3.2 `PhaseRepository.upsertLog()` Issues Multiple UPDATEs Without WHERE Scoping Bug

| Attribute | Value |
|-----------|-------|
| **Severity** | High |
| **File** | `repositories/PhaseRepository.ts` L121–150 |
| **Root Cause** | Multiple individual UPDATEs per field instead of a single UPDATE |

```typescript
this.db.run('BEGIN');
try {
    this.db.run('INSERT OR IGNORE INTO phase_logs ...', [...]);
    if (fields.prompt !== undefined) {
        this.db.run('UPDATE phase_logs SET prompt = ? WHERE master_task_id = ? AND phase_id = ?', [...]);
    }
    if (fields.requestContext !== undefined) {
        this.db.run('UPDATE phase_logs SET request_context = ? WHERE ...', [...]);
    }
    // ... 4 more individual UPDATEs
    this.db.run('COMMIT');
} catch (e) {
    this.db.run('ROLLBACK');
    throw e;
}
```

This issues up to 8 SQL statements (1 INSERT + 6 UPDATEs + 1 COMMIT) where a single `INSERT ... ON CONFLICT DO UPDATE` could handle all fields. Each UPDATE also lacks `workspace_id` scoping, potentially updating phase logs from a different workspace.

**Remediation:** Replace with a single `INSERT ... ON CONFLICT DO UPDATE SET prompt = COALESCE(?, prompt), ...` pattern matching the other repositories.

**Tests:** Verify that calling `upsertLog()` with partial fields preserves existing values for unspecified fields.

---

### 3.3 `dispose()` Calls Async `disposeAll()` Without Awaiting — `CoogentMCPServer.ts:232–240`

| Attribute | Value |
|-----------|-------|
| **Severity** | High |
| **File** | `CoogentMCPServer.ts` L232–240 |
| **Root Cause** | `dispose()` is synchronous but calls async plugin deactivation |

```typescript
dispose(): void {
    this.pluginLoader?.disposeAll().catch((err) => { ... });  // fire-and-forget
    this.db.close();  // closes DB before plugins finish deactivating
}
```

`disposeAll()` returns a `Promise` that is not awaited. `this.db.close()` executes immediately, potentially while plugins still hold references to the DB. If any plugin's `deactivate()` tries to write to the DB, it will fail silently.

**Remediation:** Make `dispose()` async and await `disposeAll()` before `this.db.close()`. If VS Code's `deactivate()` doesn't await, add a timeout:
```typescript
async dispose(): Promise<void> {
    await Promise.race([
        this.pluginLoader?.disposeAll(),
        new Promise(r => setTimeout(r, 2000)),
    ]);
    this.db.close();
}
```

**Tests:** Mock a plugin that writes on deactivate; verify the write completes before DB close.

---

### 3.4 Silent JSON Parse Failures in `TaskRepository.get()` and `HandoffRepository.get()`

| Attribute | Value |
|-----------|-------|
| **Severity** | Medium |
| **File** | `repositories/TaskRepository.ts` L155–163, `repositories/HandoffRepository.ts` L119–125 |
| **Root Cause** | JSON.parse failures silently return empty arrays |

```typescript
try {
    decisions = JSON.parse(row.decisions) as string[];
    modifiedFiles = JSON.parse(row.modified_files) as string[];
    blockers = JSON.parse(row.blockers) as string[];
} catch {
    decisions = []; modifiedFiles = []; blockers = [];
}
```

If *any one* of the three JSON.parse calls fails, *all three* arrays are reset to empty — even the ones that parsed successfully. This masks data corruption.

**Remediation:** Parse each field independently with separate try/catch blocks.

**Tests:** Store a handoff with valid decisions but corrupted `modified_files`; verify `decisions` is still returned correctly.

---

### 3.5 `ArtifactDBBackup` Does Not Verify Backup Integrity

| Attribute | Value |
|-----------|-------|
| **Severity** | Medium |
| **File** | `ArtifactDBBackup.ts` L45–60 |
| **Root Cause** | Backup is a raw file copy with no integrity check |

Backups are created via `fs.copyFile()` — a raw byte copy. There's no verification that the copy is a valid SQLite database (e.g., by opening it with sql.js and running `PRAGMA integrity_check`). A truncated or mid-write copy could produce a corrupt backup that fails silently on restore.

**Remediation:** After creating the backup, open it with sql.js and run `PRAGMA integrity_check` or at minimum verify the SQLite magic bytes.

**Trade-offs:** Adds ~50ms to backup creation. Given backups happen every 5 minutes, this is acceptable.

**Tests:** Create a backup, truncate it, attempt restore — verify error is thrown.

---

### 3.6 `restoreFromBackup` Does Not Reload In-Memory DB

| Attribute | Value |
|-----------|-------|
| **Severity** | Medium |
| **File** | `ArtifactDBBackup.ts` L130–146 |
| **Root Cause** | Restore writes to disk but doesn't update the live in-memory DB |

```typescript
async restoreFromBackup(backupPath: string): Promise<void> {
    await fsp.copyFile(backupPath, tmpPath);
    await fsp.rename(tmpPath, this.dbPath);
    log.warn('[ArtifactDBBackup] Restart required to reload database from disk.');
}
```

After restoring, the in-memory sql.js database still holds the old state. Subsequent flushes will **overwrite the restored backup** with the stale in-memory data. The log message says "restart required" but there's no enforcement — the system continues running with divergent in-memory and on-disk state.

**Remediation:** After restore, force-close the ArtifactDB and reinitialize from disk, or throw an error that makes continuation impossible.

**Tests:** Restore from backup, trigger a flush, verify the restored data survives.

---

## 4. Code Quality

### 4.1 Duplicate `Database`/`Statement` Interfaces

| Attribute | Value |
|-----------|-------|
| **Severity** | Medium |
| **File** | `ArtifactDBSchema.ts` + `repositories/db-types.ts` |
| **Root Cause** | Same interfaces duplicated in two files |

Already noted in §2.2. Both define `Database`, `Statement`, and `SqlJsStatic`. The `db-types.ts` version has a typed generic overload that `ArtifactDBSchema.ts` lacks.

**Remediation:** Single source of truth in `db-types.ts`, export `SqlJsStatic` from there too.

---

### 4.2 Manual Cascade Deletion is Duplicated — `TaskRepository.ts`

| Attribute | Value |
|-----------|-------|
| **Severity** | Medium |
| **File** | `repositories/TaskRepository.ts` L199–241 |
| **Root Cause** | `delete()` and `deleteChildRecords()` duplicate 8 DELETE statements |

```typescript
delete(masterTaskId: string): void {
    // 10 DELETE statements...
}
deleteChildRecords(masterTaskId: string): void {
    // Same 8 DELETE statements minus sessions/tasks...
}
```

**Remediation:** Extract `deleteChildRecords()` to be used by `delete()`:
```typescript
delete(masterTaskId: string): void {
    this.db.run('BEGIN');
    try {
        this.deleteChildRecordsInternal(masterTaskId);
        this.db.run('DELETE FROM sessions WHERE ...');
        this.db.run('DELETE FROM tasks WHERE ...');
        this.db.run('COMMIT');
    } catch (e) { ... }
}
```

---

### 4.3 `MCPPromptHandler` Composer Functions Are Structurally Identical

| Attribute | Value |
|-----------|-------|
| **Severity** | Low |
| **File** | `MCPPromptHandler.ts` L46–181 |
| **Root Cause** | 5 composer functions all follow the same section-join-messages pattern |

All 5 `compose*` functions follow the exact same pattern: build a sections array, join with `\n\n`, return `[{role:'user',...}, {role:'assistant',...}]`. This could be a single generic function with a configuration object.

**Remediation:** Optional refactor — low impact, but would reduce boilerplate.

---

### 4.4 `_workspaceRoot` Parameter Unused in `MCPClientBridge` Constructor

| Attribute | Value |
|-----------|-------|
| **Severity** | Low |
| **File** | `MCPClientBridge.ts` L32 |
| **Root Cause** | Constructor parameter `_workspaceRoot` is accepted but unused |

```typescript
constructor(mcpServer: CoogentMCPServer, _workspaceRoot: string) {
```

The underscore prefix signals intentional non-use, but the parameter should be removed if it's not needed, or documented if it's planned for future use.

---

### 4.5 `safeTruncate` is Exported from `CoogentMCPServer.ts` — Wrong Module

| Attribute | Value |
|-----------|-------|
| **Severity** | Low |
| **File** | `CoogentMCPServer.ts` L130 |
| **Root Cause** | Utility function coupled to server module |

`safeTruncate()` is a generic string utility exported from the MCP server module. It's imported by `GetModifiedFileContentHandler.ts`. This creates an unnecessary coupling — the handler depends on the server module for a pure function.

**Remediation:** Move `safeTruncate()` to a shared utilities module (e.g., `src/utils/strings.ts`).

---

### 4.6 Inconsistent Error Handling in `ArtifactDBSchema.ts` Migrations

| Attribute | Value |
|-----------|-------|
| **Severity** | Low |
| **File** | `ArtifactDBSchema.ts` L258–297 |
| **Root Cause** | All ALTER TABLE errors silently caught |

```typescript
try { db.run('ALTER TABLE tasks ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0'); } catch { /* already exists */ }
```

This is a well-known SQLite migration pattern, but it silently swallows errors other than "duplicate column name" (e.g., table doesn't exist, disk full). A more robust approach would catch only the specific error code.

**Remediation:** Check `err.message.includes('duplicate column')` or at least log the error at debug level.

---

## 5. Performance

### 5.1 `TaskRepository.get()` Issues 3 Separate Queries — N+1 Risk

| Attribute | Value |
|-----------|-------|
| **Severity** | Medium |
| **File** | `repositories/TaskRepository.ts` L95–191 |
| **Root Cause** | Separate queries for tasks, phases, and handoffs instead of JOINs |

The `get()` method issues 3 sequential `prepare → bind → step` cycles:
1. `SELECT * FROM tasks WHERE ...`
2. `SELECT * FROM phases WHERE ...`  
3. `SELECT * FROM handoffs WHERE ...`

While sql.js operates in-memory (so no I/O latency), this is still 3× the WASM boundary crossings and 3× the statement compilation. For a hot path (called on every resource read), this is suboptimal.

**Remediation:** Use a single JOIN query:
```sql
SELECT t.*, p.phase_id, p.implementation_plan, p.plan_required,
       h.decisions, h.modified_files, h.blockers, h.completed_at
FROM tasks t
LEFT JOIN phases p ON t.master_task_id = p.master_task_id
LEFT JOIN handoffs h ON p.master_task_id = h.master_task_id AND p.phase_id = h.phase_id
WHERE t.master_task_id = ?
```

**Trade-offs:** Single query is faster but returns denormalized rows that need grouping logic. Given the small row counts per task, the overhead is marginal.

---

### 5.2 `MCPResourceHandler.registerListResources()` Performs Nested Loops

| Attribute | Value |
|-----------|-------|
| **Severity** | Medium |
| **File** | `MCPResourceHandler.ts` L44–93 |
| **Root Cause** | For each task, queries all phase IDs, building O(tasks × phases) resources |

```typescript
const taskIds = this.db.tasks.listIds();
for (const taskId of taskIds) {
    // 4 push() calls per task
    const phaseIds = this.db.phases.listIds(taskId);  // ← separate query per task
    for (const phaseId of phaseIds) {
        // 2 push() calls per phase
    }
}
```

This issues `1 + N` queries where `N` = number of tasks. For a busy workspace with 50 tasks and 200 phases, this produces 51 queries and builds an array of ~600 resource objects — on every `ListResources` call.

**Remediation:** 
1. Fetch all phases in one query: `SELECT DISTINCT master_task_id, phase_id FROM phases WHERE workspace_id = ?`.
2. Cache the result if `ListResources` is called frequently.

**Tests:** Benchmark with 100 tasks × 10 phases each and verify < 50ms response time.

---

### 5.3 Full DB Export on Every Flush — `ArtifactDB.ts:377`

| Attribute | Value |
|-----------|-------|
| **Severity** | Medium |
| **File** | `ArtifactDB.ts` L377 |
| **Root Cause** | `db.export()` serializes the entire DB to a Uint8Array on every flush |

The reload-before-write strategy requires exporting the full in-memory database on every flush. As the DB grows (text columns for worker output, consolidation reports), this export becomes increasingly expensive. The 200ms warning threshold at L386 will trigger more frequently.

**Remediation:** 
- Consider switching to `better-sqlite3` for native file-based persistence (eliminates the export step entirely).
- Short-term: Track DB size and escalate warnings at 10MB, 50MB, 100MB thresholds.

---

### 5.4 Missing Index for `phase_logs` Queries

| Attribute | Value |
|-----------|-------|
| **Severity** | Low |
| **File** | `ArtifactDBSchema.ts` (schema SQL) |
| **Root Cause** | No index on `phase_logs(master_task_id, phase_id)` |

The `phase_logs` table uses `(master_task_id, phase_id)` as its primary key, which SQLite automatically indexes. However, `worker_outputs` similarly uses this composite PK but also has a workspace index. `phase_logs` is missing the consistent workspace index that other tables have.

**Remediation:** Add `CREATE INDEX IF NOT EXISTS idx_phase_logs_workspace ON phase_logs(workspace_id);`.

---

### 5.5 Backup Pruning Reads Entire Directory — `ArtifactDB.ts:461`

| Attribute | Value |
|-----------|-------|
| **Severity** | Low |
| **File** | `ArtifactDB.ts` L461 |
| **Root Cause** | `readdir()` reads all entries, filters by prefix |

```typescript
const entries = await fsp.readdir(dbDir);
const backups = entries.filter(f => f.startsWith(backupPrefix)).sort();
```

The `.coogent/` directory may contain many files (session data, IPC files, etc.). Reading all entries just to find 3 backup files is inefficient.

**Remediation:** Use `ArtifactDBBackup.rotateBackups()` instead, which reads from a dedicated backup directory. The inline `backupIfDue()` in `ArtifactDB` duplicates the rotation logic from `ArtifactDBBackup`.

---

## Summary Table

| # | Issue | Severity | Category | File |
|---|-------|----------|----------|------|
| 1.1 | SQL injection via unparameterized table name | Critical | Security | `ArtifactDB.ts` |
| 1.2 | Workspace tenant bypass in `TaskRepository.get()` | Critical | Security | `TaskRepository.ts` |
| 1.3 | Plugin code execution before approval | Critical | Security | `PluginLoader.ts` |
| 2.1 | TOCTOU race in multi-window merge | Critical | Reliability | `ArtifactDB.ts` |
| 1.4 | Path traversal in plugin `main` field | High | Security | `PluginLoader.ts` |
| 2.3 | `TaskRepository.get()` ignores enriched handoff fields | High | Dataflow | `TaskRepository.ts` |
| 3.1 | `flushSync()` doesn't clear `_isDirty` | High | Reliability | `ArtifactDB.ts` |
| 3.2 | `upsertLog()` issues redundant UPDATEs | High | Reliability | `PhaseRepository.ts` |
| 3.3 | `dispose()` doesn't await async plugin disposal | High | Reliability | `CoogentMCPServer.ts` |
| 1.5 | Session queries not workspace-scoped | Medium | Security | `SessionRepository.ts` |
| 2.2 | Duplicate Database/Statement interfaces | Medium | Code Quality | Multiple |
| 2.4 | `submitConsolidationReportJson` bypasses protocol | Medium | Dataflow | `MCPClientBridge.ts` |
| 2.5 | Inconsistent flush scheduling | Medium | Dataflow | Multiple |
| 3.4 | Silent all-or-nothing JSON parse failures | Medium | Reliability | `TaskRepository.ts` |
| 3.5 | No backup integrity verification | Medium | Reliability | `ArtifactDBBackup.ts` |
| 3.6 | Restore doesn't reload in-memory DB | Medium | Reliability | `ArtifactDBBackup.ts` |
| 4.1 | See 2.2 | Medium | Code Quality | — |
| 4.2 | Manual cascade deletion duplicated | Medium | Code Quality | `TaskRepository.ts` |
| 5.1 | 3 separate queries in `get()` | Medium | Performance | `TaskRepository.ts` |
| 5.2 | N+1 query in `ListResources` | Medium | Performance | `MCPResourceHandler.ts` |
| 5.3 | Full DB export on every flush | Medium | Performance | `ArtifactDB.ts` |
| 1.6 | Inconsistent path regex patterns | Low | Security | `MCPValidator.ts` |
| 4.3 | Identical prompt composer boilerplate | Low | Code Quality | `MCPPromptHandler.ts` |
| 4.4 | Unused constructor parameter | Low | Code Quality | `MCPClientBridge.ts` |
| 4.5 | `safeTruncate` in wrong module | Low | Code Quality | `CoogentMCPServer.ts` |
| 4.6 | Overly broad migration error catching | Low | Code Quality | `ArtifactDBSchema.ts` |
| 5.4 | Missing `phase_logs` workspace index | Low | Performance | `ArtifactDBSchema.ts` |
| 5.5 | Backup pruning reads entire directory | Low | Performance | `ArtifactDB.ts` |

---

```json
{
  "decisions": [
    "Prioritized SQL injection and tenant isolation as critical over code quality concerns",
    "Classified TOCTOU race as critical despite small window because multi-window support is explicitly documented",
    "Classified plugin code execution before approval as critical because it defeats the security gate",
    "Treated TaskRepository.get() missing enriched fields as high because it causes silent data loss for downstream consumers",
    "Noted dispose() async issue as high because it can cause DB corruption during shutdown",
    "Kept performance issues at medium because sql.js operates in-memory reducing I/O impact"
  ],
  "modified_files": [
    "review-part3-mcp-storage.md"
  ],
  "unresolved_issues": [
    "Could not access MCP resource server to read implementation plan context",
    "Did not review test files — coverage gaps may exist for the identified issues",
    "The double-escaped regex patterns in tool-schemas.ts need runtime validation to confirm behavior",
    "The interaction between ArtifactDB and ArtifactDBBackup has overlapping backup logic that should be consolidated"
  ],
  "next_steps_context": "Phase 3 review covers the MCP server, storage, and persistence layer. Critical issues to address first: (1) SQL injection in getTableColumns, (2) tenant isolation bypass in TaskRepository.get(), (3) plugin code execution before approval, (4) TOCTOU race in multi-window merge. The ArtifactDB backup system has two overlapping implementations (inline in ArtifactDB.backupIfDue and standalone ArtifactDBBackup class) that should be consolidated. The repository layer is generally well-structured but has inconsistent workspace scoping."
}
```
