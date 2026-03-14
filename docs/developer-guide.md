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

> [!IMPORTANT]
> Always checkout the `master` branch before building to ensure you are compiling from the latest stable source:
> ```bash
> git checkout master && git pull
> ```

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
│   ├── extension.ts              ← Activation entry point (~119 lines, thin orchestrator)
│   ├── activation.ts             ← Composable init functions (logging, services, MCP, wiring)
│   ├── ServiceContainer.ts       ← Typed service registry (replaces module-level vars)
│   ├── CommandRegistry.ts        ← VS Code command registrations (15 commands)
│   ├── EngineWiring.ts           ← Engine ↔ ADK ↔ UI event subscriptions
│   ├── PlannerWiring.ts          ← PlannerAgent ↔ Engine event wiring
│   ├── types/                    ← Domain-scoped type system (engine, phase, ipc, evaluators)
│   │   ├── engine.ts             ← FSM states, events, transition table
│   │   ├── phase.ts              ← Phase, Runbook, branded types
│   │   ├── ipc.ts                ← Host↔Webview message contracts
│   │   ├── evaluators.ts         ← Evaluator types and results
│   │   └── index.ts              ← Barrel re-export
│   │
│   ├── constants/                ← Storage paths, error codes, boundary definitions
│   │   ├── paths.ts              ← Path constants and file name definitions
│   │   ├── StorageBase.ts        ← Unified storage-path abstraction
│   │   ├── WorkspaceIdentity.ts  ← Workspace tenant identity (SHA-256 derivation)
│   │   ├── storage.ts            ← Storage configuration
│   │   └── index.ts              ← Barrel re-export
│   │
│   ├── engine/                   ← Engine (FSM), Scheduler (DAG), SelfHealingController
│   │   ├── Engine.ts             ← 9-state FSM controller
│   │   ├── EngineInternals.ts    ← Internal engine state accessors
│   │   ├── Scheduler.ts          ← DAG-aware phase scheduling
│   │   ├── DispatchController.ts ← Phase dispatch orchestration
│   │   ├── EvaluationOrchestrator.ts ← Pluggable evaluator orchestration
│   │   ├── PlanningController.ts ← Plan request handling
│   │   ├── PhaseController.ts    ← Phase lifecycle management
│   │   ├── SessionController.ts  ← Session lifecycle management
│   │   ├── SelfHealing.ts        ← Retry + healing prompt generation
│   │   ├── WorkerOutputValidator.ts ← Zod-based output validation boundary
│   │   ├── ContextAssemblyAdapter.ts ← Context assembly delegation (from EngineWiring)
│   │   ├── WorkerLauncher.ts     ← Worker spawning logic (from EngineWiring)
│   │   └── WorkerResultProcessor.ts ← Result handling (from EngineWiring)
│   │
│   ├── state/                    ← StateManager (WAL + mutex + AJV validation)
│   ├── mcp/                      ← MCP server, persistence, plugins
│   │   ├── CoogentMCPServer.ts   ← In-process MCP server
│   │   ├── ArtifactDB.ts         ← SQLite persistence (sql.js WASM), multi-window merge
│   │   ├── ArtifactDBSchema.ts   ← Schema DDL, migrations, and table constants
│   │   ├── ArtifactDBBackup.ts   ← Snapshot/restore with rotation
│   │   ├── MCPClientBridge.ts    ← Typed client-side MCP bridge
│   │   ├── MCPResourceHandler.ts ← coogent:// URI resource handler
│   │   ├── MCPToolHandler.ts     ← MCP tool implementations
│   │   ├── MCPPromptHandler.ts   ← 5 discoverable prompt templates
│   │   ├── MCPValidator.ts       ← Input validation boundary
│   │   ├── SamplingProvider.ts   ← Feature-gated LLM sampling
│   │   ├── PluginLoader.ts       ← MCP plugin discovery and loading
│   │   ├── MCPPlugin.ts          ← Plugin interface definition
│   │   ├── repositories/         ← 7 typed repository classes (Task, Phase, Handoff, etc.)
│   │   └── types.ts              ← MCP type definitions and URI builders
│   │
│   ├── adk/                      ← ADKController, ADKAdapter, OutputBuffer, OutputBufferRegistry
│   ├── context/                  ← ContextScoper, ContextPackBuilder, FileContextModeSelector,
│   │                               ASTFileResolver, TokenPruner, TiktokenEncoder, SecretsGuard, RepoMap
│   ├── evaluators/               ← EvaluatorRegistryV2 (exit_code, regex, toolchain, test_suite)
│   ├── git/                      ← GitManager (execFile), GitSandboxManager (VS Code Git API)
│   ├── agent-selection/          ← AgentRegistry, AgentSelector, SelectionPipeline, templates
│   ├── prompt-compiler/          ← PlannerPromptCompiler, PolicyEngine, TaskClassifier,
│   │                               RepoFingerprinter, RequirementNormalizer, TemplateLoader
│   ├── consolidation/            ← ConsolidationAgent (in-process fallback) + consolidation-prompt.ts (ADK worker prompt)
│   ├── session/                  ← SessionManager, SessionHistoryService, SessionRestoreService,
│   │                               SessionDeleteService, SessionHealthValidator
│   ├── planner/                  ← PlannerAgent, WorkspaceScanner, RunbookParser, PlannerRetryManager
│   ├── logger/                   ← TelemetryLogger (JSONL), log.ts, LogStream.ts
│   ├── webview/                  ← MissionControlPanel (IPC proxy), SidebarMenuProvider, ipcValidator
│   ├── utils/                    ← WorkspaceHelper, shared utilities
│   └── __tests__/                ← Integration and end-to-end test suites
│
├── webview-ui/                   ← Svelte 5 + Vite webview source
│   ├── src/
│   │   ├── components/           ← 16 components: ChatInput, ExecutionControls, GlobalHeader,
│   │   │                            InputToolbar, MarkdownRenderer, PhaseActions, PhaseDetails,
│   │   │                            PhaseHandoff, PhaseHeader, PhaseNavigator, PlanReview,
│   │   │                            ReportModal, SuggestionPopup, ViewModeTabs, WorkerStudio,
│   │   │                            WorkerTerminal
│   │   ├── stores/               ← appState, mcpStore (requestId correlation)
│   │   ├── lib/                  ← Shared webview utilities
│   │   ├── styles/               ← Global CSS
│   │   └── types.ts              ← Frontend type definitions
│   └── vite.config.ts            ← Deterministic filename build config
│
├── schemas/                      ← JSON Schemas
│   ├── runbook.schema.json       ← .task-runbook.json validation schema
│   ├── worker.schema.json        ← .coogent/workers.json validation schema
│   └── secrets-allowlist.schema.json ← Secrets allowlist configuration schema
│
├── examples/prompts/             ← Example prompt files for reference
├── .github/workflows/ci.yml     ← CI pipeline (GitHub Actions)
├── package.json                  ← Extension manifest (15 commands, 18 settings)
├── esbuild.js                    ← Extension Host bundler config
├── jest.config.js                ← Test runner config (ts-jest + ESM)
├── tsconfig.json                 ← TypeScript configuration (strict)
│
└── .coogent/                     ← Runtime operational data directory (gitignored)
    ├── ipc/<session-id>/         ← Runbook, WAL, lock files
    └── logs/<run-id>/            ← JSONL telemetry logs
