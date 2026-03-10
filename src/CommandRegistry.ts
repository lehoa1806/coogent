// ─────────────────────────────────────────────────────────────────────────────
// src/CommandRegistry.ts — Registers all VS Code commands for the extension
// ─────────────────────────────────────────────────────────────────────────────
// R1 refactor: Extracted from extension.ts activate() (lines 128–356, 788–849).

import * as vscode from 'vscode';
import * as path from 'node:path';

import { getSessionDir } from './constants/paths.js';

import type { ServiceContainer } from './ServiceContainer.js';
import { StateManager } from './state/StateManager.js';
import { MissionControlPanel } from './webview/MissionControlPanel.js';
import { formatSessionDirName } from './session/session-utils.js';
import { generateUUIDv7 } from './session/SessionManager.js';
import { asPhaseId, asTimestamp } from './types/index.js';
import log from './logger/log.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Pre-flight Git Check — reusable helper
// ═══════════════════════════════════════════════════════════════════════════════

import type { GitSandboxManager } from './git/GitSandboxManager.js';

/**
 * Check whether the working tree is clean before starting execution.
 * Uses the native VS Code Git API via GitSandboxManager (no destructive stash).
 */
export async function preFlightGitCheck(
    sandbox: GitSandboxManager | undefined
): Promise<{ blocked: true; message: string } | { blocked: false }> {
    if (!sandbox) return { blocked: false };
    try {
        const result = await sandbox.preFlightCheck();
        if (result.clean === false) return { blocked: true, message: result.message };
        return { blocked: false };
    } catch (err) {
        log.warn('[Coogent] Git pre-flight check failed (non-blocking):', err);
        return { blocked: false };
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════════════════════════════════

function generateSessionId(): string {
    return generateUUIDv7();
}

/**
 * Build the standard `onReset` callback that updates module-level state when
 * the webview triggers a new session.
 */
function makeOnReset(
    svc: ServiceContainer,
    _sessionDirName: string
): (newDir: string, newDirName: string, newStateManager?: StateManager) => void {
    return (newDir, newDirName, newStateManager) => {
        svc.switchSession({
            sessionId: newDirName.replace(/^\d{8}-\d{6}-/, ''),
            sessionDirName: newDirName,
            sessionDir: newDir,
            ...(newStateManager ? { newStateManager } : {}),
        });
        svc.sidebarMenu?.refresh();
    };
}

/**
 * Show (or create) Mission Control, injecting all current service references.
 */
function showMissionControl(
    extensionUri: vscode.Uri,
    svc: ServiceContainer
): void {
    if (!svc.engine) return;
    const sessionDirName = svc.engine.getSessionDirName() ?? '';
    MissionControlPanel.createOrShow(
        extensionUri,
        svc.engine,
        svc.sessionManager,
        svc.adkController,
        () => preFlightGitCheck(svc.gitSandbox),
        makeOnReset(svc, sessionDirName),
        svc.mcpServer,
        svc.mcpBridge,
        svc.agentRegistry,
        svc.coogentDir
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
//  registerAllCommands
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Register all 14 Coogent VS Code commands on the ExtensionContext.
 * Each command reads services from the shared `ServiceContainer`.
 */
export function registerAllCommands(
    context: vscode.ExtensionContext,
    svc: ServiceContainer
): void {
    // ── openMissionControl ─────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('coogent.openMissionControl', () => {
            if (!svc.engine) {
                vscode.window.showWarningMessage(
                    'Coogent: Open a workspace folder first to use Mission Control.'
                );
                return;
            }
            showMissionControl(context.extensionUri, svc);
        })
    );

    // ── newSession ─────────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('coogent.newSession', async () => {
            if (!svc.engine) {
                vscode.window.showWarningMessage(
                    'Coogent: Open a workspace folder first to start a new session.'
                );
                return;
            }
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (workspaceRoot) {
                const newId = generateSessionId();
                const newDirName = formatSessionDirName(newId);
                const newDir = getSessionDir(svc.coogentDir!, newDirName);
                svc.workerOutputAccumulator.clear();
                svc.sandboxBranchCreatedForSession.clear();
                const newSM = new StateManager(newDir);
                await svc.engine.reset(newSM);
                svc.switchSession({ sessionId: newId, sessionDirName: newDirName, sessionDir: newDir, newStateManager: newSM });
            } else {
                await svc.engine.reset();
            }
            showMissionControl(context.extensionUri, svc);
        })
    );

    // ── loadSession ────────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('coogent.loadSession', async (sessionId?: string) => {
            if (!svc.sessionHistoryService) {
                vscode.window.showWarningMessage('Coogent: Session services not ready. Try again in a moment.');
                return;
            }
            if (!sessionId) return;

            // SessionManager stores sessions by sessionId but SessionHistoryService
            // needs the sessionDirName. Resolve it.
            const sessionDir = svc.sessionManager!.getSessionDir(sessionId);
            const sessionDirName = path.basename(sessionDir);

            try {
                const result = await svc.sessionHistoryService.loadSession(sessionDirName);
                if (!result.success) {
                    vscode.window.showErrorMessage(`Coogent: Session load failed — ${result.errors.join('; ')}`);
                    return;
                }
                svc.switchSession({ sessionId: sessionId, sessionDirName, sessionDir });
                showMissionControl(context.extensionUri, svc);

                // Hydrate UI with restored worker outputs
                for (const [phaseIdStr, output] of Object.entries(result.workerOutputs)) {
                    const indexMatch = phaseIdStr.match(/^phase-(\d+)-/);
                    if (indexMatch && output) {
                        const phaseId = asPhaseId(parseInt(indexMatch[1], 10));
                        MissionControlPanel.broadcast({
                            type: 'PHASE_OUTPUT',
                            payload: { phaseId, stream: 'stdout', chunk: output },
                        });
                    }
                }

                // Broadcast last prompt if available
                if (svc.mcpServer) {
                    const taskState = svc.mcpServer.getTaskState(sessionDirName);
                    if (taskState?.summary) {
                        MissionControlPanel.broadcast({
                            type: 'LOG_ENTRY',
                            payload: { timestamp: asTimestamp(), level: 'info', message: `[LAST_PROMPT] ${taskState.summary}` },
                        });
                    }
                }
            } catch (err: unknown) {
                vscode.window.showErrorMessage(`Coogent: Failed to load session — ${err instanceof Error ? err.message : String(err)}`);
            }
        })
    );

    // ── deleteSession ──────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('coogent.deleteSession', async (item?: { session?: { sessionId?: string } }) => {
            if (!svc.sessionHistoryService) return;
            const sessionId = typeof item === 'string' ? item : item?.session?.sessionId;
            if (!sessionId) return;
            try {
                const sessionDir = svc.sessionManager!.getSessionDir(sessionId);
                const sessionDirName = path.basename(sessionDir);
                const currentDirName = svc.currentSessionDir ? path.basename(svc.currentSessionDir) : undefined;
                const result = await svc.sessionHistoryService.deleteSession(sessionDirName, currentDirName);
                if (!result.success) {
                    vscode.window.showWarningMessage(`Coogent: Session delete had errors — ${result.errors.join('; ')}`);
                }
                svc.sidebarMenu?.refresh();
            } catch (err: unknown) {
                vscode.window.showErrorMessage(`Coogent: Failed to delete session — ${err instanceof Error ? err.message : String(err)}`);
            }
        })
    );

    // ── searchHistory ──────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('coogent.searchHistory', async () => {
            const query = await vscode.window.showInputBox({
                prompt: 'Search session history',
                placeHolder: 'e.g. auth, refactor, api…',
            });
            if (query === undefined) return;
            svc.sidebarMenu?.search(query);
        })
    );

    // ── refreshHistory ─────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('coogent.refreshHistory', () => {
            svc.sidebarMenu?.refresh();
        })
    );

    // ── loadRunbook ────────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('coogent.loadRunbook', async () => {
            if (!svc.engine) {
                vscode.window.showWarningMessage('Coogent: No workspace — cannot load runbook.');
                return;
            }
            try {
                await svc.engine.loadRunbook();
            } catch (err: unknown) {
                vscode.window.showErrorMessage(`Coogent: Failed to load runbook — ${err instanceof Error ? err.message : String(err)}`);
            }
        })
    );

    // ── start ──────────────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('coogent.start', async () => {
            if (!svc.engine) {
                vscode.window.showWarningMessage('Coogent: No workspace — cannot start.');
                return;
            }
            const check = await preFlightGitCheck(svc.gitSandbox);
            if (check.blocked) {
                const proceed = await vscode.window.showWarningMessage(
                    `Coogent: ${check.message}`,
                    'Continue Anyway',
                    'Cancel'
                );
                if (proceed !== 'Continue Anyway') return;
            }
            try {
                await svc.engine.start();
            } catch (err: unknown) {
                vscode.window.showErrorMessage(`Coogent: Start failed — ${err instanceof Error ? err.message : String(err)}`);
            }
        })
    );

    // ── pause ──────────────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('coogent.pause', () => {
            if (!svc.engine) {
                vscode.window.showWarningMessage('Coogent: No workspace — cannot pause.');
                return;
            }
            svc.engine.pause();
        })
    );

    // ── reset ──────────────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('coogent.reset', async () => {
            if (!svc.engine) {
                vscode.window.showWarningMessage('Coogent: No workspace — cannot reset.');
                return;
            }
            try {
                const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                if (workspaceRoot) {
                    const newId = generateSessionId();
                    const newDirName = formatSessionDirName(newId);
                    const newDir = getSessionDir(svc.coogentDir!, newDirName);
                    svc.workerOutputAccumulator.clear();
                    svc.sandboxBranchCreatedForSession.clear();
                    const newSM = new StateManager(newDir);
                    await svc.engine.reset(newSM);
                    svc.switchSession({ sessionId: newId, sessionDirName: newDirName, sessionDir: newDir, newStateManager: newSM });
                } else {
                    await svc.engine.reset();
                }
            } catch (err: unknown) {
                vscode.window.showErrorMessage(`Coogent: Reset failed — ${err instanceof Error ? err.message : String(err)}`);
            }
        })
    );

    // ── resumePending ──────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('coogent.resumePending', async () => {
            if (!svc.engine) {
                vscode.window.showWarningMessage('Coogent: No workspace — cannot resume.');
                return;
            }
            try {
                await svc.engine.resumePending();
            } catch (err: unknown) {
                vscode.window.showErrorMessage(`Coogent: Resume failed — ${err instanceof Error ? err.message : String(err)}`);
            }
        })
    );

    // ── preFlightCheck ─────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('coogent.preFlightCheck', async () => {
            if (!svc.gitSandbox) {
                vscode.window.showWarningMessage('Coogent: Git not available in this workspace.');
                return;
            }
            try {
                const result = await svc.gitSandbox.preFlightCheck();
                if (result.clean) {
                    vscode.window.showInformationMessage(`Coogent: ${result.message}`);
                } else {
                    vscode.window.showWarningMessage(`Coogent: ${result.message}`);
                }
            } catch (err: unknown) {
                vscode.window.showErrorMessage(`Coogent: Pre-flight check failed — ${err instanceof Error ? err.message : String(err)}`);
            }
        })
    );

    // ── createSandbox ──────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('coogent.createSandbox', async () => {
            if (!svc.gitSandbox) {
                vscode.window.showWarningMessage('Coogent: Git not available in this workspace.');
                return;
            }
            const slug = await vscode.window.showInputBox({ prompt: 'Enter a task slug (e.g., feat-auth-flow)' });
            if (!slug) return;
            try {
                const result = await svc.gitSandbox.createSandboxBranch({ taskSlug: slug });
                if (result.success) {
                    vscode.window.showInformationMessage(`Coogent: ${result.message}`);
                } else {
                    vscode.window.showErrorMessage(`Coogent: ${result.message}`);
                }
            } catch (err: unknown) {
                vscode.window.showErrorMessage(`Coogent: Failed to create sandbox — ${err instanceof Error ? err.message : String(err)}`);
            }
        })
    );

    // ── openDiffReview ─────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('coogent.openDiffReview', async () => {
            if (!svc.gitSandbox) {
                vscode.window.showWarningMessage('Coogent: Git not available in this workspace.');
                return;
            }
            try {
                const result = await svc.gitSandbox.openDiffReview();
                if (result.success) {
                    vscode.window.showInformationMessage(`Coogent: ${result.message}`);
                } else {
                    vscode.window.showErrorMessage(`Coogent: ${result.message}`);
                }
            } catch (err: unknown) {
                vscode.window.showErrorMessage(`Coogent: Failed to open diff review — ${err instanceof Error ? err.message : String(err)}`);
            }
        })
    );

    // ── dumpState ──────────────────────────────────────────────────────
    // S3-5: Diagnostic command outputting FSM state, workers, runbook status.
    context.subscriptions.push(
        vscode.commands.registerCommand('coogent.dumpState', () => {
            const channel = vscode.window.createOutputChannel('Coogent State Dump');
            channel.clear();
            channel.appendLine('═══ Coogent State Dump ═══');
            channel.appendLine(`Timestamp: ${new Date().toISOString()}`);
            channel.appendLine('');

            // FSM state
            if (svc.engine) {
                channel.appendLine(`FSM State: ${svc.engine.getState()}`);
                channel.appendLine(`Active Worker Count: ${svc.engine.getActiveWorkerCount()}`);
                channel.appendLine(`Pause Requested: ${svc.engine.isPauseRequested()}`);
            } else {
                channel.appendLine('Engine: NOT INITIALIZED');
            }
            channel.appendLine('');

            // Runbook status
            const runbook = svc.engine?.getRunbook();
            if (runbook) {
                channel.appendLine(`Runbook Status: ${runbook.status}`);
                channel.appendLine(`Runbook Project: ${runbook.project_id}`);
                channel.appendLine(`Total Phases: ${runbook.phases.length}`);
                const byCounts = {
                    pending: 0, running: 0, completed: 0, failed: 0,
                };
                for (const p of runbook.phases) {
                    const key = p.status as keyof typeof byCounts;
                    if (key in byCounts) byCounts[key]++;
                }
                channel.appendLine(`  Pending: ${byCounts.pending}  Running: ${byCounts.running}  Completed: ${byCounts.completed}  Failed: ${byCounts.failed}`);
            } else {
                channel.appendLine('Runbook: NONE');
            }
            channel.appendLine('');

            // Service container
            channel.appendLine('── Registered Services ──');
            const active = svc.getActiveServices();
            channel.appendLine(`Services (${active.length}): ${active.join(', ')}`);
            channel.appendLine('');

            // Session info
            channel.appendLine(`Session Dir: ${svc.currentSessionDir ?? 'NONE'}`);
            channel.appendLine(`Worker Output Accumulators: ${svc.workerOutputAccumulator.size}`);

            channel.appendLine('');
            channel.appendLine('═══ End State Dump ═══');
            channel.show(true);
        })
    );
}
