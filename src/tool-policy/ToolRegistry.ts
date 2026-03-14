// ─────────────────────────────────────────────────────────────────────────────
// src/tool-policy/ToolRegistry.ts — Canonical tool registry with alias resolution
// ─────────────────────────────────────────────────────────────────────────────

import { MCP_TOOLS } from '../mcp/types.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Constants
// ═══════════════════════════════════════════════════════════════════════════════

/** Namespace prefix for first-party Coogent tools. */
const COOGENT_PREFIX = 'coogent.';

// ═══════════════════════════════════════════════════════════════════════════════
//  ToolRegistry — canonical tool ID registry with alias resolution
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Maintains a bidirectional mapping between raw tool names (including aliases)
 * and their canonical IDs.
 *
 * Canonical IDs follow the format `<namespace>.<tool_name>`, e.g.
 * `coogent.submit_execution_plan`.
 *
 * The registry is seeded with all tools from `MCP_TOOLS` at construction time
 * and supports future registration of MCP and plugin tools via `register()`.
 */
export class ToolRegistry {
    /**
     * Maps any known alias (including the canonical ID itself) to the
     * canonical ID. Lookups are O(1).
     */
    private readonly aliasToCanonical = new Map<string, string>();

    /** Set of all canonical IDs for fast membership checks. */
    private readonly canonicalIds = new Set<string>();

    constructor() {
        this.seedBuiltinTools();
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Public API
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Resolve a raw tool name (or canonical ID) to its canonical form.
     *
     * @param rawToolId - The tool name as provided by the caller (e.g.
     *   `"submit_execution_plan"` or `"coogent.submit_execution_plan"`).
     * @returns The canonical ID, or `null` if the tool is unknown.
     */
    normalize(rawToolId: string): string | null {
        return this.aliasToCanonical.get(rawToolId) ?? null;
    }

    /**
     * Check whether a canonical ID is registered.
     *
     * @param canonicalId - A fully-qualified canonical tool ID.
     */
    isRegistered(canonicalId: string): boolean {
        return this.canonicalIds.has(canonicalId);
    }

    /**
     * Return all registered canonical tool IDs in insertion order.
     */
    getAllCanonicalIds(): string[] {
        return [...this.canonicalIds];
    }

    /**
     * Register a new canonical tool ID with optional aliases.
     *
     * @param canonicalId - The fully-qualified canonical ID (e.g. `"plugin.my_tool"`).
     * @param aliases     - Additional names that should resolve to `canonicalId`.
     * @throws {Error} If the `canonicalId` or any alias collides with an
     *   existing registration.
     */
    register(canonicalId: string, aliases: string[] = []): void {
        if (this.canonicalIds.has(canonicalId)) {
            throw new Error(
                `ToolRegistry: canonical ID "${canonicalId}" is already registered.`,
            );
        }

        // Validate aliases before mutating state (fail-fast).
        for (const alias of [canonicalId, ...aliases]) {
            const existing = this.aliasToCanonical.get(alias);
            if (existing !== undefined) {
                throw new Error(
                    `ToolRegistry: alias "${alias}" already maps to "${existing}".`,
                );
            }
        }

        this.canonicalIds.add(canonicalId);
        this.aliasToCanonical.set(canonicalId, canonicalId);
        for (const alias of aliases) {
            this.aliasToCanonical.set(alias, canonicalId);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Internals
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Seed the registry with the 7 built-in MCP tools from `MCP_TOOLS`.
     * Each tool gets a canonical ID of `coogent.<tool_name>` and the raw
     * tool name is registered as an alias.
     */
    private seedBuiltinTools(): void {
        for (const rawName of Object.values(MCP_TOOLS)) {
            const canonicalId = `${COOGENT_PREFIX}${rawName}`;
            this.canonicalIds.add(canonicalId);
            // Map both the canonical ID and the raw name to the canonical ID.
            this.aliasToCanonical.set(canonicalId, canonicalId);
            this.aliasToCanonical.set(rawName, canonicalId);
        }
    }
}
