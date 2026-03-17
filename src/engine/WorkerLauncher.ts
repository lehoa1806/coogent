// ─────────────────────────────────────────────────────────────────────────────
// src/engine/WorkerLauncher.ts — Worker prompt assembly and spawn
// ─────────────────────────────────────────────────────────────────────────────
// Extracted from EngineWiring.executePhase() — Steps 4–6 + agent selection + spawn.

import { asTimestamp, type Phase } from '../types/index.js';
import { MissionControlPanel } from '../webview/MissionControlPanel.js';
import { RESOURCE_URIS } from '../mcp/types.js';
import { deriveWorkspaceId } from '../constants/WorkspaceIdentity.js';
import log from '../logger/log.js';
import type { ExecutionMode } from '../adk/ExecutionModeResolver.js';
import type { ServiceContainer } from '../ServiceContainer.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Types
// ═══════════════════════════════════════════════════════════════════════════════

/** Minimal interface for the telemetry logger dependency. */
export interface WorkerLauncherLogger {
    logPhasePrompt(phaseId: number, prompt: string): Promise<void>;
    initRun(projectId: string): Promise<void>;
}

/** Minimal interface for the handoff extractor dependency. */
export interface WorkerLauncherHandoffExtractor {
    buildNextContext(phase: Phase): Promise<string>;
    generateDistillationPrompt(phaseId: number): string;
}

/** Minimal interface for the agent registry dependency. */
export interface WorkerLauncherAgentRegistry {
    getBestAgent(skills: string[]): Promise<{
        id: string;
        name: string;
        system_prompt: string;
        default_output: string;
    }>;
}

/** Minimal interface for ADK controller used during launch. */
export interface WorkerLauncherADK {
    spawnWorker(
        phase: Phase,
        timeoutMs: number,
        masterTaskId?: string,
        mcpResourceUris?: {
            executionPlan?: string;
            parentHandoffs?: string[];
        },
    ): Promise<unknown>;
}

/** Minimal interface for MCP server used during launch. */
export interface WorkerLauncherMCPServer {
    setPhasePlanRequired(taskId: string, phaseId: string, required: boolean): void;
    upsertPhaseLog(taskId: string, phaseId: string, data: Record<string, unknown>): void;
}

/** Engine-like interface for reading runbook data during launch. */
export interface WorkerLauncherEngine {
    getRunbook(): { project_id: string; phases: Phase[] } | null;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  WorkerLauncher
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Builds the effective prompt (handoff context, agent profile, distillation
 * directives) and spawns the ADK worker.
 *
 * Extracted from EngineWiring.executePhase() Steps 4–6 + spawn.
 */
export class WorkerLauncher {
    constructor(
        private readonly adkController: WorkerLauncherADK,
        private readonly logger: WorkerLauncherLogger,
    ) { }

