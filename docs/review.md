# Audit Report — Path 1: The Distillation Phase (Agent → MCP Server)

**Scope**: Trace `submit_phase_handoff` from JSON Schema declaration → runtime validation → TypeScript type → persistence.  
**Date**: 2026-03-07  
**Auditor**: Worker Agent (Generalist Engineer)

---

## Step 1: `submit_phase_handoff` Tool Schema Analysis

**File**: `coogent/src/mcp/MCPToolHandler.ts`, lines 86–141

### Schema Declaration

```typescript
{
  name: 'submit_phase_handoff',
  inputSchema: {
    type: 'object',
    required: ['masterTaskId', 'phaseId', 'decisions', 'modified_files', 'blockers'],
    properties: {
      masterTaskId:    { type: 'string', pattern: MASTER_TASK_ID_PATTERN.source },
      phaseId:         { type: 'string', pattern: PHASE_ID_PATTERN.source },
      decisions:       { type: 'array', items: { type: 'string', maxLength: 500 }, maxItems: 50 },
      modified_files:  { type: 'array', items: { type: 'string', pattern: '^[\\w\\-./]+$', maxLength: 260 }, maxItems: 200 },
      blockers:        { type: 'array', items: { type: 'string', maxLength: 500 }, maxItems: 20 },
    },
  },
}
```

### Findings

| Check | Verdict | Details |
|---|---|---|
| 1. Required fields declared | **PASS** | All 5 fields are in the `required` array (line 92–98) |
| 2. `decisions` has `maxLength` per item | **PASS** | `maxLength: 500` (line 115) — prevents raw code dumps |
| 3. `decisions` has `maxItems` | **PASS** | `maxItems: 50` (line 116) — bounds total payload |
| 4. `modified_files` enforces path pattern | **PASS** | `pattern: '^[\\w\\-./]+$'` (line 124) — only word chars, hyphens, dots, slashes |
| 5. `modified_files` has `maxLength` per item | **PASS** | `maxLength: 260` (line 125) — reasonable path length cap |
| 6. `modified_files` has `maxItems` | **PASS** | `maxItems: 200` (line 127) |
| 7. `blockers` has `maxLength` per item | **PASS** | `maxLength: 500` (line 134) |
| 8. `blockers` has `maxItems` | **PASS** | `maxItems: 20` (line 135) |
| 9. No free-text `notes` field | **PASS** | Only the 5 declared properties exist — no unbounded backdoor fields |
| 10. `additionalProperties` restriction | **INFO** | `additionalProperties: false` is NOT declared. The JSON Schema allows extra keys. However, the handler (Step 2) only reads the 5 known keys, so extra keys are silently ignored and never persisted. **Risk: LOW** — cosmetic, not exploitable. |

### Comment D-1/D-2

The schema annotations at lines 112, 119, 131 (comments `D-1`, `D-2`) confirm these constraints were intentionally designed as part of the Pointer Method enforcement.

---

## Step 2: Runtime Validation in `handleSubmitPhaseHandoff`

**File**: `coogent/src/mcp/MCPToolHandler.ts`, lines 257–304  
**File**: `coogent/src/mcp/MCPValidator.ts`, lines 1–91

### Handler Trace (lines 257–304)

```typescript
// Line 260-261: ID validation
const masterTaskId = MCPValidator.validateMasterTaskId(args['masterTaskId']);
const phaseId      = MCPValidator.validatePhaseId(args['phaseId']);

// Line 263-266: decisions — maxItemLength: 500, maxItems: 50
const decisions = MCPValidator.validateStringArray(
    args['decisions'], 'decisions',
    { maxItemLength: 500, maxItems: 50 }
);

// Line 267-270: modified_files — maxItemLength: 260, maxItems: 200, pathLike: true
const modifiedFiles = MCPValidator.validateStringArray(
    args['modified_files'], 'modified_files',
    { maxItemLength: 260, maxItems: 200, pathLike: true }
);

// Line 271-274: blockers — maxItemLength: 500, maxItems: 20
const blockers = MCPValidator.validateStringArray(
    args['blockers'], 'blockers',
    { maxItemLength: 500, maxItems: 20 }
);
```

### Validator Analysis (`MCPValidator.ts`)

| Check | Verdict | Details |
|---|---|---|
| 1. Every field goes through MCPValidator before persistence | **PASS** | All 5 fields are validated: `masterTaskId` (line 260), `phaseId` (line 261), `decisions` (line 263), `modified_files` (line 267), `blockers` (line 271) |
| 2. `validateStringArray` enforces `maxItemLength`, `maxItems`, `pathLike` | **PASS** | See `MCPValidator.ts` lines 66-88: checks array type, `maxItems` cap, per-item string type, `maxItemLength`, and `pathLike` regex `/^[\w\-./]+$/` |
| 3. Who is the sole runtime gate? | **MCPValidator is the sole gate** | Comment at `MCPValidator.ts` line 15-16: *"The MCP SDK does NOT validate `arguments` against the declared JSON Schema, so these methods are the sole enforcement gate for runtime constraints."* |
| 4. Runtime constraints match schema declarations? | **PASS** | All values are identical between schema and runtime calls: |

**Constraint Parity Table**:

| Field | Schema `maxLength` | Runtime `maxItemLength` | Schema `maxItems` | Runtime `maxItems` | Schema `pattern` | Runtime `pathLike` |
|---|---|---|---|---|---|---|
| `decisions` | 500 | 500 | 50 | 50 | — | — |
| `modified_files` | 260 | 260 | 200 | 200 | `^[\w\-./]+$` | `true` (same regex at line 82) |
| `blockers` | 500 | 500 | 20 | 20 | — | — |

**Parity: PERFECT** — no mismatches between schema declarations and runtime enforcement.

---

## Step 3: `PhaseHandoff` TypeScript Interface

**File**: `coogent/src/mcp/types.ts`, lines 22–35

```typescript
export interface PhaseHandoff {
    phaseId: string;        // Bounded by PHASE_ID_PATTERN at runtime
    masterTaskId: string;   // Bounded by MASTER_TASK_ID_PATTERN at runtime
    decisions: string[];    // Bounded at runtime: 50 items × 500 chars
    modifiedFiles: string[];// Bounded at runtime: 200 items × 260 chars, path-like
    blockers: string[];     // Bounded at runtime: 20 items × 500 chars
    completedAt: number;    // Set internally by handler (line 282), not from agent input
}
```

| Check | Verdict | Details |
|---|---|---|
| 1. Unbounded string fields? | **PASS** | `phaseId` and `masterTaskId` are regex-bounded at runtime. Array items are length-capped. |
| 2. `modifiedFiles` typed correctly? | **PASS** | Typed as `string[]` — file paths only, not objects or `any` |
| 3. Optional backdoor fields? | **PASS** | No optional fields exist. All 6 fields are required in the interface. `completedAt` is server-generated (line 282), not from agent input. |

---

## Step 4: Persistence Verification

**File**: `coogent/src/mcp/ArtifactDB.ts`, lines 452–493

### `upsertHandoff(handoff: PhaseHandoff)` Trace

```typescript
// Line 453: Destructure the validated handoff directly
const { masterTaskId, phaseId, decisions, modifiedFiles, blockers, completedAt } = handoff;

// Lines 456-492: Transactional persistence
this.db.run('BEGIN');
// ... ensure parent rows exist ...
this.db.run(
    `INSERT INTO handoffs ... VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT ... DO UPDATE SET ...`,
    [masterTaskId, phaseId,
     JSON.stringify(decisions),      // Serialized as JSON string
     JSON.stringify(modifiedFiles),   // Serialized as JSON string
     JSON.stringify(blockers),        // Serialized as JSON string
     completedAt]
);
this.db.run('COMMIT');
```

| Check | Verdict | Details |
|---|---|---|
| 1. Saves validated handoff without transformation? | **PASS** | The `PhaseHandoff` object constructed at lines 276–283 is passed directly to `upsertHandoff`. No field additions, no mutations. |
| 2. No raw content injection via persistence? | **PASS** | Arrays are `JSON.stringify()`-d. The inverse `JSON.parse()` in `getHandoff()` (lines 521-524) has defensive try/catch. |
| 3. Transactional integrity? | **PASS** | `BEGIN`/`COMMIT`/`ROLLBACK` wrapper (lines 455-491). |
| 4. DB schema matches type? | **PASS** | `handoffs` table (lines 55-64) stores `decisions`, `modified_files`, `blockers` as `TEXT NOT NULL` — JSON strings of validated arrays. |

---

## Summary Verdict

| Audit Step | Verdict | Risk |
|---|---|---|
| Step 1: Schema Declaration | **PASS** | LOW |
| Step 2: Runtime Validation | **PASS** | NONE |
| Step 3: TypeScript Type | **PASS** | NONE |
| Step 4: Persistence | **PASS** | NONE |

### Overall: ✅ PASS

The `submit_phase_handoff` pipeline strictly enforces the Pointer Method:

1. **No unbounded fields** — every string array field has `maxItemLength` and `maxItems` caps
2. **Path enforcement** — `modified_files` only accepts `^[\w\-./]+$` patterns, preventing raw code content
3. **Defense in depth** — schema declarations and runtime validators are in perfect parity
4. **No backdoor fields** — no optional `notes`, `context`, or free-text field exists
5. **Clean persistence** — validated `PhaseHandoff` is saved directly without mutation

