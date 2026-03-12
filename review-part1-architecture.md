# Coogent Extension — Phase 1 Architecture Review

## Executive Summary

Coogent is a VS Code extension that orchestrates multi-agent AI workflows by decomposing implementation plans into isolated micro-tasks executed by ephemeral AI agents. The codebase under review (~22 files, ~3,800 source lines across the orchestration layer) shows evidence of disciplined iterative refactoring (P3, R1, S-series audits), a well-defined FSM-driven execution engine, and thoughtful type design. However, several architectural and code quality issues warrant attention.

**Overall health assessment: B (Good, with targeted improvements needed)**

| Category | Critical | High | Medium | Low |
|---|---|---|---|---|
| Architecture | 0 | 2 | 4 | 1 |
| Code Quality | 0 | 1 | 4 | 2 |
| Legacy/Obsolete | 0 | 0 | 2 | 2 |
| Dead/Disconnected | 0 | 1 | 3 | 1 |

---

## 1. Architecture

### A-1. ServiceContainer is a Service Locator, Not a DI Container

**Severity: HIGH**

**Description:** `ServiceContainer` is a flat, mutable bag of 25+ `| undefined` fields. Services are assigned imperatively during `activate()` and read via optional chaining (`svc.engine?.method()`) or the rarely-used `resolve()` method. This is the Service Locator anti-pattern: every module receives the entire container and can reach into any service.

**Why it matters:**
- **Hidden coupling**: `EngineWiring.ts` destructures 12 fields from `svc` (line 46-49). Any module can depend on any other module without a visible dependency edge.
- **Initialization order hazards**: `startMCPServer()` uses non-null assertions (`svc.coogentDir!`) because it implicitly relies on `createServices()` having run first. The compiler cannot enforce this.
- **Testing friction**: Unit tests must construct or mock the entire 25-field container even if they only use 2 services.

**Root cause:** The R1 refactor (removing 18 module-level `let`s) chose a property bag over constructor injection.

**Remediation:**
1. **Short-term**: Add a `ServiceContainerBuilder` that returns a frozen, fully-initialized container. Replace `| undefined` fields with a two-phase pattern: `ServiceContainerPartial` → `ServiceContainerReady`.
2. **Long-term**: Introduce scoped factory functions (`createEngineScope(engine, stateManager, gitSandbox)`) that produce narrow typed contexts instead of passing the whole container.

**Tradeoffs:** Builder pattern adds a new file/class. Must carefully manage the transition without breaking the existing reactive config listener that mutates `svc` at runtime.

**Tests to validate:**
- Compile-time: Remove `undefined` from fully-init fields; verify no `TS2322` errors at activation sites.
- Unit: Verify each wiring module can be instantiated with only its declared dependencies.

---

### A-2. Wiring Modules Leak UI Concerns (MissionControlPanel.broadcast)

**Severity: HIGH**

**Description:** `EngineWiring.ts` and `PlannerWiring.ts` directly call `MissionControlPanel.broadcast()` — a static method on a Webview panel class. This couples the engine/planner event pipeline to the specific VS Code Webview transport.

**Evidence:**
- `EngineWiring.ts`: 15 calls to `MissionControlPanel.broadcast()`
- `PlannerWiring.ts`: 7 calls to `MissionControlPanel.broadcast()`

**Why it matters:**
- Violates the declared layering: engine → planner → UI. Here, engine-level wiring code directly addresses the presentation layer.
- Makes the wiring modules untestable without mocking a static method on `MissionControlPanel`.
- Prevents alternative UIs (CLI, headless test mode) without modifying core event wiring.

**Root cause:** The R1 extraction moved event handler bodies from `extension.ts` into wiring modules without introducing an event bus or callback abstraction for UI notifications.

**Remediation:**
1. Define a `UIBroadcaster` interface: `{ broadcast(msg: HostToWebviewMessage): void }`.
2. Pass it as a parameter to `wireEngine()` and `wirePlanner()`.
3. In production, implement it with `MissionControlPanel.broadcast`. In tests, use a stub.

**Tradeoffs:** Adds one interface and one parameter per wiring function. Minimal disruption.

