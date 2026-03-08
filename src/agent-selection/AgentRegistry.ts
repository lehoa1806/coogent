// ─────────────────────────────────────────────────────────────────────────────
// src/agent-selection/AgentRegistry.ts — Unified agent profile registry with
//                                         cascading config & Jaccard routing.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs';
import type { AgentProfile, AgentType, TaskType } from './types.js';
import registryData from './registry.json';
import { getWorkersConfigPath } from '../constants/paths.js';
import log from '../logger/log.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  AgentRegistry
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Unified registry for agent profiles with cascading 3-level configuration
 * and Jaccard-similarity skill-based routing.
 *
 * **Priority order** (higher wins on `id` collision):
 * 1. Built-in defaults (`registry.json`)
 * 2. User settings (`coogent.customWorkers`)
 * 3. Workspace file (`<workspaceRoot>/.coogent/workers.json`)
 *
 * Also provides the original static lookup methods (`getByType`, `getCandidates`)
 * for the agent selection pipeline.
 */
export class AgentRegistry {
    private readonly workspaceRoot: string;
    private profiles = new Map<string, AgentProfile>();
    private loadPromise: Promise<void> | undefined;

    /**
     * Create a new AgentRegistry with cascading config support.
     * @param workspaceRoot Absolute path to the primary workspace folder.
     */
    constructor(workspaceRoot: string) {
        this.workspaceRoot = workspaceRoot;
    }

    // ─── Static Factory (for selection pipeline — no cascading config) ────

    /**
     * Load registry from the bundled registry.json data file only.
     * Returns a new AgentRegistry populated with the v1 agent profiles
     * WITHOUT cascading config (no workspace or user overrides).
     */
    static loadDefault(): AgentRegistry {
        const registry = new AgentRegistry('');
        const builtins = registryData as unknown as AgentProfile[];
        for (const p of builtins) {
            registry.profiles.set(p.id, p);
        }
        registry.loadPromise = Promise.resolve();
        return registry;
    }

    // ─── Public API (cascading config — async) ───────────────────────────

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
     * Find the best-matching agent for a set of required skill tags
     * using Jaccard similarity: `|A ∩ B| / |A ∪ B|`.
     *
     * Falls back to the `CodeEditor` profile (or first available) when
     * `requiredSkills` is empty or no agent scores above 0.
     */
    async getBestAgent(requiredSkills: string[]): Promise<AgentProfile> {
        await this.ensureLoaded();

        // Fast-path: no skills requested → fallback
        if (requiredSkills.length === 0) {
            return this.fallbackProfile();
        }

        const reqSet = new Set(requiredSkills);
        let bestProfile: AgentProfile | undefined;
        let bestScore = 0;

        for (const agent of this.profiles.values()) {
            const agentTags = new Set(agent.tags);

            // Intersection
            let intersectionSize = 0;
            for (const tag of reqSet) {
                if (agentTags.has(tag)) {
                    intersectionSize++;
                }
            }

            // Union = |A| + |B| - |A ∩ B|
            const unionSize = reqSet.size + agentTags.size - intersectionSize;
            const score = unionSize > 0 ? intersectionSize / unionSize : 0;

            if (score > bestScore) {
                bestScore = score;
                bestProfile = agent;
            }
        }

        if (bestScore === 0 || !bestProfile) {
            return this.fallbackProfile();
        }

        log.info(
            `[AgentRegistry] Matched "${bestProfile.id}" (score=${bestScore.toFixed(3)}) for skills: [${requiredSkills.join(', ')}]`,
        );

        return bestProfile;
    }

    /**
     * Return all loaded agent profiles.
     */
    async getAgents(): Promise<AgentProfile[]> {
        await this.ensureLoaded();
        return [...this.profiles.values()];
    }

