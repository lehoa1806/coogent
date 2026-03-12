// ─────────────────────────────────────────────────────────────────────────────
// src/prompt-compiler/RequirementNormalizer.ts — Heuristic text → NormalizedTaskSpec
// ─────────────────────────────────────────────────────────────────────────────

import type {
    NormalizedTaskSpec,
    RepoFingerprint,
    TaskFamily,
    TaskScope,
    AutonomyPreferences,
} from './types.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Internal helpers
// ═══════════════════════════════════════════════════════════════════════════════

/** Keyword → artifact type mapping, evaluated top-down (first match wins). */
const ARTIFACT_TYPE_RULES: ReadonlyArray<{
    readonly keywords: readonly string[];
    readonly type: NormalizedTaskSpec['artifactType'];
}> = [
        { keywords: ['fix bug', 'bug fix', 'bugfix', 'patch', 'hotfix', 'resolve', 'implement', 'add', 'create', 'build', 'modify', 'update', 'refactor', 'rewrite', 'replace', 'remove', 'delete', 'fix the', 'fix a', 'fix this'], type: 'code_change' },
        { keywords: ['document', 'readme', 'docs', 'jsdoc', 'changelog', 'documentation', 'comment', 'docstring', 'annotation', 'api reference', 'guide', 'tutorial', 'wiki'], type: 'documentation' },
        { keywords: ['analyze', 'audit', 'review', 'inspect', 'investigate', 'scan', 'assess', 'evaluate', 'examine', 'report', 'profile', 'benchmark', 'find', 'check'], type: 'analysis' },
        { keywords: ['test', 'spec', 'coverage', 'e2e', 'unit test', 'testing', 'tests', 'test case', 'assertion', 'mock', 'stub', 'fixture'], type: 'test' },
        { keywords: ['configure', 'setup', 'config', 'env', 'ci', 'deploy', 'dockerfile', 'yaml', 'yml', 'json config', '.env', 'nginx', 'settings', 'pipeline', 'github actions', 'terraform', 'kubernetes', 'docker', 'helm'], type: 'configuration' },
    ];

/** Keyword → task family mapping, evaluated top-down (first match wins). */
const TASK_FAMILY_RULES: ReadonlyArray<{
    readonly keywords: readonly string[];
    readonly family: TaskFamily;
}> = [
        { keywords: ['fix bug', 'bug fix', 'bugfix', 'hotfix', 'crash', 'broken', 'not working', 'defect', 'fix the', 'fix a', 'fix this'], family: 'bug_fix' },
        { keywords: ['refactor', 'clean up', 'restructure', 'simplify', 'reorganize', 'clean', 'extract', 'decouple', 'modularize', 'rename'], family: 'refactor' },
        { keywords: ['migrate', 'migration', 'upgrade', 'convert', 'move from', 'transition', 'port', 'switch to'], family: 'migration' },
        { keywords: ['document', 'readme', 'docs', 'jsdoc', 'changelog', 'documentation', 'api reference', 'guide', 'tutorial', 'wiki', 'comment', 'docstring'], family: 'documentation_synthesis' },
        { keywords: ['analyze', 'audit', 'review', 'inspect', 'investigate', 'understand', 'evaluate', 'scan', 'profile', 'examine', 'architecture review', 'comprehensive review', 'multi-phase review', 'codebase review', 'repository review', 'review of the', 'review the repo', 'assess'], family: 'repo_analysis' },
        { keywords: ['just review', 'review the pr', 'review this pr', 'pr review', 'code review', 'peer review', 'look at', 'review my', 'review the changes'], family: 'review_only' },
        { keywords: ['test', 'spec', 'coverage', 'unit test', 'e2e', 'integration test', 'test case', 'tests', 'assertion', 'mock', 'test suite'], family: 'testing' },
        { keywords: ['ci', 'cd', 'pipeline', 'github actions', 'workflow', 'ci/cd', 'continuous integration', 'continuous delivery', 'deployment pipeline'], family: 'ci_cd' },
        { keywords: ['performance', 'benchmark', 'profiling', 'optimize', 'latency', 'throughput', 'speed', 'slow', 'bottleneck', 'speed up', 'memory', 'cpu'], family: 'performance' },
        { keywords: ['security', 'vulnerability', 'cve', 'hardening', 'penetration', 'owasp', 'exploit'], family: 'security_audit' },
        { keywords: ['dependency', 'dependencies', 'npm audit', 'outdated', 'lock file', 'upgrade packages', 'npm update', 'outdated packages', 'version bump'], family: 'dependency_management' },
        { keywords: ['infra', 'infrastructure', 'docker', 'kubernetes', 'terraform', 'deploy config', 'container', 'helm', 'orchestration', 'cloud', 'aws', 'gcp', 'azure'], family: 'devops_infra' },
    ];