**Tests to validate:**
- Integration: Wire engine with a mock broadcaster; confirm all expected messages are collected.
- Grep: `rg 'MissionControlPanel' src/EngineWiring.ts src/PlannerWiring.ts` → 0 hits after migration.

---

### A-3. MissionControlPanel.shouldSkipSandbox() — Static State in a Presentation Class

**Severity: MEDIUM**

**Description:** `EngineWiring.ts:106` calls `MissionControlPanel.shouldSkipSandbox()` inside the `state:changed` handler. This means a core state-machine transition callback reads boolean state from a Webview panel class.

**Why it matters:** The sandbox-creation decision is a domain concern. Burying it in a static field on a UI class makes the engine's behavior change based on UI state that is invisible to the Engine's own state model.

**Remediation:** Move the `skipSandbox` flag to `ServiceContainer` or the `Engine` itself, where it can be set by the UI layer and read by the engine layer.

**Tests to validate:** Assert sandbox branch creation occurs/skips based on the flag's value without instantiating the Webview.

---

### A-4. EngineWiring Closure Captures — Stale Reference Risk

**Severity: MEDIUM**

**Description:** `wireEngine()` destructures `svc` fields at the top of the function (line 46-49), capturing references like `engine`, `adkController`, `mcpServer`, etc. as closure variables. Meanwhile, `getSessionDirName` correctly reads from `svc` lazily. However, `workerTimeoutMs` is captured by value at wire time and never updated reactively.

**Evidence:** In `registerReactiveConfig()` (activation.ts:301), `newWorkerTimeoutMs` is read but never propagated to the `wireEngine()` closure — it's only logged.

**Why it matters:** Users who change `coogent.workerTimeoutMs` at runtime will see the log message confirming the change, but the actual timeout used for new phases will remain the original value.

**Remediation:** Store `workerTimeoutMs` on `ServiceContainer` (or as a getter) and read it at phase-execution time rather than closure-capture time.

**Tests to validate:** Change `workerTimeoutMs` mid-run; verify the next spawned worker uses the new value.

---

### A-5. Implicit Ordering Contract Between createServices → startMCPServer → wireEventSystems

**Severity: MEDIUM**

**Description:** `activate()` in `extension.ts` calls these three functions in a specific order. The ordering is implicit — documented only in comments (`// Step 4-5`, `// Step 10`). `startMCPServer()` uses `svc.coogentDir!` and `svc.contextScoper`, which are populated by `createServices()`. `wireEventSystems()` needs `svc.mcpServer`, populated by `startMCPServer()`.

**Why it matters:** Reordering or parallelizing these calls would cause silent `undefined` dereferences. New developers won't discover the required order from the type system.

**Remediation:** Either (a) make the dependency explicit by returning artifacts from each step, or (b) use the `ServiceContainerBuilder` approach from A-1 with phase-gates.

---

### A-6. Dual Path Topology: StorageBase vs. paths.ts Direct Functions

**Severity: MEDIUM**

**Description:** `StorageBase` provides an OO path-builder with `getSessionDir()`, `getDBPath()`, `getLogsDir()`, etc. But most actual callers use the free functions in `paths.ts` directly (`getSessionDir(coogentDir, sessionDirName)`, `getDatabasePath(coogentDir)`). `StorageBase` is exported from `constants/index.ts` but appears to have minimal adoption.

**Why it matters:** Two parallel APIs for the same path computation creates confusion about which is canonical.

**Remediation:** Audit usage. If `StorageBase` is lightly used, consider deprecating it in favor of the well-established `paths.ts` functions and delete the class.

---

### A-7. Conversation Mode Types Mismatch Between package.json and TypeScript

**Severity: LOW**

**Description:** `package.json` defines `coogent.conversationMode` with enum `["isolated", "continuous", "smart-switch"]`, but `phase.ts` defines `ConversationMode = 'isolated' | 'continuous' | 'smart'`. The value `"smart-switch"` (package.json) ≠ `"smart"` (TypeScript type).

