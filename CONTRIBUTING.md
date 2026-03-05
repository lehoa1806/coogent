# Contributing to Coogent

---

## Prerequisites

- Node.js 18+
- Antigravity IDE (VS Code fork) — v1.85+
- Git

## Setup

```bash
git clone <repo-url> coogent && cd coogent
npm install
npm run build
```

## Development Workflow

```bash
npm run watch          # TypeScript compilation (watch mode)
npm run watch:webview  # Webview bundle (watch mode)
# Press F5 in IDE to launch Extension Development Host
```

## Project Structure

```
src/
├── extension.ts          ← Activation entry point
├── types/index.ts        ← Types, enums, FSM transition table
├── state/                ← StateManager (WAL, mutex, crash recovery)
├── engine/               ← Engine, Scheduler, SelfHealing
├── adk/                  ← ADKController, OutputBuffer, OutputBufferRegistry
├── context/              ← ContextScoper, FileResolver, TokenPruner
├── evaluators/           ← CompilerEvaluator (exit_code, regex, toolchain, test_suite)
├── git/                  ← GitManager (checkpoint, rollback)
├── logger/               ← TelemetryLogger (JSONL)
└── webview/              ← MissionControlPanel, messageValidator
```

## Running Tests

```bash
npm test                           # All 14 suites, 100 tests
npx jest --verbose                 # With detailed output
npx jest src/state                 # Run specific module tests
npx jest --watch                   # Watch mode
```

### Test Organization

Tests live alongside source in `__tests__/` directories:

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

## Code Style

- **TypeScript strict mode** — all types explicit, no `any`
- **Discriminated unions** for IPC messages — exhaustive `switch` with `never` check
- **EventEmitter pattern** — typed events via `EngineEvents` interface
- **No singletons** — all dependencies injected via constructor
- **Async safety** — in-process mutex for `StateManager`, `activeWorkerCount` for parallel FSM

## Architecture Decisions

| Decision | Rationale |
|---|---|
| WAL + atomic rename | Crash-safe persistence without external dependencies |
| AJV schema validation | Prevents schema drift, catches malformed runbooks early |
| `execFile` over `exec` | Prevents shell injection in GitManager/evaluators |
| `activeWorkerCount` over hierarchical FSM | Simpler parallel execution tracking without breaking the 7-state model |
| Regex-based import resolution | No `tree-sitter` WASM dependency; upgrade path documented |

## Building for Production

```bash
npm run build            # Compile TypeScript + Webview
npm run prepackage       # Production builds (minified)
npm run package          # Create .vsix extension package
```

## Documentation

| Document | Path | Description |
|---|---|---|
| README | `README.md` | Overview, features, quick start |
| User Guide | `docs/USER_GUIDE.md` | End-user reference |
| API Reference | `docs/API_REFERENCE.md` | Module APIs, events, IPC |
| Architecture | `docs/ARCHITECTURE.md` | System design, state machine, data flow |
| PRD | `docs/PRD.md` | Product requirements |
| TDD | `docs/TDD.md` | Technical design document |
| Implementation Plan | `docs/IMPLEMENTATION_PLAN.md` | Build phases and status |
| Schema | `schemas/runbook.schema.json` | Runbook JSON Schema |
