// ─────────────────────────────────────────────────────────────────────────────
// src/adk/WorkerRegistry.ts — Cascading worker profile registry with
//                              skill-based Jaccard routing.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { WorkerProfile } from '../types/index.js';
import log from '../logger/log.js';
import builtinDefaults from '../workers/defaults.json';

// ═══════════════════════════════════════════════════════════════════════════════
//  WorkerRegistry
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Registry for worker profiles with cascading 3-level configuration
 * and Jaccard-similarity skill-based routing.
 *
 * **Priority order** (higher wins on `id` collision):
 * 1. Built-in defaults (`workers/defaults.json`)
 * 2. User settings (`coogent.customWorkers`)
 * 3. Workspace file (`<workspaceRoot>/.coogent/workers.json`)
 */
export class WorkerRegistry {
    private readonly workspaceRoot: string;
    private profiles = new Map<string, WorkerProfile>();
    private loadPromise: Promise<void> | undefined;

    constructor(workspaceRoot: string) {
        this.workspaceRoot = workspaceRoot;
    }

    // ─── Public API ──────────────────────────────────────────────────────────

    /**
     * Return a sorted, deduplicated array of all tags across all loaded profiles.
     */
    async getAvailableTags(): Promise<string[]> {
        await this.ensureLoaded();
        const tagSet = new Set<string>();
        for (const profile of this.profiles.values()) {
            for (const tag of profile.tags) {
                tagSet.add(tag);
            }
        }
        return [...tagSet].sort();
    }

    /**
     * Find the best-matching worker for a set of required skill tags
     * using Jaccard similarity: `|A ∩ B| / |A ∪ B|`.
     *
     * Falls back to the `generalist` profile when `requiredSkills` is empty
     * or no worker scores above 0.
     */
    async getBestWorker(requiredSkills: string[]): Promise<WorkerProfile> {
        await this.ensureLoaded();

        // Fast-path: no skills requested → generalist
        if (requiredSkills.length === 0) {
            return this.fallbackProfile();
        }

        const reqSet = new Set(requiredSkills);
        let bestProfile: WorkerProfile | undefined;
        let bestScore = 0;

        for (const worker of this.profiles.values()) {
            const workerTags = new Set(worker.tags);

            // Intersection
            let intersectionSize = 0;
            for (const tag of reqSet) {
                if (workerTags.has(tag)) {
                    intersectionSize++;
                }
            }

            // Union = |A| + |B| - |A ∩ B|
            const unionSize = reqSet.size + workerTags.size - intersectionSize;
            const score = unionSize > 0 ? intersectionSize / unionSize : 0;

            if (score > bestScore) {
                bestScore = score;
                bestProfile = worker;
            }
        }

        if (bestScore === 0 || !bestProfile) {
            return this.fallbackProfile();
        }

        log.info(
            `[WorkerRegistry] Matched "${bestProfile.id}" (score=${bestScore.toFixed(3)}) for skills: [${requiredSkills.join(', ')}]`,
        );

        return bestProfile;
    }

    /**
     * Return all loaded worker profiles.
     */
    async getWorkers(): Promise<WorkerProfile[]> {
        await this.ensureLoaded();
        return [...this.profiles.values()];
    }

    /**
     * Look up a worker profile by its unique `id`.
     */
    async getWorkerById(id: string): Promise<WorkerProfile | undefined> {
        await this.ensureLoaded();
        return this.profiles.get(id);
    }

    /**
     * Force reload profiles from all three cascading sources.
     * Useful when workspace configuration files change at runtime.
     */
    async reload(): Promise<void> {
        this.loadPromise = undefined;
        await this.load();
    }

    // ─── Internals ───────────────────────────────────────────────────────────

    /**
     * Lazy-initialisation guard. Ensures `load()` is called exactly once
     * (or until a successful reload).
     */
    private async ensureLoaded(): Promise<void> {
        if (!this.loadPromise) {
            this.loadPromise = this.load();
        }
        await this.loadPromise;
    }

    /**
     * Three-level cascading load.
     * Level 1 (built-in) → Level 2 (user settings) → Level 3 (workspace file).
     * Higher levels overwrite by `id`.
     */
    private async load(): Promise<void> {
        const merged = new Map<string, WorkerProfile>();

        // ── Level 1: Built-in defaults ───────────────────────────────────────
        const builtins = builtinDefaults as unknown as WorkerProfile[];
        for (const p of builtins) {
            merged.set(p.id, p);
        }
        log.info(`[WorkerRegistry] L1 built-in: loaded ${builtins.length} profiles`);

        // ── Level 2: User settings ───────────────────────────────────────────
        const userProfiles = vscode.workspace
            .getConfiguration('coogent')
            .get<WorkerProfile[]>('customWorkers', []);
        for (const p of userProfiles) {
            merged.set(p.id, p);
        }
        if (userProfiles.length > 0) {
            log.info(`[WorkerRegistry] L2 user settings: loaded ${userProfiles.length} profiles`);
        }

        // ── Level 3: Workspace file ──────────────────────────────────────────
        const wsPath = path.join(this.workspaceRoot, '.coogent', 'workers.json');
        try {
            const raw = await fs.promises.readFile(wsPath, 'utf-8');
            const wsProfiles = JSON.parse(raw) as WorkerProfile[];
            for (const p of wsProfiles) {
                merged.set(p.id, p);
            }
            log.info(`[WorkerRegistry] L3 workspace: loaded ${wsProfiles.length} profiles from ${wsPath}`);
        } catch {
            // File not found or parse error — silently skip
            log.debug(`[WorkerRegistry] L3 workspace: no workers.json at ${wsPath} (skipped)`);
        }

        this.profiles = merged;
        log.info(`[WorkerRegistry] Total profiles loaded: ${merged.size}`);
    }

    /**
     * Return the generalist profile, or the first available profile,
     * or a hard-coded emergency fallback if the registry is empty.
     */
    private fallbackProfile(): WorkerProfile {
        const generalist = this.profiles.get('generalist');
        if (generalist) {
            return generalist;
        }

        // Return the first loaded profile if no generalist exists
        const first = this.profiles.values().next();
        if (!first.done) {
            log.warn('[WorkerRegistry] No "generalist" profile found — using first available profile');
            return first.value;
        }

        // Emergency fallback — should never happen if defaults.json is valid
        log.error('[WorkerRegistry] No profiles loaded at all — returning emergency fallback');
        return {
            id: 'generalist',
            name: 'Emergency Fallback',
            description: 'No worker profiles were loaded.',
            system_prompt: 'You are a helpful software engineer.',
            tags: ['general'],
        };
    }
}
