// ─────────────────────────────────────────────────────────────────────────────
// src/prompt-compiler/TaskClassifier.ts — Keyword-based task family classifier
// ─────────────────────────────────────────────────────────────────────────────

import type { NormalizedTaskSpec, TaskFamily } from './types.js';

/**
 * Keyword sets used for scoring each task family.
 * Order matters for tie-breaking: earlier entries have higher priority.
 */
const FAMILY_KEYWORDS: readonly { readonly family: TaskFamily; readonly keywords: readonly string[] }[] = [
    {
        family: 'bug_fix',
        keywords: ['fix', 'bug', 'broken', 'crash', 'error', 'failing', 'regression', 'issue', 'not working'],
    },
    {
        family: 'refactor',
        keywords: ['refactor', 'clean up', 'restructure', 'reorganize', 'simplify', 'extract', 'decouple', 'modularize'],
    },
    {
        family: 'migration',
        keywords: ['migrate', 'upgrade', 'move from', 'convert', 'transition', 'port to', 'switch to'],
    },
    {
        family: 'feature_implementation',
        keywords: ['add', 'implement', 'create', 'build', 'new feature', 'integrate'],
    },
    {
        family: 'documentation_synthesis',
        keywords: ['document', 'readme', 'docs', 'wiki', 'api reference', 'guide', 'tutorial', 'jsdoc'],
    },
    {
        family: 'repo_analysis',
        keywords: ['analyze', 'audit', 'investigate', 'assess', 'review codebase', 'understand', 'map'],
    },
    {
        family: 'review_only',
        keywords: ['review', 'code review', 'check', 'inspect'],
    },
] as const;

/**
 * Classifies a {@link NormalizedTaskSpec} into a {@link TaskFamily} using
 * keyword-based heuristic scoring.
 *
 * Classification is **synchronous** and **deterministic**: the same input
 * always produces the same output with no side-effects.
 *
 * @example
 * ```ts
 * const classifier = new TaskClassifier();
 * const family = classifier.classify(taskSpec);
 * // family === 'bug_fix' | 'refactor' | 'migration' | ...
 * ```
 */
export class TaskClassifier {
    /**
     * Classify a normalized task specification into a task family.
     *
     * The classifier builds a composite text corpus from the task spec's
     * `objective`, `constraints`, `successCriteria`, `knownInputs`, and
     * `decompositionHints`. It then counts keyword matches for each family
     * and returns the highest-scoring one. Ties are broken by a fixed
     * priority order:
     *
     * `bug_fix > refactor > migration > feature_implementation >
     *  documentation_synthesis > repo_analysis > review_only`
     *
     * If no keywords match at all, the default fallback is
     * `'feature_implementation'`.
     *
     * @param taskSpec - The normalized task specification to classify.
     * @returns The classified {@link TaskFamily}.
     */
    classify(taskSpec: NormalizedTaskSpec): TaskFamily {
        const corpus = this.buildCorpus(taskSpec);
        const scores = this.scoreAllFamilies(corpus);

        // Return highest scoring family. FAMILY_KEYWORDS order encodes
        // tie-break priority, so the first family with the max score wins.
        let bestFamily: TaskFamily = 'feature_implementation';
        let bestScore = 0;

        for (const { family, score } of scores) {
            if (score > bestScore) {
                bestScore = score;
                bestFamily = family;
            }
        }

        // For review_only, only assign if no "action" keywords matched
        // in higher-priority families. If any other family scored > 0,
        // review_only should not win unless it strictly out-scores them.
        // (This is naturally handled by the priority ordering above.)

        return bestFamily;
    }

    // ── Private helpers ────────────────────────────────────────────────────

    /**
     * Build a single lowercase text corpus from all relevant task spec fields.
     */
    private buildCorpus(taskSpec: NormalizedTaskSpec): string {
        const parts: string[] = [
            taskSpec.objective,
            ...taskSpec.constraints,
            ...taskSpec.successCriteria,
            ...taskSpec.knownInputs,
            ...taskSpec.decompositionHints,
        ];
        return parts.join(' ').toLowerCase();
    }

    /**
     * Score every family by counting keyword occurrences in the corpus.
     * Returns an array preserving the priority order from {@link FAMILY_KEYWORDS}.
     */
    private scoreAllFamilies(corpus: string): { family: TaskFamily; score: number }[] {
        return FAMILY_KEYWORDS.map(({ family, keywords }) => ({
            family,
            score: this.countMatches(corpus, keywords),
        }));
    }

    /**
     * Count how many keywords from the set appear in the corpus.
     * Each keyword is counted once regardless of how many times it appears.
     */
    private countMatches(corpus: string, keywords: readonly string[]): number {
        let count = 0;
        for (const keyword of keywords) {
            if (corpus.includes(keyword)) {
                count++;
            }
        }
        return count;
    }
}
