# Coogent — Multi-Agent Orchestration Engine for Antigravity IDE

> **Context Diffusion, Not Context Collision.**
> Break massive implementation plans into surgically scoped micro-tasks, each executed by a fresh, zero-context AI agent.

---

## The Problem: Context Collapse

Single-instance AI agents hit a wall when working on dense, multi-layered codebases. As the token window fills with file history, irrelevant dependencies, and accumulated conversation, the model begins to:

- **Hallucinate** — fabricating APIs or imports that don't exist.
- **Forget constraints** — dropping critical requirements stated 50 messages ago.
- **Truncate output** — silently cutting off generated code mid-function.

This is **Context Collapse**: the point at which an agent's cognitive load exceeds its effective processing window.

## The Solution: Context Diffusion

Coogent shifts cognitive load from the LLM to a deterministic, local state machine. Instead of one overloaded agent, it **diffuses** the work:

```
 ┌─────────────┐     ┌──────────────┐     ┌──────────────┐     ┌────────────┐     ┌─────────┐
 │  Decompose  │────►│    Scope     │────►│   Execute    │────►│  Evaluate  │────►│ Advance │
 │  (Planner)  │     │ (ContextScoper)    │  (Worker)    │     │ (Evaluator)│     │  (DAG)  │
 └─────────────┘     └──────────────┘     └──────────────┘     └────────────┘     └─────────┘
  AI breaks the       Each task gets       Ephemeral agent      Engine verifies     Fresh worker
  goal into tasks     ONLY the files       spawns with zero     success criteria    for next task.
                      it needs             prior history        (exit, regex, etc)  Zero bleed-over.
```

The result: every agent operates in a **clean room** — maximum signal, zero noise.

---

## Core Features

### Pillar 1 — Core Engine (MVP) ✅
- **9-State Deterministic FSM** — `IDLE → PLANNING → PLAN_REVIEW → PARSING → READY → EXECUTING → EVALUATING → ERROR_PAUSED → COMPLETED`
- **Mission Control Dashboard** — Svelte-based Webview UI showing phase status, live agent output, and token budgets
- **Plan & Review Workflow** — AI-generated runbook with human approval gate before execution
- **Persistent State** — `.task-runbook.json` with crash recovery via write-ahead log (WAL)
- **Git Sandboxing** — Isolated `coogent/*` branches via native VS Code Git API with pre-flight dirty-tree checks

### Pillar 2 — Intelligent Context ✅
- **AST Auto-Discovery** — Regex-based import/require/include crawling with cycle detection (`ASTFileResolver`)
- **Token Pruning** — 3-tier heuristic reducer: drop discovered files → strip function bodies → proportional truncation (`TokenPruner`)
- **DAG Execution** — Parallel agent dispatching via topological sort with `depends_on` dependencies (`Scheduler`)
- **Semantic Distillation** — "Pointer Method" context summaries prevent token bloat across phase handoffs

### Pillar 3 — Autonomous Resilience ✅
- **Pluggable Evaluators** — Exit code, regex match, workspace toolchain (`xcodebuild`, `make`), and test suite output parsing (`EvaluatorRegistry`)
- **Automated Version Control** — Snapshot commits after each phase, clean-room rollback on failure (`GitManager`)
- **Self-Healing Retry Loops** — Configurable per-phase `max_retries` with exponential backoff and error-injected augmented prompts (`SelfHealingController`)
- **Consolidation Reports** — Aggregated phase results, decisions, and modified files after execution (`ConsolidationAgent`)

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                    Antigravity IDE                            │
│                                                              │
│  ┌──────────────────────────────┐  ┌──────────────────────┐ │
│  │    Extension Host (Node.js)  │◄►│  Webview (Mission    │ │
│  │  ┌────────────────────────┐  │  │   Control Dashboard) │ │
│  │  │ Engine (9-State FSM)   │  │  └──────────────────────┘ │
│  │  │  + Scheduler (DAG)     │  │       ▲ postMessage       │
│  │  │  + SelfHealing         │  │       │                   │
│  │  │  + EvaluatorRegistry   │  │       │                   │
│  │  └────────────────────────┘  │       │                   │
│  │  ┌────────────────────────┐  │       │                   │
│  │  │ ContextScoper          │  │       │                   │
│  │  │  + ASTFileResolver     │  │       │                   │
│  │  │  + TokenPruner         │  │       │                   │
│  │  └────────────────────────┘  │       │                   │
│  │  ┌────────────────────────┐  │       │                   │
│  │  │ ADKController          │──┼───────┘                   │
│  │  │  + GitManager          │  │                           │
│  │  │  + GitSandboxManager   │  │                           │
│  │  └──────┬─────────────────┘  │                           │
│  └─────────┼────────────────────┘                           │
│            │ spawn/terminate (parallel workers)              │
│            ▼                                                │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │
│  │ Worker 0    │  │ Worker 1    │  │ Worker N    │        │
│  │ (ephemeral) │  │ (ephemeral) │  │ (ephemeral) │        │
│  └─────────────┘  └─────────────┘  └─────────────┘        │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  .coogent/ipc/<session-id>/  (session-scoped state)    │ │
│  └────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

