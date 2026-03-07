// ─────────────────────────────────────────────────────────────────────────────
// src/CommandRegistry.ts — Registers all VS Code commands for the extension
// ─────────────────────────────────────────────────────────────────────────────
// R1 refactor: Extracted from extension.ts activate() (lines 128–356, 788–849).

import * as vscode from 'vscode';
import * as path from 'node:path';

import type { ServiceContainer } from './ServiceContainer.js';
import { StateManager } from './state/StateManager.js';
import { MissionControlPanel } from './webview/MissionControlPanel.js';
import { SessionManager, formatSessionDirName, generateUUIDv7 } from './session/SessionManager.js';
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
): (newDir: string, newDirName: string) => void {
    return (newDir, newDirName) => {
        svc.currentSessionDir = newDir;
        svc.plannerAgent?.setMasterTaskId(newDirName);
        svc.sessionManager?.setCurrentSessionId(
            newDirName.replace(/^\d{8}-\d{6}-/, ''), newDirName
        );
        svc.sessionManager?.saveCurrentSession().catch(log.onError);
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
        svc.workerRegistry
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
                const newDir = path.join(workspaceRoot, '.coogent', 'ipc', newDirName);
                svc.workerOutputAccumulator.clear();
                svc.sandboxBranchCreatedForSession.clear();
                svc.currentSessionDir = newDir;
                const newSM = new StateManager(newDir);
                await svc.engine.reset(newSM);
                svc.sessionManager = new SessionManager(workspaceRoot, newId, newDirName);
                svc.sessionManager.saveCurrentSession().catch(log.onError);
                svc.plannerAgent?.setMasterTaskId(newDirName);
            } else {
                await svc.engine.reset();
            }
            showMissionControl(context.extensionUri, svc);
        })
    );

    // ── loadSession ────────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('coogent.loadSession', async (sessionId?: string) => {
            if (!svc.engine || !svc.sessionManager) {
                vscode.window.showWarningMessage(
                    'Coogent: Open a workspace folder first to load a session.'
                );
                return;
            }
            if (!sessionId) return;
            const sessionDir = svc.sessionManager.getSessionDir(sessionId);
            const newStateManager = new StateManager(sessionDir);
            try {
                await svc.engine.switchSession(newStateManager);
                svc.currentSessionDir = sessionDir;
                const masterTaskId = path.basename(sessionDir);
                svc.sessionManager.setCurrentSessionId(sessionId, masterTaskId);
                svc.sessionManager.saveCurrentSession().catch(log.onError);
                svc.plannerAgent?.setMasterTaskId(masterTaskId);
                showMissionControl(context.extensionUri, svc);

                // ── Hydrate persisted artifacts into webview ────────────
                // Read the original prompt and worker outputs from ArtifactDB
                // and broadcast them using existing message types so the
                // webview's messageHandler restores appState.lastPrompt
                // and appState.phaseOutputs from history.
                if (svc.mcpServer) {
                    const taskState = svc.mcpServer.getTaskState(masterTaskId);
                    if (taskState?.summary) {
                        MissionControlPanel.broadcast({
                            type: 'LOG_ENTRY',
                            payload: {
                                timestamp: asTimestamp(),
                                level: 'info',
                                message: `[LAST_PROMPT] ${taskState.summary}`,
                            },
                        });
                    }

                    const workerOutputs = svc.mcpServer.getWorkerOutputs(masterTaskId);
                    for (const [phaseIdStr, output] of Object.entries(workerOutputs)) {
                        // phaseIdStr is the mcpPhaseId (e.g. "phase-000-<uuid>")
                        // Extract the numeric phase index from the MCP phase ID
                        const indexMatch = phaseIdStr.match(/^phase-(\d+)-/);
                        if (indexMatch && output) {
                            const phaseId = asPhaseId(parseInt(indexMatch[1], 10));
                            MissionControlPanel.broadcast({
                                type: 'PHASE_OUTPUT',
                                payload: {
                                    phaseId,
                                    stream: 'stdout',
                                    chunk: output,
                                },
                            });
                        }
                    }
                }
            } catch (err: any) {
                vscode.window.showErrorMessage(`Coogent: Failed to load session — ${err?.message ?? err}`);
            }
        })
    );

    // ── deleteSession ──────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('coogent.deleteSession', async (item?: { session?: { sessionId?: string } }) => {
            if (!svc.sessionManager) return;
            const sessionId = typeof item === 'string' ? item : item?.session?.sessionId;
            if (!sessionId) return;
            try {
                await svc.sessionManager.deleteSession(sessionId);
                svc.sidebarMenu?.refresh();
            } catch (err: any) {
                vscode.window.showErrorMessage(`Coogent: Failed to delete session — ${err?.message ?? err}`);
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
            } catch (err: any) {
                vscode.window.showErrorMessage(`Coogent: Failed to load runbook — ${err?.message ?? err}`);
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
            } catch (err: any) {
                vscode.window.showErrorMessage(`Coogent: Start failed — ${err?.message ?? err}`);
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
                    const newDir = path.join(workspaceRoot, '.coogent', 'ipc', newDirName);
                    svc.workerOutputAccumulator.clear();
                    svc.sandboxBranchCreatedForSession.clear();
                    svc.currentSessionDir = newDir;
                    const newSM = new StateManager(newDir);
                    await svc.engine.reset(newSM);
                    svc.sessionManager = new SessionManager(workspaceRoot, newId, newDirName);
                    svc.sessionManager.saveCurrentSession().catch(log.onError);
                    svc.plannerAgent?.setMasterTaskId(newDirName);
                } else {
                    await svc.engine.reset();
                }
            } catch (err: any) {
                vscode.window.showErrorMessage(`Coogent: Reset failed — ${err?.message ?? err}`);
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
            } catch (err: any) {
                vscode.window.showErrorMessage(`Coogent: Resume failed — ${err?.message ?? err}`);
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
            } catch (err: any) {
                vscode.window.showErrorMessage(`Coogent: Pre-flight check failed — ${err?.message ?? err}`);
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
            } catch (err: any) {
                vscode.window.showErrorMessage(`Coogent: Failed to create sandbox — ${err?.message ?? err}`);
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
            } catch (err: any) {
                vscode.window.showErrorMessage(`Coogent: Failed to open diff review — ${err?.message ?? err}`);
            }
        })
    );
}
