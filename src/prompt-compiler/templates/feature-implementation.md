## Task Family: Feature Implementation

### Decomposition Strategy

Break the feature into the following phases:

1. **Design** — Analyze the codebase, identify integration points, and document the approach in `context_summary`. If the feature touches multiple modules, list affected files explicitly.
2. **Implement** — Write the production code. Each implementation phase should focus on a single module or layer (e.g., types → service → API route → UI). Keep phases small and composable.
3. **Test** — Add unit tests and integration tests for the new code. Test phases should run after the code they test is created.
4. **Validate** — Run the full test suite, linter, and type checker to verify no regressions were introduced. Use concrete commands in `success_criteria`.

### Rules

- Every new file must have corresponding test coverage.
- If the feature adds a public API surface, include a phase to update documentation or API docs.
- Prefer creating types/interfaces before implementations that use them.
- If the feature spans multiple packages in a monorepo, create separate implementation phases per package, ordered by dependency direction (leaf packages first).
