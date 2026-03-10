// ─────────────────────────────────────────────────────────────────────────────
// src/session/SessionRestoreService.ts — Deterministic session restore
// ─────────────────────────────────────────────────────────────────────────────
//
// Replaces the old CommandRegistry swap-based session loading with a
// structured reset-and-rebuild flow:
//
//   1. Validate session health (SessionHealthValidator)
//   2. Resolve session directory
//   3. Create & bind a new StateManager
//   4. Switch the engine session (FSM reset + runbook load)
//   5. Reconstruct MCP TaskState (summary, implementation plan)
//   6. Collect worker outputs for UI hydration
//   7. Return a structured SessionRestoreResult
//
// Errors at each step are accumulated — the restore continues as far
// as possible so the caller receives maximum diagnostic information.
// ─────────────────────────────────────────────────────────────────────────────

import type { Engine } from '../engine/Engine.js';
import type { CoogentMCPServer } from '../mcp/CoogentMCPServer.js';
import { StateManager } from '../state/StateManager.js';
import { getSessionDir } from '../constants/paths.js';
import { SessionHealthValidator, type SessionHealthStatus } from './SessionHealthValidator.js';
import type { Runbook } from '../types/index.js';
import log from '../logger/log.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Types
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Structured result of a session restore attempt.
 *
 * `success` is `true` only when all critical steps (health check, engine
 * switch) completed without error.  Non-critical failures (e.g. missing
 * summary, no worker outputs) are recorded in `errors[]` but do not set
 * `success` to `false`.
 */
export interface SessionRestoreResult {
    success: boolean;
    sessionDirName: string;
    healthStatus: SessionHealthStatus;
    runbook: Runbook | null;
    workerOutputs: Record<string, string>;
    errors: string[];
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SessionRestoreService
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Orchestrates deterministic session restoration.
 *
 * Usage:
 * ```ts
 * const restorer = new SessionRestoreService(engine, mcpServer, coogentDir);
 * const result = await restorer.restore(sessionDirName);
 * if (!result.success) { … handle errors … }
 * ```
 */
export class SessionRestoreService {
    private readonly healthValidator: SessionHealthValidator;

    constructor(
        private readonly engine: Engine,
        private readonly mcpServer: CoogentMCPServer,
        private readonly coogentDir: string,
    ) {
        this.healthValidator = new SessionHealthValidator(
            mcpServer.getArtifactDB(),
        );
    }

