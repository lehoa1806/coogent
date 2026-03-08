// ─────────────────────────────────────────────────────────────────────────────
// src/engine/EvaluationOrchestrator.ts — Phase result evaluation pipeline
// ─────────────────────────────────────────────────────────────────────────────
// Sprint 1 Extract: Evaluation cluster from Engine.ts.
// Handles onWorkerExited, evaluatePhaseResult, applyVerdict, applyVerdictInPlace.

import log from '../logger/log.js';
import { EngineEvent, asTimestamp } from '../types/index.js';
import type { Phase, EvaluationResult } from '../types/index.js';
import type { Engine } from './Engine.js';
import type { SelfHealingController } from './SelfHealing.js';
import type { EvaluatorRegistryV2 } from '../evaluators/EvaluatorRegistry.js';
import type { ArtifactDB } from '../mcp/ArtifactDB.js';

/**
 * Extracted evaluation logic from Engine.
 *
 * Responsible for evaluating worker exit results and applying verdicts
 * (pass/fail/retry). Manages the self-healing retry pipeline.
 */
export class EvaluationOrchestrator {
    private db: ArtifactDB | undefined;
    private masterTaskId: string = '';

    constructor(
        private readonly engine: Engine,
        private readonly healer: SelfHealingController,
        private readonly evaluatorRegistry: EvaluatorRegistryV2 | null,
    ) { }

    /**
     * S3 audit fix: Inject DB instance for persisting evaluation results.
     */
    setArtifactDB(db: ArtifactDB, masterTaskId: string): void {
        this.db = db;
        this.masterTaskId = masterTaskId;
    }

    /**
     * Called when a worker exits. Drives evaluation → verdict → advance.
     * AB-1: In parallel mode, the FSM transition to EVALUATING only fires
     * when the *last* active worker exits.
     *
     * B-1 fix: Serialization is handled by the Engine's workerExitLock.
     * This method is called from within that lock.
     */
    public async handleWorkerExited(
        phaseId: number,
        exitCode: number,
        stdout: string,
        stderr: string,
        isLastWorker: boolean,
    ): Promise<void> {
        const runbook = this.engine.getRunbook();
        if (!runbook) return;

        const phase = runbook.phases.find(p => p.id === phaseId);
        if (!phase || phase.status !== 'running') return;

        const result = await this.evaluatePhaseResult(phase, exitCode, stdout, stderr);

        if (isLastWorker) {
            this.engine.transition(EngineEvent.WORKER_EXITED);
            await this.applyVerdict(phase, result, exitCode, stderr);
        } else {
            await this.applyVerdictInPlace(phase, result, exitCode, stderr);
        }
    }

    /**
     * Evaluate a phase's success criteria against the worker's output.
     * Uses the pluggable EvaluatorRegistry when available,
     * falling back to simple exit code matching.
     */
    public async evaluatePhaseResult(
        phase: Phase,
        exitCode: number,
        stdout: string,
        stderr: string,
    ): Promise<EvaluationResult> {
        if (this.evaluatorRegistry) {
            const evaluators = this.evaluatorRegistry.getEvaluators(phase);

            // Composite: run all evaluators, fail fast on first failure
            const retryParts: string[] = [];
            for (const evaluator of evaluators) {
                const result = await evaluator.evaluate(phase, exitCode, stdout, stderr);
                log.info(`[EvaluationOrchestrator] Evaluator (${evaluator.type}) verdict: ${result.passed ? 'PASS' : 'FAIL'} — ${result.reason}`);

                if (!result.passed) {
                    if (result.retryPrompt) retryParts.push(result.retryPrompt);
                    return {
                        passed: false as const,
                        reason: result.reason,
                        ...(retryParts.length > 0 ? { retryPrompt: retryParts.join('\n---\n') } : {}),
                    };
                }
            }

            return {
                passed: true,
                reason: evaluators.length > 1
                    ? `All ${evaluators.length} evaluators passed.`
                    : evaluators[0] ? `Evaluator (${evaluators[0].type}) passed.` : 'Passed.',
            };
        }

        // Fallback: simple exit code matching (V1 compat)
        const passed = this.evaluateSuccess(phase.success_criteria, exitCode);
        const reason = passed
            ? `Exit code ${exitCode} matches criteria.`
            : `Exit code ${exitCode} does not match criteria "${phase.success_criteria}".`;

        if (passed) {
            return { passed: true, reason };
        }

        const trimmedStderr = stderr.slice(-4096);
        return {
            passed: false,
            reason,
            ...(trimmedStderr ? { retryPrompt: trimmedStderr } : {}),
        };
    }

