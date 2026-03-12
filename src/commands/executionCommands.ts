// ─────────────────────────────────────────────────────────────────────────────
// src/commands/executionCommands.ts — Engine execution lifecycle commands
// ─────────────────────────────────────────────────────────────────────────────

import * as vscode from 'vscode';

import type { ServiceContainer } from '../ServiceContainer.js';
import { preFlightGitCheck, showMissionControl, createFreshSession } from './helpers.js';

/**
 * Register execution-related commands: openMissionControl, start, pause, reset,
 * resumePending, loadRunbook.
 */
export function registerExecutionCommands(
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
                await createFreshSession(svc);
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
}
