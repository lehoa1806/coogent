// ─────────────────────────────────────────────────────────────────────────────
// src/mcp/PluginLoader.ts — Discovery and lifecycle for MCP plugins
// ─────────────────────────────────────────────────────────────────────────────
// Sprint 5: Scans `.coogent/plugins/` for plugin directories, validates
// manifests, and manages the activate/deactivate lifecycle.
// S1-1 (SEC-5): User approval flow before plugin activation.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { MCPPlugin, PluginManifest, PluginContext } from './MCPPlugin.js';
import { getPluginsDir, PLUGIN_MANIFEST_FILE } from '../constants/paths.js';
import log from '../logger/log.js';

/**
 * Represents a loaded and activated plugin with its metadata.
 */
export interface LoadedPlugin {
    manifest: PluginManifest;
    instance: MCPPlugin;
    pluginDir: string;
}

/**
 * Discovers, loads, and manages MCP plugins from `.coogent/plugins/`.
 *
 * Plugin directory structure:
 * ```
 * .coogent/plugins/
 *   my-plugin/
 *     plugin.json    ← manifest (id, name, main)
 *     index.js       ← main module (exports MCPPlugin)
 * ```
 *
 * Error isolation: A failing plugin does NOT crash the server.
 * Each plugin is loaded in a try/catch and failures are logged.
 */
export class PluginLoader {
    private readonly pluginsDir: string;
    private readonly loadedPlugins: LoadedPlugin[] = [];

    /**
     * @param workspaceRoot Absolute path to the workspace root.
     */
    constructor(workspaceRoot: string) {
        this.pluginsDir = getPluginsDir(workspaceRoot);
    }

    /**
     * Discover and activate all plugins in the plugins directory.
     * Non-existent directory is silently ignored (no plugins = no-op).
     *
     * @param ctx Plugin context providing Server, DB, and workspace access.
     * @returns Array of successfully loaded plugins.
     */
    async loadAll(ctx: PluginContext): Promise<LoadedPlugin[]> {
        // Check if plugins directory exists
        try {
            await fs.access(this.pluginsDir);
        } catch {
            log.info('[PluginLoader] No plugins directory found — skipping.');
            return [];
        }

        // Enumerate subdirectories
        const entries = await fs.readdir(this.pluginsDir, { withFileTypes: true });
        const directories = entries.filter(e => e.isDirectory());

        if (directories.length === 0) {
            log.info('[PluginLoader] Plugins directory is empty.');
            return [];
        }

        log.info(`[PluginLoader] Found ${directories.length} plugin candidate(s).`);

        for (const dir of directories) {
            const pluginDir = path.join(this.pluginsDir, dir.name);
            try {
                const plugin = await this.loadPlugin(pluginDir, ctx);
                if (plugin) {
                    // S1-1 (SEC-5): Require user approval before activation
                    const approved = await this.requestApproval(plugin.manifest);
                    if (!approved) {
                        log.info(`[PluginLoader] User declined plugin: ${plugin.manifest.id}`);
                        continue;
                    }
                    await plugin.instance.activate(ctx);
                    log.info(`[PluginLoader] Activated plugin: ${plugin.manifest.id} (${plugin.manifest.name})`);
                    this.loadedPlugins.push(plugin);
                }
            } catch (err) {
                log.warn(
                    `[PluginLoader] Failed to load plugin "${dir.name}":`,
                    (err as Error).message
                );
                // Continue loading other plugins — error isolation
            }
        }

        log.info(
            `[PluginLoader] ${this.loadedPlugins.length}/${directories.length} plugins activated.`
        );
        return [...this.loadedPlugins];
    }

    /**
     * Deactivate all loaded plugins. Call on server shutdown.
     */
    async disposeAll(): Promise<void> {
        for (const { manifest, instance } of this.loadedPlugins) {
            try {
                await instance.deactivate?.();
                log.info(`[PluginLoader] Deactivated plugin: ${manifest.id}`);
            } catch (err) {
                log.warn(
                    `[PluginLoader] Error deactivating plugin "${manifest.id}":`,
                    (err as Error).message
                );
            }
        }
        this.loadedPlugins.length = 0;
    }

    /**
     * Get all currently loaded plugins.
     */
    getLoadedPlugins(): readonly LoadedPlugin[] {
        return this.loadedPlugins;
    }

    // ── Internal ─────────────────────────────────────────────────────────

    /**
     * S1-1 (SEC-5): Request user approval before activating a plugin.
     * Gated behind `coogent.requirePluginApproval` (default: true).
     * Returns true if approval is not required or user confirms.
     */
    private async requestApproval(manifest: PluginManifest): Promise<boolean> {
        const config = vscode.workspace.getConfiguration('coogent');
        const requireApproval = config.get<boolean>('requirePluginApproval', true);

        if (!requireApproval) {
            return true;
        }

        const detail = [
            `Plugin: ${manifest.name} (${manifest.id})`,
            manifest.version ? `Version: ${manifest.version}` : '',
            manifest.description ?? '',
            '',
            '⚠ Plugins execute arbitrary code with access to your workspace.',
        ].filter(Boolean).join('\n');

        const choice = await vscode.window.showWarningMessage(
            `Coogent: Activate plugin "${manifest.name}"?`,
            { modal: true, detail },
            'Allow',
            'Deny',
        );

        return choice === 'Allow';
    }

    /**
     * Load a single plugin from a directory.
     * S1-1 (SEC-5): Activation is deferred — caller handles approval + activate.
     */
    private async loadPlugin(
        pluginDir: string,
        _ctx: PluginContext
    ): Promise<LoadedPlugin | null> {
        // 1. Read and validate manifest
        const manifestPath = path.join(pluginDir, PLUGIN_MANIFEST_FILE);
        let manifestRaw: string;
        try {
            manifestRaw = await fs.readFile(manifestPath, 'utf-8');
        } catch {
            log.warn(`[PluginLoader] No plugin.json found in ${pluginDir} — skipping.`);
            return null;
        }

        let manifest: PluginManifest;
        try {
            manifest = JSON.parse(manifestRaw) as PluginManifest;
        } catch {
            log.warn(`[PluginLoader] Invalid JSON in ${manifestPath} — skipping.`);
            return null;
        }

        if (!manifest.id || !manifest.name || !manifest.main) {
            log.warn(
                `[PluginLoader] Manifest missing required fields (id, name, main) in ${manifestPath} — skipping.`
            );
            return null;
        }

        // 2. Check for duplicate IDs
        if (this.loadedPlugins.some(p => p.manifest.id === manifest.id)) {
            log.warn(`[PluginLoader] Duplicate plugin ID "${manifest.id}" — skipping.`);
            return null;
        }

        // 3. Load the main module
        const mainPath = path.resolve(pluginDir, manifest.main);
        try {
            await fs.access(mainPath);
        } catch {
            log.warn(`[PluginLoader] Main module not found: ${mainPath} — skipping.`);
            return null;
        }

        // Dynamic import — the main module should export an MCPPlugin
        const mod = await import(mainPath);
        const instance: MCPPlugin = mod.default ?? mod;

        if (typeof instance.activate !== 'function') {
            log.warn(
                `[PluginLoader] Module ${mainPath} does not export an activate() function — skipping.`
            );
            return null;
        }

        // S1-1: Return without activating — caller handles approval + activate
        return { manifest, instance, pluginDir };
    }
}
