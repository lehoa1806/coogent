// ─────────────────────────────────────────────────────────────────────────────
// src/agent-selection/AgentSelector.ts — Capability-based agent selection
// ─────────────────────────────────────────────────────────────────────────────

import type {
    SubtaskSpec,
    AgentProfile,
    AgentScore,
    SelectionResult,
    AgentType,
    AgentMode,
    RiskLevel,
    DeliverableType,
} from './types.js';
import { AgentRegistry } from './AgentRegistry.js';

// ─── Internal constants ──────────────────────────────────────────────────────

/** Minimum composite score to avoid fallback to Planner. */
const MIN_VIABLE_SCORE = 5.0;

/** Maximum score gap between top-2 candidates to trigger tie-break logic. */
const TIE_BREAK_THRESHOLD = 1.0;

/** Scoring weights aligned with the selection algorithm spec. */
const WEIGHTS = {
    task_type_match: 4,
    reasoning_type_match: 3,
    skill_match: 2,
    context_fit: 3,
    output_fit: 2,
    risk_fit: 2,
    avoid_when_penalty: 6,
} as const;

/** Risk ordering used for tier-distance calculations. */
const RISK_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

/** Default preference ordering for tie-break: simpler/default agent first. */
const TIE_BREAK_PREFERENCE: readonly AgentType[] = [
    'Planner',
    'CodeEditor',
    'Reviewer',
    'TestWriter',
    'Researcher',
    'Debugger',
];

// ─── Verification-type task types (exempt from high-risk / low-tolerance rejection) ─
const VERIFICATION_TASK_TYPES: ReadonlySet<string> = new Set([
    'verification',
    'regression_check',
    'constraint_audit',
]);

/**
 * Selects the best-fit agent for a given {@link SubtaskSpec} using a
 * four-pass algorithm: hard filter → weighted scoring → tie-break → fallback.
 *
 * All methods are pure and deterministic given the same registry state.
 */
export class AgentSelector {
    constructor(private readonly registry: AgentRegistry) { }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Public API
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Select the best agent for a subtask.
     * Runs hard filter → weighted scoring → tie-break → fallback.
     */
    select(spec: SubtaskSpec): SelectionResult {
        const candidates = this.listCandidates(spec);
        const rationale: string[] = [];

        // Separate passing from rejected candidates
        const passing = candidates.filter((c) => !c.rejected);

        // Pass 4: Fallback – if nobody scores above the threshold
        if (passing.length === 0 || passing[0].score < MIN_VIABLE_SCORE) {
            rationale.push(
                `No candidate scored above ${MIN_VIABLE_SCORE}; falling back to Planner for reformulation.`,
            );
            return this.buildResult(spec, candidates, 'Planner', rationale, null);
        }

        // Sort passing candidates descending by score (stable)
        const sorted = [...passing].sort((a, b) => b.score - a.score);

        let selected = sorted[0];

        // Pass 3: Tie-break
        if (sorted.length >= 2) {
            const gap = sorted[0].score - sorted[1].score;
            if (gap <= TIE_BREAK_THRESHOLD) {
                selected = this.tieBreak(sorted[0], sorted[1], spec, rationale);
            }
        }

        rationale.push(
            `Selected ${selected.agent_type} with score ${selected.score.toFixed(2)}.`,
        );

        // Determine fallback agent (second best if available)
        const fallback =
            sorted.length >= 2 && sorted[1].agent_type !== selected.agent_type
                ? sorted[1].agent_type
                : sorted.find((c) => c.agent_type !== selected.agent_type)?.agent_type ?? null;

        const profile = this.registry.getByType(selected.agent_type);
        return this.buildResult(
            spec,
            candidates,
            selected.agent_type,
            rationale,
            fallback,
            profile?.mode,
        );
    }

