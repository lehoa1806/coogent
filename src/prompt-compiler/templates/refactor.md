## Task Family: Refactor

### Decomposition Strategy

Break the refactoring into the following phases:

1. **Analyze Boundaries** — Identify the public interfaces and contracts of the code being refactored. Document all call sites, consumers, and integration points. This phase produces no code changes — only analysis.
2. **Refactor** — Apply the structural changes. Each refactor phase should change internal implementation while preserving external contracts. If the refactoring spans multiple modules, create a separate phase for each module.
3. **Verify Contracts** — Run the existing test suite to confirm no behavioral regressions. Also verify that public API surfaces (exports, types, signatures) are unchanged unless intentionally modified.

### Rules

- Preserve all existing interfaces unless the user explicitly requests breaking changes.
- Run existing tests after EVERY refactor phase, not just at the end.
- If a refactoring introduces new abstractions, ensure the old API surface is maintained via adapters or re-exports until fully migrated.
- Avoid mixing refactoring with feature additions — keep them in separate tasks.
- If the refactoring changes import paths, include a phase to update all consumers.
