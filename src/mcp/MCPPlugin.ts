// ─────────────────────────────────────────────────────────────────────────────
// src/mcp/MCPPlugin.ts — Plugin interface for extending MCP tools/resources
// ─────────────────────────────────────────────────────────────────────────────
// Sprint 5: Users can drop custom MCP tool/resource plugins into
// `.coogent/plugins/` to extend the server without modifying core code.

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { ArtifactDB } from './ArtifactDB.js';

/**
 * A plugin manifest file (`plugin.json`) placed in each plugin directory.
 */
export interface PluginManifest {
    /** Unique plugin identifier (e.g., "my-custom-tools"). */
    id: string;
    /** Human-readable plugin name. */
    name: string;
    /** Relative path to the main module (e.g., "index.js"). */
    main: string;
    /** Semver version string. */
    version?: string;
    /** Description for UI display. */
    description?: string;
}

/**
 * Context provided to plugins during registration.
 * Gives plugins access to the MCP Server and persistent store.
 */
export interface PluginContext {
    /** The underlying MCP Server instance for registering handlers. */
    server: Server;
    /** The persistent artifact database. */
    db: ArtifactDB;
    /** Absolute path to the workspace root. */
    workspaceRoot: string;
}

/**
 * Interface that all MCP plugins must implement.
 *
 * Plugins are loaded from `.coogent/plugins/<name>/` directories.
 * Each plugin directory must contain a `plugin.json` manifest and
 * a main module that exports an object implementing this interface.
 *
 * @example
 * ```typescript
 * // .coogent/plugins/my-tools/index.ts
 * import type { MCPPlugin, PluginContext } from 'coogent/mcp/MCPPlugin';
 *
 * const plugin: MCPPlugin = {
 *   activate(ctx) {
 *     // Register custom tools or resources on ctx.server
 *   },
 *   deactivate() {
 *     // Cleanup
 *   },
 * };
 * export default plugin;
 * ```
 */
export interface MCPPlugin {
    /**
     * Called once when the plugin is loaded.
     * Register custom tools and/or resources on the provided context.
     */
    activate(ctx: PluginContext): void | Promise<void>;

    /**
     * Called when the server is shutting down.
     * Release any resources held by the plugin.
     */
    deactivate?(): void | Promise<void>;
}