    /**
     * Look up an agent profile by its unique `id`.
     */
    async getById(id: string): Promise<AgentProfile | undefined> {
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

    // ─── Public API (static lookup — for selection pipeline) ─────────────

    /**
     * Get all registered profiles (synchronous — for selection pipeline).
     * Must call `ensureLoaded()` or `loadDefault()` first.
     */
    listAll(): readonly AgentProfile[] {
        return [...this.profiles.values()];
    }

    /**
     * Get a single profile by agent type.
     * Returns the profile if found, or undefined if the type is not registered.
     */
    getByType(type: AgentType): AgentProfile | undefined {
        for (const p of this.profiles.values()) {
            if (p.agent_type === type) return p;
        }
        return undefined;
    }

    /**
     * Get candidate profiles that handle a given task type.
     * Returns all profiles whose `handles` array includes the specified task type.
     */
    getCandidates(taskType: TaskType): readonly AgentProfile[] {
        return [...this.profiles.values()].filter((p) =>
            p.handles.includes(taskType),
        );
    }

    /** Number of registered agent types. */
    get size(): number {
        return this.profiles.size;
    }

    // ─── Internals ───────────────────────────────────────────────────────

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
     * Level 1 (built-in registry.json) → Level 2 (user settings) → Level 3 (workspace file).
     * Higher levels overwrite by `id`.
     */
    private async load(): Promise<void> {
        const merged = new Map<string, AgentProfile>();

        // ── Level 1: Built-in defaults ───────────────────────────────────
        const builtins = registryData as unknown as AgentProfile[];
        for (const p of builtins) {
            merged.set(p.id, p);
        }
        log.info(`[AgentRegistry] L1 built-in: loaded ${builtins.length} profiles`);

        // ── Level 2: User settings ───────────────────────────────────────
        try {
            const vscode = await import('vscode');
            const userProfiles = vscode.workspace
                .getConfiguration('coogent')
                .get<AgentProfile[]>('customWorkers', []);
            for (const p of userProfiles) {
                merged.set(p.id, p);
            }
            if (userProfiles.length > 0) {
                log.info(`[AgentRegistry] L2 user settings: loaded ${userProfiles.length} profiles`);
            }
        } catch {
            // vscode module not available (e.g. in test environment) — skip L2
        }

        // ── Level 3: Workspace file ──────────────────────────────────────
        const wsPath = getWorkersConfigPath(this.workspaceRoot);
        try {
            const raw = await fs.promises.readFile(wsPath, 'utf-8');
            const wsProfiles = JSON.parse(raw) as AgentProfile[];
            for (const p of wsProfiles) {
                merged.set(p.id, p);
            }
            log.info(`[AgentRegistry] L3 workspace: loaded ${wsProfiles.length} profiles from ${wsPath}`);
        } catch {
            // File not found or parse error — silently skip
            log.debug(`[AgentRegistry] L3 workspace: no workers.json at ${wsPath} (skipped)`);
        }

        this.profiles = merged;
        log.info(`[AgentRegistry] Total profiles loaded: ${merged.size}`);
    }

    /**
     * Return the code_editor profile (generalist fallback), or the first
     * available profile, or a hard-coded emergency fallback if the registry is empty.
     */
    private fallbackProfile(): AgentProfile {
        const codeEditor = this.profiles.get('code_editor');
        if (codeEditor) {
            return codeEditor;
        }

        // Return the first loaded profile if no code_editor exists
        const first = this.profiles.values().next();
        if (!first.done) {
            log.warn('[AgentRegistry] No "code_editor" profile found — using first available profile');
            return first.value;
        }

        // Emergency fallback — should never happen if registry.json is valid
        log.error('[AgentRegistry] No profiles loaded at all — returning emergency fallback');
        return {
            id: 'code_editor',
            name: 'Emergency Fallback',
            agent_type: 'CodeEditor',
            system_prompt: 'You are a helpful software engineer.',
            tags: ['general'],
            handles: ['code_modification', 'localized_bugfix', 'small_integration'],
            reasoning_strengths: ['symbol_level_editing'],
            skills: ['repo editing'],
            preferred_context: ['target_file'],
            requires: [],
            tolerates_ambiguity: 'low',
            risk_tolerance: 'medium',
            best_for: ['known-file edits'],
            avoid_when: [],
            default_output: 'patch_with_notes',
            self_check_capabilities: [],
        } as AgentProfile;
    }
}
