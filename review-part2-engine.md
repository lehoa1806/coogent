# Code Review — Part 2: Engine & Orchestration Core

> **Scope**: 17 files under `src/engine/` and `src/types/` (Engine FSM, controllers, evaluation, scheduling, worker lifecycle, self-healing, session management, context assembly, typed events, type definitions).
>
> **Reviewed files**: `Engine.ts`, `EngineInternals.ts`, `Scheduler.ts`, `PhaseController.ts`, `PlanningController.ts`, `DispatchController.ts`, `WorkerLauncher.ts`, `WorkerResultProcessor.ts`, `WorkerOutputValidator.ts`, `EvaluationOrchestrator.ts`, `SelfHealing.ts`, `SessionController.ts`, `ContextAssemblyAdapter.ts`, `TypedEventEmitter.ts`, `wiring-contracts.ts`, `types/engine.ts`, `types/phase.ts`

---

## Table of Contents

1. [Critical Findings](#1-critical-findings)
2. [High Severity Findings](#2-high-severity-findings)
3. [Medium Severity Findings](#3-medium-severity-findings)
4. [Low Severity Findings](#4-low-severity-findings)
5. [Summary Matrix](#5-summary-matrix)

---

## 1. Critical Findings

### C-1: `workerExitLock` Promise Chain Never Rejects — Silent Error Swallowing

**File**: `Engine.ts` (lines 427–438, 466–477)

**Description**: The `workerExitLock` serialization mutex chains `.then(async () => { ... })` but never adds a `.catch()` handler. If the async inner lambda throws, the error is silently absorbed into the rejected promise chain. Subsequent calls chained via `this.workerExitLock = this.workerExitLock.then(...)` will also never execute because the chain is rejected.

**Why it matters**: A single thrown exception inside `onWorkerExited` or `onWorkerFailed` permanently breaks the serialization chain. All future worker exit callbacks will silently never execute, leaving the engine in a zombie state where phases appear "running" forever.

**Root cause**: The promise chain uses `.then()` without `.catch()`. The returned promise from the outer method is the chained promise, but unhandled rejection from the inner handler propagates as chain breakage.

**Remediation**:
```typescript
this.workerExitLock = this.workerExitLock.then(async () => {
    // ... existing logic ...
}).catch(err => {
    log.error('[Engine] workerExitLock handler threw:', err);
    // Reset chain to healthy state
});
```

**Tradeoffs**: Adding a catch means individual handler failures don't cascade, but you lose the hard-fail signal. Consider emitting an 'error' event from the catch handler.

**Tests**: Unit test that throws inside the `onWorkerExited` handler, then verifies a subsequent `onWorkerExited` call still executes.

---

### C-2: Composite FSM Transitions in `PhaseController.skipPhase()` Can Leave Orphaned State

**File**: `PhaseController.ts` (lines 195–201)

**Description**: When all phases are done and none failed, `skipPhase()` fires three sequential transitions: `START → WORKER_EXITED → ALL_PHASES_PASS`. Each transition is guarded (`if (r1 !== null)`), but if an intermediate transition fails, the runbook status is still set to `'completed'` and `run:completed`/`run:consolidate` events are emitted regardless (line 203–204 are outside the guard).

```typescript
// P-2 fix: Guard composite transitions
const r1 = this.engine.transition(EngineEvent.START);
if (r1 !== null) {
    const r2 = this.engine.transition(EngineEvent.WORKER_EXITED);
    if (r2 !== null) {
        this.engine.transition(EngineEvent.ALL_PHASES_PASS);
    }
}
await this.engine.persist();  // Always persists 'completed' status
this.engine.emit('run:completed', runbook);  // Always emitted — even if transitions failed
```

**Why it matters**: If the FSM is not in a state that accepts `START`, the runbook status is set to `'completed'` and completion events fire, but the FSM state remains wherever it was. This creates a divergence between persisted status and FSM state that will confuse session recovery.

**Root cause**: Business logic (status mutation, event emission) is not fully gated behind the transition guards.

**Severity**: Critical — can corrupt the persisted state.

**Remediation**: Only set `runbook.status = 'completed'` and emit completion events inside the innermost guard block. Add an else clause that transitions to `ERROR_PAUSED` with a diagnostic message.

**Tests**: Test `skipPhase()` when the engine is in a state where `START` is not a valid transition.

---

### C-3: `DispatchController.stallWatchdog` Fires Composite Transitions Without Checking Results

**File**: `DispatchController.ts` (lines 275–283)

**Description**: The stall watchdog fires `WORKER_EXITED` then `ALL_PHASES_PASS` (or `PHASE_FAIL`) without checking if the first transition succeeded. If `WORKER_EXITED` fails (engine not in `EXECUTING_WORKER`), `ALL_PHASES_PASS` fires against whatever state the engine is actually in.

```typescript
// No guard on first transition
this.engine.transition(EngineEvent.WORKER_EXITED);
this.engine.transition(EngineEvent.ALL_PHASES_PASS);
```

The same pattern appears at lines 303–304 for the stalled-with-pending-phases case.

**Why it matters**: Identical to C-2 — FSM state corruption. The watchdog is a recovery mechanism; it should be especially careful about state consistency.

**Root cause**: Copy-paste from the happy-path code without adding guards.

**Remediation**: Guard each transition and bail if any returns `null`.

**Tests**: Stall watchdog test where the engine is not in `EXECUTING_WORKER` when the timer fires.

---

## 2. High Severity Findings

### H-1: `advanceSchedule()` Swallows FSM Transition When Pause is Handled

**File**: `DispatchController.ts` (lines 202–219)

**Description**: When a pause is requested, `advanceSchedule()` sets `runbook.status = 'idle'` but does **not** perform any FSM transition. The engine remains in `EVALUATING` (the state it was in when the last phase passed) while the runbook says `'idle'`. Session recovery will attempt to reconstruct state from the persisted runbook status, finding `'idle'` but the FSM state when it was serialized was `EVALUATING`.

**Why it matters**: The FSM state and persisted runbook status diverge. If the extension restarts, the recovered state may be incorrect.

**Root cause**: The pause path only sets `runbook.status` without calling `transition()`.

**Severity**: High — leads to stale FSM state.

**Remediation**: Add `this.engine.transition(EngineEvent.PAUSE)` before setting runbook status. This requires adding `PAUSE` transitions from `EVALUATING` state in the transition table (currently, `PAUSE` event exists but is not used in any transition).

**Tests**: Test that after `advanceSchedule()` with pause requested, both `getState()` and persisted runbook status are consistent.

---

### H-2: `TypedEventEmitter.emit()` Override Loses Type Safety at Runtime

**File**: `TypedEventEmitter.ts` (lines 52–71)

**Description**: The constructor overrides `this.emit` via `(this as any).emit = (event: string, ...args: any[])`. This runs at runtime but the interface merge declares `emit<K extends keyof T & string>(event: K, ...args: Parameters<T[K]>): boolean`. The runtime implementation accepts `any` arguments, so type safety only exists at the TypeScript boundary — at runtime, any event name and any arguments are accepted.

More importantly, the override pattern (`this.emit = ...`) creates a **per-instance function** that shadows the prototype method. This means:
1. The prototype's `emit` is never called through normal dispatch.
2. The `origEmit` binding captures `super.emit.bind(this)` which calls the *Node.js EventEmitter* `emit`, bypassing any future middleware.
3. The `engine:listener-error` event is emitted via `origEmit()`, meaning it itself won't be fenced in error handling (intentional but not obvious).

**Why it matters**: Runtime type safety for event args is not enforced; bugs involving wrong argument types will pass silently. The per-instance override pattern is non-standard and may confuse profilers/debuggers.

**Root cause**: TypeScript's type system cannot fully express generic typed EventEmitter overrides.

**Severity**: High — subtle bugs in event listener arguments at runtime.

**Remediation**: Consider using a proxy-based approach or a well-established typed event emitter library (e.g., `typed-emitter` or `eventemitter3` with typed generics). At minimum, add a runtime assertion in development mode that validates argument count against the event map.

**Tests**: Test that emitting an event with wrong argument arity logs a diagnostic in development.

---

### H-3: `EngineInternals.emit()` Returns `string` × `unknown[]` — Loses Type Safety

**File**: `EngineInternals.ts` (line 102)

**Description**: The `emit` method on `EngineInternals` is declared as `emit(event: string, ...args: unknown[]): boolean`, which loses all type safety. Any controller can emit any event name with any arguments.

**Why it matters**: Controllers can emit events with incorrect argument types or misspelled event names. The `EngineEvents` type map is bypassed entirely.

**Root cause**: Making the interface generic for the event map was deemed too complex.

**Remediation**: Make `EngineInternals` generic over the event map, or provide emit-wrapper methods for each event (e.g., `emitPhaseExecute(phase: Phase)`). The wrapper approach is safer:
```typescript
emitPhaseExecute(phase: Phase): void;
emitPhaseHeal(phase: Phase, prompt: string): void;
emitRunCompleted(runbook: Runbook): void;
// etc.
```

**Tests**: Compile-time test: Ensure controller code does not compile when passing wrong event args (requires the generic approach).

---

### H-4: `WorkerResultProcessor.processWorkerExit()` Uses `.then().catch(log.onError)` — FSM Errors Silenced

**File**: `WorkerResultProcessor.ts` (lines 174–189)

**Description**: The handoff promise chains into `.then(() => this.engine.onWorkerExited(...))`. If `onWorkerExited` throws, `.catch(log.onError)` logs it but the error is silently swallowed. The caller (`processWorkerExit`) has already returned its own promise, which resolves successfully regardless.

**Why it matters**: If the FSM transition inside `onWorkerExited` throws (e.g., assertion failure), the error is logged but the phase is stuck in a `running` state with no recovery path. The outer caller (likely the wiring layer) believes the exit was handled successfully.

**Root cause**: Fire-and-forget pattern on a critical state transition.

**Remediation**: Propagate the error by removing the `.catch()` and letting the caller handle it, or transition to error state in the catch handler.

**Tests**: Test that `processWorkerExit` rejects when `onWorkerExited` throws.

---

### H-5: `wiring-contracts.ts` Adapter Functions Provide Zero Runtime Safety

**File**: `wiring-contracts.ts` (lines 42–79)

**Description**: Every adapter function is `(x: unknown) => x as SomeInterface`. These are pure compile-time casts that provide no runtime guarantees. If the input doesn't conform to the interface, the error surfaces much later as a `TypeError: foo.bar is not a function` deep in a callback chain.

**Why it matters**: These adapters are the boundary between the wiring layer and the engine internals. A missing method on a service will cause a runtime crash during phase execution, not at initialization time.

**Root cause**: "Trust the type system" approach without defensive programming at module boundaries.

**Severity**: High — runtime crashes deferred to execution time.

**Remediation**: Add a lightweight runtime assertion that validates the required methods exist:
```typescript
export function asContextScoper(scoper: unknown): ContextScoperLike {
    const s = scoper as ContextScoperLike;
    if (typeof s?.assemble !== 'function') {
        throw new Error('Invalid ContextScoper: missing assemble()');
    }
    return s;
}
```

**Tests**: Test each adapter function with a `null`, `undefined`, and partial object to verify they throw early.

---

### H-6: `EvaluationOrchestrator.handleWorkerFailed()` Dispatches Phases After Failure Without FSM Transition

**File**: `EvaluationOrchestrator.ts` (lines 388–392)

**Description**: When a worker fails, is the last attempt, and other workers are still running (`!isLastWorker`), the code calls `this.engine.dispatchReadyPhases()` (line 391) without performing any FSM transition. The engine remains in `EXECUTING_WORKER`, which is correct, but dispatching new phases while a failure is in progress could lead to cascading failures if the failure was caused by a shared resource (e.g., corrupted workspace).

**Why it matters**: A poisoned workspace could cause an infinite retry-then-fail loop across multiple parallel phases.

**Root cause**: Optimistic assumption that a single phase failure is independent of other phases.

**Remediation**: Add a configurable "fail-fast" mode that, when enabled, stops dispatching new phases after any failure in parallel mode.

**Tests**: Test parallel mode where one phase fails — verify that no new phases are dispatched when fail-fast is enabled.

---

## 3. Medium Severity Findings

### M-1: `Scheduler.isAllCompleted()` Treats `failed` as "Completed"

**File**: `Scheduler.ts` (line 80)

**Description**: `isAllCompleted()` returns `true` when every phase is `completed` OR `failed`. The method name is misleading — it actually means "all phases are terminal". This is only called in test utilities (not in production code), but `isAllDone()` (line 87) provides the correct semantic and is used in production.

**Why it matters**: Naming confusion could lead future developers to use `isAllCompleted()` when they mean "all succeeded".

**Root cause**: Legacy naming from before `isAllDone()` was introduced.

**Remediation**: Rename to `isAllTerminal()` or deprecate with a JSDoc `@deprecated`.

**Tests**: Existing tests should still pass after rename.

---

### M-2: `PlanningController.planApproved()` Saves Then Immediately Reloads From Disk

**File**: `PlanningController.ts` (lines 99, 111)

**Description**: `planApproved()` saves the draft to disk via `saveRunbook(planDraft, ...)` then immediately reloads it via `loadRunbook()`. The save-then-reload round-trip is wasteful and introduces a window where disk I/O failure on the reload silently loses the approved plan (the user's approval click is lost).

```typescript
await this.engine.getStateManager().saveRunbook(this.planDraft, ...);
// ... emit event ...
const runbook = await this.engine.getStateManager().loadRunbook();
if (!runbook) { /* transition to PARSE_FAILURE */ }
```

**Why it matters**: If the filesystem has a transient error between save and load, the plan is lost despite being successfully saved.

**Root cause**: The reload was added to "validate the saved format" — i.e., ensure the serialization round-trip works. This is defensive but costly.

**Remediation**: Use the in-memory `planDraft` directly. If round-trip validation is needed, do it in a separate validation step that doesn't affect the happy path.

**Tests**: Existing tests should verify that `planApproved()` succeeds even when `loadRunbook()` would fail.

---

### M-3: `WorkerLauncher.launch()` Uses `as unknown as` Runtime Type Probe

**File**: `WorkerLauncher.ts` (lines 101–104)

**Description**: The method probes for `getExecutionMode()` via `as unknown as { getExecutionMode?: () => ... }`. This is a runtime duck-type check on the ADK controller.

```typescript
const adapterAny = this.adkController as unknown as { getExecutionMode?: () => Promise<ExecutionMode> };
if (typeof adapterAny.getExecutionMode === 'function') {
    executionMode = await adapterAny.getExecutionMode();
}
```

**Why it matters**: This bypasses the `WorkerLauncherADK` interface contract. If `getExecutionMode` is expected, it should be part of the interface. If it's optional, it should be declared optional on the interface.

**Root cause**: `getExecutionMode` was added later without updating the interface.

**Remediation**: Add `getExecutionMode?(): Promise<ExecutionMode>` to `WorkerLauncherADK` interface.

**Tests**: Existing tests should verify both code paths (with and without `getExecutionMode`).

---

### M-4: `WorkerLauncher.launch()` Uses Static `MissionControlPanel.broadcast()` — Breaks Testability

**File**: `WorkerLauncher.ts` (line 147), `WorkerResultProcessor.ts` (lines 138, 159)

**Description**: Both `WorkerLauncher` and `WorkerResultProcessor` call `MissionControlPanel.broadcast()` as a static side effect. This couples them to the VS Code webview infrastructure and makes unit testing require mocking a global static.

**Why it matters**: Unit tests must either mock the global `MissionControlPanel` or accept uncontrolled side effects. This also means these classes can't be used outside VS Code context.

**Root cause**: Convenience over proper dependency injection. The `EngineInternals.emitUIMessage()` pattern exists and is used elsewhere.

**Remediation**: Pass a `broadcastMessage` function (or use `EngineInternals.emitUIMessage()`) through the constructor instead of calling the static directly.

**Tests**: After refactoring, tests should verify UI messages are emitted through the injected interface.

---

### M-5: `ContextAssemblyAdapter.assembleContext()` Uses Unsafe Duck-Type Cast

**File**: `ContextAssemblyAdapter.ts` (lines 76–79)

**Description**: The multi-root detection uses `as unknown as Record<string, unknown>` followed by checking `typeof scoper?.assembleMultiRoot === 'function'`. This is the same duck-typing anti-pattern as M-3.

**Why it matters**: The `MultiRootContextScoper` interface exists but is never used in the type parameter. The cast bypasses compile-time checking.

**Root cause**: The `ContextAssemblyAdapter` constructor accepts `ContextScoperLike` but needs to optionally call `MultiRootContextScoper` methods.

**Remediation**: Accept `ContextScoperLike | MultiRootContextScoper` in the constructor and use a type guard function:
```typescript
function isMultiRootScoper(s: ContextScoperLike): s is MultiRootContextScoper {
    return 'assembleMultiRoot' in s;
}
```

**Tests**: Test with both single-root and multi-root scopers.

---

### M-6: `SelfHealingController` Retry Delay Uses Unbounded Exponential Backoff

**File**: `SelfHealing.ts` (lines 165–172)

**Description**: `getRetryDelay()` computes `baseDelay * 2^retryCount` without a maximum cap. With `maxRetries = 10` and `baseDelay = 2000`, the final retry would have a delay of `2000 * 1024 = 2,048,000ms` (~34 minutes).

**Why it matters**: While default `maxRetries` is 2 (so max delay is 8s), users can set per-phase `max_retries` to higher values. A phase with `max_retries: 8` would wait ~8.5 minutes between its last retries.

**Root cause**: No cap on the exponential growth.

**Remediation**: Add a `maxDelay` option (default: 60_000ms) and clamp:
```typescript
return Math.round(Math.min(baseDelay * jitterFactor, this.maxDelay));
```

**Tests**: Test `getRetryDelay()` with high retry counts to verify capping.

---

### M-7: `PhaseController.restartPhase()` Has Complex Branching on Engine State

**File**: `PhaseController.ts` (lines 97–117)

**Description**: `restartPhase()` has a chain of `if/else if` blocks for different engine states (`ERROR_PAUSED`, `IDLE`, `READY`, `COMPLETED`, `EXECUTING_WORKER`). Each branch calls a different FSM event. This logic duplicates the FSM transition table knowledge.

**Why it matters**: Any change to the transition table could silently break `restartPhase()`. The method knows too much about which states accept which events.

**Root cause**: The FSM transition table doesn't have a dedicated "restart" concept — the method has to navigate through existing transitions.

**Remediation**: Consider adding a `RESTART` event to the FSM that is valid from multiple states (similar to `ABORT`). This centralizes the transition logic.

**Tests**: Test `restartPhase()` from every possible engine state.

---

### M-8: `EvaluationOrchestrator` Has Deferred Dependency Injection via `setArtifactDB()`

**File**: `EvaluationOrchestrator.ts` (lines 21–22, 33–36)

**Description**: The `db` and `masterTaskId` fields start as `undefined`/`''` and are injected later via `setArtifactDB()`. This means `persistEvaluationResult()` silently no-ops if called before injection, and there's no guarantee `setArtifactDB()` is called.

Same pattern in `SelfHealingController.setArtifactDB()` (SelfHealing.ts lines 68–71).

**Why it matters**: Best-effort persistence with no feedback when it silently skips. If the wiring layer forgets to call `setArtifactDB()`, evaluation results are never persisted and no error is raised.

**Root cause**: Circular initialization order between Engine, MCP, and ArtifactDB.

**Remediation**: Log a one-time warning when `persistEvaluationResult()` skips due to missing DB. Consider using a builder pattern or async factory function to ensure all dependencies are injected before use.

**Tests**: Test that `persistEvaluationResult()` logs a warning when `db` is not set.

---

### M-9: `PhaseController.skipPhase()` Marks Skipped Phases as `'completed'`

**File**: `PhaseController.ts` (line 174)

**Description**: `skipPhase()` sets `phase.status = 'completed'`, making it indistinguishable from a phase that actually completed. Downstream phases that depend on this phase will run, potentially with missing context since the skipped phase never produced output.

**Why it matters**: The DAG scheduler treats `'completed'` as "dependencies satisfied". A skipped phase provides none of the expected context (no handoff data, no implementation plan). Downstream phases operate blind.

**Root cause**: The `PhaseStatus` type doesn't include a `'skipped'` status.

**Remediation**: Add `'skipped'` to `PhaseStatus` type. Update `Scheduler.getReadyPhases()` to treat `'skipped'` as a satisfied dependency, and update the handoff extractor to generate synthetic empty handoff data for skipped phases.

**Tests**: Test DAG scheduling with a skipped intermediate phase to verify dependent phases still dispatch, but with a skip marker.

---

### M-10: `Engine.loadRunbook()` Ignores `_filePath` Parameter

**File**: `Engine.ts` (line 281)

**Description**: `loadRunbook(_filePath?: string)` accepts a `_filePath` parameter but ignores it, forwarding to `this.session.loadRunbook()` which takes no arguments. The underscore prefix signals intentional disuse, but the public API is misleading.

**Why it matters**: Callers passing a file path expect it to be used. This is a broken contract.

**Root cause**: API surface was kept for backward compatibility after the implementation was changed.

**Remediation**: Remove the parameter or make `SessionController.loadRunbook()` accept and use it.

**Tests**: Verify that `loadRunbook('/some/path')` either uses the path or throws.

---

## 4. Low Severity Findings

### L-1: Repeated `phaseMap` Construction in `DispatchController.dispatchReadyPhases()`

**File**: `DispatchController.ts` (line 140), `WorkerLauncher.ts` (line 234)

**Description**: Both `DispatchController` and `WorkerLauncher` build `new Map(runbook.phases.map(p => [p.id, p]))` independently within the same dispatch cycle for the same runbook. The Scheduler also builds this map internally.

**Why it matters**: Minor performance cost — O(n) map construction done 2–3 times per dispatch.

**Remediation**: Pass a pre-built `phaseMap` through the dispatch call chain.

---

### L-2: `Engine` Exposes Too Many Internal Accessors as `public`

**File**: `Engine.ts` (lines 160–200)

**Description**: 15+ methods are marked `@internal` in JSDoc but declared `public`. TypeScript's `public` keyword means they are accessible from any code, not just controllers.

**Why it matters**: Any code that imports `Engine` can call `setActiveWorkerCount(0)`, bypassing all safety checks.

**Remediation**: Consider making these `protected` or grouping them behind a separate interface that is only exposed to controllers.

---

### L-3: `evaluateSuccess()` Parses Criteria String Every Call

**File**: `EvaluationOrchestrator.ts` (lines 408–417)

**Description**: `evaluateSuccess()` does `criteria.startsWith('exit_code:')` and `parseInt(criteria.split(':')[1])` every time. The criteria string never changes during a run.

**Why it matters**: Negligible performance impact per call, but signals missing domain modeling — success criteria should be parsed once into a structured type.

**Remediation**: Parse `success_criteria` into a discriminated union type at runbook load time.

---

### L-4: `sanitizeAgentOutput()` Uses Simple Heading Stripping

**File**: `SelfHealing.ts` (lines 23–34)

**Description**: The sanitization strips `# ` patterns from line starts. This is a weak defense against prompt injection — it only handles one Markdown pattern. A determined attacker could use other formatting (bold, HTML entities, code blocks).

**Why it matters**: The comment correctly identifies this as defense-in-depth, not a primary security control. However, the sanitization could be strengthened with minimal effort.

**Remediation**: Consider adding: strip XML-like tags (`<system>`, `<instruction>`), remove triple-backtick code fences that could contain injected instructions, and normalize excessive whitespace.

---

### L-5: `EngineEvent.PAUSE` Exists But Is Never Used in Transitions

**File**: `types/engine.ts` (line 55)

**Description**: The `PAUSE` event is declared in the enum but has no entries in the `STATE_TRANSITIONS` table. It's a dead event.

**Why it matters**: Misleading — developers may try to use `transition(EngineEvent.PAUSE)` and wonder why it always returns `null`.

**Remediation**: Either add transition entries for `PAUSE` (see H-1) or remove the enum value.

---

### L-6: `WorkerResultProcessor` Uses Non-null Assertion on `this.handoffExtractor!`

**File**: `WorkerResultProcessor.ts` (line 123)

**Description**: `this.handoffExtractor!.extractImplementationPlan(...)` uses `!` despite being inside a block that already checked `this.handoffExtractor` (line 93 checks for existence, but line 123 is deep inside a nested callback). The check at line 93 guards the outer block, so the `!` is technically safe but fragile to refactoring.

**Why it matters**: If someone restructures the code, the `!` assertion could become unsafe.

**Remediation**: Use optional chaining: `this.handoffExtractor?.extractImplementationPlan(...)`.

---

### L-7: `Scheduler.kahnSort()` Doesn't Handle Undefined `depends_on` Phases in Adjacency

**File**: `Scheduler.ts` (lines 143–148)

**Description**: When building the adjacency graph, if a phase's `depends_on` references a phase ID that doesn't exist in the phases array, `adjacency.get(dep)` returns `undefined` and the push is skipped silently. The `inDegree` for the referencing phase is still incremented, so it will never become 0 — the phase is permanently blocked.

**Why it matters**: A missing dependency reference (typo) causes a phase to be silently blocked forever, detected only by the stall watchdog after 30 seconds.

**Remediation**: `SessionController.loadRunbook()` already validates dependency references (MF-1 fix). This is defense-in-depth — add a warning log when `adjacency.get(dep)` returns `undefined`.

---

## 5. Summary Matrix

| ID | Severity | Category | File(s) | Summary |
|----|----------|----------|---------|---------|
| C-1 | Critical | Reliability | `Engine.ts` | `workerExitLock` chain breaks permanently on exception |
| C-2 | Critical | Reliability | `PhaseController.ts` | Composite FSM transitions can orphan state on skip |
| C-3 | Critical | Reliability | `DispatchController.ts` | Stall watchdog fires unguarded composite transitions |
| H-1 | High | Dataflow | `DispatchController.ts` | Pause path doesn't transition FSM — state divergence |
| H-2 | High | Design | `TypedEventEmitter.ts` | Runtime `emit()` override loses type safety |
| H-3 | High | Design | `EngineInternals.ts` | `emit(string, ...unknown[])` bypasses event type map |
| H-4 | High | Reliability | `WorkerResultProcessor.ts` | FSM errors silenced by `.catch(log.onError)` |
| H-5 | High | Reliability | `wiring-contracts.ts` | Adapter functions provide zero runtime validation |
| H-6 | High | Reliability | `EvaluationOrchestrator.ts` | Parallel failure dispatches new work without safety |
| M-1 | Medium | Domain | `Scheduler.ts` | `isAllCompleted()` name misleading (includes failed) |
| M-2 | Medium | Performance | `PlanningController.ts` | Save-then-reload roundtrip is wasteful and fragile |
| M-3 | Medium | Design | `WorkerLauncher.ts` | Duck-type probe bypasses interface contract |
| M-4 | Medium | Design | `WorkerLauncher.ts`, `WorkerResultProcessor.ts` | Static `MissionControlPanel.broadcast()` breaks DI |
| M-5 | Medium | Design | `ContextAssemblyAdapter.ts` | Duck-type cast instead of proper type guard |
| M-6 | Medium | Reliability | `SelfHealing.ts` | Unbounded exponential backoff delay |
| M-7 | Medium | Design | `PhaseController.ts` | Complex state-aware branching duplicates FSM knowledge |
| M-8 | Medium | Design | `EvaluationOrchestrator.ts`, `SelfHealing.ts` | Deferred DI with silent no-op on missing dependency |
| M-9 | Medium | Domain | `PhaseController.ts` | Skipped phases marked `'completed'` — misleading |
| M-10 | Medium | Design | `Engine.ts` | `loadRunbook()` ignores file path parameter |
| L-1 | Low | Performance | `DispatchController.ts`, `WorkerLauncher.ts` | Repeated `phaseMap` construction per dispatch |
| L-2 | Low | Design | `Engine.ts` | 15+ `@internal` methods exposed as `public` |
| L-3 | Low | Performance | `EvaluationOrchestrator.ts` | Success criteria re-parsed on every evaluation |
| L-4 | Low | Security | `SelfHealing.ts` | Weak sanitization for prompt injection defense |
| L-5 | Low | Domain | `types/engine.ts` | `PAUSE` event exists but unused in transition table |
| L-6 | Low | Reliability | `WorkerResultProcessor.ts` | Non-null assertion fragile to refactoring |
| L-7 | Low | Reliability | `Scheduler.ts` | Silent blocking on missing dependency reference |

---

## Prioritized Remediation Order

1. **C-1**: Fix `workerExitLock` chain — add `.catch()` with chain recovery. (effort: 1h)
2. **C-2 + C-3**: Guard all composite transitions — audit every call site that fires multiple transitions. (effort: 2h)
3. **H-1**: Add `PAUSE` transitions to the FSM table and use them in `advanceSchedule()`. (effort: 1h)
4. **H-4**: Propagate errors from `processWorkerExit` instead of swallowing. (effort: 1h)
5. **H-5**: Add runtime assertions to adapter functions. (effort: 1h)
6. **M-9**: Introduce `'skipped'` phase status. (effort: 3h — touches types, scheduler, UI)
7. **H-2 + H-3**: Replace untyped emit with typed wrapper methods on EngineInternals. (effort: 4h)
8. **M-4**: Replace static `MissionControlPanel.broadcast()` with injected interface. (effort: 2h)

```json
{
  "decisions": [
    "Organized findings by severity (critical/high/medium/low) with 24 total issues identified",
    "Focused on reliability and correctness as the highest-priority concerns given this is an execution engine",
    "Identified 3 critical issues all related to FSM state corruption (workerExitLock chain breakage, unguarded composite transitions)",
    "Called out the consistent pattern of duck-type casting bypassing interface contracts as a systemic design issue",
    "Proposed concrete remediation with effort estimates for each finding",
    "Prioritized remediation order based on blast radius and fix difficulty"
  ],
  "modified_files": [
    "review-part2-engine.md"
  ],
  "unresolved_issues": [
    "Could not access MCP server resources for implementation plan context",
    "Could not locate request.md in the IPC directory for additional instructions",
    "Full EngineWiring.ts was not in scope but is referenced by several findings — may contain additional issues",
    "ServiceContainer type definition not reviewed — could reveal additional DI issues",
    "Test coverage analysis not performed — unclear which findings already have test coverage"
  ],
  "next_steps_context": "The review identified 3 critical bugs in the FSM state management (workerExitLock chain breakage, unguarded composite transitions in skipPhase and stallWatchdog). These should be fixed before any refactoring work. The engine module shows a consistent pattern of duck-type casting and deferred dependency injection that should be addressed systematically. The 'skipped' phase status addition (M-9) is a domain modeling fix that affects types, scheduler, and UI — coordinate with the webview team."
}
```
