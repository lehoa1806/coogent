// ─────────────────────────────────────────────────────────────────────────────
// src/ServiceContainer.ts — Typed container for all extension services
// ─────────────────────────────────────────────────────────────────────────────
// R1 refactor: Replaces 18 module-level `let` variables in extension.ts with
// a single, typed container that is passed to extracted wiring modules.

import type { StateManager } from './state/StateManager.js';
import type { Engine } from './engine/Engine.js';
import type { ADKController } from './adk/ADKController.js';
import type { ContextScoper } from './context/ContextScoper.js';
import type { TelemetryLogger } from './logger/TelemetryLogger.js';
import type { GitManager } from './git/GitManager.js';
import type { GitSandboxManager } from './git/GitSandboxManager.js';
import type { OutputBufferRegistry } from './adk/OutputBufferRegistry.js';
import type { PlannerAgent } from './planner/PlannerAgent.js';
import type { SessionManager } from './session/SessionManager.js';
import type { HandoffExtractor } from './context/HandoffExtractor.js';
import type { ConsolidationAgent } from './consolidation/ConsolidationAgent.js';
import type { CoogentMCPServer } from './mcp/CoogentMCPServer.js';
import type { MCPClientBridge } from './mcp/MCPClientBridge.js';
import type { SidebarMenuProvider } from './webview/SidebarMenuProvider.js';

/**
 * Centralised container holding all extension service instances.
 *
 * Replaces the 18 module-level `let` variables that previously lived in
 * `extension.ts`. Each field is mutable (`undefined` before init, cleared
 * on deactivation) so the existing lifecycle semantics are preserved.
 */
export class ServiceContainer {
    stateManager: StateManager | undefined;
    engine: Engine | undefined;
    adkController: ADKController | undefined;
    contextScoper: ContextScoper | undefined;
    logger: TelemetryLogger | undefined;
    gitManager: GitManager | undefined;
    gitSandbox: GitSandboxManager | undefined;
    outputRegistry: OutputBufferRegistry | undefined;
    plannerAgent: PlannerAgent | undefined;
    sessionManager: SessionManager | undefined;
    handoffExtractor: HandoffExtractor | undefined;
    consolidationAgent: ConsolidationAgent | undefined;
    currentSessionDir: string | undefined;
    mcpServer: CoogentMCPServer | undefined;
    mcpBridge: MCPClientBridge | undefined;
    sidebarMenu: SidebarMenuProvider | undefined;

    /** Accumulated worker stdout for handoff extraction (capped at 2 MB). */
    readonly workerOutputAccumulator = new Map<number, string>();

    /**
     * BUG-02 fix: Tracks which sessionDirNames have already created a sandbox branch.
     * Using a Set<string> (keyed by sessionDirName) instead of a plain boolean means
     * switching sessions naturally invalidates the guard without explicit reset code.
     */
    readonly sandboxBranchCreatedForSession = new Set<string>();

    /**
     * Release all references for GC.
     * Called during `deactivate()`.
     */
    releaseAll(): void {
        this.stateManager = undefined;
        this.engine = undefined;
        this.adkController = undefined;
        this.contextScoper = undefined;
        this.logger = undefined;
        this.gitManager = undefined;
        this.gitSandbox = undefined;
        this.outputRegistry = undefined;
        this.plannerAgent = undefined;
        this.sessionManager = undefined;
        this.handoffExtractor = undefined;
        this.consolidationAgent = undefined;
        this.currentSessionDir = undefined;
        this.mcpServer = undefined;
        this.mcpBridge = undefined;
        this.sidebarMenu = undefined;
        this.workerOutputAccumulator.clear();
        this.sandboxBranchCreatedForSession.clear();
    }
}
