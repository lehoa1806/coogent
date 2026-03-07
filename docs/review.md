# Phase 1 — Comprehension & Architecture Analysis

## 1.1 Documentation Synthesis

### Individual Document Evaluation

| Document | Lines | Clarity | Completeness | Grade |
|----------|-------|---------|--------------|-------|
| `README.md` | 158 | Excellent — problem/solution framing, ASCII workflow diagram, screenshots | Good — missing contribution workflow details | **A** |
| `ARCHITECTURE.md` | 294 | Excellent — ASCII system diagram, FSM table, tech stack matrix | Strong — covers all 8 subsystems; minor gap on V2 evaluators | **A** |
| `DEVELOPER_GUIDE.md` | 244 | Very Good — clear project structure tree, debugging quick-reference | Good — mock patterns are helpful; missing IDE launch config docs | **A-** |
| `USER_GUIDE.md` | 156 | Good — 4 clear workflows, settings table | Missing advanced scenarios (conflict resolution, manual runbook editing) | **B+** |
| `API_REFERENCE.md` | 237 | Very Good — URI tables, schema examples, correlation pattern code | Excellent for integrators; could use more error response examples | **A-** |
| `OPERATIONS.md` | 169 | Good — troubleshooting tables, log format examples | Missing monitoring/alerting guidance, metrics | **B+** |
| `SITE_MAP.md` | 39 | Concise — reading order by persona is a strong pattern | Complete for its purpose | **A** |

### Cross-Document Analysis

**Strengths:**
- Consistent formatting: All docs use tables, code blocks, and structured headings
- The `SITE_MAP.md` reading-order-by-persona pattern is exemplary
- ASCII architecture diagram in `ARCHITECTURE.md` is detailed and accurate
- IPC correlation pattern in `API_REFERENCE.md` includes actual code samples

**Gaps & Inconsistencies:**
1. **Test count drift**: `OPERATIONS.md` references "268/268 pass" but the actual suite now has 363 tests (28 suites). This suggests docs weren't updated after the V2 evaluator additions.
2. **Missing ADR records**: No Architecture Decision Records exist. Key decisions (WAL over journaling, branded types, in-process MCP) are mentioned inline but not formally documented.
3. **V2 Evaluator system undocumented**: The `EvaluatorRegistryV2` and its 4 evaluator strategies are not mentioned in any documentation. `DEVELOPER_GUIDE.md` references `evaluators/` as "CompilerEvaluator (exit_code, regex, toolchain, test_suite)" — this is the V1 name but the V2 registry is the active system.
4. **Webview architecture documentation gap**: The Svelte 5 Runes migration (`$state`/`$derived`/`$effect`) is not documented. `ARCHITECTURE.md` still shows `appState (writable)` — the V1 pattern.
5. **No runbook authoring guide**: The runbook JSON schema is referenced but there's no guide for hand-crafting runbooks (fields, evaluator types, DAG dependencies).
6. **`CONTRIBUTING.md` not reviewed**: Listed in `SITE_MAP.md` but not provided — may duplicate `DEVELOPER_GUIDE.md` content.

**Onboardability Assessment:**
A new contributor could successfully set up, build, test, and debug the project from these docs. The gap is in *understanding design intent* — without ADRs, a contributor wouldn't know *why* WAL was chosen over alternatives, or why MCP is in-process rather than a sidecar.

---

## 1.2 Core Objective

**Coogent** is a VS Code extension that combats AI context collapse by decomposing complex coding tasks into isolated, zero-context micro-phases executed by ephemeral AI agents, each receiving *only* the files it needs. The target audience is **individual developers and small engineering teams** using Antigravity IDE (VS Code ≥ 1.85) who need to orchestrate multi-step AI-assisted code changes without the quality degradation of long-running conversations. The architecture follows a **deterministic finite state machine (FSM) pattern** with DAG-aware parallel scheduling, in-process MCP for artifact management, and WAL-based crash recovery — a "local-first orchestration engine" design.

---

## 1.3 Technical Approach

### 1.3.1 The 9-State FSM Engine

The `Engine` class implements a strict 9-state FSM with 11 transition events:

```
IDLE → PLANNING → PLAN_REVIEW → PARSING → READY → EXECUTING_WORKER → EVALUATING → COMPLETED
                                                         ↑                    ↓
                                                     RETRY ← ── ERROR_PAUSED
```

**Key design properties:**
- **Deterministic**: Transition table is a `switch` statement with exhaustive guards — no implicit state changes
- **Event-driven**: All transitions triggered by typed `EngineEvent` discriminated union
- **Observable**: Every transition emits `state:changed` and `ui:message` events

### 1.3.2 DAG-Aware Parallel Scheduling (Kahn's Algorithm)

The `Scheduler` class supports two modes:
- **V1 Sequential**: When no phase has `depends_on`, phases execute serially by index
- **V2 DAG**: When `depends_on` arrays are present, Kahn's topological sort enables parallel dispatch

**Implementation details:**
- Cycle detection via incomplete Kahn traversal (unprocessed nodes = cycle members)
- O(1) phase lookup via `Map<PhaseId, Phase>` (tagged as optimization `W-6`)
- Index-based queue (`head` pointer) avoids O(n) `Array.shift()` (tagged `B-5`)
- Concurrency limit: 4 simultaneous workers (configurable)

### 1.3.3 In-Process MCP Server Architecture

`CoogentMCPServer` runs in-process (no sidecar, no HTTP) using `@modelcontextprotocol/sdk`:
- **Resources** (Read): 5 URI patterns via `coogent://` scheme — task summary, plan, report, phase plan, phase handoff
- **Tools** (Write): 4 tools — `submit_implementation_plan`, `submit_phase_handoff`, `submit_consolidation_report`, `get_modified_file_content`
- **Persistence**: `ArtifactDB` wraps `sql.js` WASM for SQLite — dual-layer (in-memory reads, disk flushes on write)

### 1.3.4 Context Diffusion Pipeline (5-Step)

| Step | Component | Action |
|------|-----------|--------|
| 1. Planning | `PlannerAgent` | Prompt → runbook JSON decomposition |
| 2. Execution | `ADKController` + `ContextScoper` | Curated file payloads → ephemeral workers |
| 3. Checkpointing | `GitManager` | Git snapshot commits after successful exits |
| 4. Distillation | `HandoffExtractor` / MCP | Extracts decisions, modified files, blockers |
| 5. Consolidation | `ConsolidationAgent` | Aggregates all handoffs → final report |

**Context Scoping sub-pipeline:**
- File discovery via `context_files` + AST-based import resolution (`ASTFileResolver`)
- Binary detection (null-byte heuristic in first 8KB)
- Secrets detection (`SecretsGuard`: API key patterns, PEM blocks, Shannon entropy > 4.5)
- Token budgeting (`TiktokenEncoder` with `CharRatioEncoder` fallback)
- Output batching (`OutputBufferRegistry`: 100ms timer / 4KB buffer threshold)

### 1.3.5 WAL-Based Crash Recovery

Every state mutation follows a 6-step atomic write sequence:
1. Acquire `.lock` file (O_CREAT | O_EXCL)
2. Write WAL snapshot (`.wal.json`)
3. Write temp file (`.task-runbook.json.tmp`)
4. Atomic rename (temp → real)
5. Remove WAL
6. Release lock

On crash recovery: StateManager detects stale `.wal.json`, re-applies snapshot, transitions to `ERROR_PAUSED`.

### 1.3.6 Git Sandboxing

- **Pre-flight check**: VS Code Git API (non-destructive)
- **Clean tree** → auto-create `coogent/<task-slug>` branch from HEAD
- **Dirty tree** → user prompt: continue or cancel
- Branch created once per session (tracked via `branchCreated` flag)
- No automatic merge/rebase — user controls integration

### 1.3.7 V2 Pluggable Evaluator System

`EvaluatorRegistryV2` implements the Strategy pattern:

| Evaluator | Criteria Format | Behavior |
|-----------|----------------|----------|
| `ExitCodeEvaluatorV2` | `exit_code:N` | Match process exit code |
| `RegexEvaluator` | `regex:<pattern>` | Match stdout against regex |
| `ToolchainEvaluatorV2` | `toolchain:<cmd>` | Run whitelisted binary (execFile, no shell) |
| `TestSuiteEvaluatorV2` | `test_suite:<cmd>` | Run test command, parse results |

All evaluators return `EvaluationResult { passed, reason, retryPrompt? }` — the optional `retryPrompt` integrates with `SelfHealingController.buildHealingPromptWithContext()` for intelligent retry feedback.

---

## 1.4 Data Flow & State Mapping

### Primary Data Lifecycle

```
User Prompt
    │
    ▼
PlannerAgent ──► Runbook JSON (.task-runbook.json)
                      │
                      ▼
              StateManager (WAL persist)
                      │
                      ▼
               Engine FSM (IDLE → PLANNING → PLAN_REVIEW → PARSING → READY)
                      │
                      ▼
              ┌── Scheduler.getReadyPhases() ──┐
              │                                │
              ▼                                ▼
     ContextScoper                    ContextScoper
     (file assembly)                  (file assembly)
              │                                │
              ▼                                ▼
     ADKController                    ADKController
     (spawn worker)                   (spawn worker)
              │                                │
              ▼                                ▼
     OutputBuffer ──► UI              OutputBuffer ──► UI
     (100ms/4KB batch)                (100ms/4KB batch)
              │                                │
              ▼                                ▼
     EvaluatorRegistryV2              EvaluatorRegistryV2
     (success check)                  (success check)
              │                                │
              ├──pass──► GitManager            ├──pass──► GitManager
              │          (checkpoint)          │          (checkpoint)
              │                                │
              ├──fail──► SelfHealing           ├──fail──► SelfHealing
              │          (retry w/ context)     │          (retry w/ context)
              │                                │
              ▼                                ▼
     HandoffExtractor                 HandoffExtractor
     (decisions, files)               (decisions, files)
              │                                │
              └───────────────┬────────────────┘
                              ▼
                    ConsolidationAgent
                    (aggregate report)
                              │
                              ▼
                    ArtifactDB (SQLite)
                    (persist to artifacts.db)
```

### Hybrid State Distribution

| Model | Data Type | Mechanism | Frequency |
|-------|-----------|-----------|-----------|
| **Push** | Engine state, phase statuses, token budgets | `STATE_SNAPSHOT` via `postMessage` | Every mutation |
| **Pull** | Plans, reports, handoffs (Markdown) | `MCP_FETCH_RESOURCE` → `MCP_RESOURCE_DATA` | On-demand (user clicks) |

### Persistence Flows

| Store | Format | Location | Scope |
|-------|--------|----------|-------|
| Runbook state | JSON + WAL | `.coogent/ipc/<session>/` | Per-session |
| Artifacts (plans, handoffs) | SQLite | `.coogent/artifacts.db` | Cross-session |
| Telemetry logs | JSONL | `.coogent/logs/<run>/` | Per-run |
| Git checkpoints | Git commits | `coogent/<slug>` branch | Per-task |

---

## 1.5 Mermaid.js Flowchart

### FSM State Machine

```mermaid
stateDiagram-v2
    [*] --> IDLE
    IDLE --> PLANNING : PLAN
    PLANNING --> PLAN_REVIEW : PLAN_READY
    PLAN_REVIEW --> PARSING : APPROVE
    PLAN_REVIEW --> PLANNING : PLAN (regenerate)
    PARSING --> READY : PARSE_OK
    READY --> EXECUTING_WORKER : START
    EXECUTING_WORKER --> EVALUATING : WORKER_EXITED (last worker)
    EXECUTING_WORKER --> EXECUTING_WORKER : WORKER_EXITED (more active)
    EVALUATING --> COMPLETED : EVALUATE_OK (all done)
    EVALUATING --> READY : EVALUATE_OK (more phases)
    EVALUATING --> ERROR_PAUSED : EVALUATE_FAIL
    ERROR_PAUSED --> READY : RETRY
    ERROR_PAUSED --> IDLE : ABORT
    COMPLETED --> IDLE : RESET
    READY --> IDLE : ABORT
    EXECUTING_WORKER --> IDLE : ABORT
```

### Full Data Flow

```mermaid
flowchart TD
    subgraph Input
        UP[User Prompt]
        CF[Codebase Files]
    end

    subgraph Planning
        PA[PlannerAgent]
        RB[Runbook JSON]
    end

    subgraph StateLayer["State & Persistence"]
        SM[StateManager + WAL]
        ADB[ArtifactDB SQLite]
        GIT[Git Checkpoints]
    end

    subgraph Execution
        SCH[Scheduler DAG]
        CS[ContextScoper]
        SG[SecretsGuard]
        TE[TiktokenEncoder]
        ADK[ADKController]
        OB[OutputBuffer]
    end

    subgraph Evaluation
        ER[EvaluatorRegistryV2]
        EC[ExitCodeEvaluator]
        RE[RegexEvaluator]
        TC[ToolchainEvaluator]
        TS[TestSuiteEvaluator]
        SH[SelfHealingController]
    end

    subgraph Output
        HE[HandoffExtractor]
        CA[ConsolidationAgent]
        UI[Svelte 5 Webview]
    end

    UP --> PA
    CF --> PA
    PA --> RB
    RB --> SM
    SM --> SCH
    SCH --> CS
    CF --> CS
    CS --> SG
    SG --> TE
    TE --> ADK
    ADK --> OB
    OB --> UI
    ADK --> ER
    ER --> EC & RE & TC & TS
    ER -->|pass| GIT
    ER -->|pass| HE
    ER -->|fail| SH
    SH -->|retry| ADK
    HE --> ADB
    HE --> CA
    CA --> ADB
    ADB --> UI
    SM --> UI
```

