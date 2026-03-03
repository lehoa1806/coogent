# Product Requirements Document: "Clean Room" Multi-Agent Orchestrator

**Platform:** Google Antigravity IDE (VS Code Fork)  
**Core Technologies:** TypeScript, VS Code Webview API, Antigravity Agent Development Kit (ADK)  
**Primary Pattern:** Master-Worker Architecture  

---

## 1. Executive Summary

### The Problem: Context Collapse

Single-instance AI agents fail when handling dense, multi-layered codebases — such as bridging native C++ processing libraries with Swift UI components and CoreML models. As token limits fill with file history and irrelevant dependencies, the AI begins to hallucinate, forget initial constraints, or output truncated code.

### The Solution: Sandboxed Orchestration

The "Clean Room" extension shifts cognitive load from the LLM to local state management. It acts as a "Master" orchestrator that breaks complex implementation plans into strictly isolated, serialized micro-tasks. For each phase, it spawns an ephemeral, zero-context "Worker" agent, injects only the strictly necessary files, and terminates the agent upon completion.

---

## 2. System Architecture

The system relies on **absolute decoupling** of global state from the executing AI agents.

| Component | Role |
|---|---|
| **The Orchestrator (Master)** | The extension core. Maintains the global objective, parses `.task-runbook.json`, manages the execution sequence. **Never writes code itself.** |
| **The Workers (Phase Agents)** | Ephemeral Antigravity agent sessions. Spun up with zero historical context, given a specific micro-task and scoped file payload, terminated immediately after verification. |
| **The State (Runbook)** | A static JSON manifest tracking the exact prompt, required files, and completion status of every phase. |

---

## 3. User Journey

1. **Initiation:** The developer opens the "Mission Control" Webview and enters a high-level architectural goal.
2. **Decomposition:** The Orchestrator queries an initial planning agent to generate a multi-phase implementation strategy.
3. **Refinement:** The developer manually adjusts the breakdown in the UI, assigning specific file scopes and success criteria to each micro-task.
4. **Execution Loop:** The Orchestrator reads Phase 1, spawns a blank-slate agent window, and injects the scoped context.
5. **Verification:** The agent completes the task. The Orchestrator verifies the output (e.g., standard exit code 0) and marks Phase 1 as complete.
6. **Handoff:** The Orchestrator automatically spins up a fresh window for Phase 2, ensuring zero token bleed-over from Phase 1.

---

## 4. Feature Roadmap & Scope

### Pillar 1: Core Orchestration Engine (MVP)

- **Persistent State Management:** Generation and tracking of a local `.task-runbook.json` file to ensure workflow recovery across IDE reloads.
- **Mission Control Dashboard:** A custom Webview UI to render the active runbook, showing completed, running, and pending phases with global start/pause controls.
- **Programmatic Sandboxing:** Utilizing the ADK to programmatically spawn new agent panels, inject strictly defined file payloads, and terminate sessions.
- **Sequential Handoffs:** Background listeners that parse an agent's completion state and automatically trigger the subsequent phase.

### Pillar 2: Intelligent Context Management

- **AST Auto-Discovery:** Integration of static analysis (e.g., Tree-sitter) to automatically map out dependencies and populate the phase context payloads without manual developer input.
- **Token Pruning & Summarization:** Dynamic removal of unused files mid-execution, or the generation of dense, token-efficient summaries for massive files (like large C++ headers) before injection.
- **DAG Execution:** Transitioning from linear sequencing to a Directed Acyclic Graph.
- **Parallel Processing:** Allowing non-dependent tasks to be executed simultaneously by multiple isolated agents without Git locking conflicts.

### Pillar 3: Autonomous Resilience & QA

- **Native Toolchain Hooks:** Binding success criteria directly to local compilers. A phase is only marked successful if commands like `xcodebuild` or `make` return a 0 exit code.
- **Automated Version Control:** Triggering automated micro-commits after every successful phase, with a `git reset --hard` fallback if a subsequent agent breaks the build.
- **Self-Healing Loops:** Capturing compiler errors or test failures and autonomously feeding those logs into a fresh agent window to fix its own mistakes up to a defined retry limit.
- **Test-Driven Execution:** Enforcing a template where Phase A writes failing unit tests, and Phase B writes the implementation until Phase A's tests pass.

---

## 5. Technical Data Model

The system's single source of truth is the runbook schema:

| Field | Type | Description |
|---|---|---|
| `project_id` | `String` | Unique identifier for the execution run. |
| `status` | `String` | Global state (`idle`, `running`, `paused_error`, `completed`). |
| `current_phase` | `Integer` | Index of the active or next phase. |
| `phases` | `Array` | Collection of individual micro-task objects. |
| `phase.id` | `Integer` | Sequential or DAG node identifier. |
| `phase.status` | `String` | Phase state (`pending`, `running`, `completed`, `failed`). |
| `phase.prompt` | `String` | The explicit instruction injected into the new agent. |
| `phase.context_files` | `Array[String]` | Exact file paths to be read and injected. |
| `phase.success_criteria` | `String` | Condition to trigger the next phase (e.g., `exit_code:0`). |

### Reference Schema

```json
{
  "project_id": "string",
  "status": "idle | running | paused_error | completed",
  "current_phase": 0,
  "phases": [
    {
      "id": 0,
      "status": "pending | running | completed | failed",
      "prompt": "string",
      "context_files": ["array of file paths"],
      "success_criteria": "exit_code:0"
    }
  ]
}
```

### Future Schema Additions (Pillars 2 & 3)

To support Directed Acyclic Graph (DAG) execution and pluggable toolchain evaluations, the following fields will be introduced in subsequent pillars:

| Field | Type | Description |
|---|---|---|
| `phase.depends_on` | `Array[Integer]` | Defines the phase IDs that must successfully complete before this phase can begin. |
| `phase.evaluator` | `String` | Defines the validation engine to use for `success_criteria` (e.g., `exit_code`, `regex`, `xcodebuild`, `jest`). |

---

## 6. Non-Functional Requirements

| Requirement | Description |
|---|---|
| **Idempotency** | Re-running a failed phase must not corrupt the overall state. File modifications must overwrite cleanly. |
| **Token Thresholds** | The extension must calculate the token count of `context_files` prior to spawning an agent. If the payload exceeds the model's safe processing window, it must halt and request further phase decomposition. |
| **Telemetry & Auditing** | Since agent windows are destroyed upon completion, all chat histories, prompts, and raw outputs must be serialized to a local `.isolated_agent/logs` directory for developer review. |
