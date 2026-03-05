# Coogent API Reference

> **Audience**: Extension developers and contributors.

---

## Module Map

```
src/
├── extension.ts              ← Entry point (activate/deactivate)
├── types/index.ts            ← All TypeScript types and FSM definition
├── state/StateManager.ts     ← Persistence (WAL + atomic rename + mutex)
├── engine/
│   ├── Engine.ts ← 7-state FSM, event-driven engine
│   ├── Scheduler.ts          ← DAG-aware phase scheduling
│   └── SelfHealing.ts        ← Auto-retry with exponential backoff
├── adk/
│   ├── ADKController.ts      ← Worker pool lifecycle management
│   ├── OutputBuffer.ts       ← 100ms batched stream flush
│   └── OutputBufferRegistry.ts ← Disposable buffer registry
├── context/
│   ├── ContextScoper.ts      ← File reading + tokenization
│   ├── FileResolver.ts       ← AST auto-discovery (import crawling)
│   └── TokenPruner.ts        ← 3-tier token budget enforcement
├── evaluators/
│   └── CompilerEvaluator.ts  ← Pluggable success evaluators
├── git/
│   └── GitManager.ts         ← Snapshot commits + rollback
├── logger/
│   └── TelemetryLogger.ts    ← Append-only JSONL session logging
└── webview/
    ├── MissionControlPanel.ts ← Webview lifecycle + IPC bridge
    └── messageValidator.ts   ← Runtime IPC message validation
```

---

## Core Modules

### Engine

The deterministic FSM governing execution lifecycle.

**Constructor**:
```typescript
new Engine(
    stateManager: StateManager,
    options?: {
        scheduler?: Scheduler;
        healer?: SelfHealingController;
        workspaceRoot?: string;
    }
)
```

**Key Methods**:

| Method | Description |
|---|---|
| `getState()` | Returns current `EngineState` |
| `getRunbook()` | Returns loaded `Runbook` or `null` |
| `transition(event)` | Attempt FSM transition, returns new state or `null` |
| `loadRunbook(filePath?)` | Load + validate runbook from disk |
| `start()` | Begin (or resume) execution |
| `pause()` | Halt after current phase completes |
| `abort()` | Stop and return to IDLE |
| `retry(phaseId)` | Retry a failed phase |
| `skipPhase(phaseId)` | Skip a failed phase |
| `editPhase(phaseId, patch)` | Edit prompt/files/criteria |
| `onWorkerExited(phaseId, exitCode, stdout?, stderr?)` | Handle worker completion (parallel-aware) |
| `onWorkerFailed(phaseId, reason)` | Handle timeout/crash (parallel-aware) |

**Events** (via `EventEmitter`):

| Event | Signature | Description |
|---|---|---|
| `state:changed` | `(from, to, event)` | Every FSM transition |
| `ui:message` | `(message)` | Messages for the Webview |
| `phase:execute` | `(phase)` | Phase ready for dispatch |
| `run:completed` | `(runbook)` | All phases done |
| `error` | `(error)` | Any error |
| `phase:heal` | `(phase, prompt)` | Self-healing retry request |
| `phase:checkpoint` | `(phaseId)` | Git checkpoint trigger |

---

### StateManager

Crash-safe persistence with WAL + atomic rename + in-process async mutex.

| Method | Description |
|---|---|
| `loadRunbook()` | Load and AJV-validate `.task-runbook.json` |
| `saveRunbook(runbook, state)` | WAL → write → atomic rename (mutex-serialized) |
| `recoverFromCrash()` | Replay WAL, clean stale locks, returns `true` if recovered |

---

### Scheduler

DAG-aware phase scheduling with Kahn's cycle detection.

| Method | Description |
|---|---|
| `isDAGMode(phases)` | `true` if any phase has `depends_on` |
| `getReadyPhases(phases)` | All phases whose deps are satisfied (respects `maxConcurrent`) |
| `isAllDone(phases)` | No `pending` or `running` phases remain |
| `detectCycles(phases)` | Returns cycle member IDs (empty = valid DAG) |
| `getExecutionOrder(phases)` | Topological sort for display |

