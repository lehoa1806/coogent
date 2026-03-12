## Task Family: Dependency Management

### Decomposition Strategy

Break the dependency management task into the following phases:

1. **Audit** — Run dependency audit tools (`npm audit`, `yarn audit`, or equivalent). List outdated packages, known vulnerabilities, and unused dependencies. Capture the current state before changes.
2. **Update** — Apply dependency changes incrementally. Update one logical group at a time (e.g., test dependencies, build tools, runtime dependencies). Regenerate lock files in the same phase as `package.json` changes.
3. **Validate** — Run the full build, test suite, and type checker after each update group. Verify that no regressions were introduced by the version changes.
4. **Cleanup** — Remove unused dependencies, prune unnecessary transitive packages, and verify the lock file is clean.

### Rules

- Always regenerate lock files in the same phase as manifest changes — never leave them out of sync.
- Update one logical group of dependencies per phase to isolate breakage.
- For major version bumps, check the changelog and migration guide before updating. Document breaking changes in `context_summary`.
- Run `npm audit` (or equivalent) after updates to confirm no new vulnerabilities were introduced.
- If a dependency update requires code changes (API migration), include those changes in the same phase.
- Never remove a dependency without verifying it is unused across the entire codebase.
