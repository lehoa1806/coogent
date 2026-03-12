// ─────────────────────────────────────────────────────────────────────────────
// src/commands/gitCommands.ts — Git-related commands
// ─────────────────────────────────────────────────────────────────────────────

import * as vscode from 'vscode';

import type { ServiceContainer } from '../ServiceContainer.js';

/**
 * Register Git-related commands: preFlightCheck, createSandbox, openDiffReview.
 */
export function registerGitCommands(
    context: vscode.ExtensionContext,
    svc: ServiceContainer
): void {
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
}
