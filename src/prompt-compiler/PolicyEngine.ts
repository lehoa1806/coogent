// ─────────────────────────────────────────────────────────────────────────────
// src/prompt-compiler/PolicyEngine.ts — Selects and composes dynamic policy modules
// ─────────────────────────────────────────────────────────────────────────────

import type { RepoFingerprint, NormalizedTaskSpec, PolicyModule } from './types.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  PolicyResult — Return type of PolicyEngine.evaluate()
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The result of evaluating all registered policy modules against a given
 * repo fingerprint and task specification.
 */
export interface PolicyResult {
    /** IDs of the policy modules that contributed prompt blocks. */
    readonly appliedPolicies: string[];
    /** The prompt blocks injected by the applied policies, in registration order. */
    readonly promptBlocks: string[];
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Built-in Policy Definitions
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Creates the set of built-in policy modules shipped with Coogent.
 * Each policy conditionally injects prompt blocks based on repo and task context.
 */
function createBuiltInPolicies(): PolicyModule[] {
    return [
        // ── a. multi-root-workspace ──────────────────────────────────────────
        {
            id: 'multi-root-workspace',
            description: 'Injects workspace-folder scoping rules for multi-root workspaces.',
            apply(fingerprint: RepoFingerprint, _taskSpec: NormalizedTaskSpec): string | null {
                if (fingerprint.workspaceType !== 'multi-root') {
                    return null;
                }
                return [
                    '## Policy: multi-root-workspace',
                    '- Each phase MUST declare `workspace_folder`',
                    '- Prefer folder-local phases unless dependencies require cross-folder work',
                ].join('\n');
            },
        },

        // ── b. api-compatibility-guard ───────────────────────────────────────
        {
            id: 'api-compatibility-guard',
            description: 'Guards against unplanned public API changes when constraints mention API compatibility.',
            apply(_fingerprint: RepoFingerprint, taskSpec: NormalizedTaskSpec): string | null {
                const triggerPatterns = ['api', 'public interface', 'backward compatible'];
                const hasApiConstraint = taskSpec.constraints.some(c => {
                    const lower = c.toLowerCase();
                    return triggerPatterns.some(p => lower.includes(p));
                });
                if (!hasApiConstraint) {
                    return null;
                }
                return [
                    '## Policy: api-compatibility-guard',
                    '- Do NOT plan public interface changes unless explicitly required',
                    '- Isolate compatibility-risk work into dedicated phases with review',
                ].join('\n');
            },
        },

        // ── c. minimal-file-scope (universal) ────────────────────────────────
        {
            id: 'minimal-file-scope',
            description: 'Always injects minimal-file-scope rules to prevent overly broad context.',
            apply(_fingerprint: RepoFingerprint, _taskSpec: NormalizedTaskSpec): string | null {
                return [
                    '## Policy: minimal-file-scope',
                    '- Each phase\'s context_files MUST list ONLY the files the worker needs',
                    '- Never pass entire directories — list specific files',
                ].join('\n');
            },
        },

        // ── d. dependency-aware-handoff ──────────────────────────────────────
        {
            id: 'dependency-aware-handoff',
            description: 'Injects handoff documentation rules when the task has multiple decomposition hints.',
            apply(_fingerprint: RepoFingerprint, taskSpec: NormalizedTaskSpec): string | null {
                if (taskSpec.decompositionHints.length <= 1) {
                    return null;
                }
                return [
                    '## Policy: dependency-aware-handoff',
                    '- When a phase creates files that later phases need, document the output file paths in the phase prompt',
                ].join('\n');
            },
        },

        // ── e. evaluator-preference ─────────────────────────────────────────
        {
            id: 'evaluator-preference',
            description: 'Prefers test_suite evaluator when the repo has a detected test stack.',
            apply(fingerprint: RepoFingerprint, _taskSpec: NormalizedTaskSpec): string | null {
                if (fingerprint.testStack.length === 0) {
                    return null;
                }
                return [
                    '## Policy: evaluator-preference',
                    '- Prefer `test_suite` evaluator for phases that modify code with existing tests',
                    `- Detected test runners: ${fingerprint.testStack.join(', ')}`,
                ].join('\n');
            },
        },

        // ── f. review-for-risky-surfaces ────────────────────────────────────
        {
            id: 'review-for-risky-surfaces',
            description: 'Adds review phases after modifying high-risk surfaces that overlap with task entry points.',
            apply(fingerprint: RepoFingerprint, taskSpec: NormalizedTaskSpec): string | null {
                if (fingerprint.highRiskSurfaces.length === 0) {
                    return null;
                }
                const entryPointSet = new Set(
                    taskSpec.scope.entryPoints.map(e => e.toLowerCase()),
                );
                const overlapping = fingerprint.highRiskSurfaces.filter(surface =>
                    entryPointSet.has(surface.toLowerCase()),
                );
                if (overlapping.length === 0) {
                    return null;
                }
                return [
                    '## Policy: review-for-risky-surfaces',
                    '- Add a review phase after modifying high-risk surfaces',
                    `- Detected surfaces: ${overlapping.join(', ')}`,
                ].join('\n');
            },
        },

        // ── g. no-squad-rule ────────────────────────────────────────────────
        {
            id: 'no-squad-rule',
            description: 'Prevents multi-agent squad patterns when squad mode is disallowed.',
            apply(_fingerprint: RepoFingerprint, taskSpec: NormalizedTaskSpec): string | null {
                if (taskSpec.autonomy.allowSquad !== false) {
                    return null;
                }
                return [
                    '## Policy: no-squad-rule',
                    '- Do NOT use squad or multi-agent patterns. Each phase is a single worker.',
                ].join('\n');
            },
        },

        // ── h. docs-update-reminder ─────────────────────────────────────────
        {
            id: 'docs-update-reminder',
            description: 'Reminds to add a documentation update phase when code changes touch a repo with known frameworks.',
            apply(fingerprint: RepoFingerprint, taskSpec: NormalizedTaskSpec): string | null {
                const codeArtifacts: Set<string> = new Set(['code_change', 'configuration', 'test']);
                if (!codeArtifacts.has(taskSpec.artifactType)) {
                    return null;
                }
                if (fingerprint.keyFrameworks.length === 0) {
                    return null;
                }
                return [
                    '## Policy: docs-update-reminder',
                    '- Consider adding a documentation update phase if public-facing code was changed',
                ].join('\n');
            },
        },

        // ── i. no-pipe-output ───────────────────────────────────────────────
        {
            id: 'no-pipe-output',
            description: 'Prevents piped command output to preserve reporter formatting and interactive features.',
            apply(_fingerprint: RepoFingerprint, _taskSpec: NormalizedTaskSpec): string | null {
                return [
                    '## Policy: no-pipe-output',
                    '- Do NOT pipe command output through another command (e.g., `| cat`, `| tee`, `| grep`)',
                    '- Run commands directly so built-in reporters and interactive features work correctly',
                ].join('\n');
            },
        },
    ];
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PolicyEngine — Evaluates policy modules against repo + task context
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Selects and composes dynamic policy modules to inject prompt blocks
 * into the compiled master prompt.
 *
 * The engine maintains a list of registered {@link PolicyModule} instances
 * and evaluates each one against the provided {@link RepoFingerprint} and
 * {@link NormalizedTaskSpec}. Only policies whose `apply()` returns a
 * non-null block are included in the resulting {@link PolicyResult}.
 */
export class PolicyEngine {
    /** The registered policy modules, evaluated in order. */
    readonly policies: PolicyModule[];

    constructor() {
        this.policies = createBuiltInPolicies();
    }

    /**
     * Evaluate all registered policies against the given repo fingerprint
     * and normalized task specification.
     *
     * @param fingerprint - The repo fingerprint describing the workspace.
     * @param taskSpec    - The normalized task specification.
     * @returns A {@link PolicyResult} with the IDs and blocks of applied policies.
     */
    evaluate(fingerprint: RepoFingerprint, taskSpec: NormalizedTaskSpec): PolicyResult {
        const appliedPolicies: string[] = [];
        const promptBlocks: string[] = [];

        for (const policy of this.policies) {
            const block = policy.apply(fingerprint, taskSpec);
            if (block !== null) {
                appliedPolicies.push(policy.id);
                promptBlocks.push(block);
            }
        }

        return { appliedPolicies, promptBlocks };
    }
}
