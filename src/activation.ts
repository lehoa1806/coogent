// ─────────────────────────────────────────────────────────────────────────────
// src/activation.ts — Composable initialization functions for activate()
// ─────────────────────────────────────────────────────────────────────────────
// P3 refactor: Extracted from the monolithic activate() in extension.ts.
// Each function handles a single responsibility, keeping activate() as a
// thin orchestrator.

import * as vscode from 'vscode';
import * as fsSync from 'node:fs';

import { asPhaseId } from './types/index.js';
import { RUNBOOK_FILE, getCoogentDir, getGlobalCoogentDir } from './constants/paths.js';
import { deriveWorkspaceId } from './constants/WorkspaceIdentity.js';
import { StateManager } from './state/StateManager.js';
import { Engine } from './engine/Engine.js';
import { ADKController } from './adk/ADKController.js';
import { AntigravityADKAdapter } from './adk/AntigravityADKAdapter.js';
import { OutputBufferRegistry } from './adk/OutputBufferRegistry.js';
import { ContextScoper, CharRatioEncoder } from './context/ContextScoper.js';
import { ASTFileResolver } from './context/FileResolver.js';
import { TelemetryLogger } from './logger/TelemetryLogger.js';
import log, { initLog } from './logger/log.js';
import { parseLogLevel } from './logger/LogStream.js';
import { GitManager } from './git/GitManager.js';
import { GitSandboxManager } from './git/GitSandboxManager.js';
import { PlannerAgent } from './planner/PlannerAgent.js';
import { SessionManager } from './session/SessionManager.js';
import { HandoffExtractor } from './context/HandoffExtractor.js';
import { ConsolidationAgent } from './consolidation/ConsolidationAgent.js';
import { CoogentMCPServer } from './mcp/CoogentMCPServer.js';
import { MCPClientBridge } from './mcp/MCPClientBridge.js';
import { deployMCPServer } from './mcp/MCPServerDeployer.js';
import { deployMCPConfig } from './mcp/MCPConfigDeployer.js';
import { SidebarMenuProvider } from './webview/SidebarMenuProvider.js';
import { MissionControlPanel } from './webview/MissionControlPanel.js';
import { AgentRegistry } from './agent-selection/AgentRegistry.js';
import { ContextPackBuilder } from './context/ContextPackBuilder.js';
import { SessionRestoreService } from './session/SessionRestoreService.js';
import { SessionDeleteService } from './session/SessionDeleteService.js';
import { SessionHistoryService } from './session/SessionHistoryService.js';

import type { ServiceContainer } from './ServiceContainer.js';
import { wireEngine } from './EngineWiring.js';
import { wirePlanner } from './PlannerWiring.js';
import { getStorageBasePath, getWorkspaceRoots, getPrimaryRoot } from './utils/WorkspaceHelper.js';


// ═══════════════════════════════════════════════════════════════════════════════
//  Exported Config Type
// ═══════════════════════════════════════════════════════════════════════════════

