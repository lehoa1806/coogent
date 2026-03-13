// ─────────────────────────────────────────────────────────────────────────────
// src/ServiceContainer.ts — Typed container for all extension services
// ─────────────────────────────────────────────────────────────────────────────
// R1 refactor: Replaces 18 module-level `let` variables in extension.ts with
// a single, typed container that is passed to extracted wiring modules.

import { randomUUID } from 'node:crypto';
import { formatSessionDirName } from './session/session-utils.js';
import type { SessionManager } from './session/SessionManager.js';
import { getSessionDir } from './constants/paths.js';

import type { StateManager } from './state/StateManager.js';
import type { Engine } from './engine/Engine.js';
import type { ADKController } from './adk/ADKController.js';
import type { ContextScoper } from './context/ContextScoper.js';
import type { TelemetryLogger } from './logger/TelemetryLogger.js';
import type { GitManager } from './git/GitManager.js';
import type { GitSandboxManager } from './git/GitSandboxManager.js';
import type { OutputBufferRegistry } from './adk/OutputBufferRegistry.js';
import type { PlannerAgent } from './planner/PlannerAgent.js';
import type { HandoffExtractor } from './context/HandoffExtractor.js';
import type { ConsolidationAgent } from './consolidation/ConsolidationAgent.js';
import type { CoogentMCPServer } from './mcp/CoogentMCPServer.js';
import type { MCPClientBridge } from './mcp/MCPClientBridge.js';
import type { SidebarMenuProvider } from './webview/SidebarMenuProvider.js';
import type { AgentRegistry } from './agent-selection/AgentRegistry.js';
import type { ContextPackBuilder } from './context/ContextPackBuilder.js';
import type { SessionHistoryService } from './session/SessionHistoryService.js';

/**
 * Centralised container holding all extension service instances.
 *
 * Replaces the 18 module-level `let` variables that previously lived in
 * `extension.ts`. Each field is mutable (`undefined` before init, cleared
 * on deactivation) so the existing lifecycle semantics are preserved.
 *
 * **Lifecycle**: Services are assigned directly via public property access
 * during `activate()` in `extension.ts` (e.g., `svc.engine = new Engine(...)`).
 * Use `resolve()` for type-safe access with runtime initialisation checks,
 * or `isRegistered()` to test before access.
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
    currentSessionDirName: string | undefined;
    currentSessionId: string | undefined;
    mcpServer: CoogentMCPServer | undefined;
    mcpBridge: MCPClientBridge | undefined;
    sidebarMenu: SidebarMenuProvider | undefined;
    agentRegistry: AgentRegistry | undefined;
    contextPackBuilder: ContextPackBuilder | undefined;
    sessionHistoryService: SessionHistoryService | undefined;
    /** Resolves once MCP server + ArtifactDB are fully initialised. */
    mcpReady: Promise<void> | undefined;
    workspaceRoots: string[] | undefined;

    /** Extension-managed storage base path (from context.storageUri). Used for DB. */
    storageBase: string | undefined;

    /** Workspace-level .coogent directory. Used for session/IPC data. */
    coogentDir: string | undefined;

    /** Absolute path to the extension install directory (context.extensionPath). */
    extensionPath: string | undefined;

    /** Accumulated worker stdout for handoff extraction (capped at 2 MB). */
    readonly workerOutputAccumulator = new Map<number, string>();

    /** Accumulated worker stderr for persistence (capped at 2 MB). */
    readonly workerStderrAccumulator = new Map<number, string>();

    /**
     * BUG-02 fix: Tracks which sessionDirNames have already created a sandbox branch.
     * Using a Set<string> (keyed by sessionDirName) instead of a plain boolean means
     * switching sessions naturally invalidates the guard without explicit reset code.
     */
    readonly sandboxBranchCreatedForSession = new Set<string>();

    /**
     * Materialise a new session (UUID + IPC dir name).
     * Called lazily on first `plan:request` instead of eagerly at boot.
     * @returns The newly created session identifiers.
     */
    initSession(): { sessionId: string; sessionDirName: string; sessionDir: string } {
        if (!this.coogentDir) {
            throw new Error('[ServiceContainer] Cannot init session — coogentDir is not set.');
        }
        const sessionId = randomUUID();
        const sessionDirName = formatSessionDirName(sessionId);
        const sessionDir = getSessionDir(this.coogentDir, sessionDirName);
        this.currentSessionId = sessionId;
        this.currentSessionDirName = sessionDirName;
        this.currentSessionDir = sessionDir;
        return { sessionId, sessionDirName, sessionDir };
    }

    /**
     * Atomically switch all session-related state to a new session.
     *
     * This is the **single entry point** for session switching. All callers
     * (newSession, loadSession, CMD_RESET, PlannerWiring deferred init) must
     * use this method to prevent divergence between `engine.getSessionDirName()`
     * (reads from `stateManager.sessionDir`) and `svc.currentSessionDirName`
     * (used by PlannerWiring/EngineWiring for MCP storage).
     *
     * @param opts.sessionId       UUID of the session.
     * @param opts.sessionDirName  Formatted directory name (e.g., `20260310-200030-<uuid>`).
     * @param opts.sessionDir      Absolute path to the session IPC directory.
     * @param opts.newStateManager  Optional new StateManager instance. When provided,
     *   replaces `this.stateManager` (e.g., after `engine.reset(newSM)`). When omitted,
     *   re-binds the existing StateManager to the new `sessionDir`.
     */
    switchSession(opts: {
        sessionId: string;
        sessionDirName: string;
        sessionDir: string;
        newStateManager?: StateManager;
    }): void {
        this.currentSessionId = opts.sessionId;
        this.currentSessionDirName = opts.sessionDirName;
        this.currentSessionDir = opts.sessionDir;

        if (opts.newStateManager) {
            this.stateManager = opts.newStateManager;
        } else {
            this.stateManager?.setSessionDir(opts.sessionDir);
        }

        this.plannerAgent?.setMasterTaskId(opts.sessionDirName);
        this.sessionManager?.setCurrentSessionId(opts.sessionId, opts.sessionDirName);

        // Defensive: ensure SessionManager always has ArtifactDB access after session switch
        const db = this.mcpServer?.getArtifactDB?.();
        if (db && this.sessionManager) {
            this.sessionManager.setArtifactDB(db);
        }
    }

    /**
     * Check whether a service has been initialised.
     */
    isRegistered<K extends keyof ResolvableServices>(key: K): boolean {
        return this[key] !== undefined;
    }

    /**
     * Return the list of service keys that are currently initialised.
     * Useful for diagnostics (e.g., `coogent.dumpState`).
     */
    getActiveServices(): (keyof ResolvableServices)[] {
        const keys = Object.keys(RESOLVABLE_KEYS) as (keyof ResolvableServices)[];
        return keys.filter(k => this[k] !== undefined);
    }

    /**
     * Type-safe service resolution with runtime initialization check.
     * Throws a descriptive error if the service hasn't been registered yet,
     * preventing the silent `undefined` cascade that previously required
     * null-checks at every call site.
     *
     * @example
     *   const engine = container.resolve('engine');
     *   // `engine` is typed as `Engine` (never undefined)
     */
    resolve<K extends keyof ResolvableServices>(key: K): ResolvableServices[K] {
        const instance = this[key];
        if (instance === undefined) {
            throw new Error(
                `[ServiceContainer] Service '${key}' is not initialized. ` +
                `Check activation order in extension.ts.`
            );
        }
        return instance as ResolvableServices[K];
    }

    /**
     * Release all references for GC.
     * Called during `deactivate()`.
     */
    releaseAll(): void {
        for (const key of Object.keys(RESOLVABLE_KEYS) as (keyof ResolvableServices)[]) {
            (this as Record<string, unknown>)[key] = undefined;
        }
        this.workerOutputAccumulator.clear();
        this.workerStderrAccumulator.clear();
        this.sandboxBranchCreatedForSession.clear();
    }
}