---

### ContextScoper

File reading, tokenization, and payload assembly.

| Method | Description |
|---|---|
| `assemble(files, workspaceRoot)` | Returns `ContextResult` — `{ok: true, payload, ...}` or `{ok: false, ...}` |

---

### ADKController

Worker pool lifecycle management with PID-based orphan cleanup.

| Method | Description |
|---|---|
| `spawnWorker(phaseId, payload)` | Spawn ephemeral worker |
| `terminateWorker(phaseId, reason)` | Force-terminate (deletes from map first) |
| `cleanupOrphanedWorkers()` | Kill any workers from previous crash |

**Events**: `worker:exited`, `worker:timeout`, `worker:output`

---

### SelfHealingController

Auto-retry with exponential backoff and error-injected prompts.

| Method | Description |
|---|---|
| `recordFailure(phaseId, exitCode, stderr)` | Log a failure attempt |
| `canRetryWithPhase(phase)` | Check if retries remain |
| `buildHealingPrompt(phase)` | Build augmented prompt with stderr context |
| `getRetryDelay(phaseId)` | Exponential backoff delay (ms) |
| `clearAttempts(phaseId)` | Reset retry state on success |

---

### EvaluatorRegistry

Pluggable success evaluators.

| Evaluator | Criteria Prefix | Description |
|---|---|---|
| `ExitCodeEvaluator` | `exit_code:` | Check process exit code |
| `RegexEvaluator` | `regex:` | Match stdout against pattern |
| `ToolchainEvaluator` | `toolchain:` | Run whitelisted build command |
| `TestSuiteEvaluator` | `test_suite:` | Run whitelisted test command |

---

### GitManager

Automated version control.

| Method | Description |
|---|---|
| `checkpoint(phaseId)` | Snapshot commit after phase success |
| `rollbackToCommit(hash)` | `git reset --hard` to commit |
| `stash()` / `unstash()` | Preserve in-progress work |

All commands use `execFile` (no shell injection).

---

## FSM States

| State | Description |
|---|---|
| `IDLE` | No runbook loaded |
| `PARSING` | Validating runbook schema |
| `READY` | Parsed, awaiting START |
| `EXECUTING_WORKER` | Worker(s) active |
| `EVALUATING` | Last worker exited, checking criteria |
| `ERROR_PAUSED` | Failed, awaiting user decision |
| `COMPLETED` | All phases passed |

---

## IPC Messages

### Host → Webview

| Type | Payload | Description |
|---|---|---|
| `STATE_SNAPSHOT` | `{ runbook, engineState }` | Full state projection |
| `PHASE_STATUS` | `{ phaseId, status, durationMs? }` | Phase status change |
| `WORKER_OUTPUT` | `{ phaseId, stream, chunk }` | Streaming output |
| `TOKEN_BUDGET` | `{ phaseId, breakdown, totalTokens, limit }` | Token breakdown |
| `ERROR` | `{ code, message, phaseId? }` | Error notification |
| `LOG_ENTRY` | `{ timestamp, level, message }` | Log message |

### Webview → Host

| Type | Payload | Description |
|---|---|---|
| `CMD_START` | — | Start execution |
| `CMD_PAUSE` | — | Pause after current phase |
| `CMD_ABORT` | — | Abort to IDLE |
| `CMD_RETRY` | `{ phaseId }` | Retry failed phase |
| `CMD_SKIP_PHASE` | `{ phaseId }` | Skip failed phase |
| `CMD_EDIT_PHASE` | `{ phaseId, patch }` | Edit phase config |
| `CMD_LOAD_RUNBOOK` | `{ filePath }` | Load runbook from disk |
| `CMD_REQUEST_STATE` | — | Request full state snapshot |

All incoming messages are runtime-validated by `isValidWebviewMessage()`.