    /**
     * Restore a persisted session through a deterministic multi-step flow.
     *
     * @param sessionDirName  Directory name identifying the session
     *                        (doubles as `masterTaskId` in the DB).
     * @returns A `SessionRestoreResult` describing the outcome.
     */
    public async restore(sessionDirName: string): Promise<SessionRestoreResult> {
        const errors: string[] = [];
        let healthStatus: SessionHealthStatus = 'invalid';
        let runbook: Runbook | null = null;
        let workerOutputs: Record<string, string> = {};

        log.info(`[SessionRestoreService] Starting restore for "${sessionDirName}"`);

        // ── Step 1: Validate session health ───────────────────────────────
        try {
            const healthResult = this.healthValidator.validate(sessionDirName);
            healthStatus = healthResult.status;

            if (healthResult.errors.length > 0) {
                errors.push(...healthResult.errors);
            }

            if (healthStatus === 'invalid') {
                log.error(`[SessionRestoreService] Session "${sessionDirName}" is invalid — aborting restore`);
                return {
                    success: false,
                    sessionDirName,
                    healthStatus,
                    runbook: null,
                    workerOutputs: {},
                    errors,
                };
            }

            log.info(`[SessionRestoreService] Health check passed: ${healthStatus}`);
        } catch (err: unknown) {
            const msg = `Health validation failed: ${err instanceof Error ? err.message : String(err)}`;
            errors.push(msg);
            log.error(`[SessionRestoreService] ${msg}`);
            return {
                success: false,
                sessionDirName,
                healthStatus: 'invalid',
                runbook: null,
                workerOutputs: {},
                errors,
            };
        }

        // ── Step 2: Resolve session directory ─────────────────────────────
        let sessionDir: string;
        try {
            sessionDir = getSessionDir(this.coogentDir, sessionDirName);
            log.info(`[SessionRestoreService] Session directory resolved: ${sessionDir}`);
        } catch (err: unknown) {
            const msg = `Failed to resolve session directory: ${err instanceof Error ? err.message : String(err)}`;
            errors.push(msg);
            log.error(`[SessionRestoreService] ${msg}`);
            return {
                success: false,
                sessionDirName,
                healthStatus,
                runbook: null,
                workerOutputs: {},
                errors,
            };
        }

        // ── Step 3: Create new StateManager and bind ArtifactDB ──────────
        let newStateManager: StateManager;
        try {
            newStateManager = new StateManager(sessionDir);
            newStateManager.setArtifactDB(
                this.mcpServer.getArtifactDB(),
                sessionDirName,
            );
            log.info(`[SessionRestoreService] StateManager created and ArtifactDB bound`);
        } catch (err: unknown) {
            const msg = `Failed to create StateManager: ${err instanceof Error ? err.message : String(err)}`;
            errors.push(msg);
            log.error(`[SessionRestoreService] ${msg}`);
            return {
                success: false,
                sessionDirName,
                healthStatus,
                runbook: null,
                workerOutputs: {},
                errors,
            };
        }

        // ── Step 4: Switch engine session ─────────────────────────────────
        try {
            await this.engine.switchSession(newStateManager);
            runbook = this.engine.getStateManager().getCachedRunbook();
            log.info(`[SessionRestoreService] Engine session switched successfully`);
        } catch (err: unknown) {
            const msg = `Engine switchSession failed: ${err instanceof Error ? err.message : String(err)}`;
            errors.push(msg);
            log.error(`[SessionRestoreService] ${msg}`);
            return {
                success: false,
                sessionDirName,
                healthStatus,
                runbook: null,
                workerOutputs: {},
                errors,
            };
        }

        // ── Step 5: Reconstruct MCP TaskState ─────────────────────────────
        try {
            const taskState = this.mcpServer.getTaskState(sessionDirName);

            if (taskState) {
                if (taskState.summary) {
                    this.mcpServer.upsertSummary(sessionDirName, taskState.summary);
                    log.info(`[SessionRestoreService] Summary restored for "${sessionDirName}"`);
                }

                // Implementation plan lives on the TaskState — re-upsert
                // is not needed because getTaskState reads directly from DB
                // and the MCP resource handler resolves it on demand.
                if (taskState.implementationPlan) {
                    log.info(`[SessionRestoreService] Implementation plan present for "${sessionDirName}"`);
                }
            } else {
                const msg = `No TaskState found in DB for "${sessionDirName}" — MCP state may be incomplete`;
                errors.push(msg);
                log.warn(`[SessionRestoreService] ${msg}`);
            }
        } catch (err: unknown) {
            const msg = `TaskState reconstruction failed: ${err instanceof Error ? err.message : String(err)}`;
            errors.push(msg);
            log.warn(`[SessionRestoreService] ${msg}`);
            // Non-critical — continue to worker output collection
        }

        // ── Step 6: Collect worker outputs for UI hydration ───────────────
        try {
            workerOutputs = this.mcpServer.getWorkerOutputs(sessionDirName);
            const phaseCount = Object.keys(workerOutputs).length;
            log.info(`[SessionRestoreService] Collected ${phaseCount} worker output(s) for UI hydration`);
        } catch (err: unknown) {
            const msg = `Failed to collect worker outputs: ${err instanceof Error ? err.message : String(err)}`;
            errors.push(msg);
            log.warn(`[SessionRestoreService] ${msg}`);
            // Non-critical — return empty outputs
        }

        // ── Step 7: Return structured result ──────────────────────────────
        const result: SessionRestoreResult = {
            success: true,
            sessionDirName,
            healthStatus,
            runbook,
            workerOutputs,
            errors,
        };

        log.info(
            `[SessionRestoreService] Restore complete for "${sessionDirName}" — ` +
            `status=${healthStatus}, runbook=${runbook ? 'present' : 'absent'}, ` +
            `outputs=${Object.keys(workerOutputs).length}, errors=${errors.length}`,
        );

        return result;
    }
}