### Recommendations (LOW priority)

1. **Add `additionalProperties: false`** to the `submit_phase_handoff` `inputSchema` (line 91). While extra properties are harmlessly ignored, explicitly forbidding them is a defense-in-depth best practice and documents intent.

2. **Consider `maxLength` on `masterTaskId` and `phaseId`** in the schema. Although the regex patterns already bound these values, an explicit `maxLength: 80` would add a schema-level guard.

---

```json
{
  "decisions": [
    "Confirmed all 5 required fields of submit_phase_handoff have schema-level and runtime-level constraints in perfect parity",
    "Verified MCPValidator is the sole runtime enforcement gate since the MCP SDK does not validate JSON Schema arguments",
    "Confirmed no unbounded free-text fields exist in the PhaseHandoff interface",
    "Verified persistence layer saves the validated handoff directly without transformation via JSON.stringify of bounded arrays",
    "Identified one LOW-risk cosmetic improvement: additionalProperties: false is not declared on the schema"
  ],
  "modified_files": [],
  "unresolved_issues": [
    "additionalProperties: false is not declared on the submit_phase_handoff inputSchema — extra keys are silently ignored but this is a defense-in-depth gap (LOW risk)"
  ],
  "next_steps_context": "Path 1 audit is PASS. The distillation pipeline (Agent → MCP Server) enforces the Pointer Method correctly. Schema constraints, runtime validation (MCPValidator), TypeScript types (PhaseHandoff), and persistence (ArtifactDB.upsertHandoff) are all aligned with no content-dump vectors. The only minor recommendation is adding additionalProperties: false to the schema for completeness."
}
```

# Audit Path 2: The Bootstrapping Phase (Orchestrator → New Agent)

## Summary

This audit traced the full prompt assembly pipeline from `executePhase()` in `EngineWiring.ts` through `HandoffExtractor.buildNextContext()` and `ADKController.buildInjectionPrompt()`. A **confirmed Pull Model violation** was found in `HandoffExtractor.buildNextContext()` — raw file contents are read from disk and injected verbatim into the worker prompt with no truncation or token budget enforcement.

---

## Step 1: Prompt Assembly Pipeline in EngineWiring.ts

### `executePhase()` — Lines 269–403

The full prompt assembly chain in order:

1. **Line 293** — `contextScoper.assemble(phase, workspaceRoot)`: Assembles context payload from `phase.context_files`. This path is correctly budgeted (100K token limit) and uses `TokenPruner` to stay within budget. However, this payload is used for token budget validation only — it is NOT directly injected into `effectivePrompt`.

2. **Line 346** — `handoffExtractor.buildNextContext(phase, currentSessionDir, workspaceRoot)`: Returns a string containing handoff metadata AND raw file contents from all `depends_on` phases. **This is the violation.**

3. **Line 356–358** — Worker profile injection: Prepends `## Worker Role: <name>\n<system_prompt>` to the effective prompt. This is clean metadata, no violation.

4. **Line 367** — `handoffExtractor.generateDistillationPrompt(phase.id)`: Returns the JSON handoff instruction block. Clean, no violation.

5. **Lines 368–377** — Final `effectivePrompt` assembly:
   ```typescript
   let effectivePrompt = phase.prompt;                                    // L368
   if (workerSystemContext) {
       effectivePrompt = `${workerSystemContext}${effectivePrompt}`;       // L370
   }
   if (handoffContext) {
       effectivePrompt = `# Context from Previous Phases\n\n${handoffContext}\n---\n\n${effectivePrompt}`; // L373
   }
   if (distillationPrompt) {
       effectivePrompt = `${effectivePrompt}\n\n---\n\n${distillationPrompt}`; // L376
   }
   ```

6. **Line 402** — `adkController.spawnWorker(effectivePhase, timeoutMs, masterTaskId, mcpResourceUris)`: The `effectivePhase` now contains the full concatenated prompt including raw file contents from `handoffContext`.

### Key Observation

Line 373 directly injects `handoffContext` (which contains raw file contents) into the prompt string. This bypasses the token budget enforcement from `contextScoper.assemble()` entirely — the budget check at lines 295–315 only validates `context_files`, not handoff context.

---

## Step 2: Deep-Dive into HandoffExtractor.buildNextContext()

### File: `coogent/src/context/HandoffExtractor.ts`, Lines 178–239

```typescript
async buildNextContext(
    phase: Phase,
    sessionDir: string,
    workspaceRoot: string,
): Promise<string> {
    const dependsOn: readonly PhaseId[] = phase.depends_on ?? [];
    if (dependsOn.length === 0) {
        return '';  // L191: Early exit — no dependencies, no context
    }

    const sections: string[] = [];

    for (const depId of dependsOn) {
        const report = await this.loadHandoff(depId, sessionDir);  // L196: Load from disk
        // ... metadata assembly (decisions, issues, next_steps) ...

        // ─── CRITICAL VIOLATION: Lines 219–231 ───
        if (report.modified_files.length > 0) {
            lines.push('### Modified Files');
            for (const relPath of report.modified_files) {
                const absPath = path.resolve(workspaceRoot, relPath);  // L222
                try {
                    const content = await fs.readFile(absPath, 'utf-8');  // L224: RAW READ
                    lines.push(`\n<<<FILE: ${relPath}>>>`);               // L225
                    lines.push(content);                                  // L226: RAW INJECTION
                    lines.push('<<<END FILE>>>');                         // L227
                } catch {
                    lines.push(`\n_Could not read: ${relPath}_`);         // L229
                }
            }
        }
    }

    return sections.join('\n---\n\n');  // L238: Concatenated and returned
}
```

### Line-by-line analysis:

1. **Line 188**: Correctly reads `depends_on` phase IDs from the phase definition.
2. **Line 196**: Loads handoff reports from disk via `loadHandoff()` — reads `handoffs/phase-{id}.json`.
3. **Lines 219–231**: **CONFIRMED VIOLATION** — For each file in `report.modified_files`, it calls `fs.readFile(absPath, 'utf-8')` and pushes the **entire file content** into the context string.
4. **No truncation**: There is zero truncation, zero token counting, and zero size limit on individual files or total payload.
5. **No path validation**: Unlike `ContextScoper.assemble()`, there is no path traversal check, no symlink boundary validation, and no binary file rejection.

### Double reading in extractHandoff():

Additionally, `extractHandoff()` (lines 91–101) ALSO reads raw file contents and stores them in `report.file_contents`. This means files are read TWICE:
- Once during extraction (stored in the persisted JSON report)
- Once again during `buildNextContext()` (re-read from disk for "freshness")

---

## Step 3: ADKController.buildInjectionPrompt() Verification

### File: `coogent/src/adk/ADKController.ts`, Lines 524–577

**Finding B-1: Pull Model correctly enforced for `context_files`**

```typescript
// Lines 536-549:
// B-1: enforce the Pull Model / Pointer Method.
// When the phase declares context_files, emit MCP tool-call directives
// so the worker fetches content on demand — never inject raw file bytes.
if (phase.context_files && phase.context_files.length > 0) {
    const fileUris = phase.context_files.map(
        (f) => `- \`get_modified_file_content\` → \`${f}\``
    );
    sections.push(
        ``,
        `## Context Files`,
        `Fetch the following files via the MCP tool \`get_modified_file_content\`. Do NOT guess their content.`,
        ...fileUris
    );
}
```

✅ **COMPLIANT**: `context_files` are emitted as MCP tool-call directives (`get_modified_file_content`), not raw content. Workers must pull content on-demand.

**MCP Resource URIs correctly injected:**

```typescript
// Lines 552-573:
if (mcpResourceUris) {
    // ... emits coogent:// URIs for implementationPlan and parentHandoffs
}
```

✅ **COMPLIANT**: MCP URIs are injected as pointers, not raw data.

**No raw JSON stringified into the prompt:**

✅ **COMPLIANT**: `buildInjectionPrompt()` only concatenates string sections containing task prompt text, tool-call directives, and URI references. No `JSON.stringify()` of data structures.

### However:

The `buildInjectionPrompt()` method operates on `phase.prompt` — which at this point has ALREADY been mutated by `executePhase()` to include the raw `handoffContext`. So by the time `buildInjectionPrompt` runs at line 183 of `spawnWorker()`, the damage is already done. The raw file contents are embedded inside `phase.prompt`.

---

## Step 4: Token Blast Radius Calculation

### Constraints from Phase 1:

- `modified_files`: array of strings, **no maximum item count enforced** in the handoff JSON schema
- `buildNextContext()`: reads **ALL** files with **NO truncation**
- `ContextScoper`: has 10 MB per-file limit and 100K token budget — but these guards are **NOT applied** to `buildNextContext()`

### Worst-case scenario:

| Parameter | Value |
|---|---|
| Files per parent handoff | 200 (no limit enforced) |
| Parent dependencies | 5 (DAG allows multiple `depends_on`) |
| Average file size | 500 lines × 80 chars = 40,000 chars |
| Chars per token | ~4 (CharRatioEncoder) |
| Tokens per file | ~10,000 |
| Total files | 200 × 5 = 1,000 |
| **Total tokens** | **1,000 × 10,000 = 10,000,000 tokens** |

Even with conservative numbers (1 parent, 50 files, 200 lines each):

| Parameter | Value |
|---|---|
| Files | 50 |
| Tokens per file | 4,000 |
| **Total tokens** | **200,000 tokens** |

This is **2× the configured token budget** of 100,000 — and it completely bypasses the `ContextScoper` budget check.

### Additional risk: The 2 MB output accumulator cap (line 207 of `EngineWiring.ts`) limits the WORKER OUTPUT but does NOT limit what goes INTO the worker prompt.

---

## Step 5: Findings Report

### Finding B-1: Pull Model status for `context_files` in `buildInjectionPrompt`

**Status: ✅ COMPLIANT**

`ADKController.buildInjectionPrompt()` (lines 536–549) correctly implements the Pull Model. `context_files` are emitted as `get_modified_file_content` tool-call directives. No raw file bytes are injected.

MCP resource URIs (lines 552–573) are also correctly injected as `coogent://` pointers.