```

---

## Agent Registry & Selection Pipeline

### AgentRegistry API

The `AgentRegistry` class (`src/agent-selection/AgentRegistry.ts`) manages agent profile loading with cascading configuration and skill-based matching.

| Method | Signature | Description |
|---|---|---|
| `getBestAgent` | `(requiredCapabilities: string[]) → Promise<AgentProfile>` | Returns the best-matching profile using Jaccard similarity + weighted scoring. Falls back to the generalist when no capabilities match above 0. |
| `getAvailableTags` | `() → Promise<string[]>` | Returns all unique tags across all loaded profiles. Used by PlannerAgent to populate the prompt. |
| `getAgents` | `() → Promise<AgentProfile[]>` | Returns all loaded profiles. Used by the Worker Studio UI. |
| `getByType` | `(type: AgentType) → AgentProfile \| undefined` | Synchronous lookup by agent type. Used by the SelectionPipeline. |

### SelectionPipeline

The `SelectionPipeline` orchestrates the full flow: `AgentSelector.select()` → `WorkerPromptCompiler.compile()` → `PromptValidator.validate()` → audit record. See [architecture.md](architecture.md#agent-registry--selection-pipeline) for the full algorithm.

### Adding New Built-In Profiles

Edit `src/agent-selection/registry.json` to add a new built-in agent:

```json
{
  "id": "mobile_expert",
  "name": "Mobile Expert",
  "description": "Specialist in React Native and Swift UI development",
  "system_prompt": "You are a mobile expert specializing in React Native and SwiftUI...",
  "tags": ["mobile", "react-native", "swift", "ios", "android"],
  "handles": ["implementation"],
  "risk_tolerance": "medium"
}
```

Profiles must have unique `id` values. The `tags` array drives skill-based matching.

### Testing Agent Selection

Tests are in `src/agent-selection/__tests__/` and cover:

- **AgentRegistry.test.ts** — Profile loading, cascading overrides, tag collection
- **AgentSelector.test.ts** — Hard filter, weighted scoring, tie-break, fallback
- **WorkerPromptCompiler.test.ts** — Template interpolation, prompt assembly
- **PromptValidator.test.ts** — Structural validation rules
- **SubtaskSpecBuilder.test.ts** — Spec construction from phase data
- **WorkerResultHandler.test.ts** — Result parsing and evaluation

Run targeted tests:
```bash
npx jest src/agent-selection
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
npm test                           # All 89 test files (serial, leak detection)
npx jest --verbose                 # With detailed output
npx jest src/engine                # Run specific module
npx jest --watch                   # Watch mode
npx jest --listTests               # List all test files
```

### Test Suites (89 host files + 24 webview files)

#### Core Engine (`src/engine/__tests__/`)

| File | Covers |
|---|---|
| `Engine.test.ts` | FSM transitions, parallel DAG |
| `Scheduler.test.ts` | DAG scheduling, cycle detection |
| `SelfHealing.test.ts` | Retry counting, prompt augmentation |
| `DispatchController.integration.test.ts` | Phase dispatch integration |
| `EvaluationOrchestrator.test.ts` | Evaluator orchestration |
| `PhaseController.test.ts` | Phase lifecycle management |
| `PlanningController.test.ts` | Plan request handling |
| `SessionController.test.ts` | Session lifecycle |
| `WorkerOutputValidator.test.ts` | Zod-based output validation |

#### State (`src/state/__tests__/`)

| File | Covers |
|---|---|
| `StateManager.test.ts` | Persistence, WAL, crash recovery |
| `StateManager.race.test.ts` | Concurrent writes, stale locks |

#### ADK (`src/adk/__tests__/`)

| File | Covers |
|---|---|
| `ADKController.test.ts` | Spawn/terminate, timeout race |
| `AntigravityADKAdapter.integration.test.ts` | ADK adapter integration |
| `OutputBuffer.test.ts` | Timer-based flush, buffer-size flush, dispose |

#### Context (`src/context/__tests__/`)

| File | Covers |
|---|---|
| `ContextScoper.test.ts` | Assembly, budget enforcement |
| `ContextPackBuilder.test.ts` | 6-step pipeline, manifest generation |
| `FileContextModeSelector.test.ts` | Mode selection heuristics |
| `ASTFileResolver.test.ts` | Import crawling, cycle detection |
| `MultiRootFileResolver.test.ts` | Cross-root path resolution |
| `ImportScanner.test.ts` | Import statement parsing |
| `TokenPruner.test.ts` | 3-tier pruning, budget enforcement |
| `TiktokenEncoder.test.ts` | Lazy init, fallback, cl100k_base |
| `SecretsGuard.test.ts` | Pattern detection, entropy, redaction |
| `SecretsGuardAllowlist.test.ts` | Allowlist configuration |
| `RepoMap.test.ts` | Repository structure mapping |
| `HandoffExtractor.test.ts` | Phase handoff extraction |

#### Agent Selection (`src/agent-selection/__tests__/`)

| File | Covers |
|---|---|
| `AgentRegistry.test.ts` | Profile loading, cascading config |
| `AgentSelector.test.ts` | Scoring, hard filter, fallback |
| `WorkerPromptCompiler.test.ts` | Template interpolation |
| `PromptValidator.test.ts` | Structural validation |
| `SubtaskSpecBuilder.test.ts` | Spec construction |
| `WorkerResultHandler.test.ts` | Result parsing |

#### Prompt Compiler (`src/prompt-compiler/__tests__/`)

6 test files covering the full pipeline: `PlannerPromptCompiler`, `RequirementNormalizer`, `TaskClassifier`, `TemplateLoader`, `RepoFingerprinter`, `PolicyEngine`.

#### MCP (`src/mcp/__tests__/`)

11 test files covering: `CoogentMCPServer`, `ArtifactDB`, `ArtifactDBBackup`, `MCPPromptHandler`, `MCPToolHandler`, `MCPResourceHandler`, `MCPValidator`, `SamplingProvider`, `HandoffRepository`, `ContextManifestRepository`, and repository integration.

#### Other Modules

| File | Covers |
|---|---|
| `src/git/__tests__/GitManager.test.ts` | Commit/rollback (mocked) |
| `src/git/__tests__/GitSandboxManager.test.ts` | Sandbox branch lifecycle |
| `src/git/__tests__/GitSandboxMultiRepo.test.ts` | Multi-repo branch ops |
| `src/logger/__tests__/TelemetryLogger.test.ts` | JSONL structured logging |
| `src/logger/__tests__/LogStream.test.ts` | Log stream rotation |
| `src/webview/__tests__/MissionControlPanel.test.ts` | IPC validation |
| `src/evaluators/__tests__/EvaluatorV2.test.ts` | Evaluator registry |
| `src/consolidation/__tests__/ConsolidationAgent.test.ts` | Report aggregation |
| `src/consolidation/__tests__/consolidation-prompt.test.ts` | Consolidation prompt builder |
| `src/constants/__tests__/StorageBase.test.ts` | Storage path resolution |
| `src/planner/__tests__/` | PlannerAgent + 3 collaborators |
| `src/__tests__/integration.test.ts` | End-to-end multi-phase flow |
| `src/__tests__/integration-expanded.test.ts` | Expanded integration scenarios |
| `src/__tests__/scheduling-evaluators-healing.test.ts` | Cross-module integration |
| `src/__tests__/CommandRegistry.test.ts` | Command registration |
| `src/__tests__/EngineWiring.test.ts` | Event wiring |
| `src/__tests__/PlannerWiring.test.ts` | Planner event wiring |
| `src/__tests__/ServiceContainer.test.ts` | Service registry |
| `src/__tests__/WorkspaceHelper.test.ts` | Workspace path utilities |

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
| `npm run lint` | TypeScript type check + ESLint (`tsc --noEmit && eslint src/`) |
| `npm test` | Run all host tests (Jest) |
| `npm run test:webview` | Run webview tests (Vitest) |
| `npm run ci` | lint → test → test:webview → `npm audit` |
| `npm run prepackage` | Minified production build |
| `npm run package` | Create `.vsix` package |
| `npm run clean` | Remove `out/` directory |

### Build Pipeline Details

#### Extension Host Build (`esbuild.js`)

The Extension Host is bundled via [esbuild](https://esbuild.github.io) with several custom behaviors:

| Feature | Implementation |
|---|---|
| **Template inlining** | `.md` files in `src/agent-selection/templates/` and `src/prompt-compiler/templates/` are loaded as text strings via esbuild's text loader. This ensures prompt templates survive single-file bundling. |
| **WASM bundling** | `sql-wasm.wasm` (sql.js) is copied alongside the output bundle. The `sql.js` library loads it at runtime from the same directory. |
| **External exclusions** | `vscode` is marked as an external — it's provided by the Extension Host at runtime. |
| **Single-file output** | The entire Extension Host compiles to `out/extension.js` (CommonJS, Node.js platform). |
| **Source maps** | Enabled in dev mode, disabled in production (`--minify` flag via `npm run prepackage`). |

The JSON runbook schema is **not** loaded from `schemas/runbook.schema.json` at runtime. It is inlined as a TypeScript constant in `StateManager.ts` to prevent `ENOENT` errors in the bundled VSIX.

#### Webview Build (`webview-ui/vite.config.ts`)

The Svelte 5 webview is built via Vite with:

- **Deterministic filenames** — output files use content-hash naming for cache busting
- **CSP compatibility** — all script/style tags include `nonce` attributes for Content Security Policy compliance
- **Single-page output** — builds to `webview-ui/dist/` as static HTML/JS/CSS

#### CI/CD Pipeline (`.github/workflows/ci.yml`)

Every push to `main` and every pull request triggers the GitHub Actions CI workflow:

| Step | Command | Purpose |
|---|---|---|
| Install | `npm ci` | Deterministic dependency install |
| Lint | `npm run lint` | TypeScript type check + ESLint |
| Test (host) | `npm test` | 89 Jest test files (serial, leak detection) |
| Test (webview) | `npm run test:webview` | 24 Vitest test files |
| Audit | `npm audit --audit-level=high` | Security vulnerability scan |
| Build | `npm run prepackage` | Minified production build |
| Package | `npm run package` | Create `.vsix` distribution |
| Upload | `actions/upload-artifact@v4` | Store VSIX for 30-day retention |

The workflow runs on **Ubuntu latest** with a Node.js version matrix of **18 and 20**.

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

---

## Multi-Root Development

### Accessing Workspace Roots

**Always** use `WorkspaceHelper` (`src/utils/WorkspaceHelper.ts`) instead of raw `vscode.workspace.workspaceFolders`:

```typescript
// ❌ Wrong — assumes single root
const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

