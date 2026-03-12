// ─────────────────────────────────────────────────────────────────────────────
// src/CommandRegistry.ts — Barrel: delegates to domain command modules
// ─────────────────────────────────────────────────────────────────────────────
// R4 refactor: Split monolithic command registry into focused domain modules.
// This barrel preserves the public API (registerAllCommands, preFlightGitCheck).

import * as vscode from 'vscode';
import type { ServiceContainer } from './ServiceContainer.js';

import { registerSessionCommands } from './commands/sessionCommands.js';
import { registerExecutionCommands } from './commands/executionCommands.js';
import { registerGitCommands } from './commands/gitCommands.js';
import { registerDiagnosticCommands } from './commands/diagnosticCommands.js';

// Re-export preFlightGitCheck for backward compatibility (used by tests and EngineWiring)
export { preFlightGitCheck } from './commands/helpers.js';

/**
 * Register all Coogent VS Code commands on the ExtensionContext.
 * Delegates to focused domain modules.
 */
export function registerAllCommands(
    context: vscode.ExtensionContext,
    svc: ServiceContainer
): void {
    registerSessionCommands(context, svc);
    registerExecutionCommands(context, svc);
    registerGitCommands(context, svc);
    registerDiagnosticCommands(context, svc);
}