---

### Finding B-2: Pull Model violation in `buildNextContext`

**Status: ❌ VIOLATION — HIGH SEVERITY**

**Location**: `coogent/src/context/HandoffExtractor.ts`, lines 219–231

**Evidence**: `buildNextContext()` reads raw file contents from disk via `fs.readFile(absPath, 'utf-8')` (line 224) and concatenates them directly into the returned context string (line 226). No truncation, no token counting, no binary rejection, no path traversal validation.

**Root cause**: The function was designed before MCP URIs were available, implementing a "push" approach to file context that predates the Pull Model architecture.

**Secondary issue**: `extractHandoff()` (lines 91–101) also reads raw file contents and persists them in `file_contents` field of the handoff JSON. This doubles disk I/O and stores potentially sensitive file contents in plaintext JSON files.

**Missing security guards** (compared to `ContextScoper.assemble()`):
- No path traversal / symlink boundary check
- No binary file rejection
- No file size limit (ContextScoper caps at 10 MB)
- No token budget enforcement
- No `SecretsGuard` scanning

---

### Finding B-3: Raw content injection in `executePhase` prompt assembly pipeline

**Status: ❌ VIOLATION — HIGH SEVERITY**

**Location**: `coogent/src/EngineWiring.ts`, line 373

**Evidence**:
```typescript
effectivePrompt = `# Context from Previous Phases\n\n${handoffContext}\n---\n\n${effectivePrompt}`;
```

The `handoffContext` string (produced by `buildNextContext()`) contains raw file contents. It is concatenated directly into `effectivePrompt` with no size check or token validation. This prompt is then passed to `adkController.spawnWorker()` at line 402.

**Impact**: The token budget validation at lines 293–315 (via `contextScoper.assemble()`) does NOT account for `handoffContext`. A phase can pass the budget check and still inject an arbitrarily large prompt due to handoff context.

---

### Token Impact Assessment

| Scenario | Files | Tokens/File | Total Injection |
|---|---|---|---|
| Realistic (1 parent, 10 files, 300 lines) | 10 | 6,000 | **60,000** |
| Moderate (2 parents, 30 files, 300 lines) | 60 | 6,000 | **360,000** |
| Worst-case (5 parents, 200 files, 500 lines) | 1,000 | 10,000 | **10,000,000** |

The configured token budget is 100,000. Even the "realistic" scenario consumes 60% of the budget without being counted against it.

---

### Recommended Fix

**Primary fix**: Remove file content injection from `buildNextContext()` entirely. Replace with MCP URI references that workers can pull on-demand.

```typescript
// BEFORE (lines 219-231):
if (report.modified_files.length > 0) {
    lines.push('### Modified Files');
    for (const relPath of report.modified_files) {
        const absPath = path.resolve(workspaceRoot, relPath);
        const content = await fs.readFile(absPath, 'utf-8');  // ❌ Raw injection
        lines.push(`\n<<<FILE: ${relPath}>>>`);
        lines.push(content);
        lines.push('<<<END FILE>>>');
    }
}

// AFTER:
if (report.modified_files.length > 0) {
    lines.push('### Modified Files');
    lines.push('Fetch these files via `get_modified_file_content`:');
    for (const relPath of report.modified_files) {
        lines.push(`- \`get_modified_file_content\` → \`${relPath}\``);  // ✅ Pull Model
    }
}
```

**Secondary fix**: Remove `file_contents` from `extractHandoff()` to stop persisting raw file contents in handoff JSON reports. The MCP `get_modified_file_content` tool already provides on-demand access.

**Tertiary fix**: Add token accounting for `handoffContext` in `executePhase()` before passing to `spawnWorker()`, or enforce a dedicated budget cap for handoff context.

---

```json
{
  "decisions": [
    "Confirmed Finding B-1: buildInjectionPrompt correctly implements Pull Model for context_files — emits get_modified_file_content directives, not raw file bytes",
    "Confirmed Finding B-2: buildNextContext() at HandoffExtractor.ts:219-231 violates Pull Model by reading raw file contents via fs.readFile() and injecting them into the context string with NO truncation",
    "Confirmed Finding B-3: executePhase() at EngineWiring.ts:373 concatenates raw handoffContext (containing file contents) directly into effectivePrompt, completely bypassing the ContextScoper token budget",
    "Identified secondary violation: extractHandoff() at HandoffExtractor.ts:91-101 reads and persists raw file_contents in handoff JSON — doubles disk I/O and stores sensitive data in plaintext",
    "Calculated worst-case token blast radius: 10M tokens for 5-parent DAG with 200 files per parent, far exceeding the 100K configured budget"
  ],
  "modified_files": [],
  "unresolved_issues": [
    "buildNextContext() lacks all security guards that ContextScoper provides: path traversal check, symlink boundary validation, binary rejection, file size limit, SecretsGuard scanning",
    "No maximum item count enforced on modified_files in the handoff JSON schema — worker agents can declare arbitrarily many files",
    "The file_contents field in HandoffReport is persisted in plaintext JSON on disk — may contain secrets that SecretsGuard would catch if applied",
    "handoffContext token cost is invisible to the ContextScoper budget system — a phase can pass budget validation and still produce an over-budget prompt"
  ],
  "next_steps_context": "The primary remediation is replacing raw file content injection in buildNextContext() with get_modified_file_content MCP tool directives (Pull Model). Secondary: remove file_contents from extractHandoff() and HandoffReport interface. Tertiary: add handoffContext to the token budget accounting in executePhase(). All three files — HandoffExtractor.ts, EngineWiring.ts — need modification. ADKController.ts buildInjectionPrompt() is clean and should NOT be changed."
}
```

# Audit Path 3: The Retrieval Phase (New Agent → MCP Server → IDE)

## Summary

This audit traced the `get_modified_file_content` MCP tool from invocation through authorization, sandbox boundary enforcement, file-not-found handling, and token-safe truncation. The implementation is **generally well-defended** with proper `realpath`-based symlink resolution, authorization gate via `db.getTask()`, and surrogate-pair-safe truncation. One **medium-severity gap** was identified: `file_path` input validation is weaker than `modified_files` validation in `submit_phase_handoff`, creating a path validation asymmetry.

---

## Step 1: Trace handleGetModifiedFileContent()

### File: `coogent/src/mcp/MCPToolHandler.ts`, Lines 329–393

### 1a. Authorization Gate (R-3) — Lines 332–347

```typescript
const masterTaskId = MCPValidator.validateMasterTaskId(args['masterTaskId']);  // L332
const phaseId = MCPValidator.validatePhaseId(args['phaseId']);                 // L333
const filePath = MCPValidator.validateString(args['file_path'], 'file_path'); // L334