/**
 * Mapped type extracting the resolvable (nullable) service properties
 * from `ServiceContainer`. Excludes `readonly` collections and methods.
 */
export type ResolvableServices = {
    stateManager: StateManager;
    engine: Engine;
    adkController: ADKController;
    contextScoper: ContextScoper;
    logger: TelemetryLogger;
    gitManager: GitManager;
    gitSandbox: GitSandboxManager;
    outputRegistry: OutputBufferRegistry;
    plannerAgent: PlannerAgent;
    sessionManager: SessionManager;
    handoffExtractor: HandoffExtractor;
    consolidationAgent: ConsolidationAgent;
    currentSessionDir: string;
    currentSessionDirName: string;
    currentSessionId: string;
    mcpServer: CoogentMCPServer;
    mcpBridge: MCPClientBridge;
    sidebarMenu: SidebarMenuProvider;
    agentRegistry: AgentRegistry;
    contextPackBuilder: ContextPackBuilder;
    sessionHistoryService: SessionHistoryService;
    mcpReady: Promise<void>;
    workspaceRoots: string[];
    storageBase: string;
    coogentDir: string;
    extensionPath: string;
};

/** Key set used by `getActiveServices()` to enumerate resolvable properties. */
const RESOLVABLE_KEYS: Record<keyof ResolvableServices, true> = {
    stateManager: true,
    engine: true,
    adkController: true,
    contextScoper: true,
    logger: true,
    gitManager: true,
    gitSandbox: true,
    outputRegistry: true,
    plannerAgent: true,
    sessionManager: true,
    handoffExtractor: true,
    consolidationAgent: true,
    currentSessionDir: true,
    currentSessionDirName: true,
    currentSessionId: true,
    mcpServer: true,
    mcpBridge: true,
    sidebarMenu: true,
    agentRegistry: true,
    contextPackBuilder: true,
    sessionHistoryService: true,
    mcpReady: true,
    workspaceRoots: true,
    storageBase: true,
    coogentDir: true,
    extensionPath: true,
};
