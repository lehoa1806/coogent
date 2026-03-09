# User Guide

> Installation, configuration, and usage workflows for Coogent.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Installation](#installation)
3. [Configuration](#configuration)
4. [Usage Workflows](#usage-workflows)

---

## Prerequisites

- [Antigravity IDE](https://antigravity.dev) (VS Code ≥ 1.85)
- Node.js 18+
- Git

---

## Installation

### From Marketplace

Search for **"Coogent — Multi-Agent Engine"** in the Extensions panel and click Install.

### From VSIX

```
Cmd+Shift+P → "Extensions: Install from VSIX…" → select coogent-0.2.0.vsix
```

**CLI Installation**:
```bash
code --install-extension coogent-0.2.0.vsix
```

### From Source

```bash
git clone https://github.com/lehoa1806/coogent.git
cd coogent
npm install
npm run build
```

Press **F5** in the IDE to launch the Extension Development Host.

### Verify Installation

1. Reload the IDE (`Cmd+Shift+P` → `Developer: Reload Window`)
2. Check the Coogent icon in the Activity Bar (left sidebar)
3. `Cmd+Shift+P` → `Coogent: Open Mission Control`

---

## Configuration

All settings are under `coogent.*` in VS Code Settings (`Cmd+,`):

### Core Settings

| Setting | Type | Default | Description |
|---|---|---|---|
| `coogent.tokenLimit` | number | `100,000` | Maximum token count for context injection per phase. If exceeded, execution halts and you're asked to decompose the phase further. |
| `coogent.workerTimeoutMs` | number | `900,000` | Time (ms) before force-killing a worker agent. Default: 15 minutes. |
| `coogent.maxRetries` | number | `3` | Maximum automatic retries when a phase fails. |
| `coogent.maxConcurrentWorkers` | number | `4` | Maximum parallel workers (1–16). Higher values increase throughput but consume more memory. |
| `coogent.contextBudgetTokens` | number | `150,000` | Token budget for context pack assembly per phase (100K–2M). Controls the `ContextPackBuilder` budget. |

### Worker & Conversation Settings

| Setting | Type | Default | Description |
|---|---|---|---|
| `coogent.conversationMode` | enum | `isolated` | Worker conversation mode: `isolated` (fresh context per phase), `continuous` (reuse conversation), or `smart-switch` (auto-detect based on token usage). |
| `coogent.smartSwitchTokenThreshold` | number | `60,000` | Token count at which `smart-switch` mode starts a new conversation. |
| `coogent.maxWorkerOutputBytes` | number | `10,485,760` | Maximum stdout/stderr capture per worker in bytes (default: 10 MB). Prevents runaway output from consuming memory. |
| `coogent.customWorkers` | array | `[]` | Custom worker profiles for skill-based routing. Overrides built-in defaults by `id`. See [Custom Worker Profiles](#custom-worker-profiles). |
| `coogent.enableShadowMode` | boolean | `false` | Run the agent selection pipeline for observability without affecting dispatch. Useful for evaluating selection quality. |

### Logging Settings

| Setting | Type | Default | Description |
|---|---|---|---|
| `coogent.logDirectory` | string | `.coogent/logs` | Session log directory, relative to workspace root. |
| `coogent.logLevel` | enum | `info` | Minimum log verbosity. Options: `trace`, `debug`, `info`, `warn`, `error`, `off`. |
| `coogent.logMaxSizeMB` | number | `5` | Log file size limit before rotation (1–100 MB). |
| `coogent.logMaxBackups` | number | `2` | Number of rotated backup log files to keep (0–10). |

### Security & Feature Flags

| Setting | Type | Default | Description |
|---|---|---|---|
| `coogent.blockOnSecretsDetection` | boolean | `false` | Block phase execution when `SecretsGuard` detects secrets in context files. Default is warn-only (secrets are redacted but execution proceeds). |
| `coogent.enableEncryption` | boolean | `false` | Encrypt `.task-runbook.json` files at rest using a key stored in VS Code `SecretStorage`. |
| `coogent.requirePluginApproval` | boolean | `true` | Require user approval before activating MCP plugins. Disable to auto-load all plugins. |
| `coogent.enableSampling` | boolean | `false` | Enable MCP Sampling for optional AI-assisted review and summarization workflows. See [Architecture — MCP Sampling](ARCHITECTURE.md#mcp-sampling). |

---

## Custom Worker Profiles

Coogent ships with built-in worker profiles (generalist, frontend, backend, database, QA, DevOps, security, documentation). You can override or extend them with workspace-specific profiles.

### Creating `.coogent/workers.json`

Create a `.coogent/workers.json` file at your workspace root:

```json
{
  "workers": [
    {
      "id": "react_expert",
      "name": "React Expert",
      "description": "Specialist in React 18+, hooks, and component architecture",
      "system_prompt": "You are a React expert. Follow hooks best practices...",
      "tags": ["frontend", "react", "typescript"]
    },
    {
      "id": "django_api",
      "name": "Django API Builder",
      "description": "Backend specialist for Django REST Framework",
      "system_prompt": "You are a Django REST Framework expert...",
      "tags": ["backend", "python", "django", "api"]
    }
  ]
}
```

Workspace profiles **override** built-in profiles with the same `id` and are merged with any additional profiles defined in VS Code settings (`coogent.workerProfiles`).

### JSON Schema Autocomplete

When editing `.coogent/workers.json`, the IDE provides autocomplete and validation automatically via the bundled JSON Schema.

### Worker Studio Tab

View all loaded worker profiles in Mission Control:

1. Open Mission Control (`Cmd+Shift+P` → `Coogent: Open Mission Control`)
2. Click the **Workers** tab (next to **Phases**)
3. Browse all loaded profiles with their names, IDs, descriptions, and skill tags

### Configuration Priority (Cascading)

Worker profiles are loaded in priority order (highest wins):

1. **Workspace file** — `.coogent/workers.json` (project-specific overrides)
2. **VS Code settings** — `coogent.workerProfiles` (user-level customization)
3. **Built-in defaults** — `defaults.json` (shipped with the extension)

---

## Usage Workflows

### Workflow 1: Plan → Review → Execute

The primary workflow for most tasks.

1. **Open Mission Control**
   - `Cmd+Shift+P` → `Coogent: Open Mission Control`
   - Or click the Coogent rocket icon in the Activity Bar

2. **Enter your objective**
   - Type a description: "Refactor the auth module to use JWT tokens"
   - The PlannerAgent scans your workspace and generates a phased runbook

   ![Mission Control — Planning Phase](images/mission-control-planning.png)

3. **Review the plan**
   - Read the implementation plan in the Mission Control panel
   - Each phase shows: prompt, target files, success criteria, and dependencies
   - **Approve** to proceed, or **regenerate** with feedback

4. **Start execution**
   - Click "Start Execution" or `Cmd+Shift+P` → `Coogent: Start Execution`
   - Watch live output streaming for each phase

5. **Monitor progress**
   - Phase status updates in real-time (pending → running → completed/failed)
   - Parallel phases run concurrently when dependencies allow
   - Failed phases retry automatically (up to `maxRetries`)

   ![Mission Control — Execution Phase](images/mission-control-execution.png)

6. **Review results**
   - A consolidated report summarizes all decisions and changes
   - Use `Coogent: Open Diff Review` to inspect Git changes

### Workflow 2: Load an Existing Runbook

For resuming work or using a hand-crafted runbook.

1. `Cmd+Shift+P` → `Coogent: Load Runbook`
2. Select a `.task-runbook.json` file from the file picker
3. The engine validates the schema and transitions to `READY`
4. Click "Start Execution" to begin

### Workflow 3: Git Sandbox Execution

Coogent isolates changes on a dedicated Git branch.

1. **Pre-Flight Check** — Coogent checks for uncommitted changes
2. **Clean tree** → A `coogent/<task-slug>` sandbox branch is created automatically
3. **Dirty tree** → You'll see a prompt:
   - **"Continue on Current Branch"** — Bypass the sandbox
   - **"Cancel"** — Stop and commit/stash first
4. After execution, review changes via `Coogent: Open Diff Review` or create a PR from the sandbox branch

### Workflow 4: Session Management

Manage multiple orchestration sessions:

- `Coogent: New Orchestration Session` — Start a fresh session
- `Coogent: Load Session` — Resume a previous session
- `Coogent: Delete Session` — Remove a session from history
- `Coogent: Reset Session` — Clear in-memory state and return to `IDLE`

### Available Commands

| Command | Description |
|---|---|
| `Coogent: Open Mission Control` | Open the dashboard UI |
| `Coogent: New Orchestration Session` | Start a new session |
| `Coogent: Load Runbook` | Load a `.task-runbook.json` |
| `Coogent: Start Execution` | Begin phase execution |
| `Coogent: Pause Execution` | Pause the current run |
| `Coogent: Reset Session` | Reset engine to IDLE |
| `Coogent: Pre-Flight Git Check` | Check for uncommitted changes |
| `Coogent: Create Git Sandbox Branch` | Manually create a sandbox branch |
| `Coogent: Open Diff Review` | View changes since sandbox creation |
| `Coogent: Load Session` | Resume a previous session |
| `Coogent: Delete Session` | Remove a session |
| `Coogent: Resume Pending Phases` | Resume all pending phases after a pause |
| `Coogent: Dump State` | Dump current engine state to the output channel |
| `Search Sessions` | Search past sessions by keyword |
| `Refresh Sessions` | Reload the session history list |

---

## Multi-Root Workspaces

Coogent works seamlessly with VS Code [multi-root workspaces](https://code.visualstudio.com/docs/editor/multi-root-workspaces).

### What Works Automatically

- **All open workspace folders** are scanned for context files referenced in runbook phases.
- **State is stored in extension storage** (not inside your repositories), so no `.coogent/` directory is created in any workspace folder.
- **Git sandbox branches** are created with the **same branch name** across all repositories in the workspace.

### Sandbox Branching Across Multiple Repos

When you start execution in a multi-root workspace:

1. Coogent checks **all** repositories for uncommitted changes (pre-flight check).
2. If **any** repository is dirty, sandbox creation is aborted — you'll be asked to commit or stash first.
3. If all repos are clean, a `coogent/<task-slug>` branch is created in **every** repository.
4. After execution, you can review changes and create PRs from each sandbox branch independently.

### Ambiguous File Paths

If a runbook references a file that exists in multiple workspace roots (e.g., both `frontend/` and `backend/` have a `src/utils.ts`):

- The **first workspace folder** (primary root) takes priority.
- To be explicit, use the qualified format: `frontend:src/utils.ts` or `backend:src/utils.ts`.