const task = this.db.getTask(masterTaskId);  // L343
if (!task) {                                  // L344
    log.warn(`[MCPToolHandler] R-3: Unauthorized file read attempt for task ${masterTaskId}.`);
    throw new Error('Unauthorized');           // L346
}
```

**Analysis:**

- ✅ `masterTaskId` is validated against the strict regex `MASTER_TASK_ID_PATTERN` (`/^\d{8}-\d{6}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/`) — syntactic injection is impossible.
- ✅ `phaseId` is validated against `PHASE_ID_PATTERN` (`/^phase-\d{3}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/`) — syntactic injection is impossible.
- ✅ Authorization check: `this.db.getTask(masterTaskId)` queries ArtifactDB (SQLite). For unknown IDs, it returns `undefined`, causing the `if (!task)` guard to throw `Error('Unauthorized')`.
- ⚠️ **Limitation**: The authorization gate checks that the `masterTaskId` *exists in the database*, not that the specific *worker/caller* is authorized for that task. Any agent with a valid `masterTaskId` (from a previous session still in the DB) can read files. This is acceptable because the MCP transport is local-only (stdio), so there's no cross-session attack vector unless the DB retains stale tasks.
- ⚠️ **Note**: `phaseId` is validated syntactically but never checked against the DB — a fabricated `phaseId` with a valid `masterTaskId` would pass. This is low-risk since `phaseId` is only used for logging (line 379), not for any access decision.

### 1b. Sandbox Boundary (B-2) — Lines 349–362

```typescript
let resolved: string;
let realWorkspaceRoot: string;
try {
    resolved = await fs.realpath(path.resolve(this.workspaceRoot, filePath));       // L353
    realWorkspaceRoot = await fs.realpath(this.workspaceRoot);                      // L354
} catch {
    log.warn(`[MCPToolHandler] File not found (realpath): ${filePath}`);
    throw new Error('File not found');                                               // L357
}
if (!resolved.startsWith(realWorkspaceRoot + path.sep) && resolved !== realWorkspaceRoot) {  // L359
    log.warn(`[MCPToolHandler] Path traversal blocked: ${filePath}`);
    throw new Error('Access denied');                                                // L361
}
```

**Analysis:**

- ✅ `fs.realpath()` is called on BOTH the requested file path AND the workspace root BEFORE the boundary check — symlink-based traversal is prevented.
- ✅ Boundary check uses `resolved.startsWith(realWorkspaceRoot + path.sep)` — includes the trailing `path.sep` to prevent matching `/workspace-evil` against `/workspace`.
- ✅ The `resolved !== realWorkspaceRoot` fallback allows reading the workspace root itself (edge case for monorepo configs).
- ✅ Path traversal with `../../etc/passwd` would: (1) resolve via `path.resolve()` to an absolute path, (2) be canonicalized by `fs.realpath()`, (3) fail the `startsWith` check → `Access denied`.
- ✅ If `realpath()` throws (file doesn't exist), the catch block throws a generic `Error('File not found')` — no path information is leaked in the error.

**Edge case — `filePath` is absolute**: `path.resolve(workspaceRoot, '/etc/passwd')` returns `/etc/passwd` on POSIX. However, `fs.realpath('/etc/passwd')` would resolve it, and the `startsWith` check would reject it. ✅ Safe.

### 1c. File-Not-Found Handling — Lines 352–358, 384–391

Two distinct error paths:

| Error Source | Condition | Error Thrown | Log Message |
|---|---|---|---|
| `realpath()` failure (L355) | File doesn't exist, broken symlink, or permissions | `Error('File not found')` | `File not found (realpath): ${filePath}` |
| `readFile()` ENOENT (L386) | File deleted between realpath and read (TOCTOU) | `Error('File not found')` | `File not found (readFile): ${filePath}` |
| `readFile()` other error (L390) | Permissions, I/O errors | `Error('Failed to read file')` | `File read error: ${filePath}` |

**Analysis:**

- ⚠️ Both `realpath` failure and `readFile` ENOENT throw the same `Error('File not found')` message. The caller cannot distinguish between "file never existed" (pre-boundary) and "file vanished after boundary check" (TOCTOU). However, the log messages ARE distinct with `(realpath)` vs `(readFile)` prefixes.
- ✅ Non-ENOENT errors (permissions, I/O) throw `Error('Failed to read file')` — distinguishable from not-found cases.
- ✅ No sensitive path information is leaked in the error messages returned to the caller — only logged internally.

### 1d. Token-Safe Truncation — Lines 364–377

```typescript
const rawContent = await fs.readFile(resolved, 'utf-8');
const MAX_FILE_CHARS = 32_000;                                    // L366
const isTruncated = rawContent.length > MAX_FILE_CHARS;            // L367
let safeContent: string;
if (isTruncated) {
    const lineCount = rawContent.split('\n').length;
    safeContent = safeTruncate(rawContent, MAX_FILE_CHARS) +       // L372: surrogate-pair safe
        `\n\n[TRUNCATED: ${rawContent.length} chars / ~${lineCount} lines total; ` +
        `showing first ${MAX_FILE_CHARS} chars. Re-invoke with a narrower file_path or specific line range.]`;
} else {
    safeContent = rawContent;                                       // L376
}
```

**Analysis:**

- ✅ `MAX_FILE_CHARS = 32_000` — reasonable limit (~8K tokens at 4 chars/token).
- ✅ `safeTruncate()` is used for the actual slice operation (surrogate-pair safety verified in Step 3).
- ✅ The truncation message instructs the agent to "re-invoke with a narrower file_path or specific line range" — proper guidance for the worker.
- ✅ **Off-by-one check**: `isTruncated = rawContent.length > MAX_FILE_CHARS` (strict greater-than). A file of exactly 32,000 chars would return `false` for `isTruncated` and be served in full. A file of 32,001 chars would be truncated. No off-by-one issue.
- ⚠️ **Minor**: The truncation message appended at L372-373 itself adds characters beyond `MAX_FILE_CHARS`, meaning the total `safeContent` could be up to ~32,150 chars. This is acceptable since the truncation metadata is small and helps the agent understand the truncation.

---

## Step 2: MCPValidator Gate Verification

### `handleGetModifiedFileContent` validation chain:

| Parameter | Validator | Pattern Enforced |
|---|---|---|
| `masterTaskId` | `MCPValidator.validateMasterTaskId()` | `/^\d{8}-\d{6}-[0-9a-f]{8}-...-[0-9a-f]{12}$/` |
| `phaseId` | `MCPValidator.validatePhaseId()` | `/^phase-\d{3}-[0-9a-f]{8}-...-[0-9a-f]{12}$/` |
| `file_path` | `MCPValidator.validateString()` | **Type check only — no path pattern** |

### `handleSubmitPhaseHandoff` validation chain:

| Parameter | Validator | Pattern Enforced |
|---|---|---|
| `modified_files` | `MCPValidator.validateStringArray()` | `pathLike: true` → `/^[\w\-./]+$/` + `maxLength: 260` + `maxItems: 200` |

### **Finding R-5: Path Validation Asymmetry**

The `submit_phase_handoff` tool validates `modified_files` items with the `pathLike` regex `/^[\w\-./]+$/`, which rejects:
- Null bytes
- Backslashes
- Spaces
- Shell metacharacters
- `..` sequences (sort of — `..` passes the regex since `.` is allowed, but `../../etc/passwd` also passes)

The `get_modified_file_content` tool validates `file_path` with only `MCPValidator.validateString()`, which checks `typeof value === 'string'` — **no path pattern enforcement at all**.

This means a worker agent can invoke `get_modified_file_content` with:
- `../../etc/passwd` — ✅ But caught by the `realpath` + `startsWith` boundary check at L359
- `path with spaces.txt` — ✅ Legitimate, should be allowed
- Extremely long paths — ⚠️ No `maxLength` enforced on `file_path`

**Risk assessment**: The sandbox boundary check (Step 1b) is the actual enforcement gate for path traversal. The `validateString` check is just a type guard. The asymmetry is a **defense-in-depth gap** but not exploitable because the real security comes from the `realpath` + `startsWith` boundary check, not from the regex.

However, the JSON Schema declared in `registerListTools()` (lines 184-188) also lacks a `pattern` constraint for `file_path`:
```typescript
file_path: {
    type: 'string',
    description: 'Relative path to the file within the workspace.',
    // ❌ No pattern constraint — unlike modified_files which has pattern: '^[\\w\\-./]+$'
},
```

---

## Step 3: Verify safeTruncate()

### File: `coogent/src/mcp/CoogentMCPServer.ts`, Lines 105–131

```typescript
export function safeTruncate(s: string, limit: number): string {
    if (s.length <= limit) return s;                         // L125
    const c = s.charCodeAt(limit - 1);                       // L128
    const cutAt = (c >= 0xD800 && c <= 0xDBFF)               // L129: Is this a leading surrogate?
        ? limit - 1                                           //       Yes → back up one code unit
        : limit;                                             //       No → cut at limit
    return s.slice(0, cutAt);                                // L130
}
```

**Analysis:**

- ✅ **Surrogate pair handling**: Checks if the character at `limit - 1` is a leading (high) surrogate (0xD800–0xDBFF). If so, backs up by 1 to avoid splitting the pair.
- ✅ **Edge case: limit = 0**: `s.charCodeAt(-1)` returns `NaN`, which fails the range check, so `cutAt = 0`. `s.slice(0, 0)` returns `''`. Safe.
- ✅ **Edge case: limit = 1 and first char is surrogate**: `s.charCodeAt(0)` is a leading surrogate → `cutAt = 0` → returns `''`. This is correct — a lone leading surrogate would be invalid.
- ✅ **UTF-8 safety**: Since JavaScript strings are UTF-16 and files are read as `'utf-8'`, Node.js handles the UTF-8 → UTF-16 conversion on read. The `safeTruncate` operates on the UTF-16 representation, which is correct for JSON serialization (MCP protocol uses JSON).
- ⚠️ **Minor pedantic note**: The function checks `limit - 1` but not `limit` itself. If the character AT position `limit` (i.e., the first excluded char) were a trailing surrogate (0xDC00–0xDFFF), the function would have already caught this by detecting the leading surrogate at `limit - 1`. However, if due to corruption the string contains a lone trailing surrogate at position `limit`, slicing at `limit` is fine — the lone trailing surrogate was already "orphaned" in the source string.

---

## Step 4: Findings Report

### Finding R-1: Authorization Gate Effectiveness

**Severity: LOW**

The authorization gate at `MCPToolHandler.ts:343-347` correctly queries `this.db.getTask(masterTaskId)` and rejects unknown task IDs with `Error('Unauthorized')`. The `masterTaskId` format is validated with a strict regex that prevents injection.

**Residual risk**: The gate checks task *existence* in ArtifactDB, not caller *ownership*. A stale task from a previous session (if not purged) could be used. Mitigated by the local-only stdio transport — no cross-process access vector.

**Recommendation**: Consider calling `purgeTask()` on session switch/reset to minimize the window of stale task IDs.

---

### Finding R-2: Sandbox Boundary Enforcement

**Severity: LOW**

The sandbox boundary at `MCPToolHandler.ts:349-362` is robust:
- `fs.realpath()` on both paths before comparison
- `startsWith(realWorkspaceRoot + path.sep)` prevents prefix confusion
- `realpath()` failure returns generic `Error('File not found')` — no path leak
- Absolute path injection (e.g., `/etc/passwd`) is correctly handled

**No exploitable traversal path found.**

---

### Finding R-3: File-Not-Found Error Handling

**Severity: LOW**

Two error paths exist (realpath failure vs. readFile ENOENT), both throw `Error('File not found')`. Log messages are distinct (`(realpath)` vs `(readFile)`) for internal debugging. Non-ENOENT read failures throw `Error('Failed to read file')`.

**Minor improvement**: The caller cannot distinguish between "file doesn't exist" and "file existed but vanished during TOCTOU window". This is acceptable for the current use case.

---

### Finding R-4: Token Truncation Safety

**Severity: LOW**

`MAX_FILE_CHARS = 32_000` provides a reasonable token ceiling (~8K tokens). `safeTruncate()` correctly handles UTF-16 surrogate pairs by backing up when the cut point lands on a leading surrogate. The truncation message guides the agent to re-invoke with a narrower scope. No off-by-one issues detected.

---

### Finding R-5: Path Validation Gap (Submit vs. Read Asymmetry)

**Severity: MEDIUM**

| Tool | Field | Validation |
|---|---|---|
| `submit_phase_handoff` | `modified_files[*]` | `pathLike: true` → `/^[\w\-./]+$/`, `maxLength: 260`, `maxItems: 200` |
| `get_modified_file_content` | `file_path` | `validateString()` → type check only, no pattern, no maxLength |

The `get_modified_file_content` tool's `file_path` parameter lacks:
1. **Path pattern regex** — allows spaces, special chars, null bytes in the input string
2. **Max length** — unbounded string length for path input
3. **JSON Schema pattern** — the `registerListTools` declaration omits a `pattern` attribute

**Mitigating factor**: The `realpath` + `startsWith` boundary check (Finding R-2) is the true security gate. The regex asymmetry is a defense-in-depth gap, not directly exploitable.

**Recommendation**: Add `pathLike` validation to `file_path` in `handleGetModifiedFileContent`:
```typescript
const filePath = MCPValidator.validateString(args['file_path'], 'file_path');
// ADD: path pattern validation for defense-in-depth
if (!/^[\w\-./]+$/.test(filePath)) {
    throw new Error('Invalid file_path: not a valid relative path.');
}
```
And add `maxLength: 260` and `pattern` to the JSON Schema declaration.

---

### Risk Matrix

| Finding | ID | Severity | Exploitable? | Recommendation |
|---|---|---|---|---|
| Authorization gate effectiveness | R-1 | LOW | No (local transport) | Purge stale tasks on session reset |
| Sandbox boundary enforcement | R-2 | LOW | No | None needed |
| File-not-found error handling | R-3 | LOW | No | None needed |
| Token truncation safety | R-4 | LOW | No | None needed |
| Path validation asymmetry | R-5 | MEDIUM | No (mitigated by realpath boundary) | Add `pathLike` regex + `maxLength` to `file_path` |

---

```json
{
  "decisions": [
    "Confirmed R-1: Authorization gate uses db.getTask(masterTaskId) which returns undefined for unknown IDs, correctly throwing 'Unauthorized'. Residual risk is stale tasks from un-purged sessions, mitigated by local-only stdio transport",
    "Confirmed R-2: Sandbox boundary correctly uses fs.realpath() on both the file path AND workspace root before the startsWith boundary check. Path traversal via '../../etc/passwd' is blocked. Absolute path injection is also blocked",
    "Confirmed R-3: File-not-found produces identical Error('File not found') for both realpath failure and readFile ENOENT, but log messages are distinct internally. No path information leaks to the caller",
    "Confirmed R-4: Token truncation uses MAX_FILE_CHARS=32000 with safeTruncate() for surrogate-pair safety. No off-by-one issue found. Truncation message guides agent to re-invoke with narrower scope",
    "Identified R-5: Path validation asymmetry — submit_phase_handoff validates modified_files with pathLike regex /^[\\w\\-./]+$/ but get_modified_file_content validates file_path with only typeof string check. Not directly exploitable due to realpath boundary check, but is a defense-in-depth gap",
    "Verified safeTruncate() correctly handles surrogate pairs by checking charCodeAt(limit-1) against the 0xD800-0xDBFF range and backing up by one code unit when a leading surrogate is found"
  ],
  "modified_files": [],
  "unresolved_issues": [
    "get_modified_file_content file_path parameter lacks pathLike regex validation and maxLength enforcement — should be added for defense-in-depth parity with submit_phase_handoff",
    "JSON Schema for get_modified_file_content in registerListTools() omits pattern and maxLength attributes for file_path — should be added to match runtime validation",
    "phaseId parameter in handleGetModifiedFileContent is validated syntactically but never checked against the DB — a fabricated phaseId with a valid masterTaskId passes (low risk, only affects logging)",
    "Stale task IDs in ArtifactDB from previous sessions could theoretically pass the authorization gate — purgeTask() should be called on session reset"
  ],
  "next_steps_context": "The retrieval path (get_modified_file_content) is well-defended with realpath-based sandbox boundary, authorization gate, and surrogate-pair-safe truncation. The primary remediation is adding pathLike regex validation and maxLength enforcement to file_path for defense-in-depth parity. No code changes were made in this audit phase — all findings are recommendations. The Phase 2 finding about buildNextContext() raw file injection bypasses this entire MCP retrieval path, making it the higher-priority fix."
}
```

# Audit Path 4: DAG Dependency Graphing — Findings Report

## Step 1: Dependency Resolution in EngineWiring.ts

### Trace of `executePhase()` (lines 380–400)

1. **Line 388: `phase.depends_on`** — Type is `readonly PhaseId[]` (defined in `src/types/index.ts:99`). `PhaseId` is a branded type (`number & { readonly __brand: 'PhaseId' }`). The cast `(phase.depends_on as unknown[]).length > 0` at line 388 discards the branded type temporarily for a length check, but this is safe since it's only used for truthiness.

2. **Line 391: The loop** — `parentId` is a `PhaseId` (number). It represents the numeric `phase.id` of the dependency, NOT the `mcpPhaseId` string. This is correct — the DAG is defined in terms of numeric IDs, and `mcpPhaseId` is only used for MCP URI construction.

3. **Line 392: `rb?.phases.find(p => p.id === parentId)`** — This is an **O(n) linear scan** over the phases array for each dependency. In contrast, `Scheduler.getReadyPhases()` (line 60) uses a `Map` for O(1) lookups. Since `executePhase()` is called once per dispatched phase and typical runbooks have <20 phases, the practical impact is negligible, but it's architecturally inconsistent.

4. **Line 393: `parentPhase?.mcpPhaseId`** — If `mcpPhaseId` is `undefined`, the entire parent handoff URI is **silently skipped**. No warning or log entry is emitted. The `if (parentPhase?.mcpPhaseId)` guard on line 393 means the `parentHandoffs` array simply won't include this parent's URI. This is a **silent failure mode** — a phase could start without receiving context from a parent that was supposed to provide it.

5. **Line 394: URI format** — `RESOURCE_URIS.phaseHandoff(masterTaskId, parentPhase.mcpPhaseId)` produces `coogent://tasks/{masterTaskId}/phases/{mcpPhaseId}/handoff`. This matches exactly what `parseResourceURI()` expects (CoogentMCPServer.ts:84-95) and what `MCPResourceHandler.registerReadResource()` handles (MCPResourceHandler.ts:126-133).