See [ARCHITECTURE.md](./docs/ARCHITECTURE.md) for the full technical design with Mermaid diagrams.

---

## Getting Started

### Prerequisites

- [Antigravity IDE](https://antigravity.dev) (VS Code fork) — v1.85+
- Node.js 18+
- Antigravity Agent Development Kit (ADK)

### Installation

```bash
# Clone the repository
git clone https://github.com/lehoa1806/coogent.git
cd coogent

# Install dependencies
npm install

# Compile TypeScript + Webview
npm run build

# Launch in Extension Development Host
# Press F5 in Antigravity IDE, or:
npm run watch  # in one terminal
# Then launch "Run Extension" from the debug panel
```

### Hello World: Your First Coogent Run

1. **Open Mission Control** — `Cmd+Shift+P` → **Coogent: Open Mission Control**

2. **Enter a prompt** — Type a high-level implementation goal in the prompt area:
   ```
   Create a TypeScript REST API with Express: a User model, a UserService
   with CRUD operations, and route handlers with input validation.
   ```

3. **Review the Plan** — Coogent's Planner Agent decomposes the goal into a multi-phase runbook. Review phases, context files, and dependencies. Click **Approve** to proceed.

4. **Monitor Execution** — Watch each phase execute in isolation:
   - Phase Navigator shows progress through the DAG
   - Phase Details shows live worker output
   - Git creates a sandbox branch (`coogent/<task-slug>`)

5. **Review the Diff** — When all phases complete, use the native VS Code Source Control to review all changes made on the `coogent/*` branch against your original branch.

### Manual Runbook (Alternative)

Create `.task-runbook.json` in your workspace root:

```json
{
  "project_id": "hello-coogent",
  "status": "idle",
  "current_phase": 0,
  "phases": [
    {
      "id": 0,
      "status": "pending",
      "prompt": "Create src/models/User.ts with a TypeScript interface for User.",
      "context_files": [],
      "success_criteria": "exit_code:0"
    },
    {
      "id": 1,
      "status": "pending",
      "prompt": "Create src/services/UserService.ts implementing CRUD operations.",
      "context_files": ["src/models/User.ts"],
      "success_criteria": "exit_code:0",
      "depends_on": [0]
    }
  ]
}
```

Then load it via **Coogent: Open Mission Control** → **Start**.

---

## Project Structure

```
coogent/
├── README.md
├── CONTRIBUTING.md
├── package.json
├── tsconfig.json
├── jest.config.js
├── esbuild.js                     # Extension bundler
├── esbuild-webview.js             # Webview bundler (legacy)
├── docs/
│   ├── PRD.md                     # Product requirements
│   ├── ARCHITECTURE.md            # System architecture (Mermaid diagrams)
│   ├── TDD.md                     # Technical design document
│   ├── API_REFERENCE.md           # IPC contracts, schemas, module APIs
│   └── USER_GUIDE.md              # End-user reference
├── schemas/
│   └── runbook.schema.json        # AJV-validated JSON Schema
├── src/
│   ├── extension.ts               # activate/deactivate + event wiring
│   ├── types/
│   │   └── index.ts               # All TypeScript interfaces (796 lines)
│   ├── state/
│   │   └── StateManager.ts        # Runbook I/O, locking, WAL
│   ├── engine/
│   │   ├── Engine.ts              # 9-state deterministic FSM
│   │   ├── Scheduler.ts           # DAG scheduler (Kahn's algorithm)
│   │   └── SelfHealing.ts         # Auto-retry controller
│   ├── adk/
│   │   ├── ADKController.ts       # Parallel worker pool
│   │   ├── AntigravityADKAdapter.ts # ADK adapter with IPC fallback
│   │   ├── OutputBuffer.ts        # 100ms batched stream flush
│   │   └── OutputBufferRegistry.ts # Multi-worker output management
│   ├── context/
│   │   ├── ContextScoper.ts       # File reading + tokenization
│   │   ├── FileResolver.ts        # AST auto-discovery (import crawling)
│   │   └── TokenPruner.ts         # 3-tier heuristic token pruning
│   ├── evaluators/
│   │   └── CompilerEvaluator.ts   # Pluggable success evaluators
│   ├── git/
│   │   ├── GitManager.ts          # Snapshot commits & rollback
│   │   └── GitSandboxManager.ts   # Native VS Code Git API sandboxing
│   ├── consolidation/
│   │   └── ConsolidationAgent.ts  # Post-execution report aggregation
│   ├── session/
│   │   └── SessionManager.ts      # Session history & search
│   ├── planner/
│   │   └── PlannerAgent.ts        # Objective → runbook decomposition
│   ├── logger/
│   │   └── TelemetryLogger.ts     # Append-only JSONL session logging
│   └── webview/
│       ├── MissionControlPanel.ts # Webview lifecycle + IPC bridge
│       └── ipcValidator.ts        # Typed IPC message validation
├── webview-ui/                    # ⚠️ DEPRECATED — legacy Vanilla JS webview
│   └── DEPRECATED.md
├── webview-ui-svelte/             # Active Svelte webview (Vite-built)
│   ├── src/
│   │   ├── components/            # Svelte UI components
│   │   ├── lib/                   # Stores, IPC bridge, utilities
│   │   ├── App.svelte             # Root component
│   │   └── main.ts                # Entry point
│   ├── dist/                      # Compiled assets (committed)
│   │   └── assets/
│   │       ├── index.js           # Single JS bundle
│   │       └── style.css          # Single CSS bundle
│   ├── vite.config.ts             # Vite build config
│   └── package.json
└── .coogent/                      # All runtime state (gitignored)
    ├── ipc/<session-id>/          # Session-scoped runbook + WAL + lock
    ├── logs/                      # JSONL session logs
    └── pid/                       # PID files for orphan recovery
```

---

## Documentation

| Document | Description |
|---|---|
| [User Guide](./docs/USER_GUIDE.md) | End-user reference — Mission Control UI, Plan & Review workflow, runbook authoring |
| [Architecture](./docs/ARCHITECTURE.md) | System architecture — 9-state FSM, DAG engine, Git sandboxing, semantic distillation |
| [API Reference](./docs/API_REFERENCE.md) | IPC contracts, MCP resources/tools, runbook schema, module APIs |
| [TDD](./docs/TDD.md) | Technical Design Document — detailed implementation blueprint |
| [PRD](./docs/PRD.md) | Product Requirements Document — problem, solution, feature roadmap |
| [Contributing](./CONTRIBUTING.md) | Development setup, debugging, testing, code style |
| [Runbook Schema](./schemas/runbook.schema.json) | JSON Schema for `.task-runbook.json` validation |

---

## Development

```bash
npm run compile          # One-time TypeScript build
npm run build:webview    # Build Svelte webview (one-time)
npm run dev:webview      # Svelte webview dev mode (HMR)
npm run build            # Both (TypeScript + Svelte)
npm run watch            # TypeScript watch mode
npm run lint             # Type-check (no emit)
npm test                 # Run test suite (Jest — 14 suites, 100+ tests)
npm run package          # Create .vsix extension package
```

### Svelte Migration

The Mission Control webview has been migrated from Vanilla JS (`webview-ui/`) to Svelte 5 (`webview-ui-svelte/`). The Svelte app is built with Vite into a single JS + CSS bundle for CSP compliance in VS Code webviews.

- **Source**: `webview-ui-svelte/src/`
- **Output**: `webview-ui-svelte/dist/assets/` (single `index.js` + `style.css`)
- **Build**: `npm run build:webview`
- **Dev**: `npm run dev:webview` (Vite dev server for rapid iteration)

The legacy `webview-ui/` directory is preserved for rollback but is no longer active. See `webview-ui/DEPRECATED.md`.

---

## License

MIT
