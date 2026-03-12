import { SubtaskSpecBuilder, type SubtaskDraft, type NormalizedRequirementContext } from '../SubtaskSpecBuilder.js';

describe('SubtaskSpecBuilder', () => {
    describe('inferTaskType', () => {
        it('classifies titles with "test" as test_creation', () => {
            const result = SubtaskSpecBuilder.inferTaskType('Write unit tests', 'Create tests for the module');
            expect(result).toBe('test_creation');
        });

        it('classifies titles with "review" as verification', () => {
            const result = SubtaskSpecBuilder.inferTaskType('Review changes', 'Verify the implementation');
            expect(result).toBe('verification');
        });

        it('classifies titles with "fix" as localized_bugfix', () => {
            const result = SubtaskSpecBuilder.inferTaskType('Fix the login bug', 'Resolve the authentication issue');
            expect(result).toBe('localized_bugfix');
        });

        it('defaults to code_modification for unrecognized titles', () => {
            const result = SubtaskSpecBuilder.inferTaskType('Implement feature X', 'Add the new capability');
            expect(result).toBe('code_modification');
        });

        it('classifies "debug and diagnose" as bug_investigation', () => {
            const result = SubtaskSpecBuilder.inferTaskType('Debug the crash', 'Diagnose the root cause');
            expect(result).toBe('bug_investigation');
        });

        it('classifies "integrate and connect" as small_integration', () => {
            const result = SubtaskSpecBuilder.inferTaskType('Integrate payment API', 'Connect the payment gateway and link it');
            expect(result).toBe('small_integration');
        });

        it('classifies "dependency" related titles as dependency_mapping', () => {
            const result = SubtaskSpecBuilder.inferTaskType('Check dependencies', 'Trace import graph and dependencies');
            expect(result).toBe('dependency_mapping');
        });

        it('uses scoring to pick the best match when multiple rules hit', () => {
            // "fix", "bug", "broken", "crash", "error" → localized_bugfix (5 hits)
            // vs "investigate" → repo_pattern_discovery (1 hit)
            const result = SubtaskSpecBuilder.inferTaskType(
                'Fix the broken crash',
                'Investigate the bug error and resolve it',
            );
            expect(result).toBe('localized_bugfix');
        });
    });

    describe('build', () => {
        const minimalDraft: SubtaskDraft = {
            id: 'subtask-001',
            title: 'Implement user profile',
            goal: 'Add user profile component',
        };

        it('produces a valid SubtaskSpec from minimal draft', () => {
            const spec = SubtaskSpecBuilder.build(minimalDraft);
            expect(spec.subtask_id).toBe('subtask-001');
            expect(spec.title).toBe('Implement user profile');
            expect(spec.goal).toBe('Add user profile component');
            expect(spec.task_type).toBe('code_modification');
            expect(spec.reasoning_type.length).toBeGreaterThan(0);
            expect(spec.risk_level).toBe('medium');
            expect(spec.deliverable).toBeDefined();
            expect(spec.deliverable.type).toBeDefined();
            expect(spec.deliverable.must_include.length).toBeGreaterThan(0);
        });

        it('uses constraints as forbidden assumptions', () => {
            const context: NormalizedRequirementContext = {
                constraints: ['Do not modify public API', 'No breaking changes'],
            };
            const spec = SubtaskSpecBuilder.build(minimalDraft, context);
            expect(spec.assumptions_forbidden).toContain('Do not modify public API');
            expect(spec.assumptions_forbidden).toContain('No breaking changes');
        });
    });

    describe('buildDefaultDeliverable', () => {
        it('maps code_modification to patch_with_summary', () => {
            const deliverable = SubtaskSpecBuilder.buildDefaultDeliverable('code_modification');
            expect(deliverable.type).toBe('patch_with_summary');
        });

        it('maps test_creation to test_patch', () => {
            const deliverable = SubtaskSpecBuilder.buildDefaultDeliverable('test_creation');
            expect(deliverable.type).toBe('test_patch');
        });

        it('maps verification to review_report', () => {
            const deliverable = SubtaskSpecBuilder.buildDefaultDeliverable('verification');
            expect(deliverable.type).toBe('review_report');
        });

        it('maps bug_investigation to debug_report', () => {
            const deliverable = SubtaskSpecBuilder.buildDefaultDeliverable('bug_investigation');
            expect(deliverable.type).toBe('debug_report');
        });

        it('maps task_decomposition to task_graph', () => {
            const deliverable = SubtaskSpecBuilder.buildDefaultDeliverable('task_decomposition');
            expect(deliverable.type).toBe('task_graph');
        });
    });
});
