// ─────────────────────────────────────────────────────────────────────────────
// src/commands/diagnosticCommands.ts — Diagnostic and debugging commands
// ─────────────────────────────────────────────────────────────────────────────

import * as vscode from 'vscode';

import type { ServiceContainer } from '../ServiceContainer.js';

/**
 * Register diagnostic commands: dumpState.
 */
export function registerDiagnosticCommands(
    context: vscode.ExtensionContext,
    svc: ServiceContainer
): void {
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