    /**
     * Apply the evaluation verdict: update phase/runbook state, handle
     * self-healing retries, and advance the schedule on success.
     */
    public async applyVerdict(
        phase: Phase,
        result: EvaluationResult,
        exitCode: number,
        stderr: string,
    ): Promise<void> {
        const runbook = this.engine.getRunbook();
        if (!runbook) return;

        if (result.passed) {
            // S3 audit fix: Persist evaluation result (passed)
            this.persistEvaluationResult(phase, result);

            phase.status = 'completed';
            this.healer.clearAttempts(phase.id);
            this.engine.emitUIMessage({
                type: 'PHASE_STATUS',
                payload: { phaseId: phase.id, status: 'completed' },
            });

            // Emit checkpoint event for GitManager
            this.engine.emit('phase:checkpoint', phase.id);

            // Check if all phases are done (DAG-aware)
            const allDone = this.engine.getScheduler().isAllDone(runbook.phases);

            if (allDone) {
                const hasFailed = runbook.phases.some(p => p.status === 'failed');
                if (hasFailed) {
                    runbook.status = 'paused_error';
                    this.engine.transition(EngineEvent.PHASE_FAIL);
                    await this.engine.persist();
                    this.engine.emitUIMessage({
                        type: 'STATE_SNAPSHOT',
                        payload: { runbook, engineState: this.engine.getState() },
                    });
                    return;
                }
                runbook.status = 'completed';
                this.engine.transition(EngineEvent.ALL_PHASES_PASS);
                await this.engine.persist();
                this.engine.emit('run:completed', runbook);
                this.engine.emit('run:consolidate', this.engine.getStateManager().getSessionDir());
                this.engine.emitUIMessage({
                    type: 'STATE_SNAPSHOT',
                    payload: { runbook, engineState: this.engine.getState() },
                });
                return;
            }

            // Advance: use DAG scheduler to find next ready phases
            this.engine.transition(EngineEvent.PHASE_PASS);
            await this.engine.persist();
            this.engine.advanceSchedule();
        } else {
            this.handleFailure(phase, result, exitCode, stderr);
        }
    }

    /**
     * Apply a verdict while other workers are still running (AB-1 parallel mode).
     */
    private async applyVerdictInPlace(
        phase: Phase,
        result: EvaluationResult,
        exitCode: number,
        stderr: string,
    ): Promise<void> {
        const runbook = this.engine.getRunbook();
        if (!runbook) return;

        if (result.passed) {
            // F-1 audit fix: Persist evaluation result in parallel mode (was missing)
            this.persistEvaluationResult(phase, result);

            phase.status = 'completed';
            this.healer.clearAttempts(phase.id);
            this.engine.emitUIMessage({
                type: 'PHASE_STATUS',
                payload: { phaseId: phase.id, status: 'completed' },
            });
            this.engine.emit('phase:checkpoint', phase.id);
            await this.engine.persist();

            // Dispatch any newly-unblocked phases from this completion
            this.engine.dispatchReadyPhases();
        } else {
            // F-1 audit fix: Persist evaluation result in parallel mode (was missing)
            this.persistEvaluationResult(phase, result);

            this.healer.recordFailure(phase.id, exitCode, stderr, phase.mcpPhaseId);

            if (this.healer.canRetryWithPhase(phase)) {
                const augmentedPrompt = result.retryPrompt
                    ? this.healer.buildHealingPromptWithContext(phase, result.retryPrompt)
                    : this.healer.buildHealingPrompt(phase);
                const delay = this.healer.getRetryDelay(phase.id);
                phase.status = 'pending';
                await this.engine.persist();
                const timer = setTimeout(() => {
                    this.engine.removeHealingTimer(timer);
                    this.engine.emit('phase:heal', phase, augmentedPrompt);
                }, delay);
                this.engine.addHealingTimer(timer);
                return;
            }

            phase.status = 'failed';
            await this.engine.persist();
            this.engine.emitUIMessage({
                type: 'PHASE_STATUS',
                payload: { phaseId: phase.id, status: 'failed' },
            });
            this.engine.emitUIMessage({
                type: 'ERROR',
                payload: {
                    code: 'PHASE_FAILED',
                    message: `Phase ${phase.id} failed (exit code ${exitCode}). Other workers still running.`,
                    phaseId: phase.id,
                },
            });
        }
    }

