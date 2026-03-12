// ─────────────────────────────────────────────────────────────────────────────
// src/commands/helpers.ts — Shared helpers for command modules
// ─────────────────────────────────────────────────────────────────────────────

import * as vscode from 'vscode';

import type { ServiceContainer } from '../ServiceContainer.js';
import type { GitSandboxManager } from '../git/GitSandboxManager.js';
import { StateManager } from '../state/StateManager.js';
import { MissionControlPanel } from '../webview/MissionControlPanel.js';
import { generateUUIDv7 } from '../session/SessionManager.js';
import { formatSessionDirName } from '../session/session-utils.js';
import { getSessionDir } from '../constants/paths.js';
import log from '../logger/log.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Pre-flight Git Check — reusable helper
// ═══════════════════════════════════════════════════════════════════════════════

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

export function generateSessionId(): string {
    return generateUUIDv7();
}

/**
 * Build the standard `onReset` callback that updates module-level state when
 * the webview triggers a new session.
 */
export function makeOnReset(
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
export function showMissionControl(
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

/**
 * Create a new session and reset the engine. Shared by `newSession` and `reset` commands.
 */
export async function createFreshSession(svc: ServiceContainer): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceRoot) {
        const newId = generateSessionId();
        const newDirName = formatSessionDirName(newId);
        const newDir = getSessionDir(svc.coogentDir!, newDirName);
        svc.workerOutputAccumulator.clear();
        svc.sandboxBranchCreatedForSession.clear();
        const newSM = new StateManager(newDir);
        await svc.engine!.reset(newSM);
        svc.switchSession({ sessionId: newId, sessionDirName: newDirName, sessionDir: newDir, newStateManager: newSM });

        // Persist session row so it appears in history even before a prompt is submitted
        svc.mcpServer?.upsertSession(newDirName, newId, '', Date.now());
        svc.sidebarMenu?.refresh();
    } else {
        await svc.engine!.reset();
    }
}