// ✅ Correct — uses centralized helper
import { getWorkspaceRoots, getPrimaryRoot } from '../utils/WorkspaceHelper';
const allRoots = getWorkspaceRoots();    // string[] — all roots
const primary = getPrimaryRoot();         // string — first root (fallback)
```

**Key functions:**

| Function | Returns | Use When |
|---|---|---|
| `getWorkspaceRoots()` | `string[]` | Iterating over all open roots |
| `getPrimaryRoot()` | `string` | Need a single canonical root (backward compat) |
| `getStorageBase(storageUri)` | `string` | Resolving extension-managed storage path |
| `resolveFileAcrossRoots(path)` | `string \| undefined` | Finding a file that could be in any root |
| `parseQualifiedPath(path)` | `{ workspace, relativePath }` | Parsing `workspace:path` format |

### Where Session State Lives

Session data follows the **hybrid storage model** — durable state is stored globally, operational state is workspace-local:

```
# Global (durable)
~/Library/Application Support/Antigravity/coogent/
├── artifacts.db          ← SQLite database (tenant-scoped via workspace_id)
└── backups/              ← Rotating DB snapshots

# Workspace-local (operational)
<workspaceRoot>/.coogent/
├── ipc/<session-id>/     ← Runbook, WAL, lock files
├── sessions/             ← Session history
└── logs/                 ← JSONL logs
```

This is critical for multi-root support — storing state inside a workspace folder would be ambiguous when multiple roots are open.

### Testing Multi-Root Scenarios

Tests for multi-root functionality are in:

- `src/utils/__tests__/WorkspaceHelper.test.ts` — path resolution, qualified paths
- `src/git/__tests__/GitSandboxMultiRepo.test.ts` — multi-repo branch operations
- `src/context/__tests__/ASTFileResolver.test.ts` — cross-root import resolution

To simulate multi-root in tests, mock `vscode.workspace.workspaceFolders` with multiple entries:

```typescript
jest.mock('vscode', () => ({
    workspace: {
        workspaceFolders: [
            { uri: { fsPath: '/workspace/frontend' }, name: 'frontend' },
            { uri: { fsPath: '/workspace/backend' }, name: 'backend' },
        ],
    },
}), { virtual: true });
```
