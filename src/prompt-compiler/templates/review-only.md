## Task Family: Review Only

### Decomposition Strategy

Break the review into the following phases:

1. **Read** — Thoroughly read the target code, changeset, or documentation. Understand the intent, structure, and context before forming opinions.
2. **Evaluate** — Apply the review criteria: correctness, clarity, consistency, test coverage, security, and adherence to project conventions. Note specific issues with file paths and line numbers.
3. **Report Findings** — Produce a structured review report with categorized feedback (must-fix, should-fix, nit). Include inline code suggestions where applicable.

### Rules

- Review phases should NOT modify any code — they produce feedback only.
- Every feedback item must reference a specific file and location.
- Distinguish between blocking issues (must-fix) and suggestions (nice-to-have).
- If reviewing a PR or changeset, focus on the diff — do NOT review unchanged code unless it interacts with the changes.
- Include positive observations alongside issues — acknowledge good patterns.