    /**
     * Handle a failed evaluation (shared by applyVerdict).
     */
    private async handleFailure(
        phase: Phase,
        result: EvaluationResult,
        exitCode: number,
        stderr: string,
    ): Promise<void> {
        const runbook = this.engine.getRunbook();
        if (!runbook) return;

        this.healer.recordFailure(phase.id, exitCode, stderr, phase.mcpPhaseId);

        // S3 audit fix: Persist evaluation result (failed)
        this.persistEvaluationResult(phase, result);

        if (this.healer.canRetryWithPhase(phase)) {
            const augmentedPrompt = result.retryPrompt
                ? this.healer.buildHealingPromptWithContext(phase, result.retryPrompt)
                : this.healer.buildHealingPrompt(phase);
            const delay = this.healer.getRetryDelay(phase.id);
            const attempt = this.healer.getAttemptCount(phase.id);

            this.engine.emitUIMessage({
                type: 'LOG_ENTRY',
                payload: {
                    timestamp: asTimestamp(),
                    level: 'warn',
                    message: `Phase ${phase.id} failed — auto-retrying (attempt ${attempt}, delay ${delay}ms)…`,
                },
            });

            this.engine.transition(EngineEvent.PHASE_FAIL);
            phase.status = 'pending';
            await this.engine.persist();

            const timer = setTimeout(() => {
                this.engine.removeHealingTimer(timer);
                this.engine.emit('phase:heal', phase, augmentedPrompt);
            }, delay);
            this.engine.addHealingTimer(timer);
            return;
        }

        // Max retries exhausted — surface to user
        phase.status = 'failed';
        runbook.status = 'paused_error';
        this.engine.transition(EngineEvent.PHASE_FAIL);
        await this.engine.persist();

        this.engine.emitUIMessage({
            type: 'PHASE_STATUS',
            payload: { phaseId: phase.id, status: 'failed' },
        });
        this.engine.emitUIMessage({
            type: 'ERROR',
            payload: {
                code: 'PHASE_FAILED',
                message: `Phase ${phase.id} failed after ${this.healer.getAttemptCount(phase.id)} attempts (exit code ${exitCode}).`,
                phaseId: phase.id,
            },
        });
    }

    /**
     * Called when a worker times out or crashes (not a normal exit).
     * Marks the phase as failed and transitions FSM if this is the last worker.
     *
     * B-1 fix: Serialization is handled by the Engine's workerExitLock.
     * This method is called from within that lock.
     */
    public async handleWorkerFailed(
        phase: import('../types/index.js').Phase,
        isLastWorker: boolean,
        reason: 'timeout' | 'crash',
    ): Promise<void> {
        const runbook = this.engine.getRunbook();
        if (!runbook) return;

        phase.status = 'failed';

        this.engine.emitUIMessage({
            type: 'PHASE_STATUS',
            payload: { phaseId: phase.id, status: 'failed' },
        });

        if (isLastWorker) {
            const event = reason === 'timeout'
                ? EngineEvent.WORKER_TIMEOUT
                : EngineEvent.WORKER_CRASH;
            this.engine.transition(event);
            runbook.status = 'paused_error';
            this.engine.stopStallWatchdog();
            await this.engine.persist();
        } else {
            await this.engine.persist();
            this.engine.dispatchReadyPhases();
        }

        this.engine.emitUIMessage({
            type: 'ERROR',
            payload: {
                code: reason === 'timeout' ? 'WORKER_TIMEOUT' : 'WORKER_CRASH',
                message: `Worker for phase ${phase.id} ${reason === 'timeout' ? 'timed out' : 'crashed'}.`,
                phaseId: phase.id,
            },
        });
    }

    /**
     * Evaluate success criteria against a worker's exit code.
     * V1: Simple exit code matching.
     */
    private evaluateSuccess(criteria: string, exitCode: number): boolean {
        if (criteria.startsWith('exit_code:')) {
            const expected = parseInt(criteria.split(':')[1], 10);
            return exitCode === expected;
        }
        if (criteria !== '' && !criteria.startsWith('exit_code:')) {
            log.warn(`[EvaluationOrchestrator] Unrecognized success_criteria "${criteria}" — falling back to exit_code:0`);
        }
        return exitCode === 0;
    }

    /**
     * S3 audit fix: Persist evaluation result to DB (best-effort).
     */
    private persistEvaluationResult(phase: Phase, result: EvaluationResult): void {
        if (!this.db || !this.masterTaskId) return;
        try {
            const phaseIdStr = phase.mcpPhaseId ?? `phase-${String(phase.id).padStart(3, '0')}`;
            const attempt = this.healer.getAttemptCount(phase.id) || 1;
            this.db.verdicts.upsertEvaluation(this.masterTaskId, phaseIdStr, {
                attempt,
                passed: result.passed,
                reason: result.reason,
                ...(result.retryPrompt != null ? { retryPrompt: result.retryPrompt } : {}),
                evaluatedAt: Date.now(),
            });
        } catch (err) {
            log.warn('[EvaluationOrchestrator] Failed to persist evaluation result:', err);
        }
    }
}