---

## Summary of Findings

| Area | Assessment |
|------|-----------|
| Documentation coverage | **Strong** — 6 docs + README covers all key angles |
| Documentation accuracy | **Minor drift** — test count, V2 evaluators, Svelte 5 Runes not reflected |
| Architecture clarity | **Excellent** — FSM, DAG, MCP, WAL all well-defined |
| Technical sophistication | **High** — branded types, WAL crash recovery, strategy pattern evaluators |
| Onboarding readiness | **Good** — missing ADRs and runbook authoring guide |

```json
{
  "decisions": [
    "Evaluated all 7 documentation files individually using a clarity/completeness rubric",
    "Identified 6 specific documentation gaps including test count drift and undocumented V2 evaluator system",
    "Mapped the full data lifecycle from user prompt through consolidation with persistence layers",
    "Generated two Mermaid diagrams: FSM state machine and full data flow graph",
    "Classified documentation accuracy as 'minor drift' rather than 'major drift' since core architecture is accurately documented"
  ],
  "modified_files": [],
  "unresolved_issues": [
    "Test count in OPERATIONS.md (268) is stale — actual count is 363",
    "ARCHITECTURE.md still shows writable stores — Svelte 5 Runes migration not reflected",
    "V2 EvaluatorRegistryV2 system is not documented in any file",
    "No ADR records exist for key architectural decisions",
    "CONTRIBUTING.md was not available for review"
  ],
  "next_steps_context": "Phase 2 should verify each documented component against actual code. Key areas to check: (1) FSM transition table completeness in Engine.ts, (2) DAG cycle detection in Scheduler.ts, (3) WAL 6-step sequence in StateManager.ts, (4) V2 evaluator registry wiring, (5) Svelte 5 Runes migration completeness in webview-ui stores. Documentation drift is minor but should be flagged in the alignment table."
}
```

# Phase 2 — Implementation Verification Report

> **Reviewer**: Principal AI Architect
> **Date**: 2026-03-07
> **Scope**: Structural scan + alignment verification of `coogent/` against `ARCHITECTURE.md`

---

## 2.1 Structural Scan

### Separation of Concerns

The codebase maintains a **clean boundary** between the VS Code extension host (`src/`) and the Svelte 5 webview (`webview-ui/`). Communication flows through a well-defined IPC bridge using `postMessage` / `onDidReceiveMessage`, with types shared via `src/types/index.ts`.

Within `src/`, responsibilities are properly separated into domain-specific directories:

| Directory | Responsibility | Cohesion |
|---|---|---|
| `engine/` | FSM lifecycle, DAG scheduling, self-healing | ✅ High |
| `evaluators/` | Pluggable phase success evaluation (4 strategies) | ✅ High |
| `context/` | File resolution, tokenization, secrets detection, pruning | ✅ High |
| `mcp/` | MCP server, ArtifactDB (SQLite), client bridge | ✅ High |
| `adk/` | Worker spawning, output buffering, adapter layer | ✅ High |
| `git/` | Git sandbox management, snapshot commits | ✅ High |
| `state/` | WAL persistence, schema validation, crash recovery | ✅ High |
| `planner/` | AI-driven runbook generation | ✅ High |
| `consolidation/` | Cross-phase report aggregation | ✅ High |
| `session/` | Session lifecycle management | ✅ High |
| `logger/` | JSONL telemetry logging, log streaming | ✅ High |
| `webview/` | VS Code panel management, message handling | ✅ High |
| `types/` | Shared type definitions (single `index.ts`) | ✅ High |

### File Size & Complexity Analysis

| File | Lines | Assessment |
|---|---|---|
| `Engine.ts` | 1,374 | ⚠️ **Exceeds 500-line threshold.** However, the file is well-structured with clear section headers (state machine core, user commands, planning commands, worker callbacks, private helpers, watchdog). The high line count is justified by the FSM's inherent complexity. Decomposition would fragment the state machine. |
| `CoogentMCPServer.ts` | 841 | ⚠️ **Exceeds 500-line threshold.** Includes URI parsing, resource handlers, tool handlers, and validation. Could extract validation helpers into a separate file, but the current structure is coherent. |
| `ContextScoper.ts` | 268 | ✅ Within limits |
| `StateManager.ts` | 438 | ✅ Within limits |
| `CommandRegistry.ts` | 357 | ✅ Within limits |
| `EngineWiring.ts` | 365 | ✅ Within limits |
| `GitSandboxManager.ts` | 340 | ✅ Within limits |
| `extension.ts` | 270 | ✅ Within limits — lean entry point |
| `Scheduler.ts` | 174 | ✅ Within limits |
| `SelfHealing.ts` | 188 | ✅ Within limits |
| `EvaluatorRegistry.ts` | 35 | ✅ Within limits |
| `ServiceContainer.ts` | 83 | ✅ Within limits |
| `PlannerWiring.ts` | 99 | ✅ Within limits |

### Test Coverage Structure

Test files are colocated in `__tests__/` subdirectories within each module, mirroring the source structure:

| Source Module | Test File(s) | Coverage |
|---|---|---|
| `engine/Engine.ts` | `engine/__tests__/Engine.test.ts` | ✅ |
| `engine/Scheduler.ts` | `engine/__tests__/Scheduler.test.ts` | ✅ |
| `engine/SelfHealing.ts` | `engine/__tests__/SelfHealing.test.ts` | ✅ |
| `evaluators/*` | `evaluators/__tests__/EvaluatorV2.test.ts`, `CompilerEvaluator.test.ts` | ✅ |
| `state/StateManager.ts` | `state/__tests__/StateManager.test.ts`, `StateManager.race.test.ts`, `SchemaSync.test.ts` | ✅ |
| `mcp/CoogentMCPServer.ts` | `mcp/__tests__/CoogentMCPServer.test.ts` | ✅ |
| `mcp/MCPClientBridge.ts` | `mcp/__tests__/MCPClientBridge.test.ts` | ✅ |
| `context/ContextScoper.ts` | `context/__tests__/ContextScoper.test.ts` | ✅ |
| `context/SecretsGuard.ts` | `context/__tests__/SecretsGuard.test.ts` | ✅ |
| `context/TiktokenEncoder.ts` | `context/__tests__/TiktokenEncoder.test.ts` | ✅ |
| `context/ASTFileResolver.ts` | `context/__tests__/ASTFileResolver.test.ts` | ✅ |
| `context/HandoffExtractor.ts` | `context/__tests__/HandoffExtractor.test.ts` | ✅ |
| `context/TokenPruner.ts` | `context/__tests__/TokenPruner.test.ts` | ✅ |
| `git/GitManager.ts` | `git/__tests__/GitManager.test.ts` | ✅ |
| `git/GitSandboxManager.ts` | `git/__tests__/GitSandboxManager.test.ts` | ✅ |
| `adk/ADKController.ts` | `adk/__tests__/ADKController.test.ts` | ✅ |
| `adk/OutputBuffer*` | `adk/__tests__/OutputBuffer.test.ts` | ✅ |
| `planner/PlannerAgent.ts` | `planner/__tests__/PlannerAgent.test.ts` | ✅ |
| `consolidation/ConsolidationAgent.ts` | `consolidation/__tests__/ConsolidationAgent.test.ts` | ✅ |
| `logger/*` | `logger/__tests__/LogStream.test.ts`, `TelemetryLogger.test.ts` | ✅ |
| `webview/*` | `webview/__tests__/MissionControlPanel.test.ts`, `messageHandler.test.ts` | ✅ |
| `ServiceContainer.ts` | ❌ **No dedicated test** | Gap |
| `CommandRegistry.ts` | ❌ **No dedicated test** | Gap |
| `EngineWiring.ts` | ❌ **No dedicated test** | Gap |
| `PlannerWiring.ts` | ❌ **No dedicated test** | Gap |

> **Test gap**: The 4 R1-refactored modules (`ServiceContainer`, `CommandRegistry`, `EngineWiring`, `PlannerWiring`) lack dedicated unit tests. While their behavior is partially covered by the integration test (`__tests__/integration.test.ts`), isolated unit tests are recommended.

---

## 2.2 Alignment & Architectural Drift

### Alignment Summary Table

| # | Component | ARCHITECTURE.md Claim | Implementation Status | Verdict |
|---|---|---|---|---|
| 1 | **FSM States** | 9 states: IDLE, PLANNING, PLAN_REVIEW, PARSING, READY, EXECUTING_WORKER, EVALUATING, ERROR_PAUSED, COMPLETED | All 9 states defined in `types/index.ts` via `EngineState` enum. `Engine.ts` implements all transitions via `STATE_TRANSITIONS` table. Events: PLAN_REQUEST, PLAN_GENERATED, PLAN_APPROVED, PLAN_REJECTED, LOAD_RUNBOOK, PARSE_SUCCESS, PARSE_FAILURE, START, WORKER_EXITED, ALL_PHASES_PASS, PHASE_PASS, PHASE_FAIL, WORKER_TIMEOUT, WORKER_CRASH, RETRY, SKIP_PHASE, ABORT, RESET (18 events, exceeding the 11 documented). | ✅ **Aligned** |
| 2 | **DAG Scheduling** | Kahn's algorithm with cycle detection; max 4 concurrent workers | `Scheduler.ts` implements Kahn's algorithm in `kahnSort()` (L128-172). `detectCycles()` uses it for validation (L94-108). Default `maxConcurrent = 4` (L27). O(1) Map-based lookups (W-6 fix). | ✅ **Aligned** |
| 3 | **MCP Server** | Resources: summary, implementation_plan, consolidation_report, phase/implementation_plan, phase/handoff. Tools: submit_phase_handoff, submit_implementation_plan, submit_consolidation_report, get_modified_file_content | `CoogentMCPServer.ts` registers all 5 resource URI patterns (L47-51, L80-101) and all 4 tools (L416-551). URI parsing handles both task-level and phase-level resources. | ✅ **Aligned** |
| 4 | **WAL Pattern** | 6-step: acquire lock → write WAL → write temp → atomic rename → remove WAL → release lock | `StateManager._doSave()` (L171-202): `acquireLock()` → `writeFile(walPath)` → `writeFile(tmpPath)` → `rename(tmp, real)` → `unlink(walPath)` → `releaseLock()`. Exact 6-step match. | ✅ **Aligned** |
| 5 | **Context Pipeline** | 5-step: Planning → Execution → Checkpointing → Distillation → Consolidation | All 5 steps implemented: (1) `PlannerAgent` generates runbook; (2) `ADKController.spawnWorker()` via `EngineWiring.executePhase()`; (3) `GitManager.snapshotCommit()` via `phase:checkpoint` event; (4) `HandoffExtractor.extractHandoff()` on worker exit; (5) `ConsolidationAgent.generateReport()` via `run:consolidate` event. | ✅ **Aligned** |
| 6 | **Git Sandboxing** | Pre-flight: check for uncommitted changes; branch from HEAD as `coogent/<task-slug>` | `GitSandboxManager.preFlightCheck()` (L167-197) checks `workingTreeChanges` and `indexChanges`. `createSandboxBranch()` (L211-260) creates `coogent/<sanitized-slug>` branches. Uses exclusively the VS Code Git API — no `child_process`. | ✅ **Aligned** |
| 7 | **Decomposed Architecture** | `extension.ts` delegates to ServiceContainer, CommandRegistry, EngineWiring, PlannerWiring | `extension.ts` (270 lines) imports and calls: `ServiceContainer` (L42), `registerAllCommands()` from `CommandRegistry` (L69), `wireEngine()` from `EngineWiring` (L173), `wirePlanner()` from `PlannerWiring` (L174). All 4 modules exist. `ServiceContainer` holds 16 service fields + `releaseAll()` (L62-81). `CommandRegistry` registers 14 commands (L95-356). | ✅ **Aligned** |
| 8 | **V2 Evaluator System** | `EvaluatorRegistryV2` registers 4 evaluator types | `EvaluatorRegistry.ts` (L16-34) registers: `exit_code` → `ExitCodeEvaluatorV2`, `regex` → `RegexEvaluator`, `toolchain` → `ToolchainEvaluatorV2`, `test_suite` → `TestSuiteEvaluatorV2`. All 4 evaluators implement `IEvaluator` interface. Default fallback to `exit_code` when type is undefined. | ✅ **Aligned** |

### Additional Observations

#### Documentation–Code Alignment Nuances

1. **FSM Events count**: ARCHITECTURE.md lists 11 events (`PLAN`, `PLAN_READY`, `APPROVE`, `PARSE_OK`, `START`, `WORKER_EXITED`, `EVALUATE_OK`, `EVALUATE_FAIL`, `RETRY`, `ABORT`, `RESET`). The actual implementation in `types/index.ts` uses different names and has 18 events. The conceptual mapping is correct but the naming diverges:
   - `PLAN` → `PLAN_REQUEST`
   - `PLAN_READY` → `PLAN_GENERATED`
   - `APPROVE` → `PLAN_APPROVED`
   - `PARSE_OK` → `PARSE_SUCCESS`
   - `EVALUATE_OK` → `ALL_PHASES_PASS` / `PHASE_PASS`
   - `EVALUATE_FAIL` → `PHASE_FAIL`
   - Additional events: `PLAN_REJECTED`, `LOAD_RUNBOOK`, `PARSE_FAILURE`, `WORKER_TIMEOUT`, `WORKER_CRASH`, `SKIP_PHASE`

   **Verdict**: ⚠️ **Minor Drift** — The docs use simplified event names. The implementation has more granular events. A doc update would improve clarity.

