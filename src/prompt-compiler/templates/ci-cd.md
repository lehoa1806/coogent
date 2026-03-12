## Task Family: CI/CD

### Decomposition Strategy

Break the CI/CD task into the following phases:

1. **Audit Current Pipeline** — Review the existing CI/CD configuration files (e.g., `.github/workflows/`, `.gitlab-ci.yml`, `Jenkinsfile`). Document the current stages, triggers, environment variables, and known pain points.
2. **Implement Changes** — Modify or create pipeline configuration files. Each change should be independently testable. If adding new stages, ensure they are idempotent and fail-fast.
3. **Validate Pipeline** — Run the pipeline (or simulate a dry-run where possible) to confirm the changes work end-to-end. Verify triggers, caching, artifact uploads, and notifications.

### Rules

- Pipeline configuration changes must be idempotent — running them twice should produce the same result.
- Never hard-code secrets or credentials in pipeline files. Use environment variables or secret stores.
- Keep pipeline stages as fast as possible. Use caching for dependencies and build artifacts.
- Fail fast — place lint and type-check stages before expensive build and test stages.
- Document any new environment variables, secrets, or infrastructure requirements in `context_summary`.
- If adding deployment stages, always include a manual approval gate for production environments.
