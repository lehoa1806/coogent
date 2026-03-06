// ─────────────────────────────────────────────────────────────────────────────
// src/PlannerWiring.ts — PlannerAgent ↔ Engine ↔ MCP event subscriptions
// ─────────────────────────────────────────────────────────────────────────────
// R1 refactor: Extracted from extension.ts activate() (lines 667–738).

import { MissionControlPanel } from './webview/MissionControlPanel.js';
import { buildImplementationPlanMarkdown } from './utils/planMarkdown.js';
import log from './logger/log.js';
import type { ServiceContainer } from './ServiceContainer.js';

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
    const { engine, plannerAgent, mcpBridge } = svc;
    if (!engine || !plannerAgent) return;

    // ── Engine → PlannerAgent ──────────────────────────────────────────
    engine.on('plan:request', (prompt: string) => {
        plannerAgent.plan(prompt).catch(log.onError);
    });

    engine.on('plan:rejected', (prompt: string, feedback: string) => {
        plannerAgent.plan(prompt, feedback).catch(log.onError);
    });

    engine.on('plan:retryParse', () => {
        plannerAgent.retryParse().catch(log.onError);
    });

    // ── PlannerAgent → Engine ──────────────────────────────────────────
    plannerAgent.on('plan:generated', (draft, fileTree) => {
        engine.planGenerated(draft, fileTree);

        // Broadcast planning summary to webview
        MissionControlPanel.broadcast({
            type: 'PLAN_SUMMARY',
            payload: {
                summary: draft.summary || draft.project_id,
            },
        });

        // Store the plan in MCP state (canonical source)
        if (mcpBridge) {
            const implPlanContent = buildImplementationPlanMarkdown(draft);
            mcpBridge.submitImplementationPlan(sessionDirName, implPlanContent)
                .then(() => log.info('[Coogent] Implementation plan stored in MCP state.'))
                .catch(err => log.error('[Coogent] Failed to store implementation plan in MCP:', err));
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
