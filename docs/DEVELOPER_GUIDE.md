# Developer & Contributor Guide

> Local development, project structure, testing, build commands, and code conventions.

---

## Table of Contents

1. [Local Development](#local-development)
2. [Project Structure](#project-structure)
3. [Debugging](#debugging)
4. [Testing](#testing)
5. [Build Commands](#build-commands)
6. [Code Style & Conventions](#code-style--conventions)

---

## Local Development

### Prerequisites

- Node.js 18+
- [Antigravity IDE](https://antigravity.dev) (VS Code ≥ 1.85)
- Git

### Two Build Targets

The project compiles two separate bundles:

#### Extension Host (TypeScript → JavaScript)

```bash
npm run compile            # One-time build via esbuild → out/extension.js
npm run watch              # Watch mode (recommended)
```

#### Webview UI (Svelte → Bundled JS/CSS)

```bash
npm run build:webview      # One-time build via Vite → webview-ui/dist/
npm run dev:webview        # Watch mode with HMR
```

#### Full Build

```bash
npm run build              # Both targets in one command
```

### Launch the Extension Development Host

1. Open the Coogent project folder in Antigravity IDE
2. Press **F5** — launches a new IDE window with the extension loaded
3. In the new window, open any test workspace
4. `Cmd+Shift+P` → **Coogent: Open Mission Control**

> **Tip**: Run `npm run watch` and `npm run dev:webview` in separate terminals alongside F5 for live reloading.

---

## Project Structure

```
coogent/
├── src/
│   ├── extension.ts              ← Activation entry point (~270 lines, delegates to modules below)
│   ├── ServiceContainer.ts       ← Typed service registry (replaces module-level vars)
│   ├── CommandRegistry.ts        ← VS Code command registrations (14 commands)
│   ├── EngineWiring.ts           ← Engine ↔ ADK ↔ UI event subscriptions
│   ├── PlannerWiring.ts          ← PlannerAgent ↔ Engine event wiring
│   ├── types/index.ts            ← Universal type system (FSM, IPC, branded types)
│   │
│   ├── engine/                   ← Engine (FSM), Scheduler (DAG), SelfHealingController
│   ├── state/                    ← StateManager (WAL + mutex + AJV validation)
│   ├── mcp/                      ← CoogentMCPServer, MCPClientBridge, ArtifactDB (SQLite)
│   ├── adk/                      ← ADKController, ADKAdapter, OutputBuffer, OutputBufferRegistry
│   ├── context/                  ← ContextScoper, ASTFileResolver, TokenPruner, TiktokenEncoder, SecretsGuard
│   ├── evaluators/               ← CompilerEvaluator (exit_code, regex, toolchain, test_suite)
│   ├── git/                      ← GitManager (execFile), GitSandboxManager (VS Code Git API)
│   ├── consolidation/            ← ConsolidationAgent (phase aggregation → report)
│   ├── session/                  ← SessionManager (history, search, pruning)
│   ├── planner/                  ← PlannerAgent (prompt → runbook decomposition)
│   ├── logger/                   ← TelemetryLogger (JSONL), log.ts, LogStream.ts
│   ├── webview/                  ← MissionControlPanel (IPC proxy), ipcValidator
│   ├── utils/                    ← Shared utilities
│   └── __tests__/                ← Integration and end-to-end test suites
│
├── webview-ui/                   ← Svelte 5 + Vite webview source
│   ├── src/
│   │   ├── components/           ← PhaseDetails, PhaseHeader, PhaseActions, PhaseHandoff, PlanReview, ...
│   │   ├── stores/               ← appState, mcpStore (requestId correlation)
│   │   └── types.ts              ← Frontend type definitions
│   └── vite.config.ts            ← Deterministic filename build config
│
├── schemas/runbook.schema.json   ← JSON Schema for .task-runbook.json
├── package.json                  ← Extension manifest, commands, settings
├── esbuild.js                    ← Extension Host bundler config
├── jest.config.js                ← Test runner config (ts-jest + ESM)
├── tsconfig.json                 ← TypeScript configuration (strict)
│
└── .coogent/                     ← Runtime data directory (gitignored)
    ├── artifacts.db              ← SQLite database (MCP state persistence)
    ├── ipc/<session-id>/         ← Runbook, WAL, lock files
    └── logs/<run-id>/            ← JSONL telemetry logs
```

---

## Debugging

### Extension Host (Node.js)

1. **Run and Debug** panel (`Cmd+Shift+D`) → Select **"Run Extension"** → **F5**
2. Set breakpoints in any `src/` file
3. Key entry points:
   - `src/extension.ts` — activation and event wiring
   - `src/engine/Engine.ts` — FSM transitions
   - `src/adk/ADKController.ts` — worker lifecycle

### IPC Messages

The most common source of bugs. To trace:

1. **Host → Webview**: Breakpoint in `MissionControlPanel.postMessage()`
2. **Webview → Host**: Breakpoint in `webview.onDidReceiveMessage` handler in `extension.ts`
3. **Validation**: Check `ipcValidator.ts` and browser console for validation errors

### Webview (Browser DevTools)

1. Launch Extension Development Host (F5)
2. Open Mission Control
3. `Cmd+Shift+P` → **"Developer: Toggle Developer Tools"**
4. Inspect DOM, set breakpoints, monitor `postMessage` traffic

### MCP Transport

- Check `.coogent/logs/` — every state mutation logged as JSONL
- Enable verbose: Settings → `coogent.logLevel: debug`
- Check VS Code Output panel → select "Coogent"

### Quick Reference

| Symptom | Where to Check |
|---|---|
| Phase stuck in `running` | ADKController worker handle map — is the PID alive? |
| UI not updating | IPC message flow — is `postMessage` firing? |
| Runbook not persisting | StateManager mutex — check `.wal.json` existence |
| Git sandbox not created | GitSandboxManager — VS Code Git extension loaded? |
| Planner returns empty | PlannerAgent logs in TelemetryLogger |

---

## Testing

### Run Tests

```bash
npm test                           # All tests (serial, leak detection) — run for current count
npx jest --verbose                 # With detailed output
npx jest src/engine                # Run specific module
npx jest --watch                   # Watch mode
```

### Test Suites

| Suite | Location | Covers |
|---|---|---|
| StateManager | `src/state/__tests__/` | Persistence, WAL, crash recovery |
| StateManager.race | `src/state/__tests__/` | Concurrent writes, stale locks |
| Engine | `src/engine/__tests__/` | FSM transitions, parallel DAG |
| Scheduler | `src/engine/__tests__/` | DAG scheduling, cycle detection |
| SelfHealing | `src/engine/__tests__/` | Retry counting, prompt augmentation |
| ADKController | `src/adk/__tests__/` | Spawn/terminate, timeout race |
| OutputBuffer | `src/adk/__tests__/` | Timer-based flush, buffer-size flush, dispose |
| ContextScoper | `src/context/__tests__/` | Assembly, budget enforcement |
| ASTFileResolver | `src/context/__tests__/` | Import crawling, cycle detection |
| TokenPruner | `src/context/__tests__/` | 3-tier pruning |
| TiktokenEncoder | `src/context/__tests__/` | Lazy init, fallback, cl100k_base encoding |
| SecretsGuard | `src/context/__tests__/` | Secret patterns, entropy, false-positive resistance |
| GitManager | `src/git/__tests__/` | Commit/rollback (mocked) |
| TelemetryLogger | `src/logger/__tests__/` | JSONL logging |
| MissionControlPanel | `src/webview/__tests__/` | IPC validation (17 cases) |
| Integration | `src/__tests__/` | End-to-end flow |
| Pillar 2+3 | `src/__tests__/` | Scheduler + SelfHealing + Evaluator |

### Writing Tests

- Use `jest.fn()` — dependency injection makes mocking straightforward
- Mock the `vscode` namespace via `jest.config.js`
- Use `async/await` (avoid `done()` callbacks)
- For timer tests (backoff, timeouts), use `jest.useFakeTimers()`

### Mock Patterns

```typescript
// MockADKAdapter — simulate worker lifecycle
const mockAdapter = {
    spawn: jest.fn().mockResolvedValue({ pid: 1234 }),
    kill: jest.fn(),
};

// Mock MCP Bridge — for "purified" components
function makeMockBridge() {
    return {
        submitConsolidationReport: jest.fn().mockResolvedValue(undefined),
        readResource: jest.fn().mockResolvedValue('{}'),
    } as unknown as MCPClientBridge;
}
```

---

## Build Commands

| Command | Description |
|---|---|
| `npm run compile` | Build Extension Host (esbuild) |
| `npm run watch` | Watch mode for Extension Host |
| `npm run build:webview` | Build Svelte webview (Vite) |
| `npm run dev:webview` | Watch mode for webview |
| `npm run build` | Full build (Host + Webview) |
| `npm run lint` | TypeScript type check (`tsc --noEmit`) |
| `npm test` | Run all tests (Jest) |
| `npm run ci` | lint → test → `npm audit` |
| `npm run prepackage` | Minified production build |
| `npm run package` | Create `.vsix` package |
| `npm run clean` | Remove `out/` directory |

---

## Code Style & Conventions

| Convention | Example |
|---|---|
| **TypeScript strict mode** | All types explicit, no `any` |
| **Discriminated unions for IPC** | Exhaustive `switch` with `never` check |
| **Dependency injection** | All services via constructor, no singletons |
| **Branded types** | `PhaseId`, `UnixTimestampMs` prevent numeric mix-ups |
| **`execFile` over `exec`** | Prevents shell injection in Git/evaluators |
| **`snake_case` for JSON** | Persisted fields: `context_files`, `depends_on` |
| **`camelCase` for TypeScript** | Runtime-only identifiers |
| **EventEmitter pattern** | Typed events via `EngineEvents` interface |
| **Async safety** | In-process mutex for `StateManager` |
