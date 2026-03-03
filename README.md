# Isolated-Agent — Multi-Agent Orchestrator for Antigravity IDE

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

Isolated-Agent shifts cognitive load from the LLM to a deterministic, local state machine. Instead of one overloaded agent, it **diffuses** the work:

1. **Decompose** — A planning agent breaks the objective into serialized micro-tasks.
2. **Scope** — Each task receives *only* the files it needs, calculated and assembled by the orchestrator.
3. **Execute** — An ephemeral "Worker" agent is spawned with zero prior history, injected with the scoped context, and given a single focused instruction.
4. **Evaluate** — The orchestrator verifies success (exit code, regex, compiler output) and terminates the worker.
5. **Advance** — A fresh worker is spawned for the next task. Zero token bleed-over.

The result: every agent operates in a **clean room** — maximum signal, zero noise.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    Antigravity IDE                        │
│                                                          │
│  ┌──────────────────────────┐  ┌──────────────────────┐ │
│  │    Extension Host         │◄►│  Webview (Mission    │ │
│  │  ┌────────────────────┐   │  │   Control Dashboard) │ │
│  │  │ OrchestratorEngine │   │  └──────────────────────┘ │
│  │  │  + Scheduler (DAG) │   │       ▲ postMessage       │
│  │  │  + SelfHealing     │   │       │                   │
│  │  │  + EvaluatorReg.   │   │       │                   │
│  │  └────────────────────┘   │       │                   │
│  │  ┌────────────────────┐   │       │                   │
│  │  │ ContextScoper      │   │       │                   │
│  │  │  + ASTFileResolver │   │       │                   │
│  │  │  + TokenPruner     │   │       │                   │
│  │  └────────────────────┘   │       │                   │
│  │  ┌────────────────────┐   │       │                   │
│  │  │ ADKController      │───┼───────┘                   │
│  │  │  + GitManager      │   │                           │
│  │  └──────┬─────────────┘   │                           │
│  └─────────┼─────────────────┘                           │
│            │ spawn/terminate (parallel workers)           │
│            ▼                                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │
│  │ Worker 0    │  │ Worker 1    │  │ Worker N    │     │
│  │ (ephemeral) │  │ (ephemeral) │  │ (ephemeral) │     │
│  └─────────────┘  └─────────────┘  └─────────────┘     │
│                                                          │
│  ┌────────────────────────────────────────────────────┐ │
│  │  .isolated_agent/ipc/<id>/  (session-scoped state) │ │
│  └────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

See [ARCHITECTURE.md](./docs/ARCHITECTURE.md) for the full technical design.

## Features

### Pillar 1 — Core Orchestration (MVP) ✅
- **Mission Control Dashboard** — Webview UI showing phase status, live agent output, and token budgets.
- **Persistent State Machine** — Deterministic `.task-runbook.json` with crash recovery via write-ahead log.
- **Programmatic Sandboxing** — Ephemeral agents spawned via the Antigravity ADK with strict context injection.
- **Sequential Handoffs** — Automatic phase progression with success criteria evaluation.

### Pillar 2 — Intelligent Context ✅
- **AST Auto-Discovery** — Regex-based import/require/include crawling with cycle detection and configurable depth limits (`ASTFileResolver`).
- **Token Pruning** — 3-tier heuristic reducer: drop discovered files → strip function bodies → proportional truncation (`TokenPruner`).
- **DAG Execution** — Parallel agent dispatching via topological sort with `depends_on` dependencies and configurable `MAX_CONCURRENT_WORKERS` (`Scheduler`).

### Pillar 3 — Autonomous Resilience ✅
- **Pluggable Evaluators** — Exit code, regex match, workspace toolchain (`xcodebuild`, `make`), and test suite output parsing (`EvaluatorRegistry`).
- **Automated Version Control** — Snapshot commits after each phase, clean-room rollback on failure, stash/unstash for in-progress work (`GitManager`).
- **Self-Healing Retry Loops** — Configurable per-phase `max_retries` with exponential backoff and error-injected augmented prompts (`SelfHealingController`).

## Getting Started

### Prerequisites

