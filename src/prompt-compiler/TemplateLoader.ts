// ─────────────────────────────────────────────────────────────────────────────
// src/prompt-compiler/TemplateLoader.ts — Loads orchestration and task-family templates
// ─────────────────────────────────────────────────────────────────────────────

import type { TaskFamily } from './types.js';
import {
    ORCHESTRATION_SKELETON,
    FEATURE_IMPLEMENTATION,
    BUG_FIX,
    REFACTOR,
    MIGRATION,
    DOCUMENTATION_SYNTHESIS,
    REPO_ANALYSIS,
    REVIEW_ONLY,
} from './templates.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Template content mapping
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Maps each {@link TaskFamily} to its inlined template content.
 */
const FAMILY_TO_CONTENT: Record<TaskFamily, string> = {
    feature_implementation: FEATURE_IMPLEMENTATION,
    bug_fix: BUG_FIX,
    refactor: REFACTOR,
    migration: MIGRATION,
    documentation_synthesis: DOCUMENTATION_SYNTHESIS,
    repo_analysis: REPO_ANALYSIS,
    review_only: REVIEW_ONLY,
};

/** Default fallback family when a template is missing. */
const FALLBACK_FAMILY: TaskFamily = 'feature_implementation';

// ═══════════════════════════════════════════════════════════════════════════════
//  TemplateLoader
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Provides orchestration skeleton and task-family planning templates.
 *
 * Templates are inlined at build time by esbuild's `loader: { '.md': 'text' }`
 * option, so no filesystem access is required at runtime. This ensures the
 * templates are always available regardless of the extension's deployment path.
 *
 * If a requested task-family template is not found in the mapping, the loader
 * falls back to `feature_implementation` to ensure the compiler always has a
 * usable template.
 */
export class TemplateLoader {
    // ─────────────────────────────────────────────────────────────────────────
    //  Public API
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Load the fixed orchestration skeleton template.
     *
     * This template contains the core instruction set, JSON schema, DAG rules,
     * and worker contract rules that are common to every planning invocation.
     *
     * @returns The skeleton template content as a string.
     */
    loadSkeleton(): string {
        return ORCHESTRATION_SKELETON;
    }

    /**
     * Load the planning template for a given task family.
     *
     * If the template for the requested family is not available, this method
     * falls back to `feature_implementation`.
     *
     * @param family - The classified task family.
     * @returns The task-family template content as a string.
     */
    loadTemplate(family: TaskFamily): string {
        const content = FAMILY_TO_CONTENT[family];
        if (!content) {
            // Unknown family — use fallback
            return FAMILY_TO_CONTENT[FALLBACK_FAMILY];
        }
        return content;
    }
}