    /**
     * Build effective prompt and launch the worker for a phase.
     *
     * @param phase           The phase to execute (with original prompt).
     * @param timeoutMs       Worker timeout in milliseconds.
     * @param masterTaskId    Session directory name.
     * @param svc             Service container for optional dependencies.
     * @param workspaceRoots  All active workspace roots.
     */
    async launch(
        phase: Phase,
        timeoutMs: number,
        masterTaskId: string,
        svc: ServiceContainer,
        _workspaceRoots: string[] = [],
    ): Promise<void> {
        const { engine, handoffExtractor, currentSessionDir, agentRegistry, mcpServer } = svc;

        // Step 3.5: Resolve execution mode for prompt adjustment and observability
        // (mirrors PlannerAgent L219–226 from Phase 3)
        let executionMode: ExecutionMode = 'unsupported'; // safe default
        const adapterAny = this.adkController as unknown as { getExecutionMode?: () => Promise<ExecutionMode> };
        if (typeof adapterAny.getExecutionMode === 'function') {
            executionMode = await adapterAny.getExecutionMode();
        }
        log.info(`[WorkerLauncher] Execution mode for phase ${phase.id}: ${executionMode}`);

        // Step 4: Log the injected prompt
        await this.logger.logPhasePrompt(phase.id, phase.prompt);

        // Step 5: Initialize telemetry run (on first phase)
        const runbook = engine?.getRunbook() ?? null;
        if (runbook && phase.id === 0) {
            await this.logger.initRun(runbook.project_id);
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
            // Section-aware truncation — drop entire upstream
            // sections from the end to avoid corrupting markdown structure or
            // Pull Model file-fetch directives. Each upstream phase handoff is
            // separated by '\n---\n\n'.
            const sections = handoffContext.split('\n---\n\n');
            let truncated = '';
            for (const section of sections) {
                const candidate = truncated ? truncated + '\n---\n\n' + section : section;
                if (Math.ceil(candidate.length / CHARS_PER_TOKEN) > HANDOFF_TOKEN_CAP) break;
                truncated = candidate;
            }
            // Fallback to character-level slice if even a single section exceeds the cap
            // Truncate at \n boundary to avoid corrupting markdown mid-line.
            if (!truncated) {
                const cutoff = HANDOFF_TOKEN_CAP * CHARS_PER_TOKEN;
                const lastNewline = handoffContext.lastIndexOf('\n', cutoff);
                handoffContext =
                    handoffContext.slice(0, lastNewline > 0 ? lastNewline : cutoff) +
                    '\n\n> ⚠ Context truncated at token cap. Some upstream data may be incomplete.\n';
            } else {
                handoffContext = truncated;
            }
        }

        // Flag missing parent handoffs for cascading failure analysis.
        // Detect the "_No handoff report found._" marker left by buildNextContext()
        // when a dependency's handoff is absent in the ArtifactDB.
        if (handoffContext && phase.depends_on && phase.depends_on.length > 0) {
            const missingParents = handoffContext.match(/_No handoff report found\._/g);
            if (missingParents && mcpServer && phase.mcpPhaseId) {
                log.warn(
                    `[WorkerLauncher] Phase ${phase.id}: ${missingParents.length} parent ` +
                    `handoff(s) missing — flagging in phase_logs for post-mortem analysis.`,
                );
                mcpServer.upsertPhaseLog(masterTaskId, phase.mcpPhaseId, {
                    requestContext: JSON.stringify({
                        parentHandoffMissing: true,
                        missingParentCount: missingParents.length,
                    }),
                });
            }
        }

        // Step 5.6: Resolve agent profile from AgentRegistry
        let resolvedAgentProfile: import('../agent-selection/types.js').AgentProfile | undefined;
        if (agentRegistry) {
            try {
                const agentProfile = await agentRegistry.getBestAgent(phase.required_capabilities ?? []);
                resolvedAgentProfile = agentProfile;
                log.info(`[EngineWiring] Phase ${phase.id}: routed to agent '${agentProfile.id}' (${agentProfile.name})`);

                // Derive plan requirement from agent's default_output
                const NON_PLAN_OUTPUTS = new Set(['review_report', 'research_summary', 'debug_report', 'task_graph']);
                const planRequired = !NON_PLAN_OUTPUTS.has(agentProfile.default_output);
                if (mcpServer && phase.mcpPhaseId) {
                    mcpServer.setPhasePlanRequired(masterTaskId, phase.mcpPhaseId, planRequired);
                }
            } catch (err) {
                log.warn(
                    `[EngineWiring] Phase ${phase.id}: AgentRegistry lookup failed, ` +
                    `falling back to raw prompt processing — planRequired defaults to true.`,
                    err
                );
                // Lookup failed → same default as "not configured": raw workers
                // are expected to produce an implementation plan.
                if (mcpServer && phase.mcpPhaseId) {
                    mcpServer.setPhasePlanRequired(masterTaskId, phase.mcpPhaseId, true);
                }
            }
        } else {
            log.info(
                `[EngineWiring] Phase ${phase.id}: AgentRegistry not configured (useAgentSelection=false). ` +
                `Falling back to raw prompt processing — planRequired defaults to true ` +
                `because the default CLI worker is expected to produce an implementation plan.`
            );
            // Raw prompt workers (e.g. Claude Code) are expected to submit an
            // implementation plan as part of their standard output flow. Explicitly
            // set planRequired so MCPResourceHandler knows what to expect when the
            // webview fetches the phase's execution_plan resource.
            if (mcpServer && phase.mcpPhaseId) {
                mcpServer.setPhasePlanRequired(masterTaskId, phase.mcpPhaseId, true);
            }
        }

        // Step 6: Build effective prompt
        // NOTE: Agent profile system_prompt is NOT injected into the effective
        // prompt. The LLM already has a system role, and the planner's task
        // prompt provides the task-specific role — injecting system_prompt
        // was a redundant third persona layer.
        const distillationPrompt = handoffExtractor?.generateDistillationPrompt(phase.id as number) ?? '';
        let effectivePrompt = phase.prompt;
        if (handoffContext) {
            effectivePrompt = `# Context from Previous Phases\n\n${handoffContext}\n---\n\n${effectivePrompt}`;
        }
        if (distillationPrompt) {
            effectivePrompt = `${effectivePrompt}\n\n---\n\n${distillationPrompt}`;
        }
        const effectivePhase = { ...phase, prompt: effectivePrompt };

        // S2 audit fix: Persist the effective prompt (includes handoff context, worker
        // system prompt, and distillation directives) to phase_logs.request_context.
        if (mcpServer && phase.mcpPhaseId) {
            mcpServer.upsertPhaseLog(masterTaskId, phase.mcpPhaseId, {
                requestContext: effectivePrompt,
            });
        }

        // MCP warm-start URIs
        const mcpResourceUris: {
            executionPlan?: string;
            parentHandoffs?: string[];
        } = {
            executionPlan: RESOURCE_URIS.taskPlan(masterTaskId),
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

        // ── Tool policy: Set worker context before spawn ─────────────────
        if (mcpServer) {
            const isLegacy = !resolvedAgentProfile || !resolvedAgentProfile.allowed_tools_policy;
            // Derive workspaceId from the primary workspace root so the MCP
            // server can scope DB queries to the correct tenant, even when the
            // stdio server was started with a different workspace context.
            const workspaceId = _workspaceRoots.length > 0
                ? deriveWorkspaceId(_workspaceRoots[0])
                : undefined;
            mcpServer.setCurrentWorkerContext({
                masterTaskId,
                phaseId: phase.mcpPhaseId ?? `phase-${phase.id}`,
                workerId: resolvedAgentProfile?.id ?? `worker-phase-${phase.id}`,
                ...(resolvedAgentProfile?.allowed_tools_policy
                    ? { workerPolicy: resolvedAgentProfile.allowed_tools_policy }
                    : {}),
                isLegacyWorker: isLegacy,
                ...(workspaceId ? { workspaceId } : {}),
            });
        }

        await this.adkController.spawnWorker(effectivePhase, timeoutMs, masterTaskId, mcpResourceUris);
    }
}