**Why it matters:** Users who set `conversationMode: "smart-switch"` in VS Code settings will receive a string that doesn't match the TypeScript type, potentially causing silent fallback to default behavior.

**Remediation:** Align the enum values. Either change the TS type to `'smart-switch'` or the package.json to `"smart"`.

**Tests to validate:** Add a JSON schema validation test that cross-references package.json enum values with TypeScript union members.

---

## 2. Code Quality

### CQ-1. Duplicated Session Reset Logic (newSession vs. reset Commands)

**Severity: HIGH**

**Description:** `CommandRegistry.ts` contains nearly identical code in the `coogent.newSession` handler (lines 127-141) and the `coogent.reset` handler (lines 306-322):

```typescript
// Both handlers contain:
const newId = generateSessionId();
const newDirName = formatSessionDirName(newId);
const newDir = getSessionDir(svc.coogentDir!, newDirName);
svc.workerOutputAccumulator.clear();
svc.sandboxBranchCreatedForSession.clear();
const newSM = new StateManager(newDir);
await svc.engine.reset(newSM);
svc.switchSession({...});
```

**Why it matters:** Any fix or enhancement to session reset must be applied in two places. Divergence has already begun—`newSession` shows Mission Control afterward, while `reset` doesn't always.

**Root cause:** These two commands evolved independently but share the same core logic.

**Remediation:** Extract a `resetToNewSession(svc): Promise<void>` helper and call it from both handlers.

**Tests to validate:** Unit test the extracted helper. Verify both commands produce identical post-reset state.

---

### CQ-2. Overuse of Non-Null Assertions (`!`)

**Severity: MEDIUM**

**Description:** Multiple files use `!` assertions on `ServiceContainer` fields:
- `svc.coogentDir!` in `CommandRegistry.ts:131, 310` and `PlannerWiring.ts`
- `svc.mcpServer!` in `activation.ts:207, 223`
- `svc.sessionManager!` in `activation.ts:216` and `CommandRegistry.ts:155, 215`

**Why it matters:** Each `!` is an unchecked assumption that the field was populated in a prior step. If the activation order changes, these become runtime `TypeError`s rather than compile-time errors.

**Remediation:** Use `resolve()` which throws a descriptive error, or restructure to pass required services as parameters.

---

### CQ-3. EngineWiring.ts — 427 Lines with Mixed Abstraction Levels

**Severity: MEDIUM**

**Description:** `EngineWiring.ts` is 427 lines combining:
- High-level event wiring (`engine.on(...)`)
- Low-level output accumulation with 2MB cap (lines 282-302)
- Incremental flush interval management (lines 305-319)
- Phase execution pipeline (`executePhase()`)

**Why it matters:** The output accumulation logic (stdout/stderr capping at 2MB, incremental 30s flush) is duplicated between `stdout` and `stderr` handlers and could be encapsulated in a dedicated accumulator class.

**Remediation:**
1. Extract stdout/stderr accumulation into a `StreamAccumulator` class.
2. Extract incremental flush management (interval creation/cleanup) into a `FlushScheduler`.

---

### CQ-4. worker:exited / worker:timeout / worker:crash Handler Duplication

**Severity: MEDIUM**

**Description:** The three ADK worker lifecycle handlers (lines 224-272 in `EngineWiring.ts`) share almost identical code:
1. Clear flush interval
2. Flush and remove output registry
3. Read and clear accumulators
4. Call `resultProcessor.processWorkerExit()` or `processWorkerFailure()`

Steps 1-3 are copy-pasted across all three handlers.

**Remediation:** Extract a `cleanupWorkerState(phaseId): { accumulatedOutput, accumulatedStderr }` helper used by all three handlers.

---

### CQ-5. makeOnReset Callback Extracts SessionId via Regex

**Severity: MEDIUM**

**Description:** `CommandRegistry.ts:61` extracts the session ID from a directory name using regex: `newDirName.replace(/^\d{8}-\d{6}-/, '')`. This reverses the formatting done by `formatSessionDirName()`.

**Why it matters:** This creates a fragile coupling to the session directory name format. If the format changes (e.g., different date format, additional fields), this regex silently produces garbage.