    /**
     * List all candidates with scores (including rejected ones).
     * Scores are computed for all agents in the registry;
     * rejected agents receive a score of 0.
     */
    listCandidates(spec: SubtaskSpec): readonly AgentScore[] {
        const profiles = this.registry.listAll();
        return profiles.map((profile) => {
            // Pass 1: Hard filter
            const rejection = this.hardFilter(profile, spec);
            if (rejection !== null) {
                return {
                    agent_type: profile.agent_type,
                    score: 0,
                    rejected: true,
                    rejection_reason: rejection,
                };
            }

            // Pass 2: Weighted scoring
            const score = this.computeScore(profile, spec);
            return {
                agent_type: profile.agent_type,
                score,
                rejected: false,
            };
        });
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Pass 1: Hard Filter
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Returns a rejection reason string if the profile fails hard filters,
     * or `null` if the profile passes.
     */
    private hardFilter(profile: AgentProfile, spec: SubtaskSpec): string | null {
        // 1. Agent must handle the subtask's task_type
        if (!profile.handles.includes(spec.task_type)) {
            return `Agent does not handle task type '${spec.task_type}'.`;
        }

        // 2. must_include context formats must be in agent's preferred_context
        const missingFormats = spec.context_requirements.must_include.filter(
            (format) => !profile.preferred_context.includes(format as typeof profile.preferred_context[number]),
        );
        if (missingFormats.length > 0) {
            return `Agent lacks required context formats: ${missingFormats.join(', ')}.`;
        }

        // 3. Deliverable type compatibility
        if (!this.isDeliverableCompatible(spec.deliverable.type, profile.default_output)) {
            return `Agent default output '${profile.default_output}' incompatible with required '${spec.deliverable.type}'.`;
        }

        // 4. Risk tolerance check (exempt verification-type tasks)
        if (
            spec.risk_level === 'high' &&
            profile.risk_tolerance === 'low' &&
            !VERIFICATION_TASK_TYPES.has(spec.task_type)
        ) {
            return `Agent risk tolerance 'low' insufficient for high-risk non-verification task.`;
        }

        // 5. assumptions_forbidden vs avoid_when conflict
        const conflicting = spec.assumptions_forbidden.filter((forbidden) =>
            profile.avoid_when.some(
                (avoid) =>
                    avoid.toLowerCase().includes(forbidden.toLowerCase()) ||
                    forbidden.toLowerCase().includes(avoid.toLowerCase()),
            ),
        );
        if (conflicting.length > 0) {
            return `Forbidden assumptions conflict with agent avoid_when: ${conflicting.join(', ')}.`;
        }

        return null;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Pass 2: Weighted Scoring
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Computes the weighted composite score for a (passing) agent profile.
     */
    private computeScore(profile: AgentProfile, spec: SubtaskSpec): number {
        const taskTypeMatch = 1.0; // Already filtered — always 1.0

        const reasoningTypeMatch = this.proportionOverlap(
            spec.reasoning_type as readonly string[],
            profile.reasoning_strengths as readonly string[],
        );

        const skillMatch = this.proportionOverlap(
            spec.required_capabilities,
            profile.skills,
        );

        const contextFit = this.proportionOverlap(
            spec.context_requirements.preferred_format as readonly string[],
            profile.preferred_context as readonly string[],
        );

        const outputFit =
            spec.deliverable.type === profile.default_output ? 1.0 : 0.5;

        const riskFit = this.computeRiskFit(spec.risk_level, profile.risk_tolerance);

        const avoidWhenPenalty = this.computeAvoidWhenPenalty(profile, spec);

        return (
            taskTypeMatch * WEIGHTS.task_type_match +
            reasoningTypeMatch * WEIGHTS.reasoning_type_match +
            skillMatch * WEIGHTS.skill_match +
            contextFit * WEIGHTS.context_fit +
            outputFit * WEIGHTS.output_fit +
            riskFit * WEIGHTS.risk_fit -
            avoidWhenPenalty * WEIGHTS.avoid_when_penalty
        );
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Pass 3: Tie-Break
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Breaks a tie between the top two candidates.
     * Returns the winning candidate and appends rationale entries.
     */
    private tieBreak(
        first: AgentScore,
        second: AgentScore,
        spec: SubtaskSpec,
        rationale: string[],
    ): AgentScore {
        rationale.push(
            `Tie detected: ${first.agent_type} (${first.score.toFixed(2)}) vs ${second.agent_type} (${second.score.toFixed(2)}).`,
        );

        // Rule 1: Prefer lower-risk agent for high failure_cost subtasks
        if (spec.failure_cost === 'high') {
            const firstProfile = this.registry.getByType(first.agent_type);
            const secondProfile = this.registry.getByType(second.agent_type);
            if (firstProfile && secondProfile) {
                const firstRisk = RISK_ORDER[firstProfile.risk_tolerance];
                const secondRisk = RISK_ORDER[secondProfile.risk_tolerance];
                if (firstRisk !== secondRisk) {
                    const winner = firstRisk < secondRisk ? first : second;
                    rationale.push(
                        `Tie-break rule 1: Preferred ${winner.agent_type} (lower risk tolerance) for high failure_cost task.`,
                    );
                    return winner;
                }
            }
        }

        // Rule 2: Prefer agent with stricter context requirements if all context available
        const firstProfile = this.registry.getByType(first.agent_type);
        const secondProfile = this.registry.getByType(second.agent_type);
        if (firstProfile && secondProfile) {
            const firstCtx = firstProfile.preferred_context.length;
            const secondCtx = secondProfile.preferred_context.length;
            if (firstCtx !== secondCtx) {
                // "stricter" = more preferred context items
                const winner = firstCtx > secondCtx ? first : second;
                rationale.push(
                    `Tie-break rule 2: Preferred ${winner.agent_type} (stricter context requirements).`,
                );
                return winner;
            }
        }

        // Rule 3: Prefer simpler/default agent (Planner < CodeEditor < Reviewer order)
        const firstIdx = TIE_BREAK_PREFERENCE.indexOf(first.agent_type);
        const secondIdx = TIE_BREAK_PREFERENCE.indexOf(second.agent_type);
        const winner = firstIdx <= secondIdx ? first : second;
        rationale.push(
            `Tie-break rule 3: Preferred ${winner.agent_type} (simpler/default preference ordering).`,
        );
        return winner;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Scoring Helpers
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Computes the proportion of items in `required` that appear in `available`.
     * Returns 0 if `required` is empty (no requirements = no match signal).
     */
    private proportionOverlap(
        required: readonly string[],
        available: readonly string[],
    ): number {
        if (required.length === 0) return 0;
        const availableSet = new Set(available);
        const matched = required.filter((r) => availableSet.has(r)).length;
        return matched / required.length;
    }

    /**
     * Computes risk fitness: 1.0 exact match, 0.5 within 1 tier, 0 otherwise.
     */
    private computeRiskFit(taskRisk: RiskLevel, agentTolerance: RiskLevel): number {
        const diff = Math.abs(RISK_ORDER[taskRisk] - RISK_ORDER[agentTolerance]);
        if (diff === 0) return 1.0;
        if (diff === 1) return 0.5;
        return 0;
    }

    /**
     * Counts how many subtask-related keywords match agent's avoid_when entries.
     * Uses substring matching against the subtask's title, goal, and task_type.
     */
    private computeAvoidWhenPenalty(profile: AgentProfile, spec: SubtaskSpec): number {
        if (profile.avoid_when.length === 0) return 0;

        const keywords = [
            spec.title.toLowerCase(),
            spec.goal.toLowerCase(),
            spec.task_type.toLowerCase(),
            ...spec.required_capabilities.map((s) => s.toLowerCase()),
        ];

        let penalty = 0;
        for (const avoid of profile.avoid_when) {
            const avoidLower = avoid.toLowerCase();
            if (keywords.some((kw) => kw.includes(avoidLower) || avoidLower.includes(kw))) {
                penalty += 1;
            }
        }
        return penalty;
    }

    /**
     * Checks if the required deliverable type is compatible with the agent's default output.
     * Compatible means exact match or a reasonable overlap (patch types are interchangeable).
     */
    private isDeliverableCompatible(
        required: DeliverableType,
        agentDefault: DeliverableType,
    ): boolean {
        if (required === agentDefault) return true;

        // Patch types are interchangeable
        const patchTypes: ReadonlySet<DeliverableType> = new Set([
            'patch_with_summary',
            'patch_with_notes',
            'test_patch',
        ]);
        if (patchTypes.has(required) && patchTypes.has(agentDefault)) return true;

        return false;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Result Builder
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Constructs a {@link SelectionResult} from scored candidates and decision metadata.
     */
    private buildResult(
        spec: SubtaskSpec,
        candidates: readonly AgentScore[],
        selectedAgent: AgentType,
        rationale: string[],
        fallbackAgent: AgentType | null,
        selectedMode?: string,
    ): SelectionResult {
        const result: SelectionResult = {
            subtask_id: spec.subtask_id,
            candidate_agents: candidates,
            selected_agent: selectedAgent,
            selection_rationale: rationale,
            fallback_agent: fallbackAgent,
        };

        if (selectedMode !== undefined) {
            return { ...result, selected_mode: selectedMode as AgentMode };
        }

        return result;
    }
}
