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
import { getDebugDir } from './constants/paths.js';
import type { Runbook } from './types/index.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  wirePlanner — connects PlannerAgent events to Engine and MCP
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Wire PlannerAgent events to the Engine and MCP bridge.
 *
 * @param svc            The shared service container.
 * @param sessionDirName The current session directory basename (masterTaskId).
 */
export function wirePlanner(
    svc: ServiceContainer,
    sessionDirName: string
): void {
    const { engine, plannerAgent, mcpBridge, mcpServer } = svc;
    if (!engine || !plannerAgent) return;

    // ── Engine → PlannerAgent ──────────────────────────────────────────
    engine.on('plan:request', (prompt: string) => {
        (async () => {
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
            mcpServer?.upsertSummary(sessionDirName, prompt);

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
            // (previously written to <sessionDir>/debug/ which is under IPC)
            if (svc.stateManager && svc.storageBase) {
                const debugDir = getDebugDir(svc.storageBase, sessionDirName);
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
                        db.audits.upsertPlanRevision(sessionDirName, {
                            feedback,
                            draftJson: JSON.stringify(currentDraft),
                            implementationPlanMd: implPlanMd,
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
                    db.audits.upsertPlanRevision(sessionDirName, {
                        draftJson: JSON.stringify(approvedDraft),
                        implementationPlanMd: buildImplementationPlanMarkdown(approvedDraft),
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

        // S2 audit fix: Persist the planner system prompt for prompt lineage
        if (mcpServer) {
            const plannerPrompt = plannerAgent.getLastSystemPrompt();
            if (plannerPrompt) {
                mcpServer.upsertPhaseLog(sessionDirName, 'phase-000-planner', {
                    prompt: plannerPrompt,
                    startedAt: Date.now(),
                });
            }

            // S5 audit fix: Persist initial draft as plan revision (v1)
            const db: ArtifactDB | undefined = mcpServer.getArtifactDB?.();
            if (db) {
                try {
                    db.audits.upsertPlanRevision(sessionDirName, {
                        draftJson: JSON.stringify(draft),
                        implementationPlanMd: buildImplementationPlanMarkdown(draft),
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
            mcpBridge.submitImplementationPlan(sessionDirName, implPlanContent)
                .then(() => log.info('[Coogent] Implementation plan stored in MCP state.'))
                .catch(err => log.error('[Coogent] Failed to store implementation plan in MCP:', err));

            // F-4 audit fix: Write debug clones outside IPC tree
            if (svc.storageBase) {
                const debugDir = getDebugDir(svc.storageBase, sessionDirName);
                fs.mkdir(debugDir, { recursive: true })
                    .then(() => fs.writeFile(path.join(debugDir, 'implementation-plan.md'), implPlanContent, 'utf-8'))
                    .catch(err => log.warn('[PlannerWiring] Debug clone (impl plan) failed (non-fatal):', err));
            }
        }
    });

    plannerAgent.on('plan:error', (error) => {
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