**Remediation:** Either pass the `sessionId` explicitly as a parameter to the reset callback, or provide a `parseSessionDirName()` inverse function alongside `formatSessionDirName()`.

---

### CQ-6. Inconsistent Error Handling Patterns

**Severity: LOW**

**Description:** Error handling varies across the codebase:
- Some handlers use `.catch(log.onError)` (fire-and-forget)
- Some use inline `.catch(err => log.error(...))` with custom message
- Some use `.catch(err => log.warn(...))` for "non-fatal" errors
- `PlannerWiring.ts:128` uses bare `catch {}` (empty catch with no logging)

**Why it matters:** The empty `catch {}` at line 128 silently swallows errors from `getAvailableTags()` on re-plan. This is explicitly documented as "best effort," but silently discarding errors makes debugging difficult.

**Remediation:** Replace empty `catch {}` with `catch (err) { log.debug(...) }` at minimum. Standardize on a small set of error-handling patterns documented in CONTRIBUTING.md.

---

### CQ-7. Default Parameter Values Duplicated Across package.json and TypeScript

**Severity: LOW**

**Description:** Default values for configuration settings appear in both `package.json` and TypeScript code:
- `tokenLimit`: `100000` in package.json:155, `100_000` in activation.ts:119 and activation.ts:300
- `workerTimeoutMs`: `900000` in package.json:161, `900_000` in activation.ts:121 and activation.ts:301
- `contextBudgetTokens`: `150000` in package.json:304, but `100_000` in activation.ts:122 and EngineWiring.ts:44
- `smartSwitchTokenThreshold`: `60000` in package.json:253, but `80_000` in phase.ts:31

**Why it matters:** The `contextBudgetTokens` mismatch is particularly concerning: package.json declares `150000` as default, but the TypeScript fallback in `activation.ts` uses `100_000`. Users who don't explicitly set this value will get `100_000` (the `vscode.workspace.getConfiguration()` fallback takes precedence if no user value is set), which disagrees with the documented schema default.

**Remediation:** Extract all configuration defaults into a single `src/constants/defaults.ts` and reference it from both TypeScript code and (via comments) `package.json`.

---

## 3. Legacy/Obsolete Code

### L-1. Comment References to Removed Code ("Previously purged task from ArtifactDB")

**Severity: MEDIUM**

**Description:** `EngineWiring.ts:98-101` contains a multi-line comment explaining code that was removed:
```typescript
// NOTE: Previously purged task from ArtifactDB on IDLE transition (LF-5).
// Removed because sql.js does not honour ON DELETE CASCADE, leaving
// orphan phases/handoffs/worker_outputs that cause "Task not found" errors.
```

**Why it matters:** The comment is useful history but belongs in a git commit message, not in production code. It clutters the event handler and new developers may wonder when/if to re-enable it.

**Remediation:** Move the rationale to an ADR or code-review note. Keep the comment if desired, but condense to one line: `// Purge disabled — sql.js lacks CASCADE. See LF-5.`

---

### L-2. StorageBase Constructor Ignores `_storageUri` Parameter

**Severity: MEDIUM**

**Description:** `StorageBase.ts` constructor accepts `_storageUri: string | undefined` as its first parameter but never uses it (the underscore prefix is the convention for intentionally unused parameters). The class only uses `workspaceRoot` to compute paths.

**Why it matters:** The unused parameter is a vestige of the pre-ADR-001 storage model where `context.storageUri` was the DB location. It misleads callers into thinking `storageUri` affects behavior.

**Remediation:** Remove the `_storageUri` parameter. Update `createStorageBase()` and all call sites.

---

### L-3. `preFlightGitCheck` Re-Exported from extension.ts for "Backward Compatibility"

**Severity: LOW**

**Description:** `extension.ts:41` re-exports `preFlightGitCheck` from `CommandRegistry.ts` with the comment "Re-export for backward compatibility." This suggests external code once imported it from `extension.ts`.

