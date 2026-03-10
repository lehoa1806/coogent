# Coogent Documentation Site Map

> Quick index for navigating the Coogent documentation suite.

---

## Root

| Document | Description |
|---|---|
| [README.md](../README.md) | Project overview, problem/solution, quick start |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | Contribution process (stub → links to Developer Guide) |
| [CHANGELOG.md](../CHANGELOG.md) | Release history (Keep a Changelog format) |
| [LICENSE](../LICENSE) | MIT License |

---

## Schemas

| File | Description |
|---|---|
| [runbook.schema.json](../schemas/runbook.schema.json) | JSON Schema for `.task-runbook.json` |
| [worker.schema.json](../schemas/worker.schema.json) | JSON Schema for `.coogent/workers.json` |
| [secrets-allowlist.schema.json](../schemas/secrets-allowlist.schema.json) | JSON Schema for secrets allowlist configuration |

---

## docs/

| Document | Description |
|---|---|
| **[ARCHITECTURE.md](ARCHITECTURE.md)** | System architecture: FSM, DAG scheduling, MCP server, context pipeline, evaluators, persistence, decomposition patterns, plugin system, error codes, and tech stack |
| **[USER_GUIDE.md](USER_GUIDE.md)** | Installation, all 18 configuration settings, usage workflows, multi-root workspace support |
| **[DEVELOPER_GUIDE.md](DEVELOPER_GUIDE.md)** | Local development, full project structure, debugging, 79-file test suite reference, build commands, code conventions, and contribution guidelines |
| **[API_REFERENCE.md](API_REFERENCE.md)** | MCP URIs, MCP tools, IPC message contracts, data model schemas, and branded types |
| **[OPERATIONS.md](OPERATIONS.md)** | Packaging, deployment, migration runbook, troubleshooting guide, backup/recovery, and log locations |

---

## Examples

| File | Description |
|---|---|
| [examples/prompts/exhaustive_multi_phases_review.md](../examples/prompts/exhaustive_multi_phases_review.md) | Multi-phase review prompt example |
| [examples/prompts/repository_handoff_ai_continuation_briefing.md](../examples/prompts/repository_handoff_ai_continuation_briefing.md) | Repository handoff briefing prompt example |

---

## Reading Order

For **new users**: README → [USER_GUIDE.md](USER_GUIDE.md)

For **contributors**: README → [DEVELOPER_GUIDE.md](DEVELOPER_GUIDE.md) → [ARCHITECTURE.md](ARCHITECTURE.md)

For **integrators**: [API_REFERENCE.md](API_REFERENCE.md) → [ARCHITECTURE.md](ARCHITECTURE.md)

For **operators**: [USER_GUIDE.md](USER_GUIDE.md) → [OPERATIONS.md](OPERATIONS.md)
