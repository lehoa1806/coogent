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
| **[architecture.md](architecture.md)** | System architecture: FSM, DAG scheduling, MCP server, context pipeline, evaluators, persistence, multi-window concurrency, workspace identity & tenanting, decomposition patterns, plugin system, error codes, and tech stack |
| **[user-guide.md](user-guide.md)** | Installation, all 18 configuration settings, usage workflows, multi-root workspace support |
| **[developer-guide.md](developer-guide.md)** | Local development, full project structure, debugging, 113-file test suite reference, CI/CD pipeline, build commands, code conventions, and contribution guidelines |
| **[api-reference.md](api-reference.md)** | MCP URIs, MCP tools, IPC message contracts, data model schemas, and branded types |
| **[mcp-setup.md](mcp-setup.md)** | MCP setup guide: auto-configuration, manual fallback, and troubleshooting for external AI tool connectivity |
| **[operations.md](operations.md)** | Packaging, deployment, CI/CD pipeline, migration runbook, troubleshooting guide, backup/recovery, and log locations |
| **[context-management.md](context-management.md)** | Context management workflow: ETSL pattern, handoff extraction, state schemas, storage mechanism, and error recovery |

---

## docs/architecture/

| Document | Description |
|---|---|
| [storage-topology.md](architecture/storage-topology.md) | Physical layout of global and workspace-local storage |
| [tenant-model.md](architecture/tenant-model.md) | Workspace identity and tenant scoping rules |
| [persistence-boundaries.md](architecture/persistence-boundaries.md) | Subsystem ownership of data |
| [data-ownership-matrix.md](architecture/data-ownership-matrix.md) | Complete data class reference |
| [mcp-integration.md](architecture/mcp-integration.md) | MCP server architecture, transports, resources, tools, and plugin system |

---

## CI/CD

| File | Description |
|---|---|
| [ci.yml](../.github/workflows/ci.yml) | GitHub Actions CI pipeline (Node 18/20 matrix, lint → test → audit → package) |

---

## ADRs & PRDs (Hybrid Storage Design)

Design documents in `coogent_ hybrid_storage/` covering the hybrid global storage architecture:

| Document | Description |
|---|---|
| PRD-001 | Hybrid global storage foundation |
| PRD-002 | Storage topology and data ownership clarity |
| ADR-001 | Hybrid storage topology |
| ADR-002 | Workspace tenant identity |
| ADR-003 | Global ArtifactDB tenanting |
| ADR-004 | Global MCP registration and workspace context resolution |
| ADR-005 | Local operational state boundary |
| ADR-006 | Migration and compatibility strategy |

---

## Examples

| File | Description |
|---|---|
| [examples/prompts/exhaustive_multi_phases_review.md](../examples/prompts/exhaustive_multi_phases_review.md) | Multi-phase review prompt example |
| [examples/prompts/repository_handoff_ai_continuation_briefing.md](../examples/prompts/repository_handoff_ai_continuation_briefing.md) | Repository handoff briefing prompt example |

---

## Reading Order

For **new users**: README → [user-guide.md](user-guide.md)

For **contributors**: README → [developer-guide.md](developer-guide.md) → [architecture.md](architecture.md)

For **integrators**: [api-reference.md](api-reference.md) → [architecture.md](architecture.md)

For **operators**: [user-guide.md](user-guide.md) → [operations.md](operations.md)

