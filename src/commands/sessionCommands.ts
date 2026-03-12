// ─────────────────────────────────────────────────────────────────────────────
// src/commands/sessionCommands.ts — Session lifecycle commands
// ─────────────────────────────────────────────────────────────────────────────

import * as vscode from 'vscode';
import * as path from 'node:path';

import type { ServiceContainer } from '../ServiceContainer.js';
import { MissionControlPanel } from '../webview/MissionControlPanel.js';
import { asPhaseId, asTimestamp } from '../types/index.js';
import log from '../logger/log.js';
import { showMissionControl, createFreshSession } from './helpers.js';

/**
 * Register session-related commands: newSession, loadSession, deleteSession,
 * searchHistory, refreshHistory.
 */
export function registerSessionCommands(
    context: vscode.ExtensionContext,
    svc: ServiceContainer
): void {
    // ── newSession ─────────────────────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('coogent.newSession', async () => {
            if (!svc.engine) {
                vscode.window.showWarningMessage(
                    'Coogent: Open a workspace folder first to start a new session.'
                );
                return;
            }
            await createFreshSession(svc);
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

                // Hydrate consolidation report if available
                try {
                    const report = await svc.sessionHistoryService.getConsolidationReport(sessionDirName);
                    if (report?.markdown) {
                        MissionControlPanel.broadcast({
                            type: 'CONSOLIDATION_REPORT',
                            payload: { report: report.markdown },
                        });
                    }
                } catch (err) {
                    log.warn('[Coogent] Failed to load consolidation report for session:', err);
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
}
