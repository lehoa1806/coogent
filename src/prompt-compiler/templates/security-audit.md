## Task Family: Security Audit

### Decomposition Strategy

Break the security audit into the following phases:

1. **Surface Enumeration** — Identify the attack surface: public endpoints, authentication flows, data ingestion points, dependency tree, secrets management, and privilege boundaries. Catalog findings without remediation.
2. **Vulnerability Analysis** — Evaluate each surface against common vulnerability classes (OWASP Top 10, CWE). Run available static analysis and dependency audit tools. Classify findings by severity (critical, high, medium, low).
3. **Remediation Plan** — For each finding, propose a concrete fix with file paths and code references. Prioritize by severity and exploitability. If a fix requires architectural changes, document the trade-offs.
4. **Verify Fixes** — If remediation is in scope, apply fixes and re-run the security checks to confirm vulnerabilities are resolved without introducing new ones.

### Rules

- Security audit phases should NOT modify any code unless explicitly instructed to remediate — they produce findings only.
- Every finding must include: severity, affected file(s), description, evidence, and recommended fix.
- Do not disclose or log actual secrets, tokens, or credentials found during the audit — reference them by location only.
- Run `npm audit` (or equivalent) and include the output in findings when dependency vulnerabilities are in scope.
- Distinguish between confirmed vulnerabilities and potential risks that need further investigation.
- Follow responsible disclosure principles — findings should be reported to the appropriate stakeholders.
