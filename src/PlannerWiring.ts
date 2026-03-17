// ─────────────────────────────────────────────────────────────────────────────
// src/PlannerWiring.ts — PlannerAgent ↔ Engine ↔ MCP event subscriptions
// ─────────────────────────────────────────────────────────────────────────────
// R1 refactor: Extracted from extension.ts activate() (lines 667–738).

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { MissionControlPanel } from './webview/MissionControlPanel.js';
import { buildImplementationPlanMarkdown } from './utils/planMarkdown.js';
import log from './logger/log.js';
import type { ServiceContainer } from './ServiceContainer.js';
import type { ArtifactDB } from './mcp/ArtifactDB.js';
import { getDebugDir, IPC_RESPONSE_FILE } from './constants/paths.js';
import type { Runbook, EngineState } from './types/index.js';
import { FailureClassifier } from './failure-console/FailureClassifier.js';
import { FailureAssembler } from './failure-console/FailureAssembler.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  wirePlanner — connects PlannerAgent events to Engine and MCP
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Wire PlannerAgent events to the Engine and MCP bridge.
 *
 * `sessionDirName` is read from `svc.currentSessionDirName` at event-fire time
 * (not captured at wire time) to support deferred session creation.
 *
 * @param svc The shared service container.
 */
export function wirePlanner(
    svc: ServiceContainer,
): void {
    const { engine, plannerAgent, mcpBridge, mcpServer } = svc;
    if (!engine || !plannerAgent) return;

    // Deferred session alias: read at call time from the mutable container.
    const getSessionDirName = () => svc.currentSessionDirName ?? '';

    // ── Engine → PlannerAgent ──────────────────────────────────────────
    engine.on('plan:request', (prompt: string) => {
        (async () => {
            // ── Deferred session init ──────────────────────────────────
            // Materialise the session on first plan:request so we don't
            // create orphan sessions when users open a workspace without
            // submitting a prompt.
            if (!svc.currentSessionDirName) {
                const { sessionId, sessionDirName, sessionDir } = svc.initSession();
                log.info(`[PlannerWiring] Deferred session created: ${sessionDirName}`);

                // Atomically switch all session state
                svc.switchSession({ sessionId, sessionDirName, sessionDir });

                // Late-bind ArtifactDB
                if (mcpServer) {
                    mcpServer.upsertSession(sessionDirName, sessionId, prompt, Date.now());
                    const db = mcpServer.getArtifactDB?.();
                    if (db) {
                        svc.stateManager?.setArtifactDB(db, sessionDirName);
                        svc.sessionManager?.setArtifactDB(db);
                        svc.handoffExtractor?.setArtifactDB(db, sessionDirName);
                        log.info('[PlannerWiring] StateManager + SessionManager + HandoffExtractor wired to ArtifactDB.');

                        // Wire FailureAssembler into EvaluationOrchestrator
                        try {
                            const classifier = new FailureClassifier();
                            const assembler = new FailureAssembler(classifier, db.failureConsole);
                            engine.getEvaluation().setFailureAssembler(assembler);
                            log.info('[PlannerWiring] FailureAssembler wired to EvaluationOrchestrator.');
                        } catch (err) {
                            log.warn('[PlannerWiring] Failed to wire FailureAssembler (non-fatal):', err);
                        }
                    }
                }

                // Refresh sidebar so the new session appears in history immediately
                svc.sidebarMenu?.refresh();
            }

            // Inject fresh available tags from AgentRegistry before planning
            if (svc.agentRegistry) {
                try {
                    const tags = await svc.agentRegistry.getAvailableTags();
                    plannerAgent.setAvailableTags(tags);
                    log.info(`[PlannerWiring] Injected ${tags.length} available tags into PlannerAgent`);
                } catch (err) {
                    log.warn('[PlannerWiring] Failed to fetch available tags — continuing without:', err);
                }
            }
            await plannerAgent.plan(prompt);
            // Persist the original prompt as the task summary in ArtifactDB
            mcpServer?.upsertSummary(getSessionDirName(), prompt);

            // S6a audit fix: Populate sessions.prompt with actual user prompt
            // (extension.ts initially persists '' because the prompt isn't known yet)
            if (mcpServer) {
                const latestSession = mcpServer.getLatestSession();
                if (latestSession) {
                    mcpServer.upsertSession(
                        latestSession.dirName,
                        latestSession.sessionId,
                        prompt,
                        latestSession.createdAt,
                    );
                }
            }

            // F-4 audit fix: Write debug clones outside IPC tree to .coogent/debug/<sessionDirName>/
            if (svc.stateManager && svc.coogentDir) {
                const debugDir = getDebugDir(svc.coogentDir, getSessionDirName());
                fs.mkdir(debugDir, { recursive: true })
                    .then(() => fs.writeFile(path.join(debugDir, 'prompt.md'), prompt, 'utf-8'))
                    .catch(err => log.warn('[PlannerWiring] Debug clone (prompt) failed (non-fatal):', err));
            }
        })().catch(log.onError);
    });

    engine.on('plan:rejected', (prompt: string, feedback: string) => {
        (async () => {
            // S5b audit fix: Persist current draft + feedback to plan_revisions
            // before re-planning, so we have a full audit trail of plan iterations
            const currentDraft = plannerAgent.getDraft();
            if (currentDraft && mcpServer) {
                const db: ArtifactDB | undefined = mcpServer.getArtifactDB?.();
                if (db) {
                    try {
                        const implPlanMd = buildImplementationPlanMarkdown(currentDraft);
                        db.audits.upsertPlanRevision(getSessionDirName(), {
                            feedback,
                            draftJson: JSON.stringify(currentDraft),
                            executionPlanMd: implPlanMd,
                        });
                        log.info('[PlannerWiring] Plan revision persisted (rejected draft + feedback).');
                    } catch (err) {
                        log.warn('[PlannerWiring] Failed to persist plan revision:', err);
                    }
                }
            }

            // Re-inject fresh tags on re-plan as well
            if (svc.agentRegistry) {
                try {
                    const tags = await svc.agentRegistry.getAvailableTags();
                    plannerAgent.setAvailableTags(tags);
                } catch {
                    // Best-effort — continue without tags
                }
            }
            await plannerAgent.plan(prompt, feedback);
        })().catch(log.onError);
    });

    engine.on('plan:retryParse', () => {
        plannerAgent.retryParse().catch(log.onError);
    });

    // M1 audit fix: Persist the approved plan revision with status='approved'
    engine.on('plan:approved', (approvedDraft: Runbook) => {
        if (mcpServer) {
            const db: ArtifactDB | undefined = mcpServer.getArtifactDB?.();
            if (db) {
                try {
                    db.audits.upsertPlanRevision(getSessionDirName(), {
                        draftJson: JSON.stringify(approvedDraft),
                        executionPlanMd: buildImplementationPlanMarkdown(approvedDraft),
                        status: 'approved',
                    });
                    log.info('[PlannerWiring] Approved plan revision persisted.');
                } catch (err) {
                    log.warn('[PlannerWiring] Failed to persist approved plan revision:', err);
                }
            }
        }
    });

    // ── PlannerAgent → Engine ──────────────────────────────────────────
    plannerAgent.on('plan:generated', (draft, fileTree) => {
        engine.planGenerated(draft, fileTree);

        // Wire HandoffExtractor phase lookup map so buildNextContext() can
        // resolve numeric depIds → mcpPhaseId strings for ArtifactDB queries.
        if (svc.handoffExtractor) {
            svc.handoffExtractor.setPhaseIdMap(
                draft.phases.map((p: { id: number; mcpPhaseId?: string }) => ({
                    id: p.id,
                    ...(p.mcpPhaseId !== undefined ? { mcpPhaseId: p.mcpPhaseId } : {}),
                })),
            );
        }

        // Log compilation manifest for observability (prompt compiler pipeline)
        const manifest = plannerAgent.getLastManifest();
        if (manifest) {
            log.info('[PlannerWiring] Prompt compilation manifest', manifest);
        }

        // Broadcast planning summary to webview
        MissionControlPanel.broadcast({
            type: 'PLAN_SUMMARY',
            payload: {
                summary: draft.summary || draft.project_id,
            },
        });

        // ── Runtime persistence: .task-runbook.json THEN response.md ──
        // Contract: .task-runbook.json must exist on disk before response.md,
        // because response.md is the completion signal for downstream consumers.
        // We await the runbook write, then fire-and-forget response.md.
        const rawOutput = plannerAgent.getLastRawOutput();

        // FR3: Persist the validated runbook first
        if (svc.stateManager) {
            svc.stateManager.saveRunbook(draft, 'PLAN_REVIEW' as EngineState)
                .then(() => {
                    log.info('[PlannerWiring] .task-runbook.json persisted (early write).');

                    // FR2: Only after the runbook is on disk, persist response.md
                    if (rawOutput && svc.currentSessionDir) {
                        const plannerPhaseDir = path.join(svc.currentSessionDir, 'phase-000-planner');
                        fs.mkdir(plannerPhaseDir, { recursive: true })
                            .then(() => fs.writeFile(path.join(plannerPhaseDir, IPC_RESPONSE_FILE), rawOutput, 'utf-8'))
                            .then(() => log.info('[PlannerWiring] Planner response.md persisted.'))
                            .catch(err => log.warn('[PlannerWiring] Failed to persist planner response.md (non-fatal):', err));
                    }
                })
                .catch(err => log.warn('[PlannerWiring] Failed to persist .task-runbook.json (non-fatal):', err));
        } else if (rawOutput && svc.currentSessionDir) {
            // No stateManager — fall back to writing response.md directly
            const plannerPhaseDir = path.join(svc.currentSessionDir, 'phase-000-planner');
            fs.mkdir(plannerPhaseDir, { recursive: true })
                .then(() => fs.writeFile(path.join(plannerPhaseDir, IPC_RESPONSE_FILE), rawOutput, 'utf-8'))
                .then(() => log.info('[PlannerWiring] Planner response.md persisted (no stateManager).'))
                .catch(err => log.warn('[PlannerWiring] Failed to persist planner response.md (non-fatal):', err));
        }

        // S2 audit fix: Persist the planner system prompt for prompt lineage
        if (mcpServer) {
            const plannerPrompt = plannerAgent.getLastSystemPrompt();
            if (plannerPrompt) {
                mcpServer.upsertPhaseLog(getSessionDirName(), 'phase-000-planner', {
                    prompt: plannerPrompt,
                    startedAt: Date.now(),
                });
            }

            // S5 audit fix: Persist initial draft as plan revision (v1)
            const db: ArtifactDB | undefined = mcpServer.getArtifactDB?.();
            if (db) {
                try {
                    db.audits.upsertPlanRevision(getSessionDirName(), {
                        draftJson: JSON.stringify(draft),
                        executionPlanMd: buildImplementationPlanMarkdown(draft),
                        // BL-5 audit fix: Persist raw LLM output for audit trail
                        rawLlmOutput: plannerAgent.getLastRawOutput(),
                        // F-6 audit fix: Persist compilation manifest for auditability
                        ...(manifest ? { compilationManifest: JSON.stringify(manifest) } : {}),
                    });
                } catch (err) {
                    log.warn('[PlannerWiring] Failed to persist initial plan revision:', err);
                }
            }
        }

        // Store the plan in MCP state (canonical source)
        if (mcpBridge) {
            const implPlanContent = buildImplementationPlanMarkdown(draft);
            mcpBridge.submitImplementationPlan(getSessionDirName(), implPlanContent)
                .then(async () => {
                    log.info('[Coogent] Implementation plan stored in MCP state.');
                    // Force flush to disk so the stdio MCP server sees the plan
                    // when workers read it via MCP resource URIs.
                    await mcpServer?.forceFlush();
                })
                .catch(err => log.error('[Coogent] Failed to store implementation plan in MCP:', err));

            // F-4 audit fix: Write debug clones outside IPC tree
            if (svc.coogentDir) {
                const debugDir = getDebugDir(svc.coogentDir, getSessionDirName());
                fs.mkdir(debugDir, { recursive: true })
                    .then(() => fs.writeFile(path.join(debugDir, 'implementation-plan.md'), implPlanContent, 'utf-8'))
                    .catch(err => log.warn('[PlannerWiring] Debug clone (impl plan) failed (non-fatal):', err));
            }
        }
    });

    plannerAgent.on('plan:error', (error) => {
        // ── FR6: Failure traceability — persist raw output on error ────
        // If the planner produced any raw output before failing (e.g. malformed JSON),
        // persist it to response.md so the output is still inspectable for debugging.
        const rawOutput = plannerAgent.getLastRawOutput();
        if (rawOutput && svc.currentSessionDir) {
            const plannerPhaseDir = path.join(svc.currentSessionDir, 'phase-000-planner');
            fs.mkdir(plannerPhaseDir, { recursive: true })
                .then(() => fs.writeFile(path.join(plannerPhaseDir, IPC_RESPONSE_FILE), rawOutput, 'utf-8'))
                .then(() => log.info('[PlannerWiring] Planner response.md persisted on error (FR6).'))
                .catch(err => log.warn('[PlannerWiring] Failed to persist planner response.md on error (non-fatal):', err));
        }

        MissionControlPanel.broadcast({
            type: 'PLAN_STATUS',
            payload: { status: 'error', message: error.message },
        });
        MissionControlPanel.broadcast({
            type: 'ERROR',
            payload: { code: 'PLAN_ERROR', message: error.message },
        });
        engine.abort().catch(log.onError);
    });

    plannerAgent.on('plan:timeout', (hasOutput) => {
        const canRetry = hasOutput || plannerAgent.hasTimeoutOutput();
        MissionControlPanel.broadcast({
            type: 'PLAN_STATUS',
            payload: {
                status: 'timeout',
                message: canRetry
                    ? 'Planner timed out — click "Retry Parse" to check for the response file on disk.'
                    : 'Planner timed out with no output. Please regenerate the plan.',
            },
        });
        if (!canRetry) {
            engine.abort().catch(log.onError);
        }
    });

    plannerAgent.on('plan:status', (status, message) => {
        MissionControlPanel.broadcast({
            type: 'PLAN_STATUS',
            payload: { status, ...(message !== undefined && { message }) },
        });
    });
}
