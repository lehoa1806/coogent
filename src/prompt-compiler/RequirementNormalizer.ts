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
        { keywords: ['fix', 'bug', 'patch', 'hotfix', 'resolve', 'crash'], type: 'code_change' },
        { keywords: ['document', 'readme', 'docs', 'jsdoc', 'changelog'], type: 'documentation' },
        { keywords: ['analyze', 'audit', 'review', 'inspect', 'investigate'], type: 'analysis' },
        { keywords: ['test', 'spec', 'coverage', 'e2e', 'unit test'], type: 'test' },
        { keywords: ['configure', 'setup', 'config', 'env', 'ci', 'deploy'], type: 'configuration' },
    ];

/** Keyword → task family mapping, evaluated top-down (first match wins). */
const TASK_FAMILY_RULES: ReadonlyArray<{
    readonly keywords: readonly string[];
    readonly family: TaskFamily;
}> = [
        { keywords: ['fix', 'bug', 'patch', 'hotfix', 'crash', 'error'], family: 'bug_fix' },
        { keywords: ['refactor', 'clean up', 'restructure', 'simplify'], family: 'refactor' },
        { keywords: ['migrate', 'migration', 'upgrade', 'convert'], family: 'migration' },
        { keywords: ['document', 'readme', 'docs', 'jsdoc', 'changelog'], family: 'documentation_synthesis' },
        { keywords: ['analyze', 'audit', 'review', 'inspect', 'investigate'], family: 'repo_analysis' },
        { keywords: ['review only', 'code review', 'just review'], family: 'review_only' },
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
            objective: trimmed,
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
     * Detect the artifact type via keyword matching against {@link ARTIFACT_TYPE_RULES}.
     * Falls back to `'code_change'` if no rule matches.
     */
    private detectArtifactType(lower: string): NormalizedTaskSpec['artifactType'] {
        for (const rule of ARTIFACT_TYPE_RULES) {
            if (rule.keywords.some((kw) => lower.includes(kw))) {
                return rule.type;
            }
        }
        return 'code_change';
    }

    /**
     * Classify the task family via keyword matching against {@link TASK_FAMILY_RULES}.
     * Falls back to `'feature_implementation'` if no rule matches.
     */
    private classifyTaskFamily(lower: string): TaskFamily {
        for (const rule of TASK_FAMILY_RULES) {
            if (rule.keywords.some((kw) => lower.includes(kw))) {
                return rule.family;
            }
        }
        return 'feature_implementation';
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