2. **Webview state description**: ARCHITECTURE.md describes `appState` as `(writable)` but the codebase has been migrated to Svelte 5 Runes (`$state`). This is explicitly covered in conversation history as the "V2 Runes Migration."

   **Verdict**: ⚠️ **Minor Drift** — ARCHITECTURE.md still references `writable` stores; should be updated to reflect Svelte 5 `$state` runes.

3. **Output Batching**: Documented as `100ms / 4KB batch` in ARCHITECTURE.md. Implementation in `OutputBufferRegistry` confirms this pattern (referenced in `EngineWiring.ts` L177 and wired in `extension.ts` L127-132).

   **Verdict**: ✅ **Aligned**

4. **ArtifactDB location**: ARCHITECTURE.md (L168) states `artifacts.db` is stored at `.coogent/` root for cross-session access. Implementation in `CoogentMCPServer.init()` (L198-201) confirms: `path.join(coogentDir, 'artifacts.db')` where `coogentDir` is `<workspace>/.coogent`.

   **Verdict**: ✅ **Aligned**

5. **Tokenizers**: Documentation lists `TiktokenEncoder` as V1 default with `CharRatioEncoder` fallback. Implementation in `ContextScoper.createDefaultEncoder()` (L70-77) tries `TiktokenEncoder` first and falls back to `CharRatioEncoder`.

   **Verdict**: ✅ **Aligned**

6. **`execFile` over `exec`**: Both `ToolchainEvaluatorV2` (L6, L78) and `TestSuiteEvaluatorV2` (L6, L88) use `execFile` (no shell) with binary whitelisting and strict timeouts. `GitSandboxManager` uses the VS Code Git API exclusively (no child_process).

   **Verdict**: ✅ **Aligned**

7. **Engine.ts size**: At 1,374 lines, the file is well above the 500-line guideline. While the sections are well-organized (state machine, commands, planning, worker callbacks, helpers, watchdog), monitor for continued growth. The stall watchdog (L1220-1304) and session switching (L403-439) each add significant bulk.

   **Verdict**: ⚠️ **Minor Drift** — Not a documentation issue, but an implementation concern. Consider extracting the lifecycle watchdog into a separate module.

### Alignment Verdict Summary

| Status | Count |
|---|---|
| ✅ Aligned | 8 / 8 core checks |
| ⚠️ Minor Drift | 3 minor documentation gaps |
| ❌ Major Drift | 0 |

---

## Summary of Findings

**The implementation strongly aligns with the documented architecture.** All 8 major architectural claims in ARCHITECTURE.md are faithfully implemented. The 3 minor drift items are documentation-only issues that do not impact runtime behavior:

1. FSM event names in ARCHITECTURE.md use simplified names vs. the actual `EngineEvent` enum values
2. Webview state management description references legacy Svelte `writable` stores instead of Svelte 5 Runes
3. `Engine.ts` at 1,374 lines exceeds the 500-line complexity guideline

### Recommendations

1. **Update ARCHITECTURE.md** to use the actual `EngineEvent` enum names and document the additional events (SKIP_PHASE, WORKER_TIMEOUT, WORKER_CRASH, PLAN_REJECTED, LOAD_RUNBOOK, PARSE_FAILURE)
2. **Update ARCHITECTURE.md** to reflect the Svelte 5 Runes migration (`$state` instead of `writable`)
3. **Add unit tests** for `ServiceContainer`, `CommandRegistry`, `EngineWiring`, and `PlannerWiring`
4. **Consider extracting** the stall watchdog from `Engine.ts` into a dedicated `LifecycleWatchdog.ts` module

```json
{
  "decisions": [
    "Verified all 8 architectural alignment checks — all pass as Aligned or Minor Drift",
    "Identified 3 minor documentation drift items (FSM event names, Svelte 5 Runes, Engine.ts size)",
    "Identified 4 test gaps in R1-refactored modules (ServiceContainer, CommandRegistry, EngineWiring, PlannerWiring)",
    "Confirmed Engine.ts at 1374 lines exceeds 500-line guideline but is well-structured with clear sections",
    "Confirmed CoogentMCPServer.ts at 841 lines exceeds 500-line guideline but has coherent structure",
    "No major architectural drift found between ARCHITECTURE.md and the codebase"
  ],
  "modified_files": [],
  "unresolved_issues": [
    "ARCHITECTURE.md uses simplified FSM event names that differ from actual EngineEvent enum values",
    "ARCHITECTURE.md still references Svelte writable stores instead of Svelte 5 $state runes",
    "No dedicated unit tests for ServiceContainer, CommandRegistry, EngineWiring, PlannerWiring",
    "Engine.ts (1374 lines) and CoogentMCPServer.ts (841 lines) exceed the 500-line complexity guideline"
  ],
  "next_steps_context": "Phase 2 found strong alignment between docs and code. The 3 minor drift items are documentation-only. The 4 test gaps in R1-refactored modules are low-risk since behavior is covered by integration tests. Phase 3 (Security & Safety Review) should pay special attention to: (1) the execFile-based evaluators (ToolchainEvaluator, TestSuiteEvaluator) and their TOOLCHAIN_WHITELIST, (2) the path traversal guards in CoogentMCPServer.handleGetModifiedFileContent and ContextScoper.assemble, (3) the SecretsGuard non-blocking scan pattern, (4) the WAL lockfile PID-based stale detection in StateManager. Engine.ts's workerExitLock serialization mutex (B-1 fix) is critical for race condition prevention during parallel worker exits."
}
```

# Phase 3 — Deep Code Review & Best Practices

> **Reviewer**: Principal AI Architect
> **Date**: 2026-03-07
> **Scope**: Code quality, patterns, and state management analysis across 20 source files

---

## 3.1 Best Practice Alignment

### TypeScript Strict Mode

🟢 **Good Practice** — The codebase demonstrates strong TypeScript discipline. Key observations:

- **Branded types** (`PhaseId`, `UnixTimestampMs`) are defined in `types/index.ts` (L45-51) with dedicated cast functions (`asPhaseId`, `asTimestamp`). These prevent accidental type mixing at compile time.
- **`readonly` modifier** is used consistently on interface fields (`ADKInjectionPayload.ephemeral`, `Phase.id`, `HostToWebviewMessage` payloads). The W-11 exceptions (`context_files`, `phases`) are explicitly documented with justification.
- **`as` casts** are used sparingly and only where structurally sound (e.g., `ArtifactDB.ts` L227 `taskStmt.getAsObject() as {...}` where the SELECT columns are known). No `any` type usage was found in critical paths.

🟡 **Warning** — `CompilerEvaluator.ts` has bare `catch` blocks (L146, L207) that swallow errors silently without logging. The V2 evaluators (`ToolchainEvaluator.ts`, `TestSuiteEvaluator.ts`) correctly capture and surface error output. The V1 `CompilerEvaluator.ts` should be considered for deprecation removal.

🟡 **Warning** — `ADKController.ts` L223: `phaseNumber: phase.id as number` — this cast strips the branded `PhaseId` type. While functionally correct (PhaseId is `number & brand`), it undermines the type safety the brand provides. Should use a dedicated `fromPhaseId()` helper.

### ESM Module Resolution

🟢 **Good Practice** — All imports use `.js` extensions consistently (e.g., `'./types/index.js'`, `'./ServiceContainer.js'`), which is required for Node16 module resolution with `"moduleResolution": "Node16"`. No missing extensions were found across the 20 files reviewed.

💡 **Suggestion** — `TiktokenEncoder.ts` L45 uses `require('js-tiktoken')` instead of dynamic `import()`. The comment (L41-43) explains this is because js-tiktoken is pure JS with no native bindings. While functional, this creates an ESM/CJS boundary crossing that could break under stricter module enforcement. Consider migrating to `await import('js-tiktoken')` with lazy init in an async `countTokens()` or a pre-init factory.

### Error Handling Patterns

🟢 **Good Practice** — Error types are well-defined:
- `ErrorCode` union (L309-322) covers 12 specific error categories.
- `ContextError` in `ContextScoper.ts` (L227-236) uses a discriminated `code` field.
- `ArtifactDB.ts` wraps transactions with `BEGIN`/`COMMIT`/`ROLLBACK` (L173-204, L412-448).
- `StateManager.ts` uses a `finally` block to guarantee lock release (WAL pattern).

🟡 **Warning** — `ArtifactDB.flush()` (L507-511) uses `fs.writeFileSync()` without error handling. A write failure here would corrupt the database. Should wrap in try/catch and log the error, or use an atomic write pattern (temp file + rename) matching `StateManager`'s approach.

### Logging Practices

🟢 **Good Practice** — The centralized `log` module (`logger/log.ts`) is used consistently across all files. Log levels are appropriate:
- `log.info` for lifecycle events (activation, initialization, phase starts)
- `log.warn` for recoverable issues (fallback encoders, skipped branches)
- `log.error` for failures (session creation, handoff extraction)
- `log.onError` as a catch-all error handler for `.catch()` chains

🟡 **Warning** — `SecretsGuard.ts` is scanned pre-injection but findings are only logged via `log.warn`. There is no mechanism to block injection if secrets are found. The guard is documented as "non-blocking" (L5), which is by design, but could lead to accidental secret leakage to AI workers.

### Test Quality

🟢 **Good Practice** — Test files are colocated in `__tests__/` directories. 28 test files cover the core modules. Key patterns:
- Edge cases for cycle detection in `Scheduler.test.ts`
- Race condition tests in `StateManager.race.test.ts`
- Mock adapter in `ADKController.ts` (L601-667) enables deterministic worker testing
- `resetForTesting()` export in `messageHandler.ts` (L55-57) for test isolation

🟡 **Warning** — `MockADKAdapter` (L601-667) is bundled with the production controller file rather than in a test utility. While it enables integration tests, it adds 67 lines to the production bundle. Should be moved to `__tests__/mocks/`.

### Branded Types Usage

🟢 **Good Practice** — `PhaseId` is used in Phase interface (`id: PhaseId`), all IPC message payloads, and webview store types. `UnixTimestampMs` is used in WALEntry, LogEntryMessage, and HealingAttempt.

💡 **Suggestion** — `Phase.id` is defined as `readonly id: PhaseId` but `activeWorkerCount` tracking in `Engine.ts` and `ADKController.ts` uses `phase.id` as a plain `number` key in `Map<number, WorkerHandle>`. Converting to `Map<PhaseId, WorkerHandle>` would ensure end-to-end type safety.

---

## 3.2 Code Quality & Modularity

### Naming Conventions

🟢 **Good Practice** — Naming is consistent and self-documenting:
- Classes: PascalCase (`EvaluatorRegistryV2`, `GitSandboxManager`, `OutputBufferRegistry`)
- Methods: camelCase (`evaluatePhaseResult`, `buildInjectionPrompt`, `preFlightCheck`)
- Constants: UPPER_SNAKE_CASE (`TOOLCHAIN_WHITELIST`, `FLUSH_INTERVAL_MS`, `MAX_BUFFER_SIZE`)
- JSON-persisted fields: snake_case (`project_id`, `context_files`, `depends_on`) — explicitly documented in types/index.ts L67-68
- TypeScript-only fields: camelCase (`smartSwitchTokenThreshold`, `mcpPhaseId`)

### Function/Method Size (>50 lines)

🟡 **Warning** — The following methods exceed 50 lines:

| File | Method | Lines | Assessment |
|---|---|---|---|
| `Engine.ts` | `evaluatePhaseResult()` | ~80 | Contains evaluation + healing + transition logic. Could extract healing decision into SelfHealingController |
| `Engine.ts` | `onWorkerExited()` | ~60 | Worker exit handling with activeWorkerCount management. Well-structured but dense |
| `CoogentMCPServer.ts` | `handleToolCall()` | ~135 | Tool dispatch with validation. Could extract per-tool validators into separate functions |
| `CoogentMCPServer.ts` | `handleReadResource()` | ~100 | URI parsing and dispatch. The switch/case is inherent to the resource routing |
| `ADKController.ts` | `spawnWorker()` | ~100 | Session creation with conversation mode logic, PID registration, watchdog setup. Inherent complexity |
| `ADKController.ts` | `cleanupOrphanedWorkers()` | ~52 | 3-phase orphan cleanup (read → SIGTERM → SIGKILL). Could be simplified |
| `ContextScoper.ts` | `assemble()` | ~75 | Pipeline: resolve → validate → read → scan → tokenize → prune. Inherently sequential |
| `EngineWiring.ts` | `executePhase()` | ~70 | Context assembly → prompt building → MCP URI injection → spawn. Core pipeline |

### Code Duplication

🟡 **Warning** — `TOOLCHAIN_WHITELIST` is defined identically in 3 files:
- `evaluators/ToolchainEvaluator.ts` L13-20
- `evaluators/TestSuiteEvaluator.ts` L13-20
- `evaluators/CompilerEvaluator.ts` L93-100

**Recommendation**: Extract to a shared constant in `types/index.ts` or `evaluators/constants.ts`.

