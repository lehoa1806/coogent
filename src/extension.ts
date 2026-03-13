// ─────────────────────────────────────────────────────────────────────────────
// src/extension.ts — Main entry point: thin orchestrator
// ─────────────────────────────────────────────────────────────────────────────
// P3 refactor: activate() is now a thin orchestrator that delegates to
// composable functions in activation.ts. All command registrations and event
// wiring are delegated to CommandRegistry, EngineWiring, and PlannerWiring.

import * as vscode from 'vscode';

import log, { disposeLog } from './logger/log.js';
import { ServiceContainer } from './ServiceContainer.js';
import { registerAllCommands, preFlightGitCheck } from './CommandRegistry.js';

import {
  initializeLogging,
  createServices,
  startMCPServer,
  registerSidebar,
  wireEventSystems,
  registerReactiveConfig,
  registerRunbookWatcher,
  cleanupOrphanWorkers,
} from './activation.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Shared Services
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Module-level service container — recreated on each `activate()` call and
 * fully released on `deactivate()`. This ensures a clean slate when VS Code
 * reloads the extension host.
 */
let svc: ServiceContainer | undefined;

// Re-export preFlightGitCheck for backward compatibility
export { preFlightGitCheck };

// ═══════════════════════════════════════════════════════════════════════════════
//  Extension Lifecycle
// ═══════════════════════════════════════════════════════════════════════════════

export function activate(context: vscode.ExtensionContext): void {
  // Step 1-3: Start log stream FIRST — captures everything from this point on
  initializeLogging();
  log.info('[Coogent] Extension activating...');

  // Create a fresh ServiceContainer on every activation
  svc = new ServiceContainer();
  svc.extensionPath = context.extensionPath;

  // Commands must always be available, even without a workspace
  registerAllCommands(context, svc);

  try {
    // Step 4-5: Resolve paths, read config, instantiate all services
    const result = createServices(context, svc);
    if (!result) return; // No workspace open

    const { config, primaryRoot } = result;

    // Step 10: Initialize MCP Server, Client Bridge, SessionHistory
    startMCPServer(svc, primaryRoot);

    // Steps 8-9: Register sidebar tree-data provider
    registerSidebar(context, svc);

    // Steps 6-7: Wire Engine + Planner event systems
    wireEventSystems(svc, config, primaryRoot);

    // Reactive configuration change listener
    registerReactiveConfig(context, svc);

    // File system watcher for external runbook edits
    registerRunbookWatcher(context, svc);

    // Orphan cleanup
    cleanupOrphanWorkers(svc);

    log.info('[Coogent] Extension activated.');

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`[Coogent] Activation failed: ${msg}`);
    log.error('[Coogent] Activation error:', err);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Extension Deactivation
// ═══════════════════════════════════════════════════════════════════════════════

export async function deactivate(): Promise<void> {
  log.info('[Coogent] Extension deactivating...');

  if (svc) {
    await Promise.allSettled([
      svc.engine?.getState() !== 'IDLE' ? svc.engine?.abort().catch(log.onError) : undefined,
      svc.adkController?.killAllWorkers().catch(log.onError),
      svc.plannerAgent?.abort().catch(log.onError),
      svc.mcpBridge?.disconnect().catch((err) =>
        log.warn('[Coogent] deactivate: mcpBridge.disconnect() threw:', err)
      ),
    ]);

    svc.outputRegistry?.dispose();

    try {
      svc.mcpServer?.dispose();
    } catch (err) {
      log.warn('[Coogent] deactivate: mcpServer.dispose() threw:', err);
    }

    svc.releaseAll();
    svc = undefined;
  }

  disposeLog();
}

