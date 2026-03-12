## Task Family: DevOps & Infrastructure

### Decomposition Strategy

Break the infrastructure task into the following phases:

1. **Assess Current State** — Review existing infrastructure configuration (Dockerfiles, Terraform/Pulumi files, Kubernetes manifests, deployment scripts). Document the current architecture, resource requirements, and known gaps.
2. **Implement Changes** — Modify or create infrastructure-as-code files. Each change should be independently deployable and rollback-safe. If adding new services, define resource limits and health checks.
3. **Validate Locally** — Run local validation: `docker build`, `terraform plan`, `kubectl dry-run`, or equivalent. Verify syntax, configuration correctness, and resource resolution without deploying.
4. **Deploy & Verify** — If deployment is in scope, apply changes to a staging or dev environment first. Verify health checks, connectivity, and resource provisioning before promoting to production.

### Rules

- Infrastructure changes must be idempotent — applying them twice should produce no side-effects.
- Never hard-code environment-specific values (IPs, hostnames, credentials). Use variables, secrets, and config maps.
- Always define resource limits (CPU, memory) for containers and services.
- Include health checks and readiness probes for every service.
- Document rollback procedures in `context_summary` for every infrastructure change.
- If modifying shared infrastructure (networking, DNS, load balancers), document the blast radius explicitly.
