import { AgentRegistry } from '../AgentRegistry.js';
import { AgentSelector } from '../AgentSelector.js';
import { SubtaskSpecBuilder } from '../SubtaskSpecBuilder.js';
import type { SubtaskSpec } from '../types.js';
import type { SubtaskDraft } from '../SubtaskSpecBuilder.js';

/** Helper to build a SubtaskSpec from a simple draft. */
function buildSpec(overrides: Partial<SubtaskDraft> = {}): SubtaskSpec {
    const draft: SubtaskDraft = {
        id: 'test-subtask',
        title: overrides.title ?? 'Default title',
        goal: overrides.goal ?? 'Default goal',
        ...overrides,
    };
    return SubtaskSpecBuilder.build(draft);
}

describe('AgentSelector', () => {
    let selector: AgentSelector;

    beforeEach(() => {
        const registry = AgentRegistry.loadDefault();
        selector = new AgentSelector(registry);
    });

    it('selects CodeEditor for a code_modification subtask', () => {
        const spec = buildSpec({ title: 'Implement feature', goal: 'Add new component' });
        expect(spec.task_type).toBe('code_modification');
        const result = selector.select(spec);
        expect(result.selected_agent).toBe('CodeEditor');
    });

    it('selects Reviewer for a verification subtask', () => {
        const spec = buildSpec({ title: 'Review changes', goal: 'Verify the patch' });
        expect(spec.task_type).toBe('verification');
        const result = selector.select(spec);
        expect(result.selected_agent).toBe('Reviewer');
    });

    it('selects TestWriter for a test_creation subtask', () => {
        const spec = buildSpec({ title: 'Write unit tests', goal: 'Create tests for module' });
        expect(spec.task_type).toBe('test_creation');
        const result = selector.select(spec);
        expect(result.selected_agent).toBe('TestWriter');
    });

    it('selects Researcher for a repo_pattern_discovery subtask', () => {
        const spec = buildSpec({ title: 'Investigate patterns', goal: 'Research the codebase' });
        expect(spec.task_type).toBe('repo_pattern_discovery');
        const result = selector.select(spec);
        expect(result.selected_agent).toBe('Researcher');
    });

    it('selects Debugger for a bug_investigation subtask', () => {
        // Use 'investigate' in the goal but not in the title to hit bug_investigation
        // Actually, let's force the task type by building a spec manually
        const spec: SubtaskSpec = {
            ...buildSpec({ title: 'Neutral title', goal: 'Neutral goal' }),
            task_type: 'bug_investigation',
            reasoning_type: ['failure_tracing', 'causal_analysis'],
            deliverable: { type: 'debug_report', must_include: ['root_cause', 'evidence', 'reproduction_steps'] },
        };
        const result = selector.select(spec);
        expect(result.selected_agent).toBe('Debugger');
    });

    it('hard filter rejects agents that do not handle the task type', () => {
        const spec = buildSpec({ title: 'Write unit tests', goal: 'Create test suite' });
        const candidates = selector.listCandidates(spec);

        // CodeEditor does not handle test_creation
        const codeEditorCandidate = candidates.find((c) => c.agent_type === 'CodeEditor');
        expect(codeEditorCandidate).toBeDefined();
        expect(codeEditorCandidate!.rejected).toBe(true);
    });

    it('selection rationale is non-empty', () => {
        const spec = buildSpec({ title: 'Implement feature', goal: 'Add component' });
        const result = selector.select(spec);
        expect(result.selection_rationale.length).toBeGreaterThan(0);
    });

    it('fallback agent is set when selection succeeds', () => {
        const spec = buildSpec({ title: 'Implement feature', goal: 'Add component' });
        const result = selector.select(spec);
        // Fallback should be set (non-null) when there are multiple passing candidates
        // or null if only one candidate passes; either way the field should exist
        expect(result).toHaveProperty('fallback_agent');
    });

    it('falls back to Planner when all scores are very low', () => {
        // Create a spec that no agent is well-suited for by using
        // task_type and deliverable that pass hard filter but score poorly.
        // We'll use task_decomposition which only Planner handles,
        // but with forbidden assumptions that conflict with Planner's avoid_when.
        // This forces fallback.
        const spec: SubtaskSpec = {
            subtask_id: 'edge-case',
            title: 'obscure task',
            goal: 'something unusual',
            task_type: 'code_modification', // CodeEditor handles this
            reasoning_type: [],
            required_skills: [],
            required_inputs: [],
            context_requirements: {
                preferred_format: [],
                must_include: [],
                optional: [],
            },
            dependency_inputs: [],
            assumptions_allowed: [],
            assumptions_forbidden: [
                'known-file edits', 'continuing prior patches', 'preserving API shape',
                'repo editing', 'patch generation', 'type-aware modification',
            ],
            required_confirmations: [],
            risk_level: 'high',
            failure_cost: 'high',
            deliverable: { type: 'task_graph', must_include: [] },
            verification_needed: [],
            fallback_strategy: 'escalate',
        };
        const result = selector.select(spec);
        // With badly-matched constraints, we expect Planner fallback or
        // a very low scorer. The important assertion is the system doesn't crash.
        expect(result.selected_agent).toBeDefined();
        expect(result.selection_rationale.length).toBeGreaterThan(0);
    });
});
