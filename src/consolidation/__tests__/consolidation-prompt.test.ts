// ─────────────────────────────────────────────────────────────────────────────
// consolidation-prompt.test.ts — Unit tests for buildConsolidationPrompt()
// ─────────────────────────────────────────────────────────────────────────────

import { buildConsolidationPrompt } from '../consolidation-prompt.js';

describe('buildConsolidationPrompt', () => {
    const MASTER_TASK_ID = '20260314-120000-a1b2c3d4-e5f6-7890-abcd-ef1234567890';

    function makeDefaultOpts() {
        return {
            masterTaskId: MASTER_TASK_ID,
            projectId: 'test-project',
            summary: 'Implement authentication module',
            workspaceRoot: '/workspace/project',
            phases: [
                {
                    id: 0,
                    mcpPhaseId: 'phase-000-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
                    status: 'completed',
                    context_summary: 'Auth setup',
                },
                {
                    id: 1,
                    mcpPhaseId: 'phase-001-11111111-2222-3333-4444-555555555555',
                    status: 'completed',
                    context_summary: 'Tests',
                },
            ],
        };
    }

    it('includes the masterTaskId in the prompt', () => {
        const prompt = buildConsolidationPrompt(makeDefaultOpts());

        expect(prompt).toContain(MASTER_TASK_ID);
    });

    it('includes all phase mcpPhaseIds', () => {
        const opts = makeDefaultOpts();
        const prompt = buildConsolidationPrompt(opts);

        expect(prompt).toContain('phase-000-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
        expect(prompt).toContain('phase-001-11111111-2222-3333-4444-555555555555');
    });

    it('instructs the agent to update documentation', () => {
        const prompt = buildConsolidationPrompt(makeDefaultOpts());

        expect(prompt).toContain('Update Documentation');
        expect(prompt).toContain('update documentation');
    });

    it('includes the project summary', () => {
        const prompt = buildConsolidationPrompt(makeDefaultOpts());

        expect(prompt).toContain('Implement authentication module');
    });

    it('handles phases without mcpPhaseId gracefully', () => {
        const opts = {
            ...makeDefaultOpts(),
            phases: [
                { id: 0, status: 'completed', context_summary: 'Phase without MCP ID' },
                {
                    id: 1,
                    mcpPhaseId: 'phase-001-11111111-2222-3333-4444-555555555555',
                    status: 'completed',
                },
            ],
        };

        const prompt = buildConsolidationPrompt(opts);

        // Phase 0 has no mcpPhaseId — should show a fallback indicator
        expect(prompt).toContain('_no mcpPhaseId_');
        // Phase 1 should still have its mcpPhaseId included
        expect(prompt).toContain('phase-001-11111111-2222-3333-4444-555555555555');
        // The handoff steps should only include phase 1 (has mcpPhaseId)
        expect(prompt).not.toContain('mcp_coogent_get_phase_handoff` with masterTaskId=`' + MASTER_TASK_ID + '`, phaseId=`undefined`');
    });

    it('handles all phases without mcpPhaseId', () => {
        const opts = {
            ...makeDefaultOpts(),
            phases: [
                { id: 0, status: 'completed' },
                { id: 1, status: 'failed' },
            ],
        };

        const prompt = buildConsolidationPrompt(opts);

        // Should show the "no phases with mcpPhaseId" fallback message
        expect(prompt).toContain('No phases with mcpPhaseId available');
    });

    it('shows fallback text when summary is empty', () => {
        const opts = {
            ...makeDefaultOpts(),
            summary: '',
        };

        const prompt = buildConsolidationPrompt(opts);

        expect(prompt).toContain('_No summary provided_');
    });

    it('includes status icons for different phase statuses', () => {
        const opts = {
            ...makeDefaultOpts(),
            phases: [
                { id: 0, status: 'completed', mcpPhaseId: 'phase-000-aaaa-bbbb-cccc-dddddddddddd' },
                { id: 1, status: 'failed', mcpPhaseId: 'phase-001-1111-2222-3333-444444444444' },
                { id: 2, status: 'pending', mcpPhaseId: 'phase-002-5555-6666-7777-888888888888' },
            ],
        };

        const prompt = buildConsolidationPrompt(opts);

        expect(prompt).toContain('✅'); // completed
        expect(prompt).toContain('❌'); // failed
        expect(prompt).toContain('⏭️'); // pending/skipped
    });

    it('handles empty phases array', () => {
        const opts = {
            ...makeDefaultOpts(),
            phases: [],
        };

        const prompt = buildConsolidationPrompt(opts);

        // Should still produce a valid prompt
        expect(prompt).toContain('Total Phases:** 0');
        expect(prompt).toContain('_No phases_');
    });
});
