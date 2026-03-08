// ─────────────────────────────────────────────────────────────────────────────
// src/prompt-compiler/TemplateLoader.ts — Loads orchestration and task-family templates
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'fs';
import * as path from 'path';
import type { TaskFamily } from './types.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Template file mapping
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Maps each {@link TaskFamily} to its corresponding template filename.
 */
const FAMILY_TO_FILE: Record<TaskFamily, string> = {
    feature_implementation: 'feature-implementation.md',
    bug_fix: 'bug-fix.md',
    refactor: 'refactor.md',
    migration: 'migration.md',
    documentation_synthesis: 'documentation-synthesis.md',
    repo_analysis: 'repo-analysis.md',
    review_only: 'review-only.md',
};

/** Filename of the fixed orchestration skeleton template. */
const SKELETON_FILE = 'orchestration-skeleton.md';

/** Default fallback family when a template file is missing. */
const FALLBACK_FAMILY: TaskFamily = 'feature_implementation';

// ═══════════════════════════════════════════════════════════════════════════════
//  TemplateLoader
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Loads orchestration skeleton and task-family planning templates from disk.
 *
 * Templates are stored as Markdown files in the `templates/` directory adjacent
 * to this module. The loader reads them synchronously at call time so template
 * content is always up to date with the files on disk.
 *
 * If a requested task-family template file is missing, the loader falls back to
 * `feature-implementation.md` to ensure the compiler always has a usable template.
 */
export class TemplateLoader {
    /** Resolved path to the templates directory. */
    private readonly templatesDir: string;

    /**
     * Create a TemplateLoader.
     * @param templatesDir - Optional override for the templates directory.
     *   Defaults to the `templates/` folder adjacent to this compiled module.
     */
    constructor(templatesDir?: string) {
        this.templatesDir = templatesDir ?? path.join(__dirname, 'templates');
    }

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
     * @throws If the skeleton file cannot be read.
     */
    loadSkeleton(): string {
        return this.readTemplate(SKELETON_FILE);
    }

    /**
     * Load the planning template for a given task family.
     *
     * If the template file for the requested family does not exist on disk,
     * this method falls back to `feature-implementation.md`.
     *
     * @param family - The classified task family.
     * @returns The task-family template content as a string.
     */
    loadTemplate(family: TaskFamily): string {
        const filename = FAMILY_TO_FILE[family];
        if (!filename) {
            // Unknown family — use fallback
            return this.readTemplate(FAMILY_TO_FILE[FALLBACK_FAMILY]);
        }

        const fullPath = path.join(this.templatesDir, filename);
        if (!fs.existsSync(fullPath)) {
            // Template file missing — fall back to feature-implementation
            return this.readTemplate(FAMILY_TO_FILE[FALLBACK_FAMILY]);
        }

        return this.readTemplate(filename);
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Internals
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Read a template file from the templates directory.
     * @param filename - The template filename (e.g., 'bug-fix.md').
     * @returns The file content as a UTF-8 string.
     */
    private readTemplate(filename: string): string {
        const fullPath = path.join(this.templatesDir, filename);
        return fs.readFileSync(fullPath, 'utf-8');
    }
}
