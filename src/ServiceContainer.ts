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
import type { WorkerRegistry } from './adk/WorkerRegistry.js';

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
    workerRegistry: WorkerRegistry | undefined;
    workspaceRoots: string[] | undefined;

    /** Extension-managed storage base path (from context.storageUri). */
    storageBase: string | undefined;

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

    /** Insertion-order tracker for debugging activation sequence. */
    private readonly initOrder: (keyof ResolvableServices)[] = [];

    /**
     * Register a service instance with initialization-order tracking.
     * Throws if the service key has already been registered (prevents
     * accidental double-init bugs that silently replace instances).
     *
     * @example
     *   container.register('engine', new Engine(...));
     */
    register<K extends keyof ResolvableServices>(key: K, instance: ResolvableServices[K]): void {
        if (this[key] !== undefined) {
            throw new Error(
                `[ServiceContainer] Service '${key}' is already registered. ` +
                `Call releaseAll() before re-registering.`
            );
        }
        (this as any)[key] = instance;
        this.initOrder.push(key);
    }

    /**
     * Check whether a service has been registered.
     */
    isRegistered<K extends keyof ResolvableServices>(key: K): boolean {
        return this[key] !== undefined;
    }

    /**
     * Get the initialization order of registered services.
     * Useful for debugging activation sequence issues.
     */
    getInitOrder(): ReadonlyArray<keyof ResolvableServices> {
        return [...this.initOrder];
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
        this.workerRegistry = undefined;
        this.workspaceRoots = undefined;
        this.storageBase = undefined;
        this.workerOutputAccumulator.clear();
        this.workerStderrAccumulator.clear();
        this.sandboxBranchCreatedForSession.clear();
        this.initOrder.length = 0;
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
    mcpServer: CoogentMCPServer;
    mcpBridge: MCPClientBridge;
    sidebarMenu: SidebarMenuProvider;
    workerRegistry: WorkerRegistry;
    workspaceRoots: string[];
    storageBase: string;
};