/** Configuration values read from `coogent.*` settings. */
export interface ActivationConfig {
    tokenLimit: number;
    workerTimeoutMs: number;
    contextBudgetTokens: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  initializeLogging — Steps 1-3: Read log config, resolve workspace, init log
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Start the log stream as early as possible so every subsequent
 * initialisation step is captured.
 *
 * @returns The primary workspace root, or `undefined` when no folder is open.
 */
export function initializeLogging(): string | undefined {
    const wsRoot = getPrimaryRoot();
    if (wsRoot) {
        const logConfig = vscode.workspace.getConfiguration('coogent');
        const logLevel = parseLogLevel(logConfig.get<string>('logLevel', 'info'));
        const logMaxSizeMB = logConfig.get<number>('logMaxSizeMB', 5);
        const logMaxBackups = logConfig.get<number>('logMaxBackups', 2);
        initLog(wsRoot, {
            level: logLevel,
            maxLogBytes: logMaxSizeMB * 1024 * 1024,
            maxBackups: logMaxBackups,
        });
    }
    return wsRoot;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  createServices — Steps 4-5: Resolve paths, instantiate all services
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Resolve workspace paths, read configuration, and instantiate every service
 * on the `ServiceContainer`.
 *
 * @returns The parsed configuration values, or `null` if no workspace is open.
 */
export function createServices(
    context: vscode.ExtensionContext,
    svc: ServiceContainer,
): { config: ActivationConfig; primaryRoot: string } | null {
    const workspaceRoots = getWorkspaceRoots();
    const primaryRoot = getPrimaryRoot();
    if (!primaryRoot) {
        log.warn('[Coogent] No workspace folder open — engine not initialized.');
        return null;
    }
    log.info('[Coogent] Workspace root:', primaryRoot);

    // Ensure extension-managed storage directory exists (sync — activate() is not async)
    const storageUri = context.storageUri ?? context.globalStorageUri;
    fsSync.mkdirSync(storageUri.fsPath, { recursive: true });
    const storageBase = getStorageBasePath(context);
    log.info('[Coogent] Storage base:', storageBase);

    // Store workspace roots and storage base on the container for multi-root support
    svc.workspaceRoots = workspaceRoots;
    svc.storageBase = storageBase;
    const coogentDir = getCoogentDir(primaryRoot);
    svc.coogentDir = coogentDir;

    // Read extension configuration
    const extConfig = vscode.workspace.getConfiguration('coogent');
    const tokenLimit = extConfig.get<number>('tokenLimit', 100_000);
    const workerTimeoutMs = extConfig.get<number>('workerTimeoutMs', 900_000);
    const contextBudgetTokens = extConfig.get<number>('contextBudgetTokens', 100_000);

    // ── Session (deferred) ─────────────────────────────────────────────
    log.info('[Coogent] Session creation deferred until first prompt.');

    // ── Initialize services ────────────────────────────────────────────
    svc.stateManager = new StateManager('');
    log.info('[Coogent] StateManager initialized (deferred session dir)');

    svc.engine = new Engine(svc.stateManager, { workspaceRoot: primaryRoot });
    log.info('[Coogent] Engine initialized');

    svc.gitManager = new GitManager(primaryRoot);
    svc.gitSandbox = new GitSandboxManager(primaryRoot);

    svc.sessionManager = new SessionManager(coogentDir, '' /* deferred */);

    const adkAdapter = new AntigravityADKAdapter(primaryRoot);
    svc.adkController = new ADKController(adkAdapter, primaryRoot);

    // R1: Wire blockOnPromptInjection setting
    const blockOnPromptInjection = extConfig.get<boolean>('blockOnPromptInjection', false);
    svc.adkController.setBlockOnInjection(blockOnPromptInjection);

    // R2: Wire maxConcurrentWorkers setting
    const maxConcurrentWorkers = extConfig.get<number>('maxConcurrentWorkers', 4);
    svc.adkController.setMaxConcurrent(maxConcurrentWorkers);

    log.info('[Coogent] ADKController initialized');

    svc.contextScoper = new ContextScoper({
        encoder: new CharRatioEncoder(),
        tokenLimit,
        resolver: new ASTFileResolver(),
    });

    svc.logger = new TelemetryLogger(primaryRoot);
    log.info('[Coogent] TelemetryLogger initialized');

    svc.outputRegistry = new OutputBufferRegistry((phaseId, stream, chunk) => {
        MissionControlPanel.broadcast({
            type: 'PHASE_OUTPUT',
            payload: { phaseId: asPhaseId(phaseId), stream, chunk },
        });
    });

    svc.plannerAgent = new PlannerAgent(adkAdapter, {
        workspaceRoot: primaryRoot,
        maxTreeDepth: 4,
        maxTreeChars: 8000,
    });
    log.info('[Coogent] PlannerAgent initialized');

    svc.handoffExtractor = new HandoffExtractor();
    svc.consolidationAgent = new ConsolidationAgent();

    svc.agentRegistry = new AgentRegistry(primaryRoot);
    log.info('[Coogent] AgentRegistry initialized');

    return {
        config: { tokenLimit, workerTimeoutMs, contextBudgetTokens },
        primaryRoot,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  startMCPServer — Step 10: Init MCP server, bridge, session history
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Initialise the MCP server, client bridge, and session history services.
 * Also wires the phaseCompleted logging bridge.
 */
export function startMCPServer(svc: ServiceContainer, primaryRoot: string): void {
    const coogentDir = svc.coogentDir!;
    const globalDir = getGlobalCoogentDir();

    // Ensure global durable storage directory exists
    fsSync.mkdirSync(globalDir, { recursive: true });

    // Deploy stdio server bundle to global Antigravity directory
    if (svc.extensionPath) {
        deployMCPServer(svc.extensionPath);
    } else {
        log.warn('[Coogent] startMCPServer: extensionPath not set — skipping MCP deployment.');
    }

    // Deploy MCP config for external AI tools (Antigravity IDE, Cursor, etc.)
    try {
        deployMCPConfig(primaryRoot);
    } catch (err) {
        log.warn('[Coogent] startMCPServer: MCP config deployment failed (non-fatal):', err);
    }

    svc.mcpServer = new CoogentMCPServer(primaryRoot);
    svc.mcpBridge = new MCPClientBridge(svc.mcpServer, primaryRoot);
    const workspaceId = deriveWorkspaceId(primaryRoot);
    log.info('[Coogent] startMCPServer: beginning init sequence...');
    log.info('[Coogent] startMCPServer: globalDir (durable):', globalDir);
    log.info('[Coogent] startMCPServer: localDir (operational):', coogentDir);
    svc.mcpReady = svc.mcpServer.init(globalDir, workspaceId)
        .then(async () => {
            log.info('[Coogent] ArtifactDB initialised (global dir).');

            // Initialize ContextPackBuilder now that ArtifactDB is available
            if (svc.contextScoper) {
                log.debug('[Coogent] startMCPServer: creating ContextPackBuilder...');
                svc.contextPackBuilder = new ContextPackBuilder(
                    svc.mcpServer!.getArtifactDB(),
                    svc.contextScoper.getEncoder(),
                    primaryRoot,
                );
                log.info('[Coogent] ContextPackBuilder initialized.');
            }

            // Initialize Session History Services
            log.debug('[Coogent] startMCPServer: creating SessionHistoryService...');
            const restoreService = new SessionRestoreService(svc.engine!, svc.mcpServer!, coogentDir);
            const deleteService = new SessionDeleteService(svc.mcpServer!, svc.sessionManager!);
            svc.sessionHistoryService = new SessionHistoryService(
                svc.sessionManager!, restoreService, deleteService,
            );
            log.info('[Coogent] SessionHistoryService initialized.');

            // Eagerly wire ArtifactDB so session history is available before first prompt
            const artifactDB = svc.mcpServer!.getArtifactDB();
            if (artifactDB && svc.sessionManager) {
                svc.sessionManager.setArtifactDB(artifactDB);
                log.info('[Coogent] SessionManager wired to ArtifactDB (eager).');
            }

            // Re-trigger sidebar refresh now that DB is available
            svc.sidebarMenu?.refresh();

            log.debug('[Coogent] startMCPServer: connecting MCP Client Bridge...');
            return svc.mcpBridge!.connect();
        })
        .then(() => log.info('[Coogent] MCP Client Bridge connected.'))
        .catch(err => {
            const stack = err instanceof Error ? err.stack ?? err.message : String(err);
            log.error('[Coogent] MCP Server/Bridge init failed:', stack);
            vscode.window.showErrorMessage(
                '[Coogent] MCP Server initialization failed: ' +
                (err instanceof Error ? err.message : String(err)),
            );
            throw err; // Re-throw so svc.mcpReady rejects
        });

    // Startup timeout guard
    const STARTUP_TIMEOUT_MS = 60_000;
    const startupTimer = setTimeout(() => {
        log.error('[Coogent] MCP Server startup timed out after 60s');
        vscode.window.showErrorMessage(
            '[Coogent] MCP Server startup timed out. Check Output panel for details.'
        );
    }, STARTUP_TIMEOUT_MS);
    svc.mcpReady.then(() => clearTimeout(startupTimer)).catch(() => clearTimeout(startupTimer));

    // MCP phaseCompleted logging bridge
    svc.mcpServer.onPhaseCompleted((handoff) => {
        log.info(
            `[Coogent] MCP phaseCompleted: masterTaskId=${handoff.masterTaskId}, ` +
            `phaseId=${handoff.phaseId}`
        );
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  registerUI — Steps 8-9: Sidebar + commands are already registered
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Register the sidebar tree-data provider and refresh it.
 * Commands are registered separately in `registerAllCommands()`.
 */
export function registerSidebar(
    context: vscode.ExtensionContext,
    svc: ServiceContainer,
): void {
    svc.sidebarMenu = new SidebarMenuProvider(svc.sessionManager);
    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('coogent.sidebarMenu', svc.sidebarMenu)
    );
    svc.sidebarMenu.refresh();
    log.info('[Coogent] Activity Bar sidebar menu registered.');
}

// ═══════════════════════════════════════════════════════════════════════════════
//  wireEventSystems — Steps 6-7: Wire engine + planner events
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Wire Engine and Planner event systems.
 * Delegates to the existing `wireEngine()` and `wirePlanner()` modules.
 */
export function wireEventSystems(
    svc: ServiceContainer,
    config: ActivationConfig,
    primaryRoot: string,
): void {
    const workspaceRoots = svc.workspaceRoots ?? [primaryRoot];
    wireEngine(svc, primaryRoot, config.workerTimeoutMs, workspaceRoots, config.contextBudgetTokens);
    wirePlanner(svc);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  registerReactiveConfig — Reactive configuration change listener
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Register a configuration change listener that updates services when
 * `coogent.*` settings are modified at runtime.
 */
export function registerReactiveConfig(
    context: vscode.ExtensionContext,
    svc: ServiceContainer,
): void {
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (!e.affectsConfiguration('coogent')) return;
            const updated = vscode.workspace.getConfiguration('coogent');
            const newTokenLimit = updated.get<number>('tokenLimit', 100_000);
            const newWorkerTimeoutMs = updated.get<number>('workerTimeoutMs', 900_000);
            const newMaxRetries = updated.get<number>('maxRetries', 3);
            svc.contextScoper?.setTokenLimit(newTokenLimit);
            svc.engine?.setMaxRetries(newMaxRetries);
            if (e.affectsConfiguration('coogent.logLevel')) {
                const newLogLevel = parseLogLevel(updated.get<string>('logLevel', 'info'));
                log.setLevel(newLogLevel);
            }
            log.info(
                `[Coogent] Configuration updated: tokenLimit=${newTokenLimit}, ` +
                `workerTimeoutMs=${newWorkerTimeoutMs}, maxRetries=${newMaxRetries}`
            );

            // R1: Reactive update for blockOnPromptInjection
            if (e.affectsConfiguration('coogent.blockOnPromptInjection')) {
                svc.adkController?.setBlockOnInjection(
                    updated.get<boolean>('blockOnPromptInjection', false)
                );
            }

            // R2: Reactive update for maxConcurrentWorkers
            if (e.affectsConfiguration('coogent.maxConcurrentWorkers')) {
                svc.adkController?.setMaxConcurrent(
                    updated.get<number>('maxConcurrentWorkers', 4)
                );
            }
        })
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
//  registerRunbookWatcher — File system watcher for external runbook edits
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Watch for external changes to the runbook file and auto-reload when the
 * engine is idle.
 */
export function registerRunbookWatcher(
    context: vscode.ExtensionContext,
    svc: ServiceContainer,
): void {
    const coogentDir = svc.coogentDir!;
    const storageGlob = new vscode.RelativePattern(
        vscode.Uri.file(coogentDir),
        `ipc/**/${RUNBOOK_FILE}`
    );
    const watcher = vscode.workspace.createFileSystemWatcher(
        storageGlob,
        true, false, true
    );
    watcher.onDidChange(() => {
        log.info(`[Coogent] ${RUNBOOK_FILE} changed externally`);
        if (svc.engine?.getState() === 'IDLE') {
            svc.engine.loadRunbook().catch(log.onError);
        }
    });
    context.subscriptions.push(watcher);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  cleanupOrphanWorkers — Start orphan cleanup on activation
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fire-and-forget orphaned worker cleanup.
 */
export function cleanupOrphanWorkers(svc: ServiceContainer): void {
    log.info('[Coogent] All event handlers wired — running orphan cleanup...');
    svc.adkController?.cleanupOrphanedWorkers().catch(log.onError);
}