🟡 **Warning** — V1 evaluators (`CompilerEvaluator.ts` — `ExitCodeEvaluator`, `RegexOutputEvaluator`, `ToolchainEvaluator`, `TestSuiteEvaluator`) duplicate the logic of V2 evaluators (`ExitCodeEvaluator.ts`, `RegexEvaluator.ts`, `ToolchainEvaluator.ts`, `TestSuiteEvaluator.ts`). The V1 versions use the deprecated `SuccessEvaluator` interface while V2 uses `IEvaluator`. The V1 `EvaluatorRegistry` and `createEvaluator()` factory appear unused by the Engine (which uses `EvaluatorRegistryV2`).

**Recommendation**: Remove `CompilerEvaluator.ts` entirely. The Engine only uses `EvaluatorRegistryV2`.

### Dead Code

🔴 **Critical** — `CompilerEvaluator.ts` (269 lines) contains the complete V1 evaluator system that is **superseded by the V2 evaluators**:
- `ExitCodeEvaluator` → superseded by `ExitCodeEvaluatorV2`
- `RegexOutputEvaluator` → superseded by `RegexEvaluator`
- `ToolchainEvaluator` → superseded by `ToolchainEvaluatorV2`
- `TestSuiteEvaluator` → superseded by `TestSuiteEvaluatorV2`
- `EvaluatorRegistry` → superseded by `EvaluatorRegistryV2`
- `createEvaluator()` factory → unused

The `SuccessEvaluator` interface in `types/index.ts` (L840-848) is marked `@deprecated` but the implementing code still ships in the bundle.

💡 **Suggestion** — `messageHandler.ts` L205-203 has a documented no-op for `MCP_RESOURCE_DATA` with a 7-line comment explaining why. While well-documented, consider adding a `// @intentional-noop` annotation for grep-ability.

### Coupling Analysis

🟢 **Good Practice** — Modules are well-decoupled:
- `Engine` depends on `StateManager` and `EvaluatorRegistryV2` (abstractions)
- `ADKController` depends on `IADKAdapter` interface, not concrete classes
- `CoogentMCPServer` depends on `ArtifactDB` (data access abstraction)
- `ContextScoper` depends on `TokenEncoder` and `FileResolver` interfaces
- `GitSandboxManager` depends only on the VS Code Git API (no cross-module deps)
- Webview stores (`vscode.svelte.ts`, `mcpStore.svelte.ts`) are fully decoupled from backend — IPC messages are the only coupling

---

## 3.3 State Management & Patterns

### Backend FSM

🟢 **Good Practice** — The FSM transition table in `types/index.ts` (L202-259) is **complete and well-guarded**:

