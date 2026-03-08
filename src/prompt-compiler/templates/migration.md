## Task Family: Migration

### Decomposition Strategy

Break the migration into the following phases:

1. **Compatibility Analysis** — Identify breaking changes between the old and new target. Document the migration surface: APIs, configuration formats, dependency versions, data schemas. List incompatibilities explicitly.
2. **Prepare** — Create compatibility shims, adapter layers, or codemods needed for the transition. This phase should not change runtime behavior — only add scaffolding.
3. **Migrate** — Apply the migration changes. If the migration is large, break it into incremental steps that each leave the project in a buildable/testable state.
4. **Validate** — Run the full build, test suite, and any migration-specific checks. Verify that the old behavior is preserved under the new system.
5. **Cleanup** — Remove old compatibility shims, deprecated code paths, and migration scaffolding once validation passes.

### Rules

- Every intermediate phase must leave the project in a compilable and testable state. Never break the build mid-migration.
- Document rollback steps in `context_summary` for each migration phase. If a phase fails, the system should know how to revert.
- For data migrations, always include a backup or snapshot step before modifying data.
- If the migration involves dependency version bumps, lock files must be updated in the same phase as `package.json` changes.
- Prefer incremental migration over big-bang rewrites. Strangler-fig pattern is preferred when applicable.