---

## Step 2: Scheduler DAG Correctness

### `getReadyPhases()` (Scheduler.ts:47-73)

1. **Dependency status check** — Yes, line 66-68 checks `deps.every(depId => { const dep = phaseMap.get(depId); return dep?.status === 'completed'; })`. Only `'completed'` status satisfies a dependency. This is correct.

2. **Non-existent `depends_on` reference** — If `depends_on` references a phase ID that doesn't exist in the runbook, `phaseMap.get(depId)` returns `undefined`, so `dep?.status === 'completed'` evaluates to `false`. The phase will **never become ready** — it is permanently blocked. There is **no explicit validation** that all `depends_on` IDs refer to actual phases in the runbook. The `detectCycles()` method builds an adjacency map but does not validate reference integrity either.

3. **`detectCycles()`** — Yes, it uses Kahn's topological sort (lines 128-172) and runs BEFORE execution starts, called from `SessionController.loadRunbook()` (SessionController.ts:48). Cycles are caught and the engine transitions to `PARSE_FAILURE` with a `CYCLE_DETECTED` error. However, `detectCycles()` does NOT detect dangling references — only cycles.

### Missing: Dangling Reference Validation

The `kahnSort()` method at line 143-148 builds adjacency but skips unknown `dep` IDs silently:
```typescript
const neighbors = adjacency.get(dep);
if (neighbors) neighbors.push(phase.id);
```
If `dep` is not in `adjacency` (not a real phase), it's simply ignored. The in-degree still gets incremented for the dependent phase, so the phase will be stuck at in-degree > 0 and never schedulable — but no error is reported.