/** Regex for file-path–like tokens (e.g., `src/foo/bar.ts`, `./lib/util.js`). */
const FILE_PATH_RE = /(?:\.\/|src\/|lib\/|test\/|tests\/|packages\/)\S+\.\w+/g;

/** Constraint-indicating signal words. */
const CONSTRAINT_SIGNALS = ['must', 'should not', 'preserve', 'do not', 'without', 'must not', 'never'];

/** Success-criteria signal words. */
const SUCCESS_SIGNALS = ['should work', 'tests pass', 'no errors', 'verify', 'ensure', 'confirm', 'expect'];

/** Decomposition-hint signal patterns. */
const DECOMPOSITION_SIGNALS = [
    /first\s*[,.]?\s*then/i,
    /step\s*\d/i,
    /^\s*\d+[.)]/m,
    /phase\s*\d/i,
];

/** Quoted strings or inline-code references (backtick or double-quote). */
const KNOWN_INPUT_RE = /`([^`]+)`|"([^"]+)"/g;

// ═══════════════════════════════════════════════════════════════════════════════
//  RequirementNormalizer
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Transforms a raw user prompt into a structured {@link NormalizedTaskSpec}.
 *
 * All analysis is performed synchronously via heuristic text matching —
 * no file I/O, no LLM calls. The output is a best-effort approximation
 * intended as input to the prompt compiler pipeline.
 *
 * @example
 * ```ts
 * const normalizer = new RequirementNormalizer();
 * const spec = normalizer.normalize('Fix the crash in src/engine/run.ts');
 * ```
 */
export class RequirementNormalizer {
    // ─────────────────────────────────────────────────────────────────────────
    //  Public API
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Normalize a raw user prompt into a structured task specification.
     *
     * @param rawPrompt       - The raw, unstructured user prompt string.
     * @param repoFingerprint - Optional repo fingerprint for risk-surface matching.
     * @returns A fully populated {@link NormalizedTaskSpec}.
     */
    normalize(rawPrompt: string, repoFingerprint?: RepoFingerprint): NormalizedTaskSpec {
        const trimmed = rawPrompt.trim();
        const lower = trimmed.toLowerCase();
        const sentences = this.splitSentences(trimmed);

        const entryPoints = this.extractFilePaths(trimmed);
        const scope = this.buildScope(entryPoints);
        const artifactType = this.detectArtifactType(lower);
        const taskType = this.classifyTaskFamily(lower);
        const constraints = this.extractBySentenceSignals(sentences, CONSTRAINT_SIGNALS);
        const successCriteria = this.extractBySentenceSignals(sentences, SUCCESS_SIGNALS);
        const knownInputs = this.extractKnownInputs(trimmed);
        const riskFactors = this.matchRiskSurfaces(lower, repoFingerprint);
        const decompositionHints = this.extractDecompositionHints(trimmed);
        const autonomy = this.defaultAutonomy();

        return {
            rawUserPrompt: trimmed,
            artifactType,
            taskType,
            scope,
            constraints,
            successCriteria,
            knownInputs,
            missingInformation: [],
            riskFactors,
            decompositionHints,
            autonomy,
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Private helpers
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Split text into sentences on `.`, `!`, `?`, or newline boundaries.
     * Returns trimmed, non-empty sentences.
     */
    private splitSentences(text: string): string[] {
        return text
            .split(/[.!?\n]+/)
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
    }

    /**
     * Extract file-path–like tokens from the prompt.
     */
    private extractFilePaths(text: string): string[] {
        const matches = text.match(FILE_PATH_RE);
        if (!matches) return [];
        // Deduplicate preserving order
        return [...new Set(matches)];
    }

    /**
     * Build a {@link TaskScope} from extracted entry-point paths.
     */
    private buildScope(entryPoints: string[]): TaskScope {
        const allowedFolders = this.deriveFolders(entryPoints);
        return {
            entryPoints,
            allowedFolders,
            forbiddenFolders: [],
        };
    }

    /**
     * Derive unique parent-folder prefixes from a list of file paths.
     */
    private deriveFolders(paths: string[]): string[] {
        const folders = new Set<string>();
        for (const p of paths) {
            const lastSlash = p.lastIndexOf('/');
            if (lastSlash > 0) {
                folders.add(p.slice(0, lastSlash));
            }
        }
        return [...folders];
    }

    /**
     * Detect the artifact type via scoring-based keyword matching.
     * Counts keyword hits per rule and returns the type with the highest score.
     * Ties are broken by declaration order. Falls back to `'code_change'`.
     */
    private detectArtifactType(lower: string): NormalizedTaskSpec['artifactType'] {
        let bestType: NormalizedTaskSpec['artifactType'] = 'code_change';
        let bestScore = 0;
        for (const rule of ARTIFACT_TYPE_RULES) {
            const score = rule.keywords.reduce((count, kw) => count + (lower.includes(kw) ? 1 : 0), 0);
            if (score > bestScore) {
                bestScore = score;
                bestType = rule.type;
            }
        }
        return bestType;
    }

    /**
     * Classify the task family via scoring-based keyword matching.
     * Counts keyword hits per rule and returns the family with the highest score.
     * Ties are broken by declaration order. Falls back to `'feature_implementation'`.
     */
    private classifyTaskFamily(lower: string): TaskFamily {
        let bestFamily: TaskFamily = 'feature_implementation';
        let bestScore = 0;
        for (const rule of TASK_FAMILY_RULES) {
            const score = rule.keywords.reduce((count, kw) => count + (lower.includes(kw) ? 1 : 0), 0);
            if (score > bestScore) {
                bestScore = score;
                bestFamily = rule.family;
            }
        }
        return bestFamily;
    }

    /**
     * Extract sentences that contain any of the given signal words.
     */
    private extractBySentenceSignals(sentences: string[], signals: string[]): string[] {
        return sentences.filter((s) => {
            const sl = s.toLowerCase();
            return signals.some((sig) => sl.includes(sig));
        });
    }

    /**
     * Extract quoted strings and backtick-delimited references as known inputs.
     */
    private extractKnownInputs(text: string): string[] {
        const results: string[] = [];
        let match: RegExpExecArray | null;
        // Reset regex state
        KNOWN_INPUT_RE.lastIndex = 0;
        while ((match = KNOWN_INPUT_RE.exec(text)) !== null) {
            const value = match[1] ?? match[2];
            if (value && !results.includes(value)) {
                results.push(value);
            }
        }
        return results;
    }

    /**
     * Check the prompt against the repo fingerprint's {@link RepoFingerprint.highRiskSurfaces}.
     * Returns surface names that appear in the prompt text.
     */
    private matchRiskSurfaces(lower: string, fingerprint?: RepoFingerprint): string[] {
        if (!fingerprint?.highRiskSurfaces?.length) return [];
        return fingerprint.highRiskSurfaces.filter((surface) =>
            lower.includes(surface.toLowerCase()),
        );
    }

    /**
     * Extract decomposition hints — phrases like "first…then", "step N",
     * or numbered list items.
     */
    private extractDecompositionHints(text: string): string[] {
        const hints: string[] = [];
        for (const re of DECOMPOSITION_SIGNALS) {
            if (re.test(text)) {
                const match = text.match(re);
                if (match) {
                    // Grab the surrounding line/sentence for context
                    const idx = text.indexOf(match[0]);
                    const lineStart = text.lastIndexOf('\n', idx) + 1;
                    const lineEnd = text.indexOf('\n', idx);
                    const line = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim();
                    if (line && !hints.includes(line)) {
                        hints.push(line);
                    }
                }
            }
        }
        return hints;
    }

    /**
     * Return default autonomy preferences.
     */
    private defaultAutonomy(): AutonomyPreferences {
        return {
            allowReview: true,
            allowSquad: false,
            allowReplan: true,
        };
    }
}
