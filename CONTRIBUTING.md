# Contributing to Coogent

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Local Development](#local-development)
3. [Debugging](#debugging)
4. [Running Tests](#running-tests)
5. [Project Structure](#project-structure)
6. [Code Style](#code-style)
7. [Architecture Decisions](#architecture-decisions)
8. [Building for Production](#building-for-production)
9. [Documentation](#documentation)

---

## Prerequisites

- Node.js 18+
- [Antigravity IDE](https://antigravity.dev) (VS Code fork) — v1.85+
- Git

## Local Development

The project has two build targets that must be compiled separately:

### 1. Extension Host (TypeScript → JavaScript)

The Extension Host is the Node.js backend that houses the FSM, state management, ADK integration, and all business logic.

```bash
# One-time build
npm run compile

# Watch mode (recommended for development)
npm run watch
```

This compiles all TypeScript in `src/` to `out/` using `esbuild.js`.

### 2. Webview UI (JavaScript → Bundled JavaScript)

The Webview is the Mission Control dashboard — a sandboxed iframe with its own JS/CSS bundle.

```bash
# One-time build
npm run compile:webview

# Watch mode (recommended for development)
npm run watch:webview
```

This bundles `webview-ui/main.js` and its 11 module files into `webview-ui/dist/` using `esbuild-webview.js`.

### 3. Full Build

```bash
# Both targets in one command
npm run build
```

### 4. Launch the Extension Development Host

1. Open the Coogent project in Antigravity IDE
2. Press **F5** — this launches a new IDE window with the extension loaded
3. In the new window, open a test workspace
4. `Cmd+Shift+P` → **Coogent: Open Mission Control**

> **Tip**: Run `npm run watch` and `npm run watch:webview` in separate terminals alongside F5 for hot reloading.

---

## Debugging

### Debugging the Extension Host

The Extension Host runs as a Node.js process. Use the built-in VS Code debugger:

1. Open the project in Antigravity IDE
2. Go to **Run and Debug** panel (Cmd+Shift+D)
3. Select **"Run Extension"** from the launch dropdown
4. Press **F5** — this launches with breakpoints enabled
5. Set breakpoints in any `src/` file

**Key files to focus on:**
- `src/extension.ts` — the activation entry point and event wiring hub
- `src/engine/Engine.ts` — FSM transitions and state management
- `src/adk/ADKController.ts` — worker spawning and lifecycle

### Debugging IPC Messages

IPC communication between the Extension Host and Webview is the most common source of bugs. To trace messages:

1. **Host → Webview**: Set a breakpoint in `MissionControlPanel.postMessage()` in `src/webview/MissionControlPanel.ts`
2. **Webview → Host**: Set a breakpoint in the `webview.onDidReceiveMessage` handler in `src/extension.ts` (the `activate()` function)
3. **Message Validation**: The `ipcValidator.ts` module validates all incoming messages. Check the browser console in the Webview for validation errors.

### Debugging the Webview (Browser DevTools)

The Webview runs in a sandboxed Chromium iframe. To inspect it:

1. Launch the Extension Development Host (F5)
2. Open Mission Control
3. In the Extension Development Host window: `Cmd+Shift+P` → **"Developer: Toggle Developer Tools"**
4. In the DevTools console, you can:
   - View `console.log` output from `webview-ui/main.js`
   - Inspect DOM elements
   - Set breakpoints in the bundled JS
   - Monitor `postMessage` traffic

### Debugging MCP Transport Errors

If MCP resources or tools return unexpected results:

1. Check the **TelemetryLogger** output in `.coogent/logs/` — every state mutation and IPC message is logged as JSONL
2. Enable verbose logging via Settings → `coogent.logLevel: debug`
3. Check the **Output** panel in the IDE → select "Coogent" from the dropdown

### Common Debugging Scenarios

| Symptom | Check |
|---|---|
| Phase stuck in `running` | ADKController worker handle map — is the worker still alive? Check PID files in `.coogent/pid/` |
| UI not updating | IPC message flow — is `MissionControlPanel` posting messages? Is the Webview receiving them? |
| Runbook not persisting | StateManager mutex — is a concurrent write blocking? Check `.wal.json` existence |
| Git sandbox not created | GitSandboxManager — is the VS Code Git extension loaded? Is the working tree clean? |
| Planner returns empty | PlannerAgent — check the output in TelemetryLogger logs |

---

## Running Tests

```bash
npm test                           # All 14 suites, 100+ tests
npx jest --verbose                 # With detailed output
npx jest src/state                 # Run specific module tests
npx jest --watch                   # Watch mode
```

### Test Organization

Tests live in `__tests__/` directories alongside their source modules:

| Suite | Location | Covers |
|---|---|---|
| StateManager | `src/state/__tests__/` | Persistence, WAL, crash recovery |
| StateManager.race | `src/state/__tests__/` | Concurrent writes, stale locks |
| Engine | `src/engine/__tests__/` | FSM transitions, parallel DAG |
| Scheduler | `src/engine/__tests__/` | DAG scheduling, cycle detection |
| SelfHealing | `src/engine/__tests__/` | Retry counting, prompt augmentation |
| ADKController | `src/adk/__tests__/` | Spawn/terminate, timeout race |
| ContextScoper | `src/context/__tests__/` | Assembly, budget enforcement |
| ASTFileResolver | `src/context/__tests__/` | Import crawling, cycle detection |
| TokenPruner | `src/context/__tests__/` | 3-tier pruning |
| GitManager | `src/git/__tests__/` | Commit/rollback (mocked) |
| TelemetryLogger | `src/logger/__tests__/` | JSONL logging |
| MissionControlPanel | `src/webview/__tests__/` | IPC validation (17 cases) |
| Integration | `src/__tests__/` | End-to-end flow |
| Pillar 2+3 | `src/__tests__/` | Scheduler + SelfHealing + Evaluator |

### Writing Tests

- Use `jest.fn()` for mocking — dependency injection makes this straightforward
- Mock the `vscode` namespace using the Jest config (`jest.config.js`)
- For async tests, use `async/await` and avoid `done()` callbacks
- For timer-dependent tests (e.g., SelfHealing backoff), use `jest.useFakeTimers()`

---

## Project Structure

```
src/
├── extension.ts          ← Activation entry point (874 lines)
├── types/index.ts        ← Full type system: FSM, IPC, ADK contracts (796 lines)
├── state/                ← StateManager (WAL, mutex, crash recovery)
├── engine/               ← Engine, Scheduler, SelfHealing
├── adk/                  ← ADKController, AntigravityADKAdapter, OutputBuffer, OutputBufferRegistry
├── context/              ← ContextScoper, FileResolver, TokenPruner
├── evaluators/           ← CompilerEvaluator (exit_code, regex, toolchain, test_suite)
├── git/                  ← GitManager (execFile), GitSandboxManager (VS Code Git API)
├── consolidation/        ← ConsolidationAgent (post-execution reports)
├── session/              ← SessionManager (history, search, pruning)
├── planner/              ← PlannerAgent (objective → runbook decomposition)
├── logger/               ← TelemetryLogger (JSONL), log.ts, LogStream.ts
└── webview/              ← MissionControlPanel, ipcValidator
```

---

## Code Style

- **TypeScript strict mode** — all types explicit, no `any`
- **Discriminated unions** for IPC messages — exhaustive `switch` with `never` check
- **EventEmitter pattern** — typed events via `EngineEvents` interface
- **No singletons** — all dependencies injected via constructor
- **Async safety** — in-process mutex for `StateManager`, `activeWorkerCount` for parallel FSM
- **Branded types** — `PhaseId` and `UnixTimestampMs` prevent accidental type mix-ups
- **`execFile` over `exec`** — prevents shell injection in GitManager and evaluators
- **snake_case for JSON** — persisted fields use `snake_case` (e.g., `context_files`, `depends_on`)
- **camelCase for TypeScript** — runtime-only fields use `camelCase`

---

## Architecture Decisions

| Decision | Rationale |
|---|---|
| WAL + atomic rename | Crash-safe persistence without external dependencies |
| AJV schema validation | Prevents schema drift, catches malformed runbooks early |
| `execFile` over `exec` | Prevents shell injection in GitManager/evaluators |
| `activeWorkerCount` over hierarchical FSM | Simpler parallel execution tracking without breaking the 9-state model |
| Regex-based import resolution | No `tree-sitter` WASM dependency; upgrade path documented |
| Native VS Code Git API for sandboxing | No `child_process` dependency; leverages IDE-integrated Git state |
| In-process async mutex (not flock) | Simpler, no POSIX dependency, sufficient for single-process case |
| Branded types (`PhaseId`, `UnixTimestampMs`) | Compile-time safety against numeric type confusion |
| UUIDv7 for session IDs | Lexicographically sortable, embeds creation timestamp |
| YYYYMMDD-HHMMSS prefix on session dirs | Human-readable session ordering in file explorers |

---

## Building for Production

```bash
# Production builds (minified)
npm run prepackage

# Create .vsix extension package
npm run package
```

The `.vsix` file can be installed in any Antigravity IDE instance via:
```bash
# In the IDE
Cmd+Shift+P → "Extensions: Install from VSIX…"
```

---

## Documentation

| Document | Path | Description |
|---|---|---|
| README | `README.md` | Overview, features, quick start |
| User Guide | `docs/USER_GUIDE.md` | Mission Control UI, Plan & Review workflow |
| Architecture | `docs/ARCHITECTURE.md` | System design, FSM, DAG engine, Git sandboxing |
| API Reference | `docs/API_REFERENCE.md` | IPC contracts, MCP resources/tools, schemas |
| PRD | `docs/PRD.md` | Product requirements |
| TDD | `docs/TDD.md` | Technical design document |
| Schema | `schemas/runbook.schema.json` | Runbook JSON Schema |
