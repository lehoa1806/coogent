# Code Review Part 4 — ADK, Agent Selection, Context, Planner, State & Session

**Scope**: `src/adk/`, `src/agent-selection/`, `src/context/`, `src/planner/`, `src/state/`, `src/session/`
**Files reviewed**: 41

---

## 1. Security

### SEC-1 — ReDoS safety check is heuristic-only and bypassable

**File**: [SecretsGuard.ts](file:///Users/hoalee1806/workspaces/anti-ex/coogent/src/context/SecretsGuard.ts#L378-L392)

**Description**: `isRegexSafe()` checks for nested quantifiers with a simple regex heuristic and a 50ms wall-clock test on a 50-char string. Adversarial patterns that exploit other ReDoS vectors (polynomial-time backtracking on `(a|a)*`, nested groups with alternation) pass the check.

**Importance**: A malicious `.coogent/secrets-allowlist.json` with a crafted regex could freeze the extension's Node.js thread, blocking the event loop indefinitely — a denial-of-service against the entire VS Code window.

**Root Cause**: The ReDoS detection is a shallow structural heuristic rather than formal regex analysis. The test string (`'a'.repeat(50) + '!'`) doesn't probe all pathological patterns.

**Severity**: Medium

**Remediation**: Use the [`recheck`](https://github.com/nicolo-ribaudo/recheck) or [`safe-regex2`](https://github.com/davisjam/safe-regex) library for formal NFA analysis. Alternatively, sandbox user-defined patterns inside a `vm` context with a CPU time limit.

**Tradeoffs**: Adding `safe-regex2` adds a small dependency; NFA analysis is O(regex-length²) but bounded.

**Validation test**: Create a `secrets-allowlist.json` with `"(a+)+$"` — verify the extension skips it and logs a warning.

---

### SEC-2 — `changedFilesJson` parsed with unchecked `JSON.parse … as`

**File**: [ContextPackBuilder.ts](file:///Users/hoalee1806/workspaces/anti-ex/coogent/src/context/ContextPackBuilder.ts#L344-L355)

**Description**: `phaseHandoffToPacket()` parses `raw.changedFilesJson` via `JSON.parse(raw.changedFilesJson) as ChangedFileHandoff[]`. No runtime shape validation follows the cast. If a corrupted or maliciously crafted handoff sneaks through the DB, the downstream code will silently misinterpret the data.

**Importance**: Handoff packets drive context file selection and slicing. A malformed `path` field (e.g. `../../../../etc/passwd`) could bypass the workspace boundary guard in `ContextScoper` if `changedFiles` paths are added to the `fileSet` without validation.

**Root Cause**: Missing Zod/runtime validation after deserialization — same pattern caught in `AgentRegistry` but not applied here.

**Severity**: Medium

**Remediation**: Add a `ChangedFileHandoffSchema` Zod schema and `safeParse()` the deserialized array, filtering out invalid entries.

**Tradeoffs**: Marginal CPU cost per handoff — negligible since handoffs are small arrays.

**Validation test**: Insert a `changedFilesJson` row with bogus fields — verify they are filtered, not used.

---

### SEC-3 — Prompt injection patterns are static and narrow

**File**: [injection-patterns.ts](file:///Users/hoalee1806/workspaces/anti-ex/coogent/src/adk/injection-patterns.ts)

**Description**: The `INJECTION_PATTERNS` array contains only 3-4 fixed regex patterns. Modern prompt injection techniques (Unicode homoglyphs, base64-encoded instructions, multilingual injections, markdown-level injections) are not covered.

**Importance**: The injection detection gate (`ADKController.buildInjectionPrompt`) can be trivially bypassed, making the `blockOnInjection` setting a false sense of security.

**Root Cause**: Pattern set is manually curated and hasn't been expanded since initial implementation.

**Severity**: Low (defense-in-depth layer — the LLM itself is the primary boundary)

**Remediation**: Treat injection detection as advisory, not blocking. Add a disclaimer in the setting description. Alternatively, integrate a dedicated injection classifier (e.g. Rebuff, classifier model).

**Tradeoffs**: Any pattern expansion increases false-positive risk on legitimate prompts.

**Validation test**: Craft 5 known bypass payloads (Unicode homoglyph, base64, markdown injection) — verify they are detected or the setting description is updated.

---

## 2. Reliability

### R-1 — `ImportScanner.resolveImport()` never actually stat-checks files

**File**: [ImportScanner.ts](file:///Users/hoalee1806/workspaces/anti-ex/coogent/src/context/ImportScanner.ts#L103-L123)

**Description**: `resolveImport()` has three stated strategies but Section 2 always returns `base + '.ts'` unconditionally (line 118), making Section 3 (index files) dead code. No `fs.access()` or `fs.stat()` is called — the returned path is optimistic and may not exist.

**Importance**: The `ImportScanner` feeds paths into `ContextPackBuilder.includedDependencies`. Non-existent paths waste token budget on `fs.access()` failures and pollute the manifest with phantom dependencies.

**Root Cause**: Performance-driven decision to skip stat calls, but the comment acknowledges it: "Section 3 is unreachable."

**Severity**: Low

**Remediation**: Add an async `fs.access()` check before returning, or at minimum document the optimistic behavior in the `scan()` JSDoc so `ContextPackBuilder` callers know to expect phantom entries.

**Tradeoffs**: Adding stat checks adds ~1ms/file latency; batch with `Promise.all()` for large sets.

**Validation test**: Create a project with `import './nonexistent.js'` — verify the scanner's output is correctly filtered (or not).

---

### R-2 — `RunbookParser` Strategy 2 regex is fragile with nested JSON

**File**: [RunbookParser.ts](file:///Users/hoalee1806/workspaces/anti-ex/coogent/src/planner/RunbookParser.ts#L32-L37)

**Description**: The raw JSON extraction regex `\{[\s\S]*?"phases"\s*:\s*\[[\s\S]*?\]\s*[\s\S]*?\}` uses non-greedy quantifiers to avoid over-matching, but nested objects inside the phases array (e.g. `depends_on: [1]`, `context_files: ["a.ts"]`) can cause the `\]` to match the first inner array closing bracket, truncating the JSON mid-parse.

**Importance**: When the fenced `\`\`\`json` extraction fails, this is the only fallback. Truncated JSON → `JSON.parse()` throws → the planner retries or fails, costing 2+ minutes of LLM time.

**Root Cause**: Regex-based JSON extraction is fundamentally fragile for nested structures.

**Severity**: Medium

**Remediation**: Replace Strategy 2 with an iterative brace-counting scanner: find the first `{` after `"phases"`, count braces to find the matching `}`, then `JSON.parse()` the substring.

**Tradeoffs**: Slightly more code but eliminates a class of silent failures.

**Validation test**: Feed a raw (unfenced) runbook with 3+ phases containing nested arrays — verify it parses.

---

### R-3 — `TokenPruner.stripFunctionBodies()` brace-counting ignores strings and comments

**File**: [TokenPruner.ts](file:///Users/hoalee1806/workspaces/anti-ex/coogent/src/context/TokenPruner.ts#L149-L205)

**Description**: The function body stripper counts `{` and `}` characters in raw source text without excluding string literals or comments. A string like `const s = "}{}}{"` will throw off the brace depth tracker, potentially stripping or corrupting the output.

**Importance**: Corrupted source context can mislead worker agents into generating incorrect patches.

**Root Cause**: Heuristic parser without lexer-level awareness.

**Severity**: Low

**Remediation**: Add a basic lexer state machine that skips characters inside `'...'`, `"..."`, `` `...` ``, `// ...`, and `/* ... */` blocks before counting braces.

**Tradeoffs**: Adds ~40 lines; still heuristic but covers the most common false-positive triggers.

**Validation test**: Source file with `const x = "}{}{";` — verify it doesn't corrupt the stripped output.

---

### R-4 — `PlannerAgent.plan()` recursive retry can stack overflow

**File**: [PlannerAgent.ts](file:///Users/hoalee1806/workspaces/anti-ex/coogent/src/planner/PlannerAgent.ts#L420-L439)

**Description**: When `onWorkerExited()` failed parsing, it calls `this.plan(this.userPrompt).catch(...)` recursively. Although bounded by `maxRetries = 2`, each retry creates a new timeout timer, new output handler, and a new `onExit` handler — all while the previous event handlers are still in scope. If the adapter's `createSession()` succeeds but the worker exits immediately (e.g. WASM crash), the retry fires synchronously before the previous handler stack unwinds.

**Importance**: Could cause double-event emissions or stack overflow in degenerate cases. Users would see phantom "Plan generated" events from stale handlers.

**Root Cause**: Missing `this.abort()` at the top of `plan()` only aborts the *session*, not the event listeners accumulated from prior retries.

**Severity**: Low

**Remediation**: `plan()` already calls `this.abort()` first, which is correct. But the recursive call from `onWorkerExited` bypasses the `await this.abort()` (the `.catch()` swallows errors). Convert to an iterative retry loop inside `plan()` itself, or use `setImmediate(() => this.plan(...))` to detach from the exit handler stack.

**Tradeoffs**: `setImmediate` is sufficient and minimal-change.

**Validation test**: Mock an adapter that always exits with code 0 but produces garbage — verify the planner retries exactly 2 times and emits exactly 1 final error.

---

## 3. Code Quality

### CQ-1 — `isNodeError` helper duplicated across 3 files

**Files**: `StateManager.ts:383`, `FileLock.ts:116`, and similar helpers in `AntigravityADKAdapter.ts`

**Description**: The `isNodeError()` type guard is copy-pasted with identical logic in at least 3 files.

**Importance**: Maintenance burden — any fix to the type guard logic must be applied in all locations.

**Root Cause**: No shared utility module for Node.js error type guards.

**Severity**: Low

**Remediation**: Extract to `src/utils/node-errors.ts` and import everywhere.

---

### CQ-2 — `FileContextModeSelector` reads file content that is re-read by `ContextPackBuilder`

**File**: [FileContextModeSelector.ts](file:///Users/hoalee1806/workspaces/anti-ex/coogent/src/context/FileContextModeSelector.ts#L86-L97) → [ContextPackBuilder.ts](file:///Users/hoalee1806/workspaces/anti-ex/coogent/src/context/ContextPackBuilder.ts#L139-L142)

**Description**: `FileContextModeSelector.selectMode()` reads the full file content to count lines and estimate tokens (lines 86-97). Then `ContextPackBuilder.materializeFileContext()` reads the same file again. Each target file is read twice from disk.

**Importance**: For large workspaces with many target files, this doubles I/O.

**Root Cause**: `selectMode()` and `materializeFileContext()` are independent — no content-passing interface between them.

**Severity**: Low (mitigated by OS page cache)

**Remediation**: Have `selectMode()` return the content it read (or accept pre-read content), and pass it through to `materializeFileContext()`.

---

### CQ-3 — `PromptTemplateManager.parsePyproject()` TOML parsing is naive

**File**: [PromptTemplateManager.ts](file:///Users/hoalee1806/workspaces/anti-ex/coogent/src/context/PromptTemplateManager.ts#L233-L265)

**Description**: The pyproject.toml parser uses `content.matchAll(/["']([a-zA-Z0-9_-]+)/g)` — matching every quoted string in the entire file as a potential dependency. This catches TOML section headers, author names, license strings, README paths, etc.

**Importance**: The `dependencies` array will contain false positives (e.g. `"MIT"`, `"readme"`, `"src"`), which pollute the planner prompt's tech stack section.

**Root Cause**: TOML is not regex-friendly; a proper parser (e.g. `smol-toml`) would be needed for correct extraction.

**Severity**: Low (incorrect deps in the prompt are tolerable — they don't affect execution)

**Remediation**: Use `smol-toml` (zero-dep TOML parser, <10KB) or scope the regex to only match within `[project.dependencies]` / `[tool.poetry.dependencies]` sections.

---

## 4. Dataflow

### DF-1 — Token counting inconsistency: `JSON.stringify()` vs. raw content

**File**: [ContextPackBuilder.ts](file:///Users/hoalee1806/workspaces/anti-ex/coogent/src/context/ContextPackBuilder.ts#L90-L91)

**Description**: Handoff token cost is computed as `this.encoder.countTokens(JSON.stringify(packet))` (line 90), while file context cost uses `JSON.stringify(entry)` (line 145). But the final `ContextPack` serializes handoffs as a nested object, and the actual token consumption when the pack is rendered into a prompt may differ significantly from the `JSON.stringify()` estimate — especially with markdown formatting, delimiters, and section headers.

**Importance**: Budget calculations may under- or over-estimate by 15-30%, leading to over-pruning (dropped context) or over-budget packs (prompt truncation by the LLM).

**Root Cause**: Token counting is applied to the intermediate representation, not the final rendered prompt.

**Severity**: Medium

**Remediation**: Count tokens on the final serialized form that gets injected into the prompt, or add a 20% headroom margin to the budget calculation.

---

### DF-2 — Pruning loop recalculates token cost with `JSON.stringify` on each removal

**File**: [ContextPackBuilder.ts](file:///Users/hoalee1806/workspaces/anti-ex/coogent/src/context/ContextPackBuilder.ts#L239-L258)

**Description**: In the pruning loop, each removed entry's cost is recalculated via `this.encoder.countTokens(JSON.stringify(removed))` — but this was already computed during materialization. The running total `fileTokens` is decremented, but the cost computed here may differ from the original cost stored in `fileDecisions[].tokenCost` if the entry was mutated between steps.

**Importance**: Minor — could cause the pruner to stop early or late by a few tokens.

**Root Cause**: No single source of truth for per-entry token cost; it's computed ad-hoc at each step.

**Severity**: Low

**Remediation**: Store the token cost on each `FileContextEntry` and reuse it in the pruning loop instead of recomputing.

---

## 5. Design Patterns

### DP-1 — `SessionDeleteService` calls `purgeTask()` twice

**File**: [SessionDeleteService.ts](file:///Users/hoalee1806/workspaces/anti-ex/coogent/src/session/SessionDeleteService.ts#L56-L96)

**Description**: Step 1 calls `this.mcpServer.purgeTask(sessionDirName)` when `isActiveSession` is true. Step 3 unconditionally calls the same method again. For active sessions, `purgeTask` runs twice.

**Importance**: `purgeTask` is idempotent, so this is functionally harmless. But it signals unclear design intent — is Step 1 meant to do something different (like clearing only in-memory state)?

**Root Cause**: Steps 1 and 3 were written at different times; Step 1 was added for the "clear active state" semantic without deduplicating with Step 3.

**Severity**: Low

**Remediation**: Guard Step 3 with `if (!isActiveSession)` to clarify intent, or merge the two paths and add a comment.

---

### DP-2 — `AgentSelector` scoring weights are hardcoded, not configurable

**File**: [AgentSelector.ts](file:///Users/hoalee1806/workspaces/anti-ex/coogent/src/agent-selection/AgentSelector.ts)

**Description**: The scoring weights (`taskTypeWeight = 0.25`, `reasoningWeight = 0.20`, etc.) and tie-breaking rules are embedded as private constants. There's no way to tune them without modifying source code.

**Importance**: As the system matures and more agent profiles are added, the static weights may need per-workspace or per-project tuning (e.g. a testing-heavy project may want higher `skillsWeight`).

**Root Cause**: V1 design decision — acceptable for initial release, but should be revisited.

**Severity**: Low

**Remediation**: Make weights configurable via `coogent.agentSelection.weights` in VS Code settings. Use current values as defaults.

---

### DP-3 — `HandoffExtractor` fallback JSON parsing is overly broad

**File**: [HandoffExtractor.ts](file:///Users/hoalee1806/workspaces/anti-ex/coogent/src/context/HandoffExtractor.ts#L393-L406)

**Description**: The fallback JSON extraction `output.match(/\{[\s\S]*?\}/g)` matches every `{...}` substring in the worker output, then tries `JSON.parse()` on each. In a verbose worker output with inline JSON examples or code snippets, this can accidentally parse a non-handoff JSON object that happens to pass the Zod schema (since all fields have `.default([])`).

**Importance**: A false-positive handoff with empty arrays means the orchestrator loses all decision/file metadata from the phase, causing downstream workers to operate without context.

**Root Cause**: The Zod schema is too permissive — every field has a `.default()`, so any empty `{}` or object with random keys will pass.

**Severity**: Medium

**Remediation**: Make at least one field required (e.g. `decisions` or `modified_files` without `.default()`), or add a discriminator key (e.g. `_type: "handoff"`).

**Tradeoffs**: Removing defaults means LLMs that omit a key will fail validation — but the fallback to "minimal report" already handles this case.

**Validation test**: Worker output containing `const config = { timeout: 5000 }` plus a real handoff — verify only the real handoff is extracted.

---

## 6. Performance

### P-1 — `SessionManager.getSessionRunbook()` and `getSessionDir()` repeatedly call `this.db.sessions.list()`

**File**: [SessionManager.ts](file:///Users/hoalee1806/workspaces/anti-ex/coogent/src/session/SessionManager.ts#L333-L424)

**Description**: Both `getSessionRunbook()` and `getSessionDir()` call `this.db.sessions.list()` to scan all DB sessions and `.find()` the matching one. `listSessions()` also calls the same method. If these are called in succession (e.g., during session restore → health check → load), the full sessions table is scanned 3+ times.

**Importance**: With 100+ sessions, each `list()` call reads and deserializes all rows. This is O(n) per call with no index-based lookup.

**Root Cause**: No `sessions.getByDirName(dirName)` or `sessions.getBySessionId(id)` method on the DB repository.

**Severity**: Low (sessions table is small in practice)

**Remediation**: Add a `sessions.get(sessionDirName)` single-row query to `SessionRepository` and use it in `getSessionRunbook()` and `getSessionDir()`.

---

### P-2 — `ASTFileResolver` makes serial async `fs.access()` calls per extension per candidate

**File**: [FileResolver.ts](file:///Users/hoalee1806/workspaces/anti-ex/coogent/src/context/FileResolver.ts#L457-L474)

**Description**: `tryResolveFile()` probes up to 20 filesystem paths serially (10 extensions × 2 variants: direct + index file). For each import specifier, this means up to 20 roundtrips to `fs.access()`.

**Importance**: For a file with 30 imports, this is up to 600 serial stat calls — approximately 60ms on an SSD, but much worse on network-mounted volumes.

**Root Cause**: The probing loop is sequential `for await`.

**Severity**: Low

**Remediation**: Try the most common extension first (`.ts`) and short-circuit. Alternatively, batch all candidates into a single `Promise.allSettled()` call.

---

## Summary Table

| ID | Category | Severity | File(s) | One-liner |
|----|----------|----------|---------|-----------|
| SEC-1 | Security | Medium | `SecretsGuard.ts` | ReDoS heuristic is bypassable |
| SEC-2 | Security | Medium | `ContextPackBuilder.ts` | Unvalidated `as` cast on JSON handoff data |
| SEC-3 | Security | Low | `injection-patterns.ts` | Static injection patterns easily bypassed |
| R-1 | Reliability | Low | `ImportScanner.ts` | `resolveImport()` never stat-checks files |
| R-2 | Reliability | Medium | `RunbookParser.ts` | Raw JSON regex breaks on nested arrays |
| R-3 | Reliability | Low | `TokenPruner.ts` | Brace-counting ignores strings/comments |
| R-4 | Reliability | Low | `PlannerAgent.ts` | Recursive retry risks stale handler accumulation |
| CQ-1 | Code Quality | Low | 3 files | `isNodeError` duplicated |
| CQ-2 | Code Quality | Low | `FileContextModeSelector.ts` | Double file reads |
| CQ-3 | Code Quality | Low | `PromptTemplateManager.ts` | Naive TOML parsing |
| DF-1 | Dataflow | Medium | `ContextPackBuilder.ts` | Token counting on intermediate form |
| DF-2 | Dataflow | Low | `ContextPackBuilder.ts` | Recomputed token costs in pruning |
| DP-1 | Design | Low | `SessionDeleteService.ts` | `purgeTask()` called twice |
| DP-2 | Design | Low | `AgentSelector.ts` | Hardcoded scoring weights |
| DP-3 | Design | Medium | `HandoffExtractor.ts` | Overly permissive fallback JSON parsing |
| P-1 | Performance | Low | `SessionManager.ts` | Repeated full-table scans |
| P-2 | Performance | Low | `FileResolver.ts` | Serial filesystem probing |

---

```json
{
  "decisions": [
    "Reviewed all 41 source files across 6 modules: ADK (8), agent-selection (9), context (10), planner (4), state (4), session (6).",
    "Focused on security, reliability, code quality, dataflow, design patterns, and performance per the task spec.",
    "Identified 17 distinct issues: 3 security, 4 reliability, 3 code quality, 2 dataflow, 3 design patterns, 2 performance.",
    "Prioritized severity based on blast radius and exploitation likelihood — SEC-1 (ReDoS), SEC-2 (unvalidated handoff JSON), DP-3 (permissive fallback parsing), DF-1 (token mis-estimation), and R-2 (fragile RunbookParser regex) are the highest-priority items."
  ],
  "modified_files": [
    "review-part4-adk-context.md"
  ],
  "unresolved_issues": [
    "The INJECTION_PATTERNS set needs a strategic decision: enhance patterns, integrate a classifier, or downgrade the feature to advisory-only.",
    "Token counting inconsistency (DF-1) requires a design decision on whether to count tokens on the final rendered prompt or add a margin.",
    "The pyproject.toml parser (CQ-3) works but produces false positives — needs a decision on whether to add a TOML dependency."
  ],
  "next_steps_context": "The medium-severity items (SEC-1, SEC-2, R-2, DF-1, DP-3) should be addressed first. SEC-1 and SEC-2 are straightforward to fix with safe-regex2 and a Zod schema respectively. R-2 can be fixed with a brace-counting JSON extractor. DF-1 requires a design discussion on prompt rendering. DP-3 requires removing .default() from the HandoffJsonSchema."
}
```
