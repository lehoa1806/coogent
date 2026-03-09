// ─────────────────────────────────────────────────────────────────────────────
// src/EngineWiring.ts — Engine ↔ ADK ↔ UI event subscriptions
// ─────────────────────────────────────────────────────────────────────────────
// R1 refactor: Extracted from extension.ts activate() (lines 487–666, 741–786).

import { randomUUID } from 'node:crypto';
import { asTimestamp, EngineState, EngineEvent, type Phase, type HostToWebviewMessage } from './types/index.js';
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
 * @param svc             The shared service container.
 * @param sessionDirName  The current session directory basename (used as masterTaskId).
 * @param workspaceRoot   Absolute path to the primary workspace folder.
 * @param workerTimeoutMs Worker timeout from the extension configuration.
 * @param workspaceRoots  All active workspace folder paths (defaults to [workspaceRoot]).
 */
export function wireEngine(
    svc: ServiceContainer,
    sessionDirName: string,
    workspaceRoot: string,
    workerTimeoutMs: number,
    workspaceRoots: string[] = [workspaceRoot]
): void {
    const { engine, adkController, logger, gitSandbox, gitManager, mcpBridge, mcpServer,
        handoffExtractor, consolidationAgent, outputRegistry,
        workerOutputAccumulator, workerStderrAccumulator,
        sandboxBranchCreatedForSession } = svc;

    if (!engine || !adkController) return;

    // ── Wire DispatchController with agent-selection options ──────────
    // Pass ArtifactDB reference and TelemetryLogger so the pipeline can
    // persist audit records and log agent selection events.
    // `useAgentSelection` defaults to false — enable via configuration.
    if (svc.mcpServer && engine.configureDispatch) {
        const dispatchOpts: import('./engine/DispatchController.js').DispatchControllerOptions = {
            useAgentSelection: false,
            artifactDb: svc.mcpServer.getArtifactDB(),
            sessionDirName,
            ...(logger ? { logger } : {}),
        };
        engine.configureDispatch(dispatchOpts);
    }

    // F-5 audit fix: Track per-phase flush intervals for incremental worker output persistence.
    // Every 30s, accumulated output is flushed to DB so a crash mid-phase doesn't lose diagnostics.
    const INCREMENTAL_FLUSH_MS = 30_000;
    const flushIntervals = new Map<number, ReturnType<typeof setInterval>>();

    /** Clear and remove the incremental flush interval for a phase. */
    function clearFlushInterval(phaseId: number): void {
        const interval = flushIntervals.get(phaseId);
        if (interval !== undefined) {
            clearInterval(interval);
            flushIntervals.delete(phaseId);
        }
    }

    // ── Engine → Webview (ui:message) ──────────────────────────────────
    engine.on('ui:message', (message: HostToWebviewMessage) => {
        MissionControlPanel.broadcast(message);
    });

    // ── Engine → Webview (state:changed) ───────────────────────────────
    engine.on('state:changed', (from, to, event) => {
        logger?.logStateTransition(from, to, event).catch(log.onError);

        // NOTE: Previously purged task from ArtifactDB on IDLE transition (LF-5).
        // Removed because sql.js does not honour ON DELETE CASCADE, leaving
        // orphan phases/handoffs/worker_outputs that cause "Task not found" errors.
        // The realpath workspace boundary check is the true security gate.

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
        // Persist task completion timestamp (BL-5 audit fix)
        if (mcpServer) {
            mcpServer.setTaskCompleted(sessionDirName);
        }

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

        // Persist phase log entry at start
        if (mcpServer && phase.mcpPhaseId) {
            mcpServer.upsertPhaseLog(sessionDirName, phase.mcpPhaseId, {
                prompt: phase.prompt,
                startedAt: Date.now(),
            });
        }

        executePhase(svc, phase, workspaceRoot, workerTimeoutMs, sessionDirName, workspaceRoots).catch((err) => {
            log.error('[Coogent] Phase execution error:', err);
        });
    });

    // ── Engine → phase:heal (SelfHealing) ──────────────────────────────
    engine.on('phase:heal', (phase: Phase, augmentedPrompt: string) => {
        const healPhase = { ...phase, prompt: augmentedPrompt };
        executePhase(svc, healPhase, workspaceRoot, workerTimeoutMs, sessionDirName, workspaceRoots).catch((err) => {
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
        // F-5 audit fix: Clear incremental flush interval before final flush
        clearFlushInterval(phaseId);

        outputRegistry?.flushAndRemove(phaseId);

        // RACE-FIX: Await handoff extraction + MCP submission BEFORE triggering
        // the engine FSM transition. The FSM transition broadcasts STATE_SNAPSHOT
        // to the webview, which immediately fetches the handoff URI. If submission
        // hasn't completed, the webview gets "Phase not found".
        const handoffPromise: Promise<void> = (async () => {
            if (exitCode === 0 && handoffExtractor && svc.currentSessionDir) {
                const accumulatedOutput = workerOutputAccumulator.get(phaseId) ?? '';
                const accumulatedStderr = workerStderrAccumulator.get(phaseId) ?? '';
                workerOutputAccumulator.delete(phaseId);
                workerStderrAccumulator.delete(phaseId);

                // Persist worker output + stderr to ArtifactDB so it survives session reloads
                if (mcpServer && (accumulatedOutput || accumulatedStderr)) {
                    const runbook = engine.getRunbook() ?? null;
                    const phaseObj = runbook?.phases.find(p => p.id === phaseId);
                    const phaseIdStr = phaseObj?.mcpPhaseId;
                    if (phaseIdStr) {
                        mcpServer.upsertWorkerOutput(sessionDirName, phaseIdStr, accumulatedOutput, accumulatedStderr);
                    }
                }

                try {
                    const report = await handoffExtractor.extractHandoff(phaseId, accumulatedOutput);
                    if (mcpBridge && report) {
                        const runbook = engine.getRunbook() ?? null;
                        const phaseObj = runbook?.phases.find(p => p.id === phaseId);
                        const phaseIdStr = phaseObj?.mcpPhaseId;
                        if (!phaseIdStr) {
                            log.warn(`[Coogent] mcpPhaseId missing for phase ${phaseId} — skipping handoff submission.`);
                        } else {
                            await mcpBridge.submitPhaseHandoff(
                                sessionDirName,
                                phaseIdStr,
                                report.decisions ?? [],
                                report.modified_files ?? [],
                                report.unresolved_issues ?? []
                            );
                        }
                    }
                } catch (err) {
                    log.error('[Coogent] Handoff extraction/submission error:', err);
                    // LF-6 FIX: Surface handoff failure to the webview so users
                    // know a child agent may be missing parent context.
                    MissionControlPanel.broadcast({
                        type: 'LOG_ENTRY',
                        payload: {
                            timestamp: asTimestamp(),
                            level: 'warn',
                            message: `⚠ Phase ${phaseId}: handoff extraction/submission failed — ` +
                                `child phases may start without full parent context. ` +
                                `(${err instanceof Error ? err.message : String(err)})`,
                        },
                    });
                }
            } else {
                workerOutputAccumulator.delete(phaseId);
                workerStderrAccumulator.delete(phaseId);
            }
        })();

        // Engine FSM transition fires AFTER handoff is persisted (or fails gracefully).
        // Errors in handoff extraction/submission are caught above and don't block the FSM.
        handoffPromise
            .then(() => {
                // Persist phase completion to phase_logs
                if (mcpServer) {
                    const rb = engine.getRunbook() ?? null;
                    const pObj = rb?.phases.find(p => p.id === phaseId);
                    if (pObj?.mcpPhaseId) {
                        mcpServer.upsertPhaseLog(sessionDirName, pObj.mcpPhaseId, {
                            exitCode: exitCode,
                            completedAt: Date.now(),
                        });
                    }
                }
                return engine.onWorkerExited(phaseId, exitCode);
            })
            .catch(log.onError);
    });

    adkController.on('worker:timeout', (phaseId) => {
        // F-5 audit fix: Clear incremental flush interval
        clearFlushInterval(phaseId);

        outputRegistry?.flushAndRemove(phaseId);

        // M3 audit fix: Flush accumulated stdout/stderr to DB before marking failure
        // so crash diagnostics survive for debugging.
        if (mcpServer) {
            const accOut = workerOutputAccumulator.get(phaseId) ?? '';
            const accErr = workerStderrAccumulator.get(phaseId) ?? '';
            if (accOut || accErr) {
                const rb = engine.getRunbook() ?? null;
                const pObj = rb?.phases.find(p => p.id === phaseId);
                if (pObj?.mcpPhaseId) {
                    mcpServer.upsertWorkerOutput(sessionDirName, pObj.mcpPhaseId, accOut, accErr);
                }
            }
        }
        workerOutputAccumulator.delete(phaseId);
        workerStderrAccumulator.delete(phaseId);

        engine.onWorkerFailed(phaseId, 'timeout').catch(log.onError);
    });

    adkController.on('worker:crash', (phaseId) => {
        // F-5 audit fix: Clear incremental flush interval
        clearFlushInterval(phaseId);

        outputRegistry?.flushAndRemove(phaseId);

        // M3 audit fix: Flush accumulated stdout/stderr to DB before marking failure
        if (mcpServer) {
            const accOut = workerOutputAccumulator.get(phaseId) ?? '';
            const accErr = workerStderrAccumulator.get(phaseId) ?? '';
            if (accOut || accErr) {
                const rb = engine.getRunbook() ?? null;
                const pObj = rb?.phases.find(p => p.id === phaseId);
                if (pObj?.mcpPhaseId) {
                    mcpServer.upsertWorkerOutput(sessionDirName, pObj.mcpPhaseId, accOut, accErr);
                }
            }
        }
        workerOutputAccumulator.delete(phaseId);
        workerStderrAccumulator.delete(phaseId);

        engine.onWorkerFailed(phaseId, 'crash').catch(log.onError);
    });

    // ── ADK → Webview (output streaming via OutputBufferRegistry) ────────
    adkController.on('worker:output', (phaseId, stream, chunk) => {
        // Output is batched through OutputBufferRegistry (100ms timer / 4KB flush).
        // The registry's flush callback broadcasts PHASE_OUTPUT to the webview.
        outputRegistry?.getOrCreate(phaseId, stream).append(chunk);
        logger?.logPhaseOutput(phaseId, stream, chunk).catch(log.onError);

        // Accumulate stdout for handoff extraction (capped at 2 MB)
        const MAX_ACCUMULATOR_SIZE = 2 * 1024 * 1024;
        if (stream === 'stdout') {
            const existing = workerOutputAccumulator.get(phaseId) ?? '';
            if (existing.length + chunk.length <= MAX_ACCUMULATOR_SIZE) {
                workerOutputAccumulator.set(phaseId, existing + chunk);
            } else if (existing.length < MAX_ACCUMULATOR_SIZE) {
                const remaining = MAX_ACCUMULATOR_SIZE - existing.length;
                workerOutputAccumulator.set(phaseId, existing + chunk.slice(0, remaining));
            }
        }

        // S3 audit fix: Accumulate stderr for persistence (capped at 2 MB)
        if (stream === 'stderr') {
            const existing = workerStderrAccumulator.get(phaseId) ?? '';
            if (existing.length + chunk.length <= MAX_ACCUMULATOR_SIZE) {
                workerStderrAccumulator.set(phaseId, existing + chunk);
            } else if (existing.length < MAX_ACCUMULATOR_SIZE) {
                const remaining = MAX_ACCUMULATOR_SIZE - existing.length;
                workerStderrAccumulator.set(phaseId, existing + chunk.slice(0, remaining));
            }
        }

        // F-5 audit fix: Start incremental flush interval if not already running
        if (!flushIntervals.has(phaseId) && mcpServer) {
            const interval = setInterval(() => {
                const accOut = workerOutputAccumulator.get(phaseId) ?? '';
                const accErr = workerStderrAccumulator.get(phaseId) ?? '';
                if (accOut || accErr) {
                    const rb = engine.getRunbook() ?? null;
                    const pObj = rb?.phases.find(p => p.id === phaseId);
                    if (pObj?.mcpPhaseId) {
                        mcpServer.upsertWorkerOutput(sessionDirName, pObj.mcpPhaseId, accOut, accErr);
                        log.debug(`[EngineWiring] F-5: Incremental flush for phase ${phaseId} (${accOut.length + accErr.length} bytes)`);
                    }
                }
            }, INCREMENTAL_FLUSH_MS);
            flushIntervals.set(phaseId, interval);
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
                    await agent.saveReport(evtSessionDir, report, mcpBridge, sessionDirName, svc.storageBase);
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
 *
 * @param workspaceRoots  All active workspace roots (defaults to [workspaceRoot]).
 */
async function executePhase(
    svc: ServiceContainer,
    phase: Phase,
    workspaceRoot: string,
    timeoutMs: number,
    masterTaskId: string,
    workspaceRoots: string[] = [workspaceRoot]
): Promise<void> {
    const { engine, contextScoper, adkController, logger, handoffExtractor, currentSessionDir } = svc;

    // Guard against stale healing timer fires after abort/reset.
    // Allow ERROR_PAUSED → RETRY transition for self-healing retries
    // (e.g. timeout/crash auto-retry fires after FSM reached ERROR_PAUSED).
    const engineState = engine?.getState();
    if (engineState === EngineState.ERROR_PAUSED) {
        const retryResult = engine?.transition(EngineEvent.RETRY);
        if (retryResult === null) {
            log.warn(`[Coogent] Skipping phase ${phase.id} execution — RETRY transition from ERROR_PAUSED rejected`);
            return;
        }
    } else if (engineState !== EngineState.EXECUTING_WORKER) {
        log.warn(`[Coogent] Skipping phase ${phase.id} execution — engine not in EXECUTING_WORKER (state: ${engineState})`);
        return;
    }

    if (!contextScoper || !adkController || !logger) {
        engine?.onWorkerFailed(phase.id, 'crash').catch(log.onError);
        return;
    }

    // Step 0: Log phase start
    await logger.logPhaseStart(phase.id);

    // Step 1: Assemble context
    // Multi-root: prefer assembleMultiRoot if the scoper supports it,
    // otherwise fall back to single-root assemble.
    const result = (contextScoper as any).assembleMultiRoot
        ? await (contextScoper as any).assembleMultiRoot(phase, workspaceRoots)
        : await contextScoper.assemble(phase, workspaceRoot);

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

    // Step 5.5: Build handoff context from dependent phases.
    //
    // LF-2 NOTE — Dual-Path Context Injection (intentional design):
    //   PATH A (inline metadata): `buildNextContext()` loads handoff metadata
    //          (decisions, issues, next_steps) and emits Pull Model file-fetch
    //          directives. This is injected directly into the effective prompt.
    //   PATH B (MCP warm-start URIs): `mcpResourceUris.parentHandoffs` provides
    //          `coogent://` URIs that workers can read via MCP read_resource.
    //   Both paths coexist: Path A gives immediate context, Path B enables
    //   on-demand retrieval. Consolidation into MCP-only is a V2 consideration.
    let handoffContext = '';
    if (handoffExtractor && currentSessionDir) {
        try {
            handoffContext = await handoffExtractor.buildNextContext(phase);
        } catch (err) {
            log.error('[Coogent] Failed to build handoff context:', err);
        }
    }

    // CF-2 FIX: Token budget accounting for handoffContext.
    // After the Pull Model fix (CF-1), handoffContext contains only metadata
    // and file-pointer directives (~2K tokens typical). This guard catches
    // edge cases where many parents produce excessive metadata.
    const HANDOFF_TOKEN_CAP = 30_000; // Reserve 70K for context_files + prompt
    const CHARS_PER_TOKEN = 4;
    const handoffTokenEstimate = Math.ceil(handoffContext.length / CHARS_PER_TOKEN);
    if (handoffTokenEstimate > HANDOFF_TOKEN_CAP) {
        log.warn(
            `[EngineWiring] Phase ${phase.id}: handoffContext exceeds token cap ` +
            `(~${handoffTokenEstimate} tokens > ${HANDOFF_TOKEN_CAP}). Truncating.`
        );
        MissionControlPanel.broadcast({
            type: 'LOG_ENTRY',
            payload: {
                timestamp: asTimestamp(),
                level: 'warn',
                message: `⚠ Phase ${phase.id}: handoff context truncated (~${handoffTokenEstimate} tokens > ${HANDOFF_TOKEN_CAP} cap).`,
            },
        });
        // Truncate to cap — use character count to stay within budget
        handoffContext = handoffContext.slice(0, HANDOFF_TOKEN_CAP * CHARS_PER_TOKEN);
    }

    // Step 5.6: Resolve agent profile from AgentRegistry
    let workerSystemContext = '';
    if (svc.agentRegistry) {
        try {
            const agentProfile = await svc.agentRegistry.getBestAgent(phase.required_skills ?? []);
            log.info(`[EngineWiring] Phase ${phase.id}: routed to agent '${agentProfile.id}' (${agentProfile.name})`);
            workerSystemContext = `## Worker Role: ${agentProfile.name}\n${agentProfile.system_prompt}\n\n`;

            // Derive plan requirement from agent's default_output
            const NON_PLAN_OUTPUTS = new Set(['review_report', 'research_summary', 'debug_report', 'task_graph']);
            const planRequired = !NON_PLAN_OUTPUTS.has(agentProfile.default_output);
            if (svc.mcpServer && phase.mcpPhaseId) {
                svc.mcpServer.setPhasePlanRequired(masterTaskId, phase.mcpPhaseId, planRequired);
            }
        } catch (err) {
            log.warn(`[EngineWiring] Phase ${phase.id}: AgentRegistry lookup failed, using default prompt`, err);
        }
    } else {
        log.debug(`[EngineWiring] Phase ${phase.id}: agentRegistry not available — skipping skill routing`);
    }

    // Step 6: Build effective prompt
    const distillationPrompt = handoffExtractor?.generateDistillationPrompt(phase.id as number) ?? '';
    let effectivePrompt = phase.prompt;
    if (workerSystemContext) {
        effectivePrompt = `${workerSystemContext}${effectivePrompt}`;
    }
    if (handoffContext) {
        effectivePrompt = `# Context from Previous Phases\n\n${handoffContext}\n---\n\n${effectivePrompt}`;
    }
    if (distillationPrompt) {
        effectivePrompt = `${effectivePrompt}\n\n---\n\n${distillationPrompt}`;
    }
    const effectivePhase = { ...phase, prompt: effectivePrompt };

    // S2 audit fix: Persist the effective prompt (includes handoff context, worker
    // system prompt, and distillation directives) to phase_logs.request_context.
    if (svc.mcpServer && phase.mcpPhaseId) {
        svc.mcpServer.upsertPhaseLog(masterTaskId, phase.mcpPhaseId, {
            requestContext: effectivePrompt,
        });
    }

    // MCP warm-start URIs
    const mcpResourceUris: {
        implementationPlan?: string;
        parentHandoffs?: string[];
    } = {
        implementationPlan: RESOURCE_URIS.taskPlan(masterTaskId),
    };

    if (phase.depends_on && (phase.depends_on as unknown[]).length > 0 && engine) {
        const rb = engine.getRunbook();
        // LF-3 FIX: O(1) Map lookup for phase resolution instead of O(n) find().
        // Consistent with the Map-based pattern used in Scheduler.getReadyPhases().
        const phaseMap = new Map(rb?.phases.map(p => [p.id, p]) ?? []);
        const parentHandoffs: string[] = [];
        for (const parentId of phase.depends_on) {
            const parentPhase = phaseMap.get(parentId);
            // MF-3 FIX: Defense-in-depth — check parent is completed AND has mcpPhaseId.
            // Log a warning if either is missing so silent context loss is visible.
            if (parentPhase?.mcpPhaseId && parentPhase.status === 'completed') {
                parentHandoffs.push(RESOURCE_URIS.phaseHandoff(masterTaskId, parentPhase.mcpPhaseId));
            } else {
                log.warn(
                    `[EngineWiring] Phase ${phase.id}: parent ${parentId} missing mcpPhaseId ` +
                    `or not completed (status=${parentPhase?.status}, mcpPhaseId=${parentPhase?.mcpPhaseId})`
                );
            }
        }
        if (parentHandoffs.length > 0) {
            mcpResourceUris.parentHandoffs = parentHandoffs;
        }
    }

    await adkController.spawnWorker(effectivePhase, timeoutMs, masterTaskId, mcpResourceUris);
}
