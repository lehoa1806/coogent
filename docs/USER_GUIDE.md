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
Cmd+Shift+P → "Extensions: Install from VSIX…" → select coogent-0.1.0.vsix
```

Or via CLI:
```bash
code --install-extension coogent-0.1.0.vsix
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

| Setting | Type | Default | Description |
|---|---|---|---|
| `coogent.tokenLimit` | number | `100,000` | Maximum token count for context injection per phase. If exceeded, execution halts and you're asked to decompose the phase further. |
| `coogent.workerTimeoutMs` | number | `900,000` | Time (ms) before force-killing a worker agent. Default: 15 minutes. |
| `coogent.maxRetries` | number | `3` | Maximum automatic retries when a phase fails. |
| `coogent.logDirectory` | string | `.coogent/logs` | Session log directory, relative to workspace root. |
| `coogent.logLevel` | enum | `info` | Minimum log verbosity. Options: `trace`, `debug`, `info`, `warn`, `error`, `off`. |
| `coogent.logMaxSizeMB` | number | `5` | Log file size limit before rotation (1–100 MB). |
| `coogent.logMaxBackups` | number | `2` | Number of rotated backup files to keep (0–10). |

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
