## Task Family: Repo Analysis

### Decomposition Strategy

Break the analysis into the following phases:

1. **Scan** — Read and catalog the relevant portions of the codebase. Identify files, patterns, dependencies, and structures that are relevant to the analysis question. Capture raw observations.
2. **Analyze** — Interpret the scanned data. Apply the analysis criteria (e.g., security audit, performance review, dependency hygiene). Identify findings, risks, and recommendations.
3. **Report** — Produce the analysis output in the requested format (markdown report, structured JSON, annotated file list). Include evidence and file references for every finding.

### Rules

- Analysis phases should NOT modify any code — they are read-only.
- Every finding must include at least one file path and line reference as evidence.
- Distinguish between critical, important, and informational findings.
- If the analysis scope is large, narrow down to the most impactful areas first and document what was excluded.
- Output should be actionable — findings without recommendations are incomplete.
