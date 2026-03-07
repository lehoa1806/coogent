# Coogent Context Audit — Refactoring Plan

Distilled from the [full audit report](file:///Users/hoalee1806/workspaces/anti-ex/coogent/docs/review.md) (2026-03-07, 4 audit paths, 13 files reviewed).

---

## Sprint 1 — Critical (Before Next Release)

### 1.1 Replace raw file injection with Pull Model in `buildNextContext()`

> [!CAUTION]
> **CF-1 + CF-2 (HIGH)** — `buildNextContext()` reads raw file contents via `fs.readFile` and injects them into worker prompts, bypassing the 100K token budget entirely. Worst-case: **10M tokens** from a 5-parent DAG.

**Files**: [HandoffExtractor.ts](file:///Users/hoalee1806/workspaces/anti-ex/coogent/src/context/HandoffExtractor.ts#L219-L231), [EngineWiring.ts](file:///Users/hoalee1806/workspaces/anti-ex/coogent/src/EngineWiring.ts#L373)

**Changes**:
1. Replace `fs.readFile` content injection (lines 219–231) with `get_modified_file_content` tool directives
2. Remove `file_contents` from `extractHandoff()` (lines 91–101) — stop persisting raw content in handoff JSON
3. Add `handoffContext` token accounting in `executePhase()` before prompt assembly (lines 342–377)

```diff
 // HandoffExtractor.ts:219-231
 if (report.modified_files.length > 0) {
     lines.push('### Modified Files');
-    for (const relPath of report.modified_files) {
-        const absPath = path.resolve(workspaceRoot, relPath);
-        const content = await fs.readFile(absPath, 'utf-8');
-        lines.push(`\n<<<FILE: ${relPath}>>>`);
-        lines.push(content);
-        lines.push('<<<END FILE>>>');
-    }
+    lines.push('Fetch these files via `get_modified_file_content`:');
+    for (const relPath of report.modified_files) {
+        lines.push(`- \`get_modified_file_content\` → \`${relPath}\``);
+    }
 }
```

**Est. effort**: 2h | **Token impact**: Worst-case drops from 10.1M → 123.5K tokens

---

### 1.2 Add `depends_on` reference integrity validation

> [!WARNING]
> **MF-1 (MEDIUM)** — A typo in `depends_on: [99]` silently blocks the phase forever; the stall watchdog (30s) reports a generic stall, not a config error.

**File**: [SessionController.ts](file:///Users/hoalee1806/workspaces/anti-ex/coogent/src/engine/SessionController.ts#L48)

**Change**: After `detectCycles()`, validate all `depends_on` IDs exist in the runbook:

```typescript
const phaseIds = new Set(runbook.phases.map(p => p.id));
for (const phase of runbook.phases) {
    for (const depId of (phase.depends_on ?? [])) {
        if (!phaseIds.has(depId)) {
            this.engine.transition(EngineEvent.PARSE_FAILURE);
            this.engine.emitUIMessage({
                type: 'ERROR',
                payload: { code: 'VALIDATION_ERROR',
                    message: `Phase ${phase.id} references non-existent dependency: ${depId}` },
            });
            return;
        }
    }
}
```

**Est. effort**: 30m

---

## Sprint 2 — Defense-in-Depth (Next Sprint)

### 2.1 Add `pathLike` validation to `get_modified_file_content`

**MF-2 (MEDIUM)** — `file_path` parameter has type-check only, no regex or `maxLength`, unlike `submit_phase_handoff`'s `modified_files` field.

**File**: [MCPToolHandler.ts](file:///Users/hoalee1806/workspaces/anti-ex/coogent/src/mcp/MCPToolHandler.ts#L329-L334)

| Change | Detail |
|---|---|
| Runtime validation | Add `pathLike` regex `/^[\w\-./]+$/` + `maxLength: 260` to `file_path` |
| JSON Schema | Add `pattern` + `maxLength` to `registerListTools()` declaration |

---

### 2.2 Log warning for missing `mcpPhaseId` on parent phases

**MF-3 (MEDIUM)** — Missing `mcpPhaseId` silently omits warm-start URIs; child starts without parent context.

**File**: [EngineWiring.ts](file:///Users/hoalee1806/workspaces/anti-ex/coogent/src/EngineWiring.ts#L392-L395)

Add `log.warn()` and defense-in-depth status check:
```typescript
if (parentPhase?.mcpPhaseId && parentPhase.status === 'completed') {
    // ... construct URI
} else {
    log.warn(`[executePhase] Parent phase ${parentId} missing mcpPhaseId or not completed`);
}
```

---

### 2.3 Schema hardening

| Item | Finding | File | Change |
|---|---|---|---|
| `additionalProperties: false` | LF-1 (LOW) | `MCPToolHandler.ts:91` | Add to `submit_phase_handoff` schema |
| Remove `file_contents` from `extractHandoff` | LF-4 (LOW) | `HandoffExtractor.ts:91-101` | Stop persisting raw content |
| Purge stale tasks on session reset | LF-5 (LOW) | `SessionController.ts` | Call `purgeTask()` during session switch |

---

## Sprint 3 — Backlog

| Item | Finding | Action |
|---|---|---|
| Consolidate dual-path context injection | LF-2 | Decide: file-based OR MCP-only handoff context |
| Use `Map` for phase lookup in `executePhase()` | LF-3 | Replace `rb.phases.find()` with O(1) Map |
| Surface handoff submission failures to webview | LF-6 | Emit `LOG_ENTRY` on failure at `EngineWiring.ts:172-174` |

---

## Risk Matrix

| ID | Finding | Sev. | Sprint | Exploitable? |
|---|---|---|---|---|
| CF-1 | Raw file injection in `buildNextContext()` | **HIGH** | 1 | Token exhaustion |
| CF-2 | Token budget bypass in `executePhase()` | **HIGH** | 1 | Token exhaustion |
| MF-1 | Missing `depends_on` reference validation | **MED** | 1 | Silent deadlock |
| MF-2 | Path validation asymmetry (submit vs. read) | **MED** | 2 | No (realpath mitigates) |
| MF-3 | Silent `mcpPhaseId` omission | **MED** | 2 | Missing context |
| LF-1–6 | Schema, I/O, logging improvements | **LOW** | 2–3 | No |
