// ─────────────────────────────────────────────────────────────────────────────
// src/EngineWiring.ts — Engine ↔ ADK ↔ UI event subscriptions
// ─────────────────────────────────────────────────────────────────────────────
// R1 refactor: Extracted from extension.ts activate() (lines 487–666, 741–786).

import { randomUUID } from 'node:crypto';
import { asTimestamp, EngineState } from './types/index.js';
import type { Phase, HostToWebviewMessage } from './types/index.js';
import { MissionControlPanel } from './webview/MissionControlPanel.js';
import { RESOURCE_URIS } from './mcp/types.js';
import log from './logger/log.js';
import type { ServiceContainer } from './ServiceContainer.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  wireEngine — connects Engine, ADK, MCP, and Consolidation events
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Wire all engine events, ADK worker lifecycle events, and consolidation flow.
 * Must be called after all services are initialised on the container.
 *
 * @param svc           The shared service container.
 * @param sessionDirName  The current session directory basename (used as masterTaskId).
 * @param workspaceRoot   Absolute path to the workspace folder.
 * @param workerTimeoutMs Worker timeout from the extension configuration.
 */
export function wireEngine(
    svc: ServiceContainer,
    sessionDirName: string,
    workspaceRoot: string,
    workerTimeoutMs: number
): void {
    const { engine, adkController, logger, gitSandbox, gitManager, mcpBridge,
        handoffExtractor, consolidationAgent, outputRegistry,
        workerOutputAccumulator, sandboxBranchCreatedForSession } = svc;

    if (!engine || !adkController) return;

    // ── Engine → Webview (ui:message) ──────────────────────────────────
    engine.on('ui:message', (message: HostToWebviewMessage) => {
        MissionControlPanel.broadcast(message);
    });

    // ── Engine → Webview (state:changed) ───────────────────────────────
    engine.on('state:changed', (from, to, event) => {
        logger?.logStateTransition(from, to, event).catch(log.onError);

        // Auto-create sandbox branch on first EXECUTING_WORKER per session
        if (to === 'EXECUTING_WORKER' && !sandboxBranchCreatedForSession.has(sessionDirName) && gitSandbox) {
            sandboxBranchCreatedForSession.add(sessionDirName);
            if (MissionControlPanel.shouldSkipSandbox()) {
                log.info('[Coogent] Sandbox branch skipped — user chose to continue on current branch.');
            } else {
                const branchRb = engine.getRunbook() ?? null;
                const slug = branchRb?.project_id || 'coogent-task';
                gitSandbox.createSandboxBranch({ taskSlug: slug })
                    .then(result => {
                        if (result.success) {
                            MissionControlPanel.broadcast({
                                type: 'LOG_ENTRY',
                                payload: { timestamp: asTimestamp(), level: 'info', message: `🔀 ${result.message}` },
                            });
                        } else {
                            log.warn('[Coogent] Branch creation skipped:', result.message);
                        }
                    })
                    .catch(err => log.error('[Coogent] Auto-branch creation error:', err));
            }
        }

        // Broadcast STATE_SNAPSHOT on every state transition
        const rb = engine.getRunbook() ?? null;
        MissionControlPanel.broadcast({
            type: 'STATE_SNAPSHOT',
            payload: {
                runbook: rb ?? { project_id: '', status: 'idle', current_phase: 0, phases: [] },
                engineState: to,
                masterTaskId: sessionDirName,
            },
        });
    });

    // ── Engine → run:completed ──────────────────────────────────────────
    engine.on('run:completed', (runbook) => {
        const phaseCount = runbook.phases.length;
        const completedCount = runbook.phases.filter(p => p.status === 'completed').length;
        log.info(
            `[Coogent] Run completed: ${completedCount}/${phaseCount} phases completed ` +
            `for project "${runbook.project_id}".`
        );
        MissionControlPanel.broadcast({
            type: 'LOG_ENTRY',
            payload: {
                timestamp: asTimestamp(),
                level: 'info',
                message: `✅ Run completed: ${completedCount}/${phaseCount} phases for "${runbook.project_id}".`,
            },
        });
    });

    // ── Engine → phase:execute ──────────────────────────────────────────
    engine.on('phase:execute', (phase: Phase) => {
        if (!phase.mcpPhaseId) {
            phase.mcpPhaseId = `phase-${String(phase.id).padStart(3, '0')}-${randomUUID()}`;
        }
        executePhase(svc, phase, workspaceRoot, workerTimeoutMs, sessionDirName).catch((err) => {
            log.error('[Coogent] Phase execution error:', err);
        });
    });

    // ── Engine → phase:heal (SelfHealing) ──────────────────────────────
    engine.on('phase:heal', (phase: Phase, augmentedPrompt: string) => {
        const healPhase = { ...phase, prompt: augmentedPrompt };
        executePhase(svc, healPhase, workspaceRoot, workerTimeoutMs, sessionDirName).catch((err) => {
            log.error('[Coogent] Self-healing phase execution error:', err);
        });
    });

    // ── Engine → phase:checkpoint (Git) ────────────────────────────────
    engine.on('phase:checkpoint', (phaseId: number) => {
        gitManager?.snapshotCommit(phaseId).then(res => {
            if (res.success) {
                MissionControlPanel.broadcast({
                    type: 'LOG_ENTRY',
                    payload: { timestamp: asTimestamp(), level: 'info', message: res.message }
                });
            }
        }).catch(log.onError);
    });

    // ── ADK → Engine (worker lifecycle) ────────────────────────────────
    adkController.on('worker:exited', (phaseId, exitCode) => {
        outputRegistry?.flushAndRemove(phaseId);

        if (exitCode === 0 && handoffExtractor && svc.currentSessionDir) {
            const accumulatedOutput = workerOutputAccumulator.get(phaseId) ?? '';
            workerOutputAccumulator.delete(phaseId);
            handoffExtractor.extractHandoff(phaseId, accumulatedOutput, workspaceRoot)
                .then(report => {
                    if (mcpBridge && report) {
                        const runbook = engine.getRunbook() ?? null;
                        const phaseObj = runbook?.phases.find(p => p.id === phaseId);
                        const phaseIdStr = phaseObj?.mcpPhaseId;
                        if (!phaseIdStr) {
                            log.warn(`[Coogent] mcpPhaseId missing for phase ${phaseId} — skipping handoff submission.`);
                        } else {
                            mcpBridge.submitPhaseHandoff(
                                sessionDirName,
                                phaseIdStr,
                                report.decisions ?? [],
                                report.modified_files ?? [],
                                report.unresolved_issues ?? []
                            ).catch(err => log.error('[Coogent] Failed to store handoff in MCP:', err));
                        }
                    }
                })
                .catch(err => log.error('[Coogent] Handoff extraction error:', err));
        } else {
            workerOutputAccumulator.delete(phaseId);
        }

        engine.onWorkerExited(phaseId, exitCode).catch(log.onError);
    });

    adkController.on('worker:timeout', (phaseId) => {
        outputRegistry?.flushAndRemove(phaseId);
        engine.onWorkerFailed(phaseId, 'timeout').catch(log.onError);
    });

    adkController.on('worker:crash', (phaseId) => {
        outputRegistry?.flushAndRemove(phaseId);
        engine.onWorkerFailed(phaseId, 'crash').catch(log.onError);
    });

    // ── ADK → Webview (output streaming via OutputBufferRegistry) ────────
    adkController.on('worker:output', (phaseId, stream, chunk) => {
        // Output is batched through OutputBufferRegistry (100ms timer / 4KB flush).
        // The registry's flush callback broadcasts PHASE_OUTPUT to the webview.
        outputRegistry?.getOrCreate(phaseId, stream).append(chunk);
        logger?.logPhaseOutput(phaseId, stream, chunk).catch(log.onError);

        // Accumulate stdout for handoff extraction (capped at 2 MB)
        if (stream === 'stdout') {
            const existing = workerOutputAccumulator.get(phaseId) ?? '';
            const MAX_ACCUMULATOR_SIZE = 2 * 1024 * 1024;
            if (existing.length + chunk.length <= MAX_ACCUMULATOR_SIZE) {
                workerOutputAccumulator.set(phaseId, existing + chunk);
            } else if (existing.length < MAX_ACCUMULATOR_SIZE) {
                const remaining = MAX_ACCUMULATOR_SIZE - existing.length;
                workerOutputAccumulator.set(phaseId, existing + chunk.slice(0, remaining));
            }
        }
    });

    // ── Engine → ConsolidationAgent ────────────────────────────────────
    engine.on('run:consolidate', (evtSessionDir: string) => {
        const runbook = engine.getRunbook() ?? null;
        const agent = consolidationAgent;
        if (!agent || !runbook) return;

        agent.generateReport(evtSessionDir, runbook, mcpBridge, sessionDirName)
            .then(async report => {
                try {
                    await agent.saveReport(evtSessionDir, report, mcpBridge, sessionDirName);
                } catch (err) {
                    log.error('[Coogent] saveReport failed:', err);
                }
                return report;
            })
            .then(report => {
                MissionControlPanel.broadcast({
                    type: 'LOG_ENTRY',
                    payload: {
                        timestamp: asTimestamp(),
                        level: 'info',
                        message: 'Consolidation report stored in MCP state.',
                    },
                });
                const markdown = agent.formatAsMarkdown(report);
                MissionControlPanel.broadcast({
                    type: 'CONSOLIDATION_REPORT',
                    payload: { report: markdown },
                });
            })
            .catch(err => {
                log.error('[Coogent] Consolidation error:', err);
                MissionControlPanel.broadcast({
                    type: 'LOG_ENTRY',
                    payload: {
                        timestamp: asTimestamp(),
                        level: 'error',
                        message: `Consolidation report generation failed: ${err instanceof Error ? err.message : String(err)}`,
                    },
                });
            });
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Phase Execution Pipeline
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Full phase execution pipeline: assemble context → spawn worker.
 * Extracted from the module-level `executePhase()` in extension.ts.
 */
async function executePhase(
    svc: ServiceContainer,
    phase: Phase,
    workspaceRoot: string,
    timeoutMs: number,
    masterTaskId: string
): Promise<void> {
    const { engine, contextScoper, adkController, logger, handoffExtractor, currentSessionDir } = svc;

    // Guard against stale healing timer fires after abort/reset
    if (engine?.getState() !== EngineState.EXECUTING_WORKER) {
        log.warn(`[Coogent] Skipping phase ${phase.id} execution — engine not in EXECUTING_WORKER (state: ${engine?.getState()})`);
        return;
    }

    if (!contextScoper || !adkController || !logger) {
        engine?.onWorkerFailed(phase.id, 'crash').catch(log.onError);
        return;
    }

    // Step 0: Log phase start
    await logger.logPhaseStart(phase.id);

    // Step 1: Assemble context
    const result = await contextScoper.assemble(phase, workspaceRoot);

    if (!result.ok) {
        MissionControlPanel.broadcast({
            type: 'TOKEN_BUDGET',
            payload: {
                phaseId: phase.id,
                breakdown: result.breakdown,
                totalTokens: result.totalTokens,
                limit: result.limit,
            },
        });
        MissionControlPanel.broadcast({
            type: 'ERROR',
            payload: {
                code: 'TOKEN_OVER_BUDGET',
                message: `Phase ${phase.id} context exceeds token limit (${result.totalTokens}/${result.limit}).`,
                phaseId: phase.id,
            },
        });
        engine?.onWorkerFailed(phase.id, 'crash').catch(log.onError);
        return;
    }

    // Step 2: Log context assembly
    await logger.logContextAssembly(
        phase.id, result.totalTokens, result.limit, result.breakdown.length
    );

    // Step 3: Send token budget to UI
    MissionControlPanel.broadcast({
        type: 'TOKEN_BUDGET',
        payload: {
            phaseId: phase.id,
            breakdown: result.breakdown,
            totalTokens: result.totalTokens,
            limit: result.limit,
        },
    });

    // Step 4: Log the injected prompt
    await logger.logPhasePrompt(phase.id, phase.prompt);

    // Step 5: Initialize telemetry run (on first phase)
    const runbook = engine?.getRunbook() ?? null;
    if (runbook && phase.id === 0) {
        await logger.initRun(runbook.project_id);
    }

    // Step 5.5: Build handoff context from dependent phases
    let handoffContext = '';
    if (handoffExtractor && currentSessionDir) {
        try {
            handoffContext = await handoffExtractor.buildNextContext(phase, currentSessionDir, workspaceRoot);
        } catch (err) {
            log.error('[Coogent] Failed to build handoff context:', err);
        }
    }

    // Step 6: Build effective prompt
    const distillationPrompt = handoffExtractor?.generateDistillationPrompt(phase.id as number) ?? '';
    let effectivePrompt = phase.prompt;
    if (handoffContext) {
        effectivePrompt = `# Context from Previous Phases\n\n${handoffContext}\n---\n\n${effectivePrompt}`;
    }
    if (distillationPrompt) {
        effectivePrompt = `${effectivePrompt}\n\n---\n\n${distillationPrompt}`;
    }
    const effectivePhase = { ...phase, prompt: effectivePrompt };

    // MCP warm-start URIs
    const mcpResourceUris: {
        implementationPlan?: string;
        parentHandoffs?: string[];
    } = {
        implementationPlan: RESOURCE_URIS.taskPlan(masterTaskId),
    };

    if (phase.depends_on && (phase.depends_on as unknown[]).length > 0 && engine) {
        const rb = engine.getRunbook();
        const parentHandoffs: string[] = [];
        for (const parentId of phase.depends_on) {
            const parentPhase = rb?.phases.find(p => p.id === parentId);
            if (parentPhase?.mcpPhaseId) {
                parentHandoffs.push(RESOURCE_URIS.phaseHandoff(masterTaskId, parentPhase.mcpPhaseId));
            }
        }
        if (parentHandoffs.length > 0) {
            mcpResourceUris.parentHandoffs = parentHandoffs;
        }
    }

    await adkController.spawnWorker(effectivePhase, timeoutMs, masterTaskId, mcpResourceUris);
}