- [Antigravity IDE](https://antigravity.dev) (VS Code fork) — v1.85+
- Node.js 18+
- Antigravity Agent Development Kit (ADK)

### Installation

```bash
# Clone the repository
git clone https://github.com/lehoa1806/Isolated-Agent.git
cd Isolated-Agent

# Install dependencies
npm install

# Compile TypeScript + Webview
npm run build

# Launch in Extension Development Host
# Press F5 in Antigravity IDE, or:
npm run watch  # in one terminal
# Then launch "Run Extension" from the debug panel
```

### Usage

1. Open the Command Palette (`Cmd+Shift+P`)
2. Run **Isolated-Agent: Open Mission Control**
3. Enter a high-level implementation goal or load an existing `.task-runbook.json`
4. Review and refine the generated phase breakdown
5. Press **Start** — the orchestrator handles the rest

## Project Structure

```
Isolated-Agent/
├── README.md
├── CONTRIBUTING.md
├── package.json
├── tsconfig.json
├── jest.config.js
├── esbuild.js                     # Extension bundler
├── esbuild-webview.js             # Webview bundler
├── docs/
│   ├── PRD.md                     # Product requirements
│   ├── ARCHITECTURE.md            # System architecture
│   ├── TDD.md                     # Technical design document
│   ├── IMPLEMENTATION_PLAN.md     # Build phases & status
│   ├── API_REFERENCE.md           # Module APIs, events, IPC
│   └── USER_GUIDE.md              # End-user reference
├── schemas/
│   └── runbook.schema.json        # AJV-validated JSON Schema
├── src/
│   ├── extension.ts               # activate/deactivate + event wiring
│   ├── types/
│   │   └── index.ts               # All TypeScript interfaces
│   ├── state/
│   │   └── StateManager.ts        # Runbook I/O, locking, WAL
│   ├── engine/
│   │   ├── OrchestratorEngine.ts  # 9-state deterministic FSM
│   │   ├── Scheduler.ts           # DAG scheduler (Pillar 2)
│   │   └── SelfHealing.ts         # Auto-retry controller (Pillar 3)
│   ├── adk/
│   │   ├── ADKController.ts       # Parallel worker pool
│   │   ├── AntigravityADKAdapter.ts # ADK adapter with IPC fallback
│   │   ├── OutputBuffer.ts        # 100ms batched stream flush
│   │   └── OutputBufferRegistry.ts # Multi-worker output management
│   ├── context/
│   │   ├── ContextScoper.ts       # File reading + tokenization
│   │   ├── FileResolver.ts        # AST auto-discovery (Pillar 2)
│   │   └── TokenPruner.ts         # Heuristic token pruning (Pillar 2)
│   ├── evaluators/
│   │   └── CompilerEvaluator.ts   # Pluggable success evaluators (Pillar 3)
│   ├── git/
│   │   └── GitManager.ts          # Snapshot commits & rollback (Pillar 3)
│   ├── logger/
│   │   └── TelemetryLogger.ts     # Append-only JSONL session logging
│   ├── planner/
│   │   └── PlannerAgent.ts        # Objective → runbook decomposition
│   └── webview/
│       ├── MissionControlPanel.ts # Webview lifecycle + IPC bridge
│       └── ipcValidator.ts        # Typed IPC message validation
├── webview-ui/
│   ├── main.js                    # Mission Control frontend logic
│   └── styles.css                 # Mission Control styles
└── .isolated_agent/               # All runtime state (gitignored)
    ├── ipc/<id>/                  # Session-scoped runbook + WAL + lock
    ├── logs/                      # JSONL session logs
    └── pid/                       # PID files for orphan recovery
```

## Documentation

| Document | Description |
|---|---|
| [User Guide](./docs/USER_GUIDE.md) | End-user reference — runbook authoring, evaluators, settings, execution lifecycle |
| [API Reference](./docs/API_REFERENCE.md) | Module APIs, events, FSM states, IPC message contracts |
| [Architecture](./docs/ARCHITECTURE.md) | System architecture — components, state machine, data flow |
| [TDD](./docs/TDD.md) | Technical Design Document — detailed implementation blueprint |
| [PRD](./docs/PRD.md) | Product Requirements Document — problem, solution, feature roadmap |
| [Implementation Plan](./docs/IMPLEMENTATION_PLAN.md) | Build phases, dependency graph, and completion status |
| [Contributing](./CONTRIBUTING.md) | Development setup, testing, code style, build instructions |
| [Runbook Schema](./schemas/runbook.schema.json) | JSON Schema for `.task-runbook.json` validation |

## Development

```bash
npm run compile          # One-time TypeScript build
npm run compile:webview  # One-time Webview build
npm run build            # Both
npm run watch            # TypeScript watch mode
npm run watch:webview    # Webview watch mode
npm run lint             # Type-check (no emit)
npm test                 # Run test suite (Jest)
npm run package          # Create .vsix extension package
```

## License

MIT
