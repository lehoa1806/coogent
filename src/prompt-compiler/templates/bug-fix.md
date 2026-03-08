## Task Family: Bug Fix

### Decomposition Strategy

Break the bug fix into the following phases:

1. **Reproduce** — Write a failing test or describe the exact steps to reproduce the bug. The worker must confirm the bug exists before proceeding. Include error messages, stack traces, or logs in the prompt.
2. **Root-Cause** — Analyze the relevant code paths, identify the root cause, and document it in `context_summary`. Do NOT fix the code in this phase — only diagnose.
3. **Fix** — Apply the minimal change required to resolve the root cause. Keep the scope as narrow as possible. Avoid unrelated refactoring.
4. **Regression Test** — Add a test that specifically guards against this bug recurring. The test should fail without the fix and pass with it.

### Rules

- Keep fix scope minimal — fix the bug, nothing else.
- Do NOT refactor surrounding code in the fix phase unless the refactor is necessary for the fix.
- The regression test phase is MANDATORY. Every bug fix must leave behind a test.
- If the bug affects multiple call sites, list all affected files in `context_files` for the fix phase.
- If root cause analysis reveals a systemic issue beyond the original report, note it in `context_summary` but do NOT expand scope — that is a separate task.