**Why it matters:** If no external code imports from `extension.ts` (extensions typically don't export their activation module), this re-export is dead code.

**Remediation:** Search for external consumers. If none exist, remove the re-export.

---

### L-4. Refactor Provenance Comments (P3, R1, S-series)

**Severity: LOW**

**Description:** Many files contain comments referencing refactoring passes: "P3 refactor:", "R1 refactor:", "S2 audit fix:", "F-5 audit fix:", "BL-5 audit fix:", "LF-5", "M1 audit fix:", "S6a audit fix:", etc. These are internal Jira/task references.

**Why it matters:** These provide useful archaeological context but can be consolidated once the refactoring stabilizes. They currently contribute noise in ~15% of comment lines.

**Remediation:** After the current refactoring wave concludes, do a cleanup pass to remove or consolidate these into a `docs/CHANGELOG-INTERNAL.md`.

---

## 4. Dead/Disconnected Code

### D-1. `useAgentSelection` Hardcoded to `false` — Feature Flag Without Configuration Path

**Severity: HIGH**

**Description:** `EngineWiring.ts:63` hardcodes `useAgentSelection: false` when configuring the `DispatchController`. The `agent-selection/` module (474-line type file, 39-line barrel export with 7 exported classes) is fully implemented but never activated in production.

**Evidence:**
- No setting in `package.json` to enable agent selection
- `enableShadowMode` exists in both `package.json` (`coogent.enableShadowMode`) and `DispatchController` options, but `EngineWiring.ts` never reads the `enableShadowMode` configuration value and never passes it to `configureDispatch()`.
- The comment says "enable via configuration" but no such configuration wiring exists.

**Why it matters:** ~500+ lines of agent selection code (types, registry, selector, pipeline, prompt compiler, validator, result handler, subtask spec builder) ship in the production bundle but are entirely dormant.

**Remediation:**
1. **If the feature is intended for release**: Wire `coogent.enableAgentSelection` (boolean setting) through to `DispatchControllerOptions.useAgentSelection`, and wire `coogent.enableShadowMode` through to `DispatchControllerOptions.enableShadowMode`.
2. **If the feature is experimental**: Document this clearly and either (a) gate behind a `when` clause so it doesn't appear in settings, or (b) move the entire `agent-selection/` module behind a compile-time flag to reduce bundle size.

**Tests to validate:**
- Enable the flag; run the agent selection pipeline end-to-end with a real runbook.
- Verify shadow mode logs audit records without affecting dispatch.

---

### D-2. `coogent.logDirectory` Setting — Declared But Never Read

**Severity: MEDIUM**

**Description:** `package.json:168-171` declares `coogent.logDirectory` with a default of `".coogent/logs"`, but no TypeScript code reads this setting. `activation.ts:initializeLogging()` uses `initLog(wsRoot, ...)` which constructs the log path from the hardcoded `COOGENT_DIR` constant in `paths.ts`.

**Why it matters:** Users who configure `coogent.logDirectory` are misled — the setting has no effect.

**Remediation:** Either wire the setting into `initLog()` or remove it from `package.json`.

---

### D-3. `coogent.enableEncryption` Setting — Partially Wired

**Severity: MEDIUM**

**Description:** `package.json:223-226` declares `coogent.enableEncryption`, and `StateManager.ts` accepts `enableEncryption` in its constructor. However, `activation.ts:127` constructs `StateManager` with only one argument (`new StateManager('')`), never reading the `enableEncryption` setting from VS Code configuration.

**Why it matters:** The encryption feature exists in `StateManager` but is never activated. Users who enable the setting get no effect.

**Remediation:** Read `extConfig.get<boolean>('enableEncryption', false)` in `createServices()` and pass it to `StateManager`. Also wire `context.secrets` as the `secretStorage` parameter.

---

### D-4. `coogent.blockOnSecretsDetection` Setting — Declared But Unchecked in Wiring

**Severity: MEDIUM**

**Description:** `package.json:213-217` declares `coogent.blockOnSecretsDetection`, but a grep for the string yields no results in the TypeScript source (only in `package.json`). The setting is never read by any activation or wiring code.

**Why it matters:** A security-relevant setting that does nothing is worse than no setting — it gives false confidence.

**Remediation:** Wire this setting into the context assembly pipeline, or remove it from `package.json` with a deprecation note.

---

### D-5. `RESOLVABLE_KEYS` Object — Maintained in Parallel with ResolvableServices Type

**Severity: LOW**

**Description:** `ServiceContainer.ts:253-279` defines `RESOLVABLE_KEYS` as a `Record<keyof ResolvableServices, true>` that must be manually kept in sync with the `ResolvableServices` type. The `satisfies` constraint ensures compile-time exhaustiveness, which is good, but adding a new service field requires updating two separate locations.

**Why it matters:** Minor maintenance tax. The `satisfies` constraint does catch errors, so the risk is low.

**Remediation:** Consider using `Object.keys(this)` with a type guard, or generating the keys programmatically.

---

## Summary of Priority Recommendations

### Immediate (before next release)

| # | Issue | Severity | Effort |
|---|---|---|---|
| CQ-7 | Fix `contextBudgetTokens` default mismatch (150k vs 100k) | Medium | XS |
| A-7 | Fix `conversationMode` enum mismatch ("smart-switch" vs "smart") | Low | XS |
| D-2 | Remove or wire `coogent.logDirectory` | Medium | S |
| D-3 | Wire `enableEncryption` or remove from package.json | Medium | S |
| D-4 | Wire `blockOnSecretsDetection` or remove from package.json | Medium | S |

### Short-term (next 2-3 sprints)

| # | Issue | Severity | Effort |
|---|---|---|---|
| A-2 | Extract UIBroadcaster interface | High | M |
| CQ-1 | De-duplicate session reset logic | High | S |
| D-1 | Wire `useAgentSelection` and `enableShadowMode` settings | High | M |
| A-4 | Make `workerTimeoutMs` reactively updatable | Medium | S |
| CQ-3 | Extract StreamAccumulator from EngineWiring | Medium | M |

### Medium-term (quarterly planning)

| # | Issue | Severity | Effort |
|---|---|---|---|
| A-1 | Evolve ServiceContainer toward typed-scope pattern | High | L |
| A-6 | Consolidate StorageBase vs paths.ts | Medium | M |
| L-2 | Remove unused `_storageUri` parameter | Medium | XS |
| L-4 | Cleanup internal refactor comments | Low | S |

---

```json
{
  "decisions": [
    "Classified ServiceContainer as Service Locator anti-pattern — recommend scoped factory functions over full container passing",
    "Identified MissionControlPanel.broadcast coupling in wiring modules as the highest-impact structural issue",
    "Flagged contextBudgetTokens default mismatch (150k in package.json vs 100k in TS) as the most impactful quick fix",
    "Prioritized dead feature-flag wiring (useAgentSelection, enableShadowMode, enableEncryption, blockOnSecretsDetection) as critical for user trust",
    "Chose to focus Phase 1 review on orchestration layer (extension.ts through types/) rather than engine internals or webview"
  ],
  "modified_files": [
    "review-part1-architecture.md"
  ],
  "unresolved_issues": [
    "Engine.ts internals, DispatchController, and evaluators/ not yet reviewed — deeper engine FSM logic needs Phase 2 analysis",
    "Webview module (MissionControlPanel, SidebarMenuProvider) not reviewed — Phase 2 or separate UI review needed",
    "Full dead-code analysis (tree-shaking, unused exports) not performed — requires build-time analysis tools",
    "agent-selection/ module internal quality not reviewed — only dormant status identified",
    "Session/consolidation/prompt-compiler internals deferred to later phases"
  ],
  "next_steps_context": "Phase 2 should focus on: (1) engine/ internals (Engine.ts FSM, DispatchController, evaluators, SelfHealingController, workers), (2) webview/ module (MissionControlPanel message handling, state management), (3) mcp/ module (ArtifactDB, CoogentMCPServer, MCPClientBridge), (4) context/ module (ContextScoper, ContextPackBuilder, HandoffExtractor). The highest-priority action item from this review is wiring the dormant configuration settings (useAgentSelection, enableShadowMode, enableEncryption, blockOnSecretsDetection) and fixing the contextBudgetTokens/conversationMode default mismatches."
}
```