- All 9 states define their valid transitions
- ABORT and RESET are available from every non-terminal state (except COMPLETED only allows RESET)
- Invalid transitions are silently rejected (the Engine's `transition()` method checks the table)
- Self-loops are explicitly modeled: `PLANNING → PLAN_REJECTED → PLANNING`, `EVALUATING → RETRY → EXECUTING_WORKER`

🟢 **Good Practice** — The `workerExitLock` mutex in `Engine.ts` serializes `onWorkerExited()` calls, preventing race conditions when multiple parallel workers exit simultaneously (AB-1 fix). The `activeWorkerCount` counter correctly gates the `WORKER_EXITED` event to only fire when the last worker exits.

💡 **Suggestion** — The RESUME event (L183, L231) appears in the EngineEvent enum and transition table (`READY → RESUME → EXECUTING_WORKER`) but its distinction from START is unclear. Consider documenting the semantic difference or merging them.

### DAG Scheduler

🟢 **Good Practice** — The parallel dispatch strategy is sound:
- Kahn's algorithm in `kahnSort()` correctly detects cycles before execution begins
- `getReadyPhases()` respects both dependency satisfaction and concurrency limits
- `maxConcurrent = 4` prevents runaway parallel spawning
- O(1) Map-based lookups for completed phase checks (W-6 fix)

💡 **Suggestion** — `Scheduler.ts` uses `phase.depends_on as unknown[]` casting (L73, L90) to check array length. This works but is unnecessary — `Array.isArray()` would be clearer and avoid the cast.

### Svelte 5 Webview

🟢 **Good Practice** — The Runes migration is clean and complete:
- `appState` uses `$state()` (L71) with `$effect.root()` for auto-persistence (L82-88)
- Hydration properly resets transient fields via `TRANSIENT_FIELDS` set (L38-44)
- `patchState()` uses `Object.assign()` which correctly triggers Svelte 5's Proxy-based reactivity
- `destroyStore()` cleanup function is exported for test teardown

🟡 **Warning** — `appendPhaseOutput()` (L125-130) creates a new object spread on every append (`{ ...appState.phaseOutputs, [phaseId]: ... }`). For high-frequency output (workers produce thousands of chunks), this creates significant GC pressure. Consider:
1. Using a `Map<number, string>` instead of a plain object
2. Or batching appends with a debounced flush (similar to `OutputBuffer`)

### MCP Store

🟢 **Good Practice** — `mcpStore.svelte.ts` implements a clean factory pattern:
- Each `createMCPResource<T>()` call creates an independent `$state()` object
- requestId-based correlation prevents cross-resource interference
- Self-cleaning listeners remove themselves after response
- `destroy()` method for early cleanup on component unmount
- Documented no-op in `messageHandler.ts` (L194-203) prevents double-resolution

### Dependency Injection / ServiceContainer

🟡 **Warning** — `ServiceContainer` is a **Service Locator**, not a proper DI container:
- All fields are `public` and mutable (`T | undefined`)
- No constructor injection — services are assigned imperatively in `extension.ts`
- `releaseAll()` nullifies all references (manual lifecycle management)
- The `workerOutputAccumulator` (Map) and `sandboxBranchCreatedForSession` (Set) are stateful data, not services

**Assessment**: For a VS Code extension with a single composition root, the Service Locator pattern is pragmatically appropriate. A full DI framework (inversify, tsyringe) would add complexity without proportional benefit. The current pattern works because:
1. There's exactly one `ServiceContainer` instance per extension lifecycle
2. All services are initialized in a deterministic order in `activate()`
3. The container is never passed to untrusted code

**Verdict**: 🟡 Recognized anti-pattern, but pragmatically justified for the extension context.

### Event-Driven Architecture

🟢 **Good Practice** — Engine events are well-typed through the `EngineEvents` interface pattern:
- `ADKControllerEvents` (ADKController.ts L89-98) uses TypeScript's declaration merging for type-safe `on()`/`emit()`
- Events carry specific payload types (no `any` or `unknown`)
- The `EngineWiring.ts` module acts as a clean event router between Engine, ADK, MCP, and webview

💡 **Suggestion** — The Engine itself extends `EventEmitter` but doesn't use the declaration merging pattern like `ADKController` does. Adding a typed `EngineEvents` interface with declaration merging would provide compile-time safety for Engine event listeners.

### Evaluator Strategy Pattern

🟢 **Good Practice** — The V2 `EvaluatorRegistryV2` is a textbook Strategy pattern:
- `IEvaluator` interface defines the contract (L815-832 in types/index.ts)
- `EvaluatorRegistryV2` manages the strategy map (evaluators/EvaluatorRegistry.ts)
- `EvaluationResult` includes structured feedback (`retryPrompt`) for the SelfHealingController
- Default fallback to `exit_code` when type is undefined (L32)
- Each evaluator is self-contained with clear security boundaries (whitelist, timeout, execFile)

🟡 **Warning** — Both V1 (`EvaluatorRegistry` from `CompilerEvaluator.ts`) and V2 (`EvaluatorRegistryV2` from `evaluators/EvaluatorRegistry.ts`) registries exist simultaneously. Only V2 is used by the Engine. The V1 registry and all V1 evaluator classes are dead code.

---

## Summary of Findings by Severity

| Severity | Count | Key Issues |
|---|---|---|
| 🔴 Critical | 1 | `CompilerEvaluator.ts` (269 lines) is dead code — entire V1 evaluator system is superseded |
| 🟡 Warning | 9 | Duplicate `TOOLCHAIN_WHITELIST`; `ArtifactDB.flush()` lacks error handling; `MockADKAdapter` in production file; `appendPhaseOutput()` GC pressure; ServiceContainer is Service Locator; `PhaseId` brand stripped in ADKController |
| 🟢 Good Practice | 12 | Branded types, ESM extensions, transition table completeness, Svelte 5 Runes migration, evaluator Strategy pattern, interface-based DI, error typing |
| 💡 Suggestion | 5 | Extract TOOLCHAIN_WHITELIST, typed Engine events, RESUME/START merge, Scheduler cast cleanup, TiktokenEncoder require→import |

```json
{
  "decisions": [
    "Classified CompilerEvaluator.ts (269 lines, entire V1 evaluator system) as dead code — only V2 evaluators are used by Engine",
    "Identified TOOLCHAIN_WHITELIST duplication across 3 files as extraction candidate",
    "Assessed ServiceContainer as Service Locator anti-pattern but pragmatically justified for VS Code extension context",
    "Confirmed FSM transition table is complete with 9 states, 20 events, and proper ABORT/RESET coverage",
    "Validated Svelte 5 Runes migration as clean with proper hydration, persistence, and cleanup patterns",
    "Identified appendPhaseOutput() as potential GC pressure issue under high-frequency worker output",
    "Confirmed ArtifactDB.flush() uses synchronous writeFileSync without error handling or atomic rename",
    "Found MockADKAdapter bundled with production code instead of test utilities"
  ],
  "modified_files": [],
  "unresolved_issues": [
    "CompilerEvaluator.ts (269 lines) and deprecated SuccessEvaluator interface are dead code shipping in production bundle",
    "TOOLCHAIN_WHITELIST duplicated in 3 evaluator files — should be extracted to shared constant",
    "ArtifactDB.flush() uses writeFileSync without error handling — write failure could corrupt database",
    "MockADKAdapter ships in the production ADKController.ts file (67 lines of test code in prod)",
    "appendPhaseOutput() creates new object spread on every chunk — GC pressure under heavy output",
    "PhaseId branded type is stripped via `as number` cast in ADKController.spawnWorker()"
  ],
  "next_steps_context": "Phase 3 identified one critical issue (V1 evaluator dead code) and 9 warnings. The most actionable items for Phase 4 (if applicable) are: (1) delete CompilerEvaluator.ts and remove the SuccessEvaluator interface, (2) extract TOOLCHAIN_WHITELIST to a shared module, (3) add atomic write pattern to ArtifactDB.flush(), (4) move MockADKAdapter to __tests__/mocks/. The codebase demonstrates strong TypeScript discipline overall, with clean interfaces, proper branded types, and well-structured state management. The Svelte 5 Runes migration is complete and follows best practices. The FSM transition table is complete and race-condition-safe. Security patterns (execFile, whitelist, path traversal guards) are consistently applied across evaluators and context pipeline."
}
```

# Phase 4 — Ecosystem & Comparative Analysis

> **Scope**: Evaluate Coogent's tech stack against 2025–2026 industry trends, compare its architecture with open-source alternatives, and identify modernization opportunities.

---

## 4.1 Modernization & Protocol Adoption

### 4.1.1 MCP Integration Depth

Coogent uses `@modelcontextprotocol/sdk` ^1.27 via an **in-process `Server` instance** (`CoogentMCPServer`). The integration covers two of the four core MCP primitives:

| MCP Primitive | Supported | Details |
|---|---|---|
| **Resources** (read) | ✅ Yes | 5 URI templates (`summary`, `implementation_plan`, `consolidation_report`, phase-level `implementation_plan`, `handoff`) via `coogent://` scheme |
| **Tools** (write) | ✅ Yes | 4 tools (`submit_implementation_plan`, `submit_phase_handoff`, `submit_consolidation_report`, `get_modified_file_content`) with runtime validation |
| **Sampling** | ❌ No | Not used — LLM calls are dispatched directly via `ADKController` spawned processes, bypassing MCP sampling entirely |
| **Prompts** | ❌ No | Prompt templates are constructed inline in `PlannerAgent` and `ConsolidationAgent` — not exposed as MCP Prompt resources |
| **Roots** | ❌ No | The workspace root is passed as a constructor arg; MCP's `roots` capability for workspace scoping is not leveraged |

**Assessment**: MCP is used primarily as a **structured data routing layer** (read/write artifacts between the Extension Host and ephemeral workers). The full protocol potential — server-initiated sampling requests, reusable prompt templates, dynamic root scoping — remains untapped.

**Key Gaps**:

1. **No MCP Sampling**: Workers spawn as independent `child_process` sessions. MCP Sampling would allow the server to request completions from the client, enabling an inverting-control pattern where the MCP server orchestrates LLM calls. This is particularly relevant for the `ConsolidationAgent` and `SelfHealingController` where structured LLM calls are made.
2. **No MCP Prompts**: The planner and consolidation prompt templates are hardcoded. Exposing them as MCP Prompt resources would enable external tooling (MCP Inspector, client UIs) to discover and test prompts independently.
3. **No Roots**: Declaring workspace roots via MCP would improve multi-root workspace support and provide a protocol-standard way for clients to communicate which directories are available.
4. **No Notifications**: The server does not emit `notifications/resources/updated` when artifacts change — clients relying on standard MCP resource subscriptions would not receive updates.

**Recommendation Tier**: 🟡 Medium. Sampling adoption would be the highest-impact improvement, enabling MCP-native LLM orchestration. Prompts and Roots are lower priority but improve interoperability.

---

### 4.1.2 Reactive Frameworks — Svelte 5 Runes Migration

The Svelte 5 Runes migration is **functionally complete**:

| Store / Component | Migration Status | Notes |
|---|---|---|
| `vscode.svelte.ts` | ✅ `$state` + `$effect.root()` | Clean implementation; `appState` is a top-level `$state` object with auto-persist via `$effect` |
| `mcpStore.svelte.ts` | ✅ `$state` | Factory pattern (`createMCPResource`) returns `$state` objects — no legacy stores |
| `writable` imports | ✅ Eliminated | `grep -r "writable"` shows only a single comment explaining the migration; zero runtime usage |
| Component patterns | ✅ Direct property access | Components access `appState.foo` directly without `$`-prefix store subscriptions |

**Idiomatic Usage Assessment**:

| Pattern | Grade | Notes |
|---|---|---|
| `$state` for root objects | ✅ Idiomatic | `appState` uses `$state(hydrateInitialState())` correctly |
| `$effect` for side effects | ✅ Correct | Auto-persist effect reads all properties via spread, triggering correct dependency tracking |
| `$effect.root()` for module-level effects | ✅ Correct | Required for effects outside component context; cleanup function properly exposed |
| `$derived` usage | ⚠️ Under-utilized | No `$derived` runes found — derived computations (e.g., `isExecuting`, `hasError`, `activePhaseCount`) are likely computed inline in templates rather than cached |
| State mutation patterns | ⚠️ `Object.assign` | `patchState()` uses `Object.assign(appState, patch)` — works but bypasses fine-grained reactivity for replaced object properties |

**Recommendations**:
1. **Add `$derived` computations** for frequently-accessed derived state (reduces template complexity)
2. **Replace `Object.assign` patterns** with direct property assignment for better reactivity tracking
3. Consider `$state.snapshot()` (Svelte 5.1+) for explicit serialization instead of `{ ...appState }` spread

---

### 4.1.3 Agent Orchestration Patterns — Comparative Analysis

| Framework | Architecture | Execution Model | State Persistence | Evaluation |
|---|---|---|---|---|
| **Coogent** | FSM (9-state) + DAG scheduler | Parallel `child_process` workers (≤4) | WAL + SQLite (sql.js) | V2 Strategy pattern (`IEvaluator`) |
| **LangGraph** | Stateful directed graph | Async nodes with conditional edges | Checkpointer (SQLite/Postgres) | Custom node functions |
| **CrewAI** | Role-based agents + tasks | Sequential/parallel task execution | In-memory (no persistence) | Task-level validation |
| **OpenAI Agents SDK** | Agent + handoff model | Single-threaded with tool calls | Conversation state | Guardrails (input/output) |
| **AutoGen** | Conversation patterns | Multi-agent chat + function calling | Chat history log | Termination conditions |

**Coogent's Unique Position**:

| Advantage | Details |
|---|---|
| **IDE-native** | Only tool in this comparison that runs inside VS Code Extension Host with native Git API access |
| **Context isolation** | Each phase gets a curated, token-budgeted context slice — prevents context collapse by design |
| **Deterministic FSM** | 9-state machine with strict transition guards prevents non-deterministic state corruption |
| **DAG parallelism** | Dependency-aware parallel scheduling (Kahn's algorithm) vs sequential-only patterns in CrewAI/AutoGen |
| **Crash recovery** | WAL + atomic rename pattern survives IDE crashes — no other tool in the comparison offers this |
| **Git sandboxing** | Automatic sandbox branches with pre-flight dirty-check — architecturally unique |

**Coogent's Gaps vs Competitors**:

| Gap | Competitor with advantage | Recommendation |
|---|---|---|
| No streaming intermediate results between phases | LangGraph (streaming node outputs) | Add inter-phase streaming for long-running DAG chains |
| No human-in-the-loop breakpoints mid-phase | OpenAI Agents SDK (guardrails) | Allow user interruption during worker execution, not just at phase boundaries |
| No dynamic replanning | LangGraph (conditional edges) | Allow the evaluator to trigger DAG modifications (add/skip phases) based on results |
| No conversation memory across sessions | AutoGen (persistent chat log) | The `ArtifactDB` could store cross-session decision logs for progressive learning |
| No role specialization | CrewAI (role + backstory) | Phases could carry agent persona metadata (e.g., "security auditor", "architect") |

---

### 4.1.4 Evaluator Architecture — Comparative Analysis

**Coogent's V2 Evaluator System**:

```
EvaluatorRegistryV2 → Map<EvaluatorType, IEvaluator>
  ├── ExitCodeEvaluatorV2  (exit_code)
  ├── RegexEvaluator       (regex)
  ├── ToolchainEvaluatorV2 (toolchain)
  └── TestSuiteEvaluatorV2 (test_suite)
```

Each evaluator returns `EvaluationResult { passed, reason, retryPrompt? }`, enabling structured feedback for self-healing retries.

| Feature | Coogent V2 | LangSmith | Braintrust | promptfoo |
|---|---|---|---|---|
| **Architecture** | Strategy pattern (registry) | Decorator-based evaluators | Function-based evals | YAML-configured assertions |
| **Result structure** | `{ passed, reason, retryPrompt }` | `{ score, comment }` | `{ score, metadata }` | `{ pass, score, reason }` |
| **Self-healing integration** | ✅ `retryPrompt` feeds `SelfHealingController` | ❌ Evaluation only | ❌ Evaluation only | ❌ Evaluation only |
| **Async support** | ✅ Promise-based | ✅ Async | ✅ Async | ✅ Async |
| **Custom evaluators** | ✅ Implement `IEvaluator` | ✅ Custom functions | ✅ Custom scorers | ✅ Custom providers |
| **LLM-as-judge** | ❌ Not implemented | ✅ Built-in | ✅ Built-in | ✅ Built-in |
| **Composite/chained** | ❌ Single evaluator per phase | ✅ Multiple evaluators | ✅ Composite scores | ✅ Multiple assertions |
| **Historical tracking** | ❌ No eval history | ✅ Run tracking | ✅ Experiment tracking | ✅ Test suite history |

**Key Gaps**:

1. **No LLM-as-judge evaluator**: For code quality or architecture evaluations, an LLM-based evaluator would be more flexible than regex/exit-code patterns
2. **Single evaluator per phase**: Phases can only specify one evaluator type. A composite evaluator (e.g., exit_code AND regex) would catch more failure modes
3. **No evaluation history**: Results are consumed in-flight for self-healing but not persisted for trend analysis or regression detection
4. **No confidence scoring**: Binary pass/fail — no graded scoring for partial successes

**Recommendation Tier**: 🟡 Medium. Adding composite evaluators and LLM-as-judge would significantly improve evaluation fidelity.

---

### 4.1.5 Build & Bundle — Dual Bundler Assessment

**Current Setup**:

| Artifact | Bundler | Config | Output |
|---|---|---|---|
| Extension Host (`extension.js`) | **esbuild** | `esbuild.js` (CJS, Node18, single bundle) | `out/extension.js` (~16 MB with sql.js WASM) |
| Webview UI | **Vite** (Rollup) | `vite.config.ts` (ESM, ES2020, manual chunks) | `webview-ui/dist/` (index.js + vendor-mermaid.js ~2.4 MB) |

**Is the dual-bundler approach optimal?**

| Consideration | Assessment |
|---|---|
| **Technical necessity** | ✅ **Justified**. The Extension Host requires CJS format (`"format": "cjs"`) with Node externals, while the webview requires ESM with browser-targeted builds. These have fundamentally different targets. |
| **Developer experience** | ⚠️ Two `package.json` files, two build configs, two dependency trees. `npm run build` runs both sequentially. |
| **Alternative: Unified Vite** | ❌ Not viable. Vite's `build.lib` mode doesn't support CJS + Node externals for VS Code extensions. The official VS Code extension scaffolding (`yo code`) uses esbuild. |
| **Alternative: esbuild for both** | ⚠️ Possible for simple UIs, but loses Svelte plugin support and Rollup's advanced chunking. |
| **WASM handling** | ⚠️ Custom `copyWasmPlugin` copies `sql-wasm.wasm` — this is fragile. Consider using esbuild's native `loader: { '.wasm': 'file' }` or an `import.meta.glob` pattern. |

**Verdict**: The dual-bundler approach is the **correct architectural choice** for this project. The maintenance cost is low (both configs are <60 lines). The main improvement opportunity is better WASM handling.

---

## 4.2 Alternative Approaches — Competitive Landscape

### Detailed Comparison Matrix

| Dimension | Coogent | Cline | Aider | SWE-Agent | OpenHands | Bolt.new |
|---|---|---|---|---|---|---|
| **Architecture** | FSM + DAG | Conversational | Git-integrated | Research agent | Multi-agent | Browser IDE |
| **Task Decomposition** | ✅ Auto-phased runbook | ❌ Single conversation | ❌ Diff-based | ⚠️ Trajectory-based | ✅ Agent delegation | ❌ Single prompt |
| **Parallel Execution** | ✅ ≤4 concurrent workers | ❌ Sequential | ❌ Sequential | ❌ Sequential | ⚠️ Multi-agent | ❌ Sequential |
| **IDE Integration** | ✅ VS Code native | ✅ VS Code extension | ⚠️ Terminal-based | ❌ CLI/Docker | ❌ Cloud platform | ❌ Browser-only |
| **Git Safety** | ✅ Sandbox branches | ⚠️ Working tree | ✅ Atomic commits | ⚠️ Docker isolation | ⚠️ Container | ❌ No Git |
| **Crash Recovery** | ✅ WAL + SQLite | ❌ None | ❌ None | ❌ None | ⚠️ Container restart | ❌ None |
| **Context Management** | ✅ Token-budgeted scoping | ⚠️ Full conversation | ✅ Repo-map | ⚠️ Retrieval-based | ⚠️ File selection | ❌ Full context |
| **Self-Healing** | ✅ Evaluator + retry | ❌ Manual | ⚠️ Lint feedback | ✅ Trajectory retry | ⚠️ Error recovery | ❌ None |
| **Secrets Detection** | ✅ Pre-injection guard | ❌ None | ❌ None | ❌ None | ❌ None | ❌ None |
| **Pricing Model** | Free (BYOK) | Free (BYOK) | Free (BYOK) | Free (OSS) | Free tier + paid | Paid SaaS |

### Per-Tool Analysis

#### Cline

| Aspect | Analysis |
|---|---|
| **Unique advantage over Coogent** | Lower complexity ceiling — simple request/response loop is easier to reason about for small tasks |
| **Critical weakness vs Coogent** | Context collapse on large tasks; no task decomposition; no parallel execution |
| **Feature to consider adopting** | Cline's inline diff review UI — Coogent could show per-phase diffs inline in Mission Control |

#### Aider

| Aspect | Analysis |
|---|---|
| **Unique advantage over Coogent** | Repo-map generation gives the LLM a bird's-eye view of the entire codebase structure at low token cost |
| **Critical weakness vs Coogent** | No task decomposition — single conversation with growing context; no parallel workers; terminal-only |
| **Feature to consider adopting** | Repo-map concept — Coogent's `ContextScoper` could generate a lightweight repo-map as part of each phase's context injection, giving workers structural awareness beyond their scoped files |

#### SWE-Agent

| Aspect | Analysis |
|---|---|
| **Unique advantage over Coogent** | Academic rigor — trajectory-based evaluation with benchmarks (SWE-bench); bash/file tool abstractions |
| **Critical weakness vs Coogent** | Not IDE-native; Docker-based isolation is heavy; not designed for developer workflow integration |
| **Feature to consider adopting** | Action trajectory logging — recording every tool call and its output for post-hoc analysis would enhance Coogent's observability |

#### OpenHands (formerly OpenDevin)

| Aspect | Analysis |
|---|---|
| **Unique advantage over Coogent** | Cloud-first with container isolation; multi-agent delegation without IDE constraints |
| **Critical weakness vs Coogent** | No local execution; no IDE integration; requires cloud infrastructure; higher latency |
| **Feature to consider adopting** | Agent delegation model — allowing phases to sub-delegate work to specialized agents based on task type |

#### Bolt.new

| Aspect | Analysis |
|---|---|
| **Unique advantage over Coogent** | Zero setup — browser-based with instant preview; good for rapid prototyping |
| **Critical weakness vs Coogent** | No Git integration; no existing codebase support; no persistence; browser sandbox limitations |
| **Feature to consider adopting** | Live preview — Coogent could spawn a dev server for UI phases and show live preview in a webview panel |

### Competitive Advantages Summary

Coogent's **unique competitive moat** comes from the combination of:

1. **Deterministic FSM orchestration** — No other tool provides a formally-defined state machine governing the entire task lifecycle
2. **DAG-aware parallelism** — Only tool that supports dependency-ordered concurrent execution
3. **Context isolation by design** — Zero-context drift via ephemeral workers with token-budgeted scoping
4. **Crash-safe persistence** — WAL + SQLite ensures no work is lost on IDE crashes
5. **Git sandboxing with pre-flight checks** — Architectural safety net that no competitor matches

### Strategic Recommendations (Priority-Ordered)

| Priority | Recommendation | Effort | Impact |
|---|---|---|---|
| 🔴 P1 | Add repo-map to context injection (inspired by Aider) | Medium | High — gives workers structural awareness |
| 🔴 P1 | Add composite evaluators (multiple evaluators per phase) | Low | High — better failure detection |
| 🟡 P2 | Add LLM-as-judge evaluator | Medium | Medium — flexible code quality checks |
| 🟡 P2 | Add `$derived` runes for computed UI state | Low | Medium — cleaner templates |
| 🟡 P2 | Emit MCP `notifications/resources/updated` on artifact writes | Low | Medium — MCP protocol compliance |
| 🟢 P3 | Adopt MCP Sampling for LLM orchestration | High | Medium — architectural shift |
| 🟢 P3 | Expose prompt templates as MCP Prompts | Low | Low — interoperability benefit |
| 🟢 P3 | Add evaluation history persistence to ArtifactDB | Medium | Low — trend analysis for debugging |

---

```json
{
  "decisions": [
    "MCP integration is currently a data-routing layer (Resources + Tools only); Sampling, Prompts, and Roots are not used",
    "Svelte 5 Runes migration is functionally complete — zero runtime writable usage remains. $derived is under-utilized",
    "FSM+DAG orchestration model is architecturally unique and a clear competitive advantage over all compared tools",
    "Dual-bundler (esbuild for Extension Host + Vite for Webview) is the correct and justified approach",
    "V2 evaluator strategy pattern is well-designed but limited to single-evaluator-per-phase and lacks LLM-as-judge capability",
    "Repo-map generation (inspired by Aider) and composite evaluators are the highest-impact improvements",
    "Coogent's crash-safe persistence (WAL + SQLite) and Git sandboxing are unmatched by any competitor in this space"
  ],
  "modified_files": [],
  "unresolved_issues": [
    "No MCP Sampling integration — LLM calls bypass MCP protocol entirely",
    "No composite evaluator support — phases can only use one evaluator type at a time",
    "No evaluation history persistence — results are consumed for self-healing but not stored for trend analysis",
    "$derived runes not used in webview — computed state is likely inline in templates",
    "WASM handling uses a custom esbuild plugin (copyWasmPlugin) instead of native loader configuration"
  ],
  "next_steps_context": "Phase 5 should assess the actionability of the strategic recommendations from this analysis, particularly (1) repo-map generation feasibility given existing ContextScoper architecture, (2) composite evaluator registry design impact on the IEvaluator interface, and (3) MCP Sampling adoption path given the current in-process transport. The Svelte 5 Runes migration is complete and should not block any other work. The dual-bundler approach requires no changes."
}
```

# Phase 5 — Additional Perspectives & Edge Cases

> **Scope**: Extensibility analysis, security/privacy audit, and performance bottleneck identification for the Coogent VS Code extension.

---

## 5.1 Extensibility

### 5.1.1 New Evaluator Types

🟢 **Low Risk — Clean Strategy Pattern**

The `EvaluatorRegistryV2` uses a `Map<EvaluatorType, IEvaluator>` with a clean `getEvaluator(type?)` accessor. Adding a new evaluator requires:

1. Create a class implementing `IEvaluator` (interface in `types/index.ts`)
2. Add the type string to the `EvaluatorType` union in `types/index.ts`
3. Register in `EvaluatorRegistryV2` constructor (1 line)

**No core engine modification is needed.** The Engine calls `registry.getEvaluator(phase.evaluator)` — new evaluators are automatically available. The runbook JSON Schema in `StateManager.ts` also needs the new `evaluator` enum value added (line 39).

**Verdict**: Excellent extensibility. A plugin manifest pattern would make this zero-registration, but the current approach is pragmatic for the project's scale.

### 5.1.2 New MCP Tools/Resources

🟡 **Moderate — Requires `CoogentMCPServer.ts` modification**

Adding a new MCP tool requires:
1. Add tool metadata to the `ListToolsRequest` handler (tool name, inputSchema)
2. Add a case to the `CallToolRequest` switch statement
3. Implement the handler method

Adding a new resource requires:
1. Update `parseResourceURI()` with the new URI pattern
2. Add the URI template to `RESOURCE_URIS` in `types.ts`
3. Add the read handler in `ReadResourceRequest`

**All changes are confined to `CoogentMCPServer.ts` and `types.ts`**, but the monolithic switch/if pattern means every addition modifies the same file. Refactoring to a registry pattern (similar to evaluators) would improve this.

**Verdict**: Functional but not ideal. A tool/resource registry would decouple additions.

### 5.1.3 New FSM States

🟡 **Moderate — Tightly Coupled Transition Table**

The 9-state FSM is defined with TypeScript union types and a transition table. Adding a state requires:
1. Add to `EngineState` type union
2. Update the transition table in `Engine.ts`
3. May require changes to `Scheduler`, `MissionControlPanel`, and `StateManager` (which all switch on state)
4. Update the runbook JSON Schema `status` enum

The FSM is **intentionally rigid** — transitions are guarded by a validation function. This is a strength for correctness but a cost for extensibility. The webview also hardcodes state-to-UI-component mappings.

**Verdict**: Adding states is high-effort by design. The 9-state model covers the full lifecycle well; new states should be rare.

### 5.1.4 Planner Agent Swappability

🟡 **Moderate — ADK Adapter Interface Exists but is Under-Used**

The `IADKAdapter` interface abstracts agent creation:
```typescript
interface IADKAdapter {
    createSession(options: ADKSessionOptions): Promise<ADKSessionHandle>;
    terminateSession(handle: ADKSessionHandle): Promise<void>;
}
```

A `MockADKAdapter` already exists for testing. Swapping the LLM provider requires implementing `IADKAdapter` — the `ADKController` is fully decoupled from the concrete adapter.

However, `PlannerAgent` and `ConsolidationAgent` (not directly reviewed but referenced) embed provider-specific prompt formatting. Swapping providers may require adjusting prompt templates.

**Verdict**: Adapter pattern is solid for transport. Prompt templates would need an abstraction layer for true provider-swappability.

### 5.1.5 Webview UI Independence

🟢 **Low Risk — Clean Separation**

The webview communicates exclusively via `postMessage` IPC. The contract is defined by `HostToWebviewMessage` and `WebviewToHostMessage` TypeScript unions with exhaustive compile-time checking (`_AssertExhaustive` in `ipcValidator.ts`).

The webview could be replaced with any framework (React, vanilla JS) as long as it:
1. Sends `WebviewToHostMessage` objects
2. Handles `HostToWebviewMessage` objects
3. Calls `acquireVsCodeApi()` for the IPC bridge

**Verdict**: Excellent modularity. The IPC contract is the only coupling surface.

### 5.1.6 Plugin/Extension Mechanism

🟡 **Not Present — No Plugin System**

There is no plugin API, no extension point registration, and no third-party hook mechanism. The system is designed as a monolithic VS Code extension with internal modularity (services, registries) but no external extensibility surface.

**Recommendation**: For V2, consider exposing an event bus or hook registry for:
- Custom evaluators (beyond the built-in 4)
- Custom context resolvers (beyond AST/Explicit)
- Pre/post-phase hooks (for CI integration, notifications)

### 5.1.7 Adding a Local AI Backend (e.g., Ollama)

To add Ollama support, you would need to:
1. Implement `IADKAdapter` that spawns Ollama API calls instead of ADK sessions
2. Map `ADKSessionOptions.initialPrompt` to Ollama's `/api/generate` or `/api/chat` endpoint
3. Adapt `ADKSessionHandle.onOutput` to stream responses from Ollama's chunked API
4. Handle `onExit` as the completion of the API call

**Estimated effort**: Medium (2-3 days). The `IADKAdapter` interface provides a clean seam, but the output streaming model differs (HTTP chunked transfer vs. process stdout).

---

## 5.2 Security, Privacy & "Offline-First"

### 5.2.1 Secrets Detection — `SecretsGuard`

🟡 **Moderate — Several Edge Case Gaps**

**What it catches well:**
- AWS Access Keys (`AKIA...`)
- OpenAI, GitHub, Slack, GitLab, Stripe keys via exact prefix patterns
- Private key PEM headers (`-----BEGIN RSA PRIVATE KEY-----`)
- Environment variable secrets (`DB_PASSWORD=...`)
- High-entropy strings via Shannon entropy analysis (threshold: 4.5)

**Edge cases NOT caught:**

| Edge Case | Status | Details |
|---|---|---|
| **Base64-encoded keys** | ❌ Missed | `base64(sk-proj-AbCdEfGh...)` encodes as a high-entropy string but the API key regex won't match the encoded form. The entropy detector *might* catch it if the encoded value is ≥16 chars and appears in an assignment, but the assignment regex `(?:['\"]?\w+['\"]?\s*[:=]\s*)['\"]([A-Za-z0-9+/=_\-]{16,})['"/]` requires quote delimiters. |
| **Multi-line PEM blocks** | ⚠️ Partial | The regex `-----BEGIN\s+(RSA|EC|OPENSSH|PGP|DSA)\s+PRIVATE\s+KEY-----` catches the header line. However, PEM blocks split across multiple lines with `\r\n` are caught correctly (the regex only needs the header). Full PEM blocks are detected. |
| **Environment variable interpolation** | ❌ Missed | `export SECRET_KEY=${INHERITED_SECRET}` — the `${}` interpolation syntax doesn't match the literal value extraction regex. The value `${INHERITED_SECRET}` would be flagged but that's a false positive (it's a reference, not a secret). |
| **JWT tokens** | ❌ Missed | `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0...` — no dedicated JWT pattern. The entropy heuristic may catch it if it appears in an assignment. |
| **Google Cloud service account keys** | ❌ Missed | No pattern for Google `AIza...` API keys or service account JSON `"private_key": "..."`. |
| **Hex-encoded secrets** | ⚠️ Partial | `0xdeadbeef...` long hex strings may be caught by entropy analysis depending on their character distribution. |

**Recommendations:**
1. Add JWT token pattern: `/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/`
2. Add Google API key pattern: `/AIza[0-9A-Za-z\-_]{35}/`
3. Consider a base64 decode + re-scan option for high-entropy values

### 5.2.2 Command Injection — `execFile` Analysis

🟢 **Low Risk — Properly Hardened**

| Component | Uses `exec`? | Uses `execFile`? | Shell? | Injection Risk |
|---|---|---|---|---|
| `ToolchainEvaluator.ts` | ❌ | ✅ | ❌ | 🟢 Minimal — whitelist enforced |
| `GitManager.ts` | ❌ | ✅ | ❌ | 🟢 Minimal — args passed as array |
| `GitSandboxManager.ts` | ❌ | ❌ (uses VS Code Git API) | N/A | 🟢 None — no child_process |

**ToolchainEvaluator whitelist analysis:**

The whitelist includes 19 binaries: `make`, `npm`, `npx`, `tsc`, `node`, `cargo`, `go`, `python`, `python3`, `swift`, `swiftc`, `xcodebuild`, `gcc`, `g++`, `clang`, `clang++`, `cmake`, `gradle`, `mvn`, `dotnet`, `rustc`.

**Potential bypass vectors:**
- 🟡 `node -e "require('child_process').exec('malicious')"` — `node` is whitelisted, and arbitrary JS can be executed. The criteria format `toolchain:node -e ...` would bypass the whitelist check since `node` is the binary.
- 🟡 `python -c "import os; os.system('malicious')"` — same pattern.
- 🟡 `npx arbitrary-package` — `npx` downloads and executes packages from npm.

**Mitigations in place:**
- `execFile` (no shell) prevents chaining (`&&`, `|`, `;`)
- 120s timeout prevents infinite execution
- 10MB maxBuffer prevents memory exhaustion

**Recommendations:**
1. 🔴 **Block arbitrary code execution flags**: Add an argument blacklist for `-e`, `-c`, `--eval`, `exec` when the binary is `node`, `python`, `python3`
2. 🟡 Consider restricting `npx` to a project-local context (add `--no-install` flag)

### 5.2.3 IPC Security — `postMessage` Validation

🟢 **Low Risk — Well Validated**

The IPC channel is secured through multiple layers:

1. **Runtime validation**: `isValidWebviewMessage()` in `ipcValidator.ts` validates every incoming message type and payload shape
2. **Exhaustive type checking**: `_AssertExhaustive` compile-time guard ensures all message types are handled
3. **URI scheme validation**: `MCP_FETCH_RESOURCE` validates `uri.startsWith('coogent://')` — prevents arbitrary URI requests
4. **Timeout protection**: MCP fetch operations have a 15-second timeout to prevent infinite loading
5. **Panel disposal guard**: Async MCP responses check `MissionControlPanel.currentPanel` before delivering to prevent use-after-dispose

**Missing:**
- 🟡 No rate limiting on IPC messages — a compromised webview could flood the host
- 🟢 No CSP (Content Security Policy) header visible — the webview likely inherits VS Code's default CSP, but explicit CSP configuration would be better

### 5.2.4 Data at Rest — `artifacts.db`

🟡 **Moderate — No Encryption, Potential Secret Persistence**

| Concern | Status | Details |
|---|---|---|
| **Encryption** | ❌ Not encrypted | `artifacts.db` is stored as plaintext SQLite at `.coogent/artifacts.db` |
| **Secrets in DB** | 🟡 Possible | If worker stdout/stderr contains secrets (e.g., API keys printed by error messages), they could be persisted via handoff `decisions` or `blockers` arrays. The `SecretsGuard` scans **input** files but not **output** artifacts. |
| **File permissions** | 🟢 Default | DB file inherits OS defaults. PID files are created with `mode: 0o600` (good), but DB lacks explicit permission setting. |
| **Cleanup** | 🟡 Manual | `purgeTask()` exists but is only called on `CMD_RESET`. No automatic TTL-based cleanup. |

**Recommendations:**
1. 🟡 Add `SecretsGuard.scan()` on handoff `decisions` and `blockers` before DB persistence
2. 🟡 Set file permissions on `artifacts.db` to `0o600` (owner-only)
3. 🟢 Consider SQLite encryption extension (SQLCipher) for high-security environments

### 5.2.5 Network Dependencies — Offline Capability

🟢 **Low Risk — Essentially Offline-First**

| Component | Network Required? | Details |
|---|---|---|
| Extension Host | ❌ | Pure local Node.js — no external API calls |
| `sql.js` | ❌ | WASM binary bundled in `out/sql-wasm.wasm` |
| `js-tiktoken` | ❌ | Pure JS with bundled encoding data |
| `marked` / `mermaid` | ❌ | Client-side rendering, no external fetches |
| `@modelcontextprotocol/sdk` | ❌ | In-process transport — no network |
| ADK Workers | ✅ | Workers call LLM APIs (OpenAI, Anthropic, etc.) — **this is the only network dependency** |

The extension itself is fully offline-capable. Only the AI agent workers require network access to call LLM APIs. For local models (Ollama), even this dependency could be eliminated.

### 5.2.6 Supply Chain — Dependency Analysis

🟡 **Moderate — 6 Direct Dependencies, Manageable Transitive Tree**

**Production dependencies:**

| Package | Version | Transitive Count | Risk |
|---|---|---|---|
| `@modelcontextprotocol/sdk` | ^1.27.1 | ~10 | 🟢 Active, well-maintained |
| `ajv` | ^8.18.0 | ~15 | 🟢 Industry standard |
| `js-tiktoken` | ^1.0.21 | ~3 | 🟢 Minimal deps |
| `marked` | ^17.0.4 | 0 | 🟢 Zero deps |
| `sql.js` | ^1.14.1 | 0 | 🟢 WASM bundle, zero deps |
| `mermaid` | ^11.12.3 | **~80+** | 🟡 **Heavy** — d3, dagre, elkjs, cytoscape, dompurify, katex, lodash |

**Mermaid is the supply chain risk outlier.** It pulls in the entire d3 ecosystem plus multiple rendering engines. However, it's isolated to the webview (not the Extension Host), limiting the blast radius.

**Recommendations:**
1. Run `npm audit` in CI (already in `ci` script ✅)
2. Consider Dependabot / Renovate for automated vulnerability alerts
3. Pin mermaid to a specific patch version to reduce supply chain drift

### 5.2.7 Token/API Key Exposure in Outputs

🟡 **Moderate — Worker Output Streams to UI and Logs**

The data flow for worker output is:

```
Worker stdout/stderr → ADKController → OutputBufferRegistry → postMessage → Webview UI
                                     → TelemetryLogger (JSONL on disk)
```

If a worker prints an API key (e.g., a failed API call that logs the key), it would:
1. **Appear in Mission Control UI** — visible in the terminal output panel
2. **Be persisted to JSONL telemetry logs** — `phase-<id>.jsonl` in `.coogent/logs/`
3. **Potentially persist in handoff data** — if the LLM includes the key in its `decisions` output

**Mitigations:**
- `SecretsGuard` scans **input** files (pre-injection) — ✅
- No scanning of **output** streams — ❌
- No redaction of secrets in JSONL logs — ❌

**Recommendations:**
1. 🟡 Add `SecretsGuard.scan()` on OutputBuffer flush (before broadcasting to UI)
2. 🟡 Add redaction to TelemetryLogger entries (replace detected secrets with `[REDACTED]`)

---

## 5.3 Performance Bottlenecks

### 5.3.1 Memory — `sql.js` In-Memory Database

🟡 **Moderate — Unbounded Growth Potential**

`sql.js` operates as a **full in-memory SQLite database**. The WASM engine loads the entire `artifacts.db` into WASM linear memory on initialization:

```typescript
const buffer = fs.readFileSync(dbPath);
db = new SQL.Database(buffer); // Entire file loaded into WASM memory
```

Every write calls `flush()`:
```typescript
private flush(): void {
    const data = this.db.export(); // Copies entire DB to a Uint8Array
    const buffer = Buffer.from(data); // Copies again to Node.js Buffer
    fs.writeFileSync(this.dbPath, buffer); // Synchronous full-file write
}
```

**Issues:**
1. **Double memory copy on every write**: `db.export()` → `Buffer.from()` → `writeFileSync`. For a 10MB DB, this allocates 30MB temporarily (WASM memory + Uint8Array + Buffer).
2. **Synchronous write blocks the event loop**: `writeFileSync` is used in `flush()`. For large DBs, this blocks the Extension Host.
3. **No flush debouncing**: `upsertTask` → `flush()`, `upsertPhasePlan` → `flush()`, `upsertHandoff` → `flush()`. Consecutive writes during rapid phase completions trigger redundant full-DB exports.
4. **No size limit**: The DB grows unboundedly as tasks accumulate. Only `deleteTask()` reclaims space, and it's only called on explicit `CMD_RESET`.

**Growth estimate:**
- Each task: ~5KB (summary + plan metadata)
- Each phase: ~10KB (implementation plan + handoff JSON)
- 10-phase task: ~105KB
- 100 historical tasks: ~10.5MB → 30MB memory pressure on flush

**Recommendations:**
1. 🔴 **Replace `writeFileSync` with `fs.writeFile` (async)** in `flush()` — this is the most impactful fix
2. 🟡 **Debounce `flush()`** — batch writes within a 500ms window
3. 🟡 **Add automatic pruning** — delete tasks older than N days or keep only the last N tasks

### 5.3.2 Concurrency — 4 Parallel Workers Memory Footprint

🟡 **Moderate — Depends on Worker Type**

Each worker is an `ADKSessionHandle` (external process). The Extension Host memory overhead per worker:
- `WorkerHandle` object: ~200 bytes
- `OutputBuffer` (2 per worker: stdout + stderr): up to 8KB each before flush
- Timeout + watchdog timers: trivial

**Total Extension Host overhead per worker: ~17KB** — negligible.

However, each worker is a separate OS process (AI agent session). Their memory consumption depends on the ADK runtime and is **outside Coogent's control**.

**OutputBuffer concern**: The `OutputBuffer.buffer` is a string that grows via `+=` concatenation. If a worker produces output faster than the 100ms flush interval in bursts smaller than 4KB, the buffer concatenation creates many intermediate strings. There is **no upper bound cap** on the buffer — a worker producing a continuous stream of sub-4KB chunks without any pause >100ms would grow the buffer indefinitely.

**Recommendation:**
1. 🟡 Add `MAX_TOTAL_BUFFER_SIZE` cap (e.g., 1MB) — truncate oldest content when exceeded

### 5.3.3 Bundling — 16MB `extension.js`

🟡 **Moderate — Expected for the Stack**

**Size breakdown (estimated from dependencies):**

| Component | Estimated Size | Notes |
|---|---|---|
| `sql.js` WASM loader + JS glue | ~8 MB | The sql-wasm.wasm is separate (copied by plugin), but the JS glue is bundled |
| `js-tiktoken` + encoding data | ~4 MB | cl100k_base encoding dictionary |
| `ajv` + JSON Schema validation | ~1 MB | Schema compiler |
| `@modelcontextprotocol/sdk` | ~0.5 MB | Protocol implementation |
| `marked` (Markdown parser) | ~0.2 MB | |
| Application code | ~2 MB | TypeScript compiled output |

**Note:** `mermaid` (~2.4MB) is NOT in the extension.js — it's in the webview bundle (`vendor-mermaid.js`). The Vite config correctly splits it via `manualChunks`.

**Recommendations:**
1. 🟢 The size is acceptable for a VS Code extension — extensions are loaded once and persisted
2. 🟡 Consider tree-shaking `ajv` (only draft-07 is used, not the full validator suite)
3. 🟡 The `--minify` flag in `prepackage` script compresses the bundle for distribution

### 5.3.4 Tokenization — Cold Start Delay

🟢 **Low Risk — Lazy Initialization**

`TiktokenEncoder` uses lazy initialization:
```typescript
countTokens(text: string): number {
    if (!this.initialized) {
        this.initEncoder(); // First call triggers require('js-tiktoken')
    }
    // ...
}
```

The `getEncoding('cl100k_base')` call loads the encoding dictionary (~4MB of data) on first invocation. This is a one-time cost per extension activation, not per-phase.

**Measured cold-start estimate:** ~100-300ms for `getEncoding()` based on js-tiktoken benchmarks.

**Fallback path:** If tiktoken fails, `CharRatioEncoder` provides instant (but less accurate) tokenization with zero initialization cost.

**Verdict**: The lazy loading strategy is correct. The cold-start delay is imperceptible in the context of a planning operation that involves an LLM API call (seconds).

### 5.3.5 IPC Throughput — OutputBuffer Parameters

🟢 **Low Risk — Well Calibrated**

| Parameter | Value | Assessment |
|---|---|---|
| Flush interval | 100ms | ✅ Good balance — 10 messages/sec max is well within `postMessage` capacity |
| Buffer size cap | 4KB | ✅ Prevents UI thread congestion — 4KB of terminal output is readable |
| Batching strategy | Immediate on size, timer on time | ✅ Correct dual-trigger prevents both delayed delivery and flooding |

For long-running builds (e.g., `cargo build` producing MBs of output), the buffer will flush frequently (every 4KB) but never faster than one `postMessage` per buffer fill. The webview terminal component handles appending efficiently.

**No changes needed** — the 100ms/4KB parameters are well-optimized.

### 5.3.6 WAL Contention — Concurrent Phase Completions

🟢 **Low Risk — Properly Serialized**

The `StateManager` serializes all writes through an **in-process async mutex** (`writeLock`):

```typescript
private writeLock: Promise<void> = Promise.resolve();

public async saveRunbook(runbook, engineState): Promise<void> {
    const ticket = this.writeLock.then(() => this._doSave(runbook, engineState));
    this.writeLock = ticket.catch(() => { });
    return ticket;
}
```

Concurrent phase completions queue their saves. The file-level lock (`O_CREAT | O_EXCL`) only guards against external process contention, which is rare.

Additionally, stale lock detection (`cleanStaleLock`) handles locks from crashed processes by checking PID liveness.

**Potential issue:** If 4 workers complete simultaneously, 4 queued saves each perform a full WAL → temp → rename cycle. Each save is independent (no coalescing), resulting in 4 sequential disk writes. For NVMe storage, this is ~4ms total — negligible.

**Verdict**: The dual-lock strategy (in-process mutex + filesystem advisory lock) correctly handles all contention scenarios.

---

## Summary Table

| Finding | Risk | Category |
|---|---|---|
| SecretsGuard misses base64, JWT, Google keys | 🟡 Moderate | Security |
| `node -e` / `python -c` whitelist bypass | 🟡 Moderate | Security |
| No secrets scanning on worker output streams | 🟡 Moderate | Security |
| `artifacts.db` not encrypted, no permissions | 🟡 Moderate | Privacy |
| `writeFileSync` in ArtifactDB.flush() | 🔴 Critical | Performance |
| No flush debouncing in ArtifactDB | 🟡 Moderate | Performance |
| OutputBuffer has no upper bound cap | 🟡 Moderate | Performance |
| No plugin/extension mechanism | 🟡 Moderate | Extensibility |
| MCP tools require CoogentMCPServer.ts modification | 🟡 Moderate | Extensibility |
| IPC validation is exhaustive and well-tested | 🟢 Low Risk | Security |
| All child_process calls use execFile | 🟢 Low Risk | Security |
| Extension operates offline-first | 🟢 Low Risk | Privacy |
| OutputBuffer parameters well-calibrated | 🟢 Low Risk | Performance |
| WAL contention properly serialized | 🟢 Low Risk | Performance |
| Tokenization uses lazy initialization | 🟢 Low Risk | Performance |

---

```json
{
  "decisions": [
    "Evaluator extensibility is excellent via the IEvaluator strategy pattern — no core engine changes needed for new evaluators",
    "MCP server extensibility requires CoogentMCPServer.ts modification — a registry pattern would improve this",
    "SecretsGuard has gaps for base64-encoded keys, JWT tokens, and Google API keys — these should be added",
    "ToolchainEvaluator whitelist allows node -e and python -c arbitrary code execution — argument blacklist recommended",
    "IPC security is strong with runtime validation, exhaustive type checking, and URI scheme validation",
    "ArtifactDB.flush() uses synchronous writeFileSync which blocks the event loop — should be async",
    "ArtifactDB has no flush debouncing — consecutive writes cause redundant full-DB exports",
    "OutputBuffer has no upper bound cap — could grow indefinitely with continuous sub-4KB output streams",
    "Worker output streams are not scanned for secrets — API keys could leak to UI and JSONL logs",
    "artifacts.db is not encrypted and has no explicit file permissions set",
    "Extension is fully offline-first — only AI workers require network access for LLM APIs",
    "Supply chain risk is manageable — mermaid is the only heavy transitive dependency tree"
  ],
  "modified_files": [],
  "unresolved_issues": [
    "ArtifactDB.flush() uses synchronous writeFileSync — critical performance issue for large databases",
    "SecretsGuard does not scan worker output streams — secrets could leak to UI, logs, and handoff data",
    "ToolchainEvaluator allows arbitrary code execution via node -e, python -c through whitelisted binaries",
    "No automatic pruning or TTL for artifacts.db — unbounded growth across sessions",
    "OutputBuffer lacks an upper bound cap — potential memory exhaustion with high-throughput workers",
    "artifacts.db has no encryption and no explicit file permissions (mode 0o600)",
    "No plugin/extension mechanism for third-party integrations"
  ],
  "next_steps_context": "Phase 6 should prioritize the P0 fix of converting ArtifactDB.flush() from writeFileSync to async writeFile, add flush debouncing, and add output stream secrets scanning. The ToolchainEvaluator argument blacklist for -e/-c flags is a security P1. The OutputBuffer upper bound cap is straightforward to add. All IPC and command injection surfaces are properly hardened and do not require immediate action."
}
```

# Phase 6 — Executive Summary & Strategic Recommendations

> **Reviewer**: Principal AI Architect
> **Date**: 2026-03-07
> **Scope**: Synthesis of Phases 1–5 findings into actionable executive guidance

---

## 6.1 Executive Summary

**Coogent** is a VS Code extension that addresses the fundamental challenge of AI context collapse — the progressive degradation of LLM quality during long-running coding sessions. Its core innovation is **Context Diffusion**: decomposing complex coding tasks into small, isolated micro-phases, each executed by an ephemeral AI agent receiving only the files it needs. This architectural philosophy eliminates context drift by design, and the deterministic 9-state finite state machine (FSM) ensures that the multi-phase lifecycle is governed by strict, predictable transition rules rather than ad-hoc conversational state.

Across the five review phases, the codebase demonstrated **strong architectural discipline and high engineering maturity**. The FSM transition table is complete and race-condition-safe, with a well-implemented DAG-aware parallel scheduler (Kahn's algorithm) enabling up to 4 concurrent workers. The TypeScript codebase uses branded types (`PhaseId`, `UnixTimestampMs`), interface-driven abstractions (`IEvaluator`, `IADKAdapter`, `TokenEncoder`), and a clean separation of concerns across 13 well-defined modules. Documentation is comprehensive — 7 docs covering architecture, operations, API reference, and developer guides — with only minor drift from the current implementation (Svelte 5 Runes, V2 evaluators, FSM event naming).

The review identified **three areas requiring immediate attention**: (1) `ArtifactDB.flush()` uses synchronous `writeFileSync`, which blocks the VS Code Extension Host event loop — this is the single most critical performance issue; (2) the `SecretsGuard` scans input files but not worker output streams, creating a gap where API keys printed by error messages could leak to the UI, telemetry logs, and handoff data; and (3) the `ToolchainEvaluator` whitelist permits arbitrary code execution via `node -e` and `python -c` flags through whitelisted binaries, bypassing the intended security boundary.

Overall, the project achieves a **mature pre-1.0 quality level**. The architecture is sound, the code is well-tested (363 tests across 28 suites), and the competitive analysis confirms that Coogent's combination of FSM orchestration, DAG parallelism, crash-safe persistence, and Git sandboxing is **architecturally unique** among AI coding assistants. The primary gaps are operational hardening (async I/O, output scanning, DB pruning) and protocol completeness (MCP Sampling, composite evaluators) — all addressable without architectural redesign.

---

## 6.2 Architecture Scorecard

| Dimension | Rating | Notes |
|-----------|--------|-------|
| Documentation Quality | ⭐⭐⭐⭐ | 7 docs with consistent formatting, ASCII diagrams, and persona-based reading order. Minor drift: V2 evaluators and Svelte 5 Runes undocumented, FSM event names simplified vs. actual enum. |
| Code Quality | ⭐⭐⭐⭐ | Strong TypeScript discipline — branded types, `readonly` usage, ESM `.js` extensions. One critical dead code issue (V1 `CompilerEvaluator.ts` — 269 lines). `TOOLCHAIN_WHITELIST` duplicated in 3 files. |
| Test Coverage | ⭐⭐⭐⭐ | 363 tests across 28 suites. All core modules have dedicated tests. 4 R1-refactored modules (`ServiceContainer`, `CommandRegistry`, `EngineWiring`, `PlannerWiring`) lack dedicated unit tests. |
| Security Posture | ⭐⭐⭐ | `execFile` (no shell) used consistently, IPC validation is exhaustive, `SecretsGuard` catches common patterns. Gaps: no output stream scanning, `node -e`/`python -c` bypass vector, no DB encryption. |
| Performance | ⭐⭐⭐ | Good IPC batching (100ms/4KB), lazy tokenizer initialization, efficient DAG scheduling. Critical: synchronous `writeFileSync` in `ArtifactDB.flush()`, no flush debouncing, no DB size limits. |
| Extensibility | ⭐⭐⭐⭐ | Excellent evaluator extensibility via `IEvaluator` strategy pattern. Clean `IADKAdapter` abstraction. Webview is fully replaceable via IPC contract. No external plugin system. |
| Developer Experience | ⭐⭐⭐⭐ | Clear project structure, colocated tests, single `npm run build` command, `F5` launch support. `DEVELOPER_GUIDE.md` provides debugging quick-reference. Missing IDE launch.json docs. |
| Operational Readiness | ⭐⭐⭐ | WAL crash recovery works. JSONL telemetry logging with rotation. No monitoring/alerting guidance, no automatic DB pruning, `OPERATIONS.md` has stale test counts. |

---

## 6.3 Strategic Recommendations

### 1. Convert `ArtifactDB.flush()` to Asynchronous I/O

- **Priority**: P0 (Critical)
- **Impact Area**: Performance
- **Description**: `ArtifactDB.flush()` calls `fs.writeFileSync()` which blocks the VS Code Extension Host event loop on every artifact write. During rapid phase completions (4 parallel workers finishing near-simultaneously), this creates visible UI freezes. Replace with `fs.writeFile` (async) and add a 500ms debounce to coalesce consecutive writes. This is the single highest-impact fix identified across all review phases.
- **Effort Estimate**: Low
- **Expected Outcome**: Eliminates event-loop blocking during artifact persistence. UI remains responsive during rapid phase completions. Debouncing reduces redundant full-DB exports by ~75% in typical DAG execution.

### 2. Add Output Stream Secrets Scanning

- **Priority**: P0 (Critical)
- **Impact Area**: Security
- **Description**: The `SecretsGuard` scans input files before injection into AI workers but does not scan worker output streams. API keys, tokens, or credentials printed by error messages (e.g., a failed API call that logs the key) flow unfiltered to the Mission Control UI, JSONL telemetry logs, and handoff data stored in `artifacts.db`. Add `SecretsGuard.scan()` on `OutputBuffer` flush (before UI broadcast) and on handoff `decisions`/`blockers` arrays (before DB persistence). Apply `[REDACTED]` replacement for detected secrets.
- **Effort Estimate**: Medium
- **Expected Outcome**: Prevents accidental secret leakage through worker output channels. Closes the input-only scanning gap identified in Phase 5.

### 3. Harden Toolchain Evaluator Argument Blacklist

- **Priority**: P1 (High)
- **Impact Area**: Security
- **Description**: The `ToolchainEvaluator` whitelist permits `node`, `python`, and `npx` as valid binaries. This enables arbitrary code execution via `node -e "require('child_process').exec('malicious')"` or `python -c "import os; os.system('malicious')"`. While `execFile` prevents shell chaining, the interpreted languages themselves can execute arbitrary system commands. Add an argument blacklist for `-e`, `-c`, `--eval`, and `exec` flags when the binary is `node`, `python`, or `python3`. Restrict `npx` with `--no-install` to prevent downloading arbitrary packages.
- **Effort Estimate**: Low
- **Expected Outcome**: Closes the arbitrary code execution vector through whitelisted interpreters without restricting legitimate build commands.

### 4. Remove V1 Evaluator Dead Code & Extract Shared Constants

- **Priority**: P1 (High)
- **Impact Area**: DevEx / Architecture
- **Description**: `CompilerEvaluator.ts` (269 lines) contains the complete V1 evaluator system that is fully superseded by the V2 evaluators. The `SuccessEvaluator` interface is deprecated. The V1 code ships in the production bundle, increasing size and confusing contributors. Additionally, `TOOLCHAIN_WHITELIST` is duplicated identically across 3 evaluator files. Delete `CompilerEvaluator.ts`, remove the `SuccessEvaluator` interface, move `MockADKAdapter` from `ADKController.ts` to `__tests__/mocks/`, and extract `TOOLCHAIN_WHITELIST` to `evaluators/constants.ts`.
- **Effort Estimate**: Low
- **Expected Outcome**: Reduces production bundle by ~270 lines, eliminates contributor confusion about V1 vs V2 evaluators, and consolidates the whitelist to a single source of truth.

### 5. Add Composite Evaluators & Repo-Map Context Injection

- **Priority**: P2 (Medium)
- **Impact Area**: Resilience / Architecture
- **Description**: Phases currently support only one evaluator type. A failed `exit_code` check might miss a successful build that produced warning output matching a known error pattern — composite evaluation (e.g., exit_code AND regex) would catch more failure modes. Separately, workers lack structural awareness beyond their scoped files. Inspired by Aider's repo-map concept, generating a lightweight repository structure summary as part of each phase's context injection would give workers architectural awareness at low token cost (~500 tokens).
- **Effort Estimate**: Medium
- **Expected Outcome**: Composite evaluators improve failure detection fidelity. Repo-map injection reduces worker hallucination about project structure and import paths.

---

## 6.4 Risk Matrix

```
                        High Impact
                            │
     ┌──────────────────────┼───────────────────────┐
     │                      │                       │
     │  ArtifactDB.flush()  │  Secrets in output    │
     │  sync I/O blocking   │  streams (UI, logs,   │
     │  (Performance P0)    │  artifacts.db)         │
     │                      │  (Security P0)        │
     │                      │                       │
High │                      │  node -e / python -c  │
Like-│                      │  whitelist bypass      │
lihood                      │  (Security P1)        │
     │                      │                       │
     ├──────────────────────┼───────────────────────┤
     │                      │                       │
     │  OutputBuffer        │  artifacts.db         │
     │  unbounded growth    │  no encryption        │
     │  (Performance P2)    │  (Privacy P2)         │
     │                      │                       │
Low  │  V1 dead code        │  No DB auto-pruning   │
Like-│  in prod bundle      │  (Ops P2)             │
lihood  (DevEx P1)          │                       │
     │                      │                       │
     └──────────────────────┼───────────────────────┘
                            │
                       Low Impact
```

| Quadrant | Risks | Action |
|----------|-------|--------|
| **High Likelihood × High Impact** | Sync `writeFileSync` blocking, unscanned output secrets, interpreter bypass vector | Immediate remediation (Sprint 1) |
| **High Likelihood × Low Impact** | OutputBuffer unbounded growth, V1 dead code in bundle | Address in next maintenance cycle |
| **Low Likelihood × High Impact** | DB not encrypted, no auto-pruning | Plan for V1.1 hardening release |
| **Low Likelihood × Low Impact** | Stale doc test counts, missing ADRs | Address during doc refresh |

---

## 6.5 Conclusion

Coogent is a well-architected, technically sophisticated VS Code extension that solves a genuine problem — AI context collapse — with an innovative and defensible approach. The 9-state FSM, DAG-aware scheduling, WAL crash recovery, and Git sandboxing form a unique competitive moat that no other tool in the AI coding assistant space currently matches. The codebase demonstrates strong engineering discipline: clean module boundaries, comprehensive test coverage, branded types for compile-time safety, and thoughtful interface abstractions.

The project is in a **healthy pre-1.0 state**. The 3 critical-to-high priority recommendations (async I/O, output scanning, argument blacklist) are all low-to-medium effort fixes that address the most impactful gaps without requiring architectural changes. The V1 evaluator dead code removal is straightforward cleanup. The medium-priority items (composite evaluators, repo-map) represent natural evolution of the platform's evaluation and context capabilities. With these improvements implemented, Coogent would be well-positioned for a confident 1.0 release.

---

```json
{
  "decisions": [
    "Synthesized findings from all 5 prior phases into a unified executive assessment",
    "Rated 8 architectural dimensions on a 1-5 star scale based on evidence from Phases 1-5",
    "Prioritized 5 strategic recommendations: 2 P0 (async flush, output scanning), 1 P1 (argument blacklist), 1 P1 (dead code removal), 1 P2 (composite evaluators + repo-map)",
    "Created a 2x2 risk matrix categorizing top risks by likelihood and impact",
    "Assessed overall project maturity as 'healthy pre-1.0' with a clear path to 1.0 release",
    "Identified sync writeFileSync in ArtifactDB.flush() as the single most critical fix across all phases",
    "Confirmed Coogent's FSM+DAG+WAL+Git combination as architecturally unique and competitively defensible"
  ],
  "modified_files": [],
  "unresolved_issues": [
    "ArtifactDB.flush() still uses synchronous writeFileSync — requires code change",
    "Worker output streams are not scanned for secrets — requires SecretsGuard integration",
    "ToolchainEvaluator allows node -e and python -c execution — requires argument blacklist",
    "CompilerEvaluator.ts (269 lines V1 dead code) still ships in production bundle",
    "TOOLCHAIN_WHITELIST duplicated across 3 evaluator files — needs extraction",
    "MockADKAdapter bundled in production ADKController.ts — needs relocation to test mocks",
    "No composite evaluator support — single evaluator per phase limitation",
    "No repo-map generation for worker context awareness",
    "ARCHITECTURE.md still references legacy Svelte writable stores and simplified FSM event names",
    "No unit tests for ServiceContainer, CommandRegistry, EngineWiring, PlannerWiring"
  ],
  "next_steps_context": "This is the final phase of the 6-phase review. All findings have been synthesized into actionable recommendations. The implementation priority order is: (1) ArtifactDB async flush + debounce, (2) output stream secrets scanning, (3) ToolchainEvaluator argument blacklist, (4) V1 dead code removal + whitelist extraction, (5) composite evaluators + repo-map. No further review phases are needed."
}
```