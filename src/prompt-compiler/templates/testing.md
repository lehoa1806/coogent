## Task Family: Testing

### Decomposition Strategy

Break the testing task into the following phases:

1. **Assess Coverage** — Identify existing test coverage gaps for the target code. List untested functions, branches, and edge cases. Capture raw observations without writing tests yet.
2. **Write Tests** — Create the test files. Group tests by module or feature. Each test should be focused, independent, and clearly named. Use the project's existing test framework and conventions.
3. **Validate** — Run the full test suite to confirm all new tests pass and no existing tests have regressed. Report coverage metrics if tooling supports it.

### Rules

- Use the project's established test framework (e.g., Jest, Vitest, Mocha) — do not introduce a new one unless explicitly requested.
- Follow existing naming conventions and directory structure for test files.
- Each test should test one behavior. Avoid multi-assertion monolith tests.
- Include edge cases: empty inputs, boundary values, error paths, and concurrent access when applicable.
- Mock external dependencies (network, file system, databases) — tests must be deterministic and fast.
- If adding integration or e2e tests, clearly separate them from unit tests and document how to run them independently.