---

## Step 3: The "Wrong URI" Scenario

### Missing status validation in URI construction

1. **No status check at line 392** — `EngineWiring.ts:392` does `rb?.phases.find(p => p.id === parentId)` but does NOT check `parentPhase.status === 'completed'`. It only checks `parentPhase?.mcpPhaseId`. In theory, the Scheduler guarantees all deps are `completed` before dispatching, so this is a redundant-but-missing defense-in-depth check. If the Scheduler had a bug, a phase could receive a URI to a parent that hasn't completed.

2. **Race condition on `mcpPhaseId`** — No. `mcpPhaseId` is assigned synchronously in the `phase:execute` event handler (EngineWiring.ts:102-105) BEFORE `executePhase()` is called at line 106. The assignment flow is:
   - `DispatchController.dispatchReadyPhases()` emits `phase:execute` at line 46
   - The handler at line 102 assigns `mcpPhaseId` synchronously
   - `executePhase()` is called asynchronously at line 106
   - When `executePhase()` reaches line 392, the parent's `mcpPhaseId` was assigned when the parent was dispatched (earlier)

   This is safe because the JavaScript event loop processes the handler synchronously before yielding.

3. **`mcpPhaseId` assignment timing** — Confirmed at EngineWiring.ts:102-105:
   ```typescript
   engine.on('phase:execute', (phase: Phase) => {
       if (!phase.mcpPhaseId) {
           phase.mcpPhaseId = `phase-${String(phase.id).padStart(3, '0')}-${randomUUID()}`;
       }
       executePhase(svc, phase, ...);
   });
   ```
   The `if (!phase.mcpPhaseId)` guard is idempotent — if a phase is re-dispatched (e.g., after healing), the same `mcpPhaseId` is reused. This is correct.

---

## Step 4: Full URI Chain Verification

### `RESOURCE_URIS.phaseHandoff` → `parseResourceURI()` → `MCPResourceHandler`

1. **`parseResourceURI()`** (CoogentMCPServer.ts:50-99) — Correctly extracts `masterTaskId` via `URI_MASTER_TASK_REGEX` and `phaseId` via `URI_PHASE_ID_REGEX`. The regex patterns (types.ts:73-81, 107-115) are strict and match the exact format produced by `RESOURCE_URIS.phaseHandoff()`. ✅

2. **`this.db.getTask(parsed.masterTaskId)`** (MCPResourceHandler.ts:101) — Correctly retrieves the task by `masterTaskId`. If not found, throws `"Task not found"`. ✅

3. **`task.phases.get(parsed.phaseId)`** (MCPResourceHandler.ts:110) — The `Map` key is the `mcpPhaseId` string (format: `phase-NNN-<uuid>`). This MUST match what was used during `upsertHandoff()`. Tracing the handoff submission path:
   - `EngineWiring.ts:159-169` submits via `mcpBridge.submitPhaseHandoff(sessionDirName, phaseIdStr, ...)` where `phaseIdStr = phaseObj.mcpPhaseId`
   - The MCP tool handler stores it keyed by `phaseId` parameter (the `mcpPhaseId` string)
   - The read handler uses `parsed.phaseId` which is also the `mcpPhaseId` string extracted from the URI

   **The chain is consistent.** ✅

### Dual-path inconsistency (HandoffExtractor)

`HandoffExtractor.saveHandoff()` (line 141) constructs a DIFFERENT `phaseIdStr`:
```typescript
const phaseIdStr = `phase-${String(phaseId).padStart(3, '0')}-00000000-0000-0000-0000-000000000000`;
```
This uses a zeroed UUID, whereas the real `mcpPhaseId` uses `randomUUID()`. However, `saveHandoff()` is NOT called from the main `EngineWiring` path — the main path at EngineWiring.ts:163-169 uses the real `mcpPhaseId`. `saveHandoff()` appears to be a legacy/fallback path. The `buildNextContext()` method (line 183-239) uses the file-based fallback (`handoffs/phase-{numericId}.json`), not MCP URIs. This creates a **dual-path data inconsistency**:

- **MCP path** (main): Keyed by `mcpPhaseId` (e.g., `phase-002-a1b2c3d4-...`)
- **File path** (fallback): Keyed by numeric `phaseId` (e.g., `phase-2.json`)

Both paths are used simultaneously — MCP for warm-start URIs (line 394, passed to `spawnWorker`), and file-based for inline context injection (line 346, `buildNextContext`). This is redundant but not broken.

---

## Step 5: Silent Failure Modes

1. **Failed dependency blocking** — If `depends_on` references Phase 2 and Phase 2 has `status: 'failed'`, the Scheduler's `getReadyPhases()` will NOT dispatch Phase 4 because `dep?.status === 'completed'` returns `false` for `'failed'`. Phase 4 remains permanently `pending`. The stall watchdog (DispatchController.ts:96-166) will eventually detect this and transition to `ERROR_PAUSED` with a message: "Pipeline stalled: pending phases exist but dependencies are unmet." ✅

2. **Handoff submission failure** — If Phase 2 completed but its handoff submission failed (EngineWiring.ts:172-174 catches the error), then:
   - The FSM transition (`engine.onWorkerExited`) still fires (line 183), so Phase 2 is marked `completed`
   - Phase 4 becomes schedulable (deps satisfied)
   - When Phase 4's worker reads `coogent://tasks/{id}/phases/{phase2McpId}/handoff`, `MCPResourceHandler` throws: `"Resource not yet available: handoff has not been submitted for phase {phaseId}"` (line 128-130)
   - This error propagates to the worker agent, which will see a tool error but can still proceed with the task (missing context, not fatal)

   **Risk**: The child agent silently operates without parent context if the warm-start URI read fails. There's no notification to the engine or user.

---

## Findings Report

### Finding D-1: Dependency Resolution Correctness

**Severity**: LOW | **Status**: Correct with minor optimizations available

The dependency resolution at EngineWiring.ts:388-400 correctly iterates `phase.depends_on` (typed `PhaseId[]`), looks up parent phases by numeric ID, extracts their `mcpPhaseId`, and constructs valid MCP URIs. The logic is sound. Minor issue: O(n) `find()` vs O(1) Map lookup is inconsistent with Scheduler patterns but has negligible practical impact.

**Recommendation**: Consider extracting a `phaseMap` at the top of `executePhase()` for consistency, or accept the O(n) lookup given typical phase counts < 20.

---

### Finding D-2: mcpPhaseId Assignment Timing

**Severity**: NONE | **Status**: Correct

`mcpPhaseId` is assigned synchronously in the `phase:execute` handler (EngineWiring.ts:102-105) BEFORE the async `executePhase()` call. This guarantees:
- The executing phase has its `mcpPhaseId` when it starts
- All parent phases (which must have completed before this phase was dispatched) already have their `mcpPhaseId` assigned from when they were dispatched

The idempotent `if (!phase.mcpPhaseId)` guard correctly handles self-healing re-dispatch.

---

### Finding D-3: URI Chain Integrity (types.ts → MCPResourceHandler → ArtifactDB)

**Severity**: LOW | **Status**: Correct with dual-path annotation needed

The URI chain is fully consistent:
- `RESOURCE_URIS.phaseHandoff()` produces URIs matching `parseResourceURI()` regex patterns
- The `phaseId` in the URI is the `mcpPhaseId` string
- The ArtifactDB `phases` Map is keyed by `mcpPhaseId`
- Handoff submission and retrieval both use the same key

**Dual-path note**: `HandoffExtractor.buildNextContext()` uses file-based lookups keyed by numeric phase ID, while MCP warm-start URIs use `mcpPhaseId`. Both paths carry handoff context to child agents, creating redundancy.

**Recommendation**: Document the intentional dual-path design. Consider deprecating the file-based path in favor of MCP-only in a future sprint.

---

### Finding D-4: Missing Phase ID Validation

**Severity**: MEDIUM | **Status**: Gap Identified

There is NO validation that `depends_on` IDs reference actual phases in the runbook. The impact:
1. `Scheduler.getReadyPhases()` silently treats unknown deps as unsatisfied → phase permanently blocked
2. `detectCycles()` silently ignores unknown deps (adjacency.get returns undefined)
3. `SessionController.loadRunbook()` runs cycle detection but NOT reference integrity validation

