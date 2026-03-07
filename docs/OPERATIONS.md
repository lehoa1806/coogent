# Deployment, Operations & Runbooks

> Packaging, deployment, migration, troubleshooting, and log reference.

---

## Table of Contents

1. [Deployment Steps](#deployment-steps)
2. [Migration & Rollout](#migration--rollout)
3. [Troubleshooting](#troubleshooting)
4. [Log Locations](#log-locations)
5. [Debugging Tips](#debugging-tips)

---

## Deployment Steps

### Package the Extension

```bash
npm run prepackage             # Minified build (Extension Host + Webview)
npm run package                # Produces coogent-<version>.vsix
```

### Install the VSIX

```bash
# Via command palette:
Cmd+Shift+P → "Extensions: Install from VSIX…" → select .vsix

# Via CLI:
code --install-extension coogent-0.1.0.vsix
```

### Verify

1. Reload the IDE window (`Cmd+Shift+P` → `Developer: Reload Window`)
2. Check the Coogent icon in the Activity Bar
3. `Cmd+Shift+P` → `Coogent: Open Mission Control`
4. Verify the dashboard renders without errors

---

## Migration & Rollout

### Preparation

| Step | Command / Action | Pass Criteria |
|---|---|---|
| Type check | `npm run lint` | 0 errors |
| Test suite | `npm test` | 32 suites, 401 tests pass |
| Security audit | `npm audit --audit-level=high` | No high/critical vulnerabilities |
| CI pipeline | `npm run ci` | All above in sequence |
| Version bump | Update `version` in `package.json` | Semantic versioning |
| Package test | `npm run package` → install in clean IDE | Extension activates, UI loads |

### Execution

1. Create a release tag: `git tag v0.1.0 && git push --tags`
2. Distribute the `.vsix` file (or publish to marketplace)
3. Users install via VSIX or marketplace update

### Validation (Post-Deployment)

After installation in the target environment:

| Check | How | Expected |
|---|---|---|
| Extension activates | Open any workspace | Coogent icon in Activity Bar |
| Mission Control loads | Open Mission Control | Dashboard renders (not blank) |
| Planning works | Enter a test prompt | Plan generates and displays |
| Execution works | Approve plan, start | Phase output streams in real-time |
| Git sandbox | Execute with clean tree | `coogent/<slug>` branch created |
| Persistence | Restart IDE mid-execution | Session resumes from WAL |
| Logs | Check `.coogent/logs/` | JSONL entries present |

### Schema Compatibility

The runbook schema is validated by AJV on every load. When modifying the schema:

1. Add new fields as **optional** (backward-compatible)
2. Update the inlined schema constant in `StateManager.ts`
3. Update `schemas/runbook.schema.json` (reference copy)
4. Run the test suite — `StateManager` tests cover valid/invalid schemas

---

## Troubleshooting

### Activation & Environment

| Symptom | Cause | Resolution |
|---|---|---|
| `"Command 'coogent.openMissionControl' not found"` | Extension not activated | Reload window. Verify `out/extension.js` exists. Press F5 in dev mode. |
| `"No workspace folder open"` | Missing workspace | Open a folder, not just a file. Extension requires workspace root. |
| Extension loads but no sidebar icon | Activity bar hidden or view not registered | Check `package.json` → `viewsContainers` / `views` |

### UI / Mission Control

| Symptom | Cause | Resolution |
|---|---|---|
| Blank panel / "Loading..." forever | CSP blocking modulepreload | Ensure all `<link rel="modulepreload">` tags include `nonce` attribute. |
| Plan not scrollable | CSS overflow/flex issue | Parent containers need `min-height: 0; flex: 1; overflow-y: auto`. |
| UI doesn't refresh on reveal | Missing state sync | Extension Host must listen to `onDidChangeViewState` and broadcast `STATE_SNAPSHOT`. |
| Svelte components mount early | VS Code API not ready | Ensure `acquireVsCodeApi()` called exactly once in singleton store. |

### Persistence & State

| Symptom | Cause | Resolution |
|---|---|---|
| `"Runbook Not Found"` | Looking at workspace root | Runbooks in `.coogent/ipc/<id>/`. Use Mission Control to load. |
| `"ENOENT: schemas/runbook.schema.json"` | Schema not inlined | Schema must be a TypeScript constant in `StateManager.ts`, not a file read. |
| WAL file present after clean exit | Interrupted write | Extension auto-recovers on next activation. Delete `.wal.json` if stale. |
| Concurrent write corruption | Missing mutex | StateManager uses in-process async mutex — check lock file. |

### Workers & Execution

| Symptom | Cause | Resolution |
|---|---|---|
| Phase stuck in `running` | Worker process orphaned | Check ADKController PID map. Manually kill orphaned processes. |
| Worker produces no output | File-based IPC fallback | Check `.coogent/ipc/` directory permissions. Verify meta-prompt injection. |
| Worker timeout | Long-running task | Increase `coogent.workerTimeoutMs` in settings. |

### Git

| Symptom | Cause | Resolution |
|---|---|---|
| Sandbox branch not created | Dirty tree or Git extension not loaded | Run `Coogent: Pre-Flight Git Check`. Ensure VS Code Git extension active. |
| Multiple branches created | `branchCreated` flag lost | Flag is session-scoped — only one branch per session. Check for session resets. |

---

## Log Locations

| Log | Path | Format | Content |
|---|---|---|---|
| Engine transitions | `.coogent/logs/<run_id>/engine.jsonl` | JSONL | State changes, errors, system events |
| Phase output | `.coogent/logs/<run_id>/phase-<n>.jsonl` | JSONL | Prompts, agent output, token counts, exit codes |
| Extension Host | VS Code Output → "Coogent" | Text | General extension logging |
| Webview console | DevTools (see below) | Browser | UI errors, IPC messages |

### JSONL Format

Each log entry is a single-line JSON object:

```json
{"timestamp":"2026-03-03T03:47:05.123Z","level":"info","category":"state","message":"READY → EXECUTING_WORKER (START)","data":{"from":"READY","to":"EXECUTING_WORKER","event":"START"}}
```

### Accessing Webview Logs

1. Launch Extension Development Host (F5)
2. Open Mission Control
3. `Cmd+Shift+P` → **"Developer: Toggle Developer Tools"**
4. Check the Console tab

---

## Debugging Tips

1. **Enable verbose logging**: Set `coogent.logLevel` to `debug` or `trace` in settings
2. **Trace IPC flow**: Breakpoints in `MissionControlPanel.postMessage()` and `webview.onDidReceiveMessage`
3. **Inspect MCP state**: Logged on every mutation at `debug` level in JSONL files
4. **Check Git state**: Run `Coogent: Pre-Flight Git Check` from the command palette
5. **Force reset**: `Coogent: Reset Session` clears in-memory state and returns to `IDLE`
6. **Inspect file locks**: Check for `.coogent/ipc/<id>/.lock` — stale locks auto-expire but can be manually deleted
7. **Unicode in source**: If refactoring tools fail on emoji markers (`⏳`, `✅`), use line-range deletion or hex escapes
