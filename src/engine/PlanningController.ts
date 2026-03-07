// ─────────────────────────────────────────────────────────────────────────────
// src/engine/PlanningController.ts — Conversational runbook generation flow
// ─────────────────────────────────────────────────────────────────────────────
// Sprint 1 Extract: Planning cluster from Engine.ts.
// Manages IDLE → PLANNING → PLAN_REVIEW → PARSING lifecycle.

import log from '../logger/log.js';
import { EngineState, EngineEvent } from '../types/index.js';
import type { Runbook } from '../types/index.js';
import type { Engine } from './Engine.js';

/**
 * Extracted planning-flow logic from Engine.
 *
 * All FSM transitions and event emissions are delegated back to the owning
 * Engine via its public API so the FSM remains the single source of truth.
 */
export class PlanningController {
    private planDraft: Runbook | null = null;
    private planPrompt = '';

    constructor(private readonly engine: Engine) { }

    // ── Accessors (used by Engine delegation) ──────────────────────────────

    public getPlanDraft(): Runbook | null {
        return this.planDraft;
    }

    public updatePlanDraft(draft: Runbook): void {
        this.planDraft = draft;
    }

    public getPlanPrompt(): string {
        return this.planPrompt;
    }

    // ── Commands ────────────────────────────────────────────────────────────

    /**
     * User submitted a prompt — start the planning flow.
     * Transitions IDLE → PLANNING and emits 'plan:request'.
     */
    public planRequest(prompt: string): void {
        this.planPrompt = prompt;
        this.planDraft = null;

        const result = this.engine.transition(EngineEvent.PLAN_REQUEST);
        if (result === null) return;

        this.engine.emitUIMessage({
            type: 'PLAN_STATUS',
            payload: { status: 'generating', message: 'Planning started...' },
        });
        this.engine.emitUIMessage({
            type: 'STATE_SNAPSHOT',
            payload: {
                runbook: this.engine.getRunbook() ?? { project_id: '', status: 'idle', current_phase: 0, phases: [] },
                engineState: this.engine.getState(),
            },
        });

        this.engine.emit('plan:request', prompt);
    }

    /**
     * Planner agent produced a draft runbook.
     * Transitions PLANNING → PLAN_REVIEW.
     */
    public planGenerated(draft: Runbook, fileTree: string[]): void {
        this.planDraft = draft;

        const result = this.engine.transition(EngineEvent.PLAN_GENERATED);
        if (result === null) return;

        this.engine.emitUIMessage({
            type: 'PLAN_DRAFT',
            payload: { draft, fileTree },
        });
        this.engine.emitUIMessage({
            type: 'STATE_SNAPSHOT',
            payload: {
                runbook: draft,
                engineState: this.engine.getState(),
            },
        });
    }

    /**
     * User approved the AI-generated plan.
     * Saves draft to disk and transitions PLAN_REVIEW → PARSING.
     */
    public async planApproved(): Promise<void> {
        if (!this.planDraft) {
            this.engine.emit('error', new Error('Cannot approve: no draft available.'));
            return;
        }

        // Save the draft as the active runbook
        await this.engine.getStateManager().saveRunbook(this.planDraft, this.engine.getState());

        // M1 audit fix: Emit plan:approved so PlannerWiring can persist the
        // approved revision to plan_revisions with status='approved'.
        this.engine.emit('plan:approved', this.planDraft);

        // Transition to PARSING and load the saved runbook
        const result = this.engine.transition(EngineEvent.PLAN_APPROVED);
        if (result === null) return;

        // Load and validate the saved runbook (reuses existing loadRunbook logic)
        try {
            const runbook = await this.engine.getStateManager().loadRunbook();
            if (!runbook) {
                this.engine.transition(EngineEvent.PARSE_FAILURE);
                return;
            }
            this.engine.setRunbook(runbook);
            this.engine.transition(EngineEvent.PARSE_SUCCESS);

            this.engine.emitUIMessage({
                type: 'STATE_SNAPSHOT',
                payload: { runbook, engineState: this.engine.getState() },
            });
        } catch (err) {
            this.engine.transition(EngineEvent.PARSE_FAILURE);
            this.engine.emitUIMessage({
                type: 'ERROR',
                payload: {
                    code: 'PARSE_ERROR',
                    message: err instanceof Error ? err.message : String(err),
                },
            });
        }
    }

    /**
     * User rejected the plan — re-plan with feedback.
     * Transitions PLAN_REVIEW → PLANNING and emits 'plan:rejected'.
     */
    public planRejected(feedback: string): void {
        const result = this.engine.transition(EngineEvent.PLAN_REJECTED);
        if (result === null) return;

        this.engine.emitUIMessage({
            type: 'PLAN_STATUS',
            payload: { status: 'generating', message: 'Re-planning with feedback...' },
        });

        this.engine.emit('plan:rejected', this.planPrompt, feedback);
    }

    /**
     * User wants to retry parsing cached timeout output.
     * Only valid while in PLANNING state.
     */
    public planRetryParse(): void {
        if (this.engine.getState() !== EngineState.PLANNING && this.engine.getState() !== EngineState.IDLE) {
            log.warn(`[PlanningController] planRetryParse() rejected: engine is in state "${this.engine.getState()}"`);
            return;
        }

        this.engine.emit('plan:retryParse');
    }

    /**
     * Reset planning state. Called by Engine.reset().
     */
    public reset(): void {
        this.planDraft = null;
        this.planPrompt = '';
    }
}