A typo in `depends_on: [99]` (where phase 99 doesn't exist) would cause the dependent phase to silently never execute, with the stall watchdog eventually catching it as a generic stall — not a configuration error.

**Recommendation**: Add a reference integrity check in `SessionController.loadRunbook()` after cycle detection:
```typescript
const phaseIds = new Set(runbook.phases.map(p => p.id));
for (const phase of runbook.phases) {
    for (const depId of (phase.depends_on ?? [])) {
        if (!phaseIds.has(depId)) {
            // Emit VALIDATION_ERROR with specific message
        }
    }
}
```

---

### Finding D-5: Silent Failure Modes

**Severity**: MEDIUM | **Status**: Multiple silent failures identified

1. **Missing `mcpPhaseId` on parent** (EngineWiring.ts:393): If a parent's `mcpPhaseId` is undefined (should not happen in normal flow, but could after a crash/reload), the parent's URI is silently omitted from `parentHandoffs`. No warning is logged. The child agent receives fewer warm-start URIs than expected.

2. **Handoff submission failure** (EngineWiring.ts:172-174): The error is logged but the FSM transition proceeds. The child agent later gets an MCP error when reading the handoff URI ("Resource not yet available") but can still attempt its task. No user notification is generated.

3. **Dangling dependency reference**: Silently blocks the dependent phase forever until the stall watchdog fires (30s delay) and generates a generic stall message.

**Recommendation**:
- Add `log.warn()` when a parent's `mcpPhaseId` is missing at line 393
- Emit a `LOG_ENTRY` to the webview when handoff submission fails (currently only logged server-side)
- Add reference integrity validation during runbook loading (see D-4)

---

### Vulnerability Assessment: Could the Wrong URI Ever Be Passed?

**Verdict: Extremely unlikely, but a defense-in-depth check is missing.**

The "wrong URI" scenario requires:
1. A parent phase's `mcpPhaseId` being assigned to the wrong phase object — **Not possible** because `mcpPhaseId` is assigned directly on the phase object in the `phase:execute` handler, and the lookup in `executePhase()` uses the numeric `phase.id` from `depends_on` to find the correct parent.

2. A race condition swapping `mcpPhaseId` values — **Not possible** in single-threaded JavaScript. The `phase:execute` handler runs synchronously.

3. The Scheduler dispatching a phase before deps are completed — **Not possible** under normal operation. `getReadyPhases()` strictly checks `dep?.status === 'completed'`.

**Residual risk**: After a crash + session reload, if `mcpPhaseId` values are restored from persisted state but the ArtifactDB handoff entries are not (e.g., DB corruption), a child could receive valid URIs pointing to missing handoff data. This would result in an MCP error, not a wrong-URI scenario.

**Recommendation**: Add a status validation at EngineWiring.ts:392 as defense-in-depth:
```typescript
if (parentPhase?.mcpPhaseId && parentPhase.status === 'completed') {
```

---

```json
{
  "decisions": [
    "Traced dependency resolution from phase.depends_on through mcpPhaseId assignment to URI construction and MCP read handlers",
    "Identified dual-path context injection: file-based (HandoffExtractor.buildNextContext) and MCP URI-based (warm-start URIs in spawnWorker)",
    "Confirmed mcpPhaseId assignment timing is correct — synchronous assignment before async executePhase()",
    "Confirmed Scheduler.getReadyPhases() correctly requires 'completed' status for all dependencies",
    "Confirmed detectCycles() runs during loadRunbook() before any execution",
    "Identified missing reference integrity validation for depends_on IDs",
    "Identified three silent failure modes: missing mcpPhaseId, handoff submission failure, dangling references"
  ],
  "modified_files": [],
  "unresolved_issues": [
    "No validation that depends_on IDs reference existing phases — dangling references silently block execution (Finding D-4)",
    "Missing mcpPhaseId on parent phases silently omits warm-start URIs with no log warning (Finding D-5)",
    "Handoff submission failures are only server-side logged, not surfaced to user via webview (Finding D-5)",
    "Dual-path context injection (file-based + MCP URI-based) is undocumented and creates maintenance burden (Finding D-3)",
    "O(n) phase lookup in EngineWiring.ts:392 is inconsistent with O(1) Map pattern in Scheduler (Finding D-1)"
  ],
  "next_steps_context": "The DAG dependency chain is fundamentally correct. The main actionable findings are: (1) Add depends_on reference integrity validation in SessionController.loadRunbook() alongside existing cycle detection, (2) Add log.warn when parentPhase.mcpPhaseId is missing at EngineWiring.ts:393, (3) Add defense-in-depth status check at the URI construction loop. No wrong-URI vulnerability exists under normal operation. The dual-path context injection (file + MCP) should be documented or consolidated in a future sprint."
}
```

# Coogent Multi-Agent Context Management Audit Report

**Date**: 2026-03-07
**Scope**: Full lifecycle audit of context data from agent output → MCP persistence → worker retrieval → DAG dependency resolution
**Phases Audited**: 4 independent audit paths + this consolidation

---

## Executive Summary

Coogent's multi-agent context management architecture is **fundamentally sound** with correct schema enforcement, robust sandbox boundaries, and a well-designed DAG scheduler. However, one **critical Pull Model violation** exists in `HandoffExtractor.buildNextContext()` — raw file contents are read from disk and injected verbatim into worker prompts, completely bypassing the token budget system. This is the single highest-priority remediation item. All other findings are defense-in-depth improvements.

## Architecture Assessment

| Dimension | Grade | Rationale |
|---|---|---|
| Pull Model Compliance | **PARTIAL** | `context_files` correctly uses `get_modified_file_content` MCP tool directives (Pull). However, `buildNextContext()` injects raw file bytes into prompts (Push). |
| Token Efficiency | **C** | `ContextScoper` enforces 100K token budget, but `handoffContext` bypasses it entirely. Worst-case: 10M tokens from a 5-parent DAG. |
| Security Boundary | **PASS** | `realpath`-based sandbox, strict regex validation on IDs, authorization gate, surrogate-pair-safe truncation. One path validation asymmetry (MEDIUM). |
| DAG Correctness | **PASS** | Kahn's topological sort, cycle detection at load time, O(1) Map-based lookups in Scheduler. Missing reference integrity validation (MEDIUM). |

---

## Critical Findings

### CF-1: Pull Model Violation — Raw File Injection in buildNextContext() (HIGH)

**Source**: Phase 2, Finding B-2
**Location**: `coogent/src/context/HandoffExtractor.ts`, lines 219–231

`buildNextContext()` calls `fs.readFile(absPath, 'utf-8')` for every file in `report.modified_files` and concatenates the raw content into the worker prompt string. This content is then injected at `EngineWiring.ts:373` into `effectivePrompt` WITHOUT any token budget accounting.

**Missing guards** (vs. `ContextScoper.assemble()`):
- No path traversal / symlink boundary check
- No binary file rejection
- No file size limit (ContextScoper caps at 10 MB)
- No token budget enforcement
- No `SecretsGuard` scanning

**Token blast radius**:

| Scenario | Files | Tokens/File | Total Unbudgeted |
|---|---|---|---|
| Realistic (1 parent, 10 files) | 10 | 6,000 | **60,000** |
| Moderate (2 parents, 30 files) | 60 | 6,000 | **360,000** |
| Worst-case (5 parents, 200 files) | 1,000 | 10,000 | **10,000,000** |

### CF-2: Token Budget Bypass in executePhase() (HIGH)

**Source**: Phase 2, Finding B-3
**Location**: `coogent/src/EngineWiring.ts`, line 373

The token budget validation at lines 293–315 (via `contextScoper.assemble()`) does NOT account for `handoffContext`. A phase can pass the budget check and still produce an arbitrarily large prompt.

---

## Medium Findings

### MF-1: Missing Dependency Reference Integrity Validation (MEDIUM)

**Source**: Phase 4, Finding D-4
**Location**: `coogent/src/engine/SessionController.ts:48`, `coogent/src/engine/Scheduler.ts:94`

`detectCycles()` catches circular dependencies but does NOT validate that `depends_on` IDs reference actual phases. A typo like `depends_on: [99]` (where phase 99 doesn't exist) silently blocks the phase forever. The stall watchdog (30s) catches it as a generic stall — not a config error.

### MF-2: Path Validation Asymmetry — Submit vs. Read (MEDIUM)

**Source**: Phase 3, Finding R-5
**Location**: `coogent/src/mcp/MCPToolHandler.ts`, lines 329–334

| Tool | Field | Validation |
|---|---|---|
| `submit_phase_handoff` | `modified_files[*]` | `pathLike` regex + `maxLength: 260` + `maxItems: 200` |
| `get_modified_file_content` | `file_path` | Type check only — no pattern, no maxLength |

Mitigated by `realpath` + `startsWith` boundary check, but inconsistent defense-in-depth.

### MF-3: Silent Failure in Parent Handoff URI Construction (MEDIUM)

**Source**: Phase 4, Finding D-5
**Location**: `coogent/src/EngineWiring.ts`, lines 392–395

If a parent phase's `mcpPhaseId` is undefined (crash/reload edge case), the URI is silently omitted from `parentHandoffs`. No warning logged. Child agent starts without parent context.

---

## Low Findings / Observations

### LF-1: Missing `additionalProperties: false` on `submit_phase_handoff` Schema (LOW)

**Source**: Phase 1
Extra properties are silently ignored, but declaring `additionalProperties: false` is defense-in-depth best practice.

### LF-2: Dual-Path Context Injection (LOW)

**Source**: Phase 4, Finding D-3
Context is injected via both file-based `buildNextContext()` (inline in prompt) AND MCP warm-start URIs (pointers for workers). Redundant but not broken. Should be documented or consolidated.

### LF-3: O(n) Phase Lookup in EngineWiring.ts (LOW)

**Source**: Phase 4, Finding D-1
`EngineWiring.ts:392` uses `rb.phases.find()` (O(n)) while `Scheduler.getReadyPhases()` uses a Map (O(1)). Negligible practical impact given typical phase counts < 20.

### LF-4: Double File Read in extractHandoff() (LOW)

**Source**: Phase 2
`extractHandoff()` (lines 91-101) reads file contents and stores in `file_contents`. Then `buildNextContext()` reads the same files AGAIN from disk. Redundant I/O.

### LF-5: Stale Task IDs in Authorization Gate (LOW)

**Source**: Phase 3, Finding R-1
The authorization gate checks task existence, not caller ownership. Un-purged sessions remain accessible. Mitigated by local-only stdio transport.

### LF-6: Handoff Submission Failure Not Surfaced to User (LOW)

**Source**: Phase 4, Finding D-5
`EngineWiring.ts:172-174` catches handoff submission errors and logs server-side, but generates no webview notification. Users don't know context is missing.

---

## Remediation Plan

### Priority 1 (Immediate — Before Next Release)

| Item | Action | File(s) | Est. Effort |
|---|---|---|---|
| **Fix CF-1/CF-2**: Remove raw file injection from `buildNextContext()` | Replace `fs.readFile` content injection with `get_modified_file_content` MCP tool directives (Pull Model) | `HandoffExtractor.ts:219-231` | 2h |
| **Fix CF-2**: Add token budget accounting for `handoffContext` | Count `handoffContext` tokens and validate against budget before prompt assembly | `EngineWiring.ts:342-377` | 1h |
| **Fix MF-1**: Add `depends_on` reference integrity validation | Validate all `depends_on` IDs exist in runbook during `loadRunbook()` | `SessionController.ts:48` | 30m |

**Recommended code for CF-1**:
```typescript
// HandoffExtractor.ts:219-231 — REPLACE:
if (report.modified_files.length > 0) {
    lines.push('### Modified Files');
    lines.push('Fetch these files via `get_modified_file_content`:');
    for (const relPath of report.modified_files) {
        lines.push(`- \`get_modified_file_content\` → \`${relPath}\``);
    }
}
```

**Recommended code for MF-1**:
```typescript
// SessionController.ts after line 48:
const phaseIds = new Set(runbook.phases.map(p => p.id));
for (const phase of runbook.phases) {
    for (const depId of (phase.depends_on ?? [])) {
        if (!phaseIds.has(depId)) {
            this.engine.transition(EngineEvent.PARSE_FAILURE);
            this.engine.emitUIMessage({
                type: 'ERROR',
                payload: {
                    code: 'VALIDATION_ERROR',
                    message: `Phase ${phase.id} references non-existent dependency: ${depId}`,
                },
            });
            return;
        }
    }
}
```

### Priority 2 (Next Sprint)

| Item | Action | File(s) |
|---|---|---|
| **Fix MF-2**: Add `pathLike` validation to `file_path` | Add regex + `maxLength` to `get_modified_file_content` schema and runtime | `MCPToolHandler.ts`, `MCPValidator.ts` |
| **Fix MF-3**: Log warning for missing `mcpPhaseId` | Add `log.warn()` when parent's `mcpPhaseId` is undefined | `EngineWiring.ts:393` |
| **Fix LF-1**: Add `additionalProperties: false` | Update `submit_phase_handoff` schema | `MCPToolHandler.ts:91` |
| **Fix LF-4**: Remove `file_contents` from extractHandoff | Stop storing raw content in handoff JSON | `HandoffExtractor.ts:91-101` |
| **Fix LF-5**: Purge stale tasks on session reset | Call `purgeTask()` during session switch/reset | `SessionController.ts` |

### Priority 3 (Backlog)

| Item | Action |
|---|---|
| **LF-2**: Document or consolidate dual-path context injection | Decide between file-based and MCP-only handoff context |
| **LF-3**: Use Map for phase lookup in `executePhase()` | Minor consistency improvement |
| **LF-6**: Surface handoff submission failures to webview | Emit `LOG_ENTRY` on failure |

---

## Token Budget Analysis

### Current System: Token Budget Enforcement Paths

| Component | Budget Enforced? | Limit | Notes |
|---|---|---|---|
| `ContextScoper.assemble()` | ✅ YES | 100K tokens | Validates `context_files` with pruning |
| `buildNextContext()` (handoff) | ❌ NO | Unbounded | Raw file injection, bypasses budget |
| `get_modified_file_content` | ✅ YES | 32K chars (~8K tokens) | `safeTruncate()` per-file |
| `generateDistillationPrompt()` | ✅ YES | ~300 tokens | Fixed template string |
| Worker profile injection | ✅ YES | ~200 tokens | Fixed system prompt |

### Worst-Case vs. Best-Case Token Usage

| Path | Best Case | Worst Case |
|---|---|---|
| Phase prompt (`phase.prompt`) | 500 tokens | 5,000 tokens |
| Context files (budgeted) | 0 tokens | 100,000 tokens |
| Handoff context (UNBUDGETED) | 0 tokens | **10,000,000 tokens** |
| Worker profile | 0 tokens | 200 tokens |
| Distillation prompt | 300 tokens | 300 tokens |
| MCP warm-start URIs | 200 tokens | 1,000 tokens |
| **Total** | **1,000 tokens** | **~10,106,500 tokens** |

After CF-1/CF-2 remediation (Pull Model for handoff files):

| Path | Best Case | Worst Case |
|---|---|---|
| Phase prompt | 500 tokens | 5,000 tokens |
| Context files (budgeted) | 0 tokens | 100,000 tokens |
| Handoff metadata (decisions, issues, next_steps) | 0 tokens | 15,000 tokens |
| Handoff file pointers (Pull Model) | 0 tokens | 2,000 tokens |
| Worker profile + distillation + URIs | 500 tokens | 1,500 tokens |
| **Total** | **1,000 tokens** | **~123,500 tokens** |

---

## Appendix: Files Reviewed

| File | Audit Path | Lines Reviewed |
|---|---|---|
| `coogent/src/mcp/MCPToolHandler.ts` | P1, P3 | 86–141 (schema), 257–304 (handoff handler), 329–393 (file read handler) |
| `coogent/src/mcp/MCPValidator.ts` | P1, P3 | 1–91 (all validators) |
| `coogent/src/mcp/types.ts` | P1, P4 | 1–146 (all types, URI constants) |
| `coogent/src/mcp/MCPResourceHandler.ts` | P4 | 1–185 (full file — list + read handlers) |
| `coogent/src/mcp/CoogentMCPServer.ts` | P3, P4 | 50–99 (parseResourceURI), 124–131 (safeTruncate) |
| `coogent/src/mcp/ArtifactDB.ts` | P1 | 452–493 (upsertHandoff), 55–64 (schema) |
| `coogent/src/EngineWiring.ts` | P2, P4 | 1–404 (full file — event wiring + executePhase) |
| `coogent/src/context/HandoffExtractor.ts` | P2, P4 | 1–284 (full file — extract, save, build, parse) |
| `coogent/src/adk/ADKController.ts` | P2 | 524–577 (buildInjectionPrompt) |
| `coogent/src/engine/Scheduler.ts` | P4 | 1–174 (full file — getReadyPhases, detectCycles, kahnSort) |
| `coogent/src/engine/DispatchController.ts` | P4 | 1–232 (full file — dispatch, stall watchdog, resume) |
| `coogent/src/engine/SessionController.ts` | P4 | 1–158 (full file — loadRunbook, reset, switchSession) |
| `coogent/src/types/index.ts` | P4 | 75–134 (Phase interface), 44–61 (branded types) |

---

```json
{
  "decisions": [
    "Synthesized findings from all 4 audit paths into a unified report with consistent severity ratings",
    "Classified 2 findings as CRITICAL (CF-1: buildNextContext raw injection, CF-2: token budget bypass), 3 as MEDIUM (MF-1: dangling deps, MF-2: path validation asymmetry, MF-3: silent mcpPhaseId failure), and 6 as LOW",
    "Structured remediation plan into 3 priority tiers: Priority 1 (immediate, 3 items), Priority 2 (next sprint, 5 items), Priority 3 (backlog, 3 items)",
    "Calculated post-remediation token budget: worst-case drops from 10.1M to 123.5K tokens after applying Pull Model to handoff file injection",
    "Confirmed overall architecture is fundamentally sound — the critical finding is an isolated violation in one method, not a systemic design flaw"
  ],
  "modified_files": [],
  "unresolved_issues": [
    "CF-1/CF-2 (buildNextContext raw file injection + token budget bypass) are the highest-priority items requiring code changes before next release",
    "MF-1 (dangling dependency reference validation) should be added to SessionController.loadRunbook() — a simple Set-based check",
    "MF-2 (path validation asymmetry) should be addressed by adding pathLike regex to get_modified_file_content file_path parameter",
    "The dual-path context injection design (file-based + MCP URI) should be officially documented or consolidated to reduce maintenance burden",
    "No code changes were made in this audit — all findings are recommendations requiring implementation"
  ],
  "next_steps_context": "This consolidated report is the final deliverable. The top remediation item is replacing raw file injection in HandoffExtractor.buildNextContext() with Pull Model MCP tool directives, then adding handoffContext token accounting in EngineWiring.executePhase(), then adding depends_on reference integrity validation in SessionController.loadRunbook(). All Priority 1 items have concrete code samples in the Remediation Plan section. Estimated total effort for Priority 1: ~3.5 hours."
}
```