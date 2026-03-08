## Task Family: Documentation Synthesis

### Decomposition Strategy

Break the documentation task into the following phases:

1. **Evidence Gathering** — Read the relevant source files, existing docs, and test files to extract factual information. List all source files in `context_files`. Do NOT write documentation in this phase — only collect facts.
2. **Synthesis** — Write the documentation artifacts based on the gathered evidence. Use clear, precise language. Include code examples where appropriate.
3. **Consistency Check** — Verify that the new documentation is consistent with existing docs, code comments, and API signatures. Fix any discrepancies found.

### Rules

- Documentation must be grounded in actual code — never fabricate API signatures, parameter names, or behavior.
- Use the project's existing documentation style and format conventions.
- For API documentation, always include: purpose, parameters, return types, exceptions, and usage examples.
- If the documentation references code that could change, include file paths so future updates can trace dependencies.
- Keep documentation concise — prefer accurate brevity over exhaustive verbosity.
