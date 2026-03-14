// ─────────────────────────────────────────────────────────────────────────────
// src/tool-policy/__tests__/ToolPolicyEnforcer.test.ts — Unit tests for
//                                                          ToolPolicyEnforcer
// ─────────────────────────────────────────────────────────────────────────────

import { ToolPolicyEnforcer } from '../ToolPolicyEnforcer.js';
import type { ResolvedPolicy } from '../ToolPolicyResolver.js';

describe('ToolPolicyEnforcer', () => {
    const enforcer = new ToolPolicyEnforcer();

    // ═════════════════════════════════════════════════════════════════════════
    //  ADR #3: Explicit allowed tool succeeds
    // ═════════════════════════════════════════════════════════════════════════

    describe('explicit allowed tool succeeds', () => {
        it('allows a tool that is in the allowedTools list', () => {
            const policy: ResolvedPolicy = {
                allowedTools: ['coogent.submit_execution_plan', 'coogent.get_file_slice'],
                policySource: 'workspace_default',
                enforcementMode: 'enforce',
            };

            const decision = enforcer.evaluate(policy, 'coogent.submit_execution_plan');

            expect(decision.allowed).toBe(true);
            expect(decision.toolId).toBe('coogent.submit_execution_plan');
            expect(decision.policySource).toBe('workspace_default');
            expect(decision.reason).toBeUndefined();
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    //  ADR #4: Explicit denied tool fails
    // ═════════════════════════════════════════════════════════════════════════

    describe('explicit denied tool fails', () => {
        it('denies a tool that is NOT in the allowedTools list', () => {
            const policy: ResolvedPolicy = {
                allowedTools: ['coogent.get_file_slice'],
                policySource: 'worker_override',
                enforcementMode: 'enforce',
            };

            const decision = enforcer.evaluate(policy, 'coogent.submit_execution_plan');

            expect(decision.allowed).toBe(false);
            expect(decision.toolId).toBe('coogent.submit_execution_plan');
            expect(decision.policySource).toBe('worker_override');
            expect(decision.reason).toBeDefined();
            expect(decision.reason).toContain('not in the allowed tools list');
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    //  Observe mode: always allows but flags would-be denials
    // ═════════════════════════════════════════════════════════════════════════

    describe('observe mode', () => {
        it('allows a tool in the allow list with no reason', () => {
            const policy: ResolvedPolicy = {
                allowedTools: ['coogent.get_file_slice'],
                policySource: 'workspace_default',
                enforcementMode: 'observe',
            };

            const decision = enforcer.evaluate(policy, 'coogent.get_file_slice');

            expect(decision.allowed).toBe(true);
            expect(decision.reason).toBeUndefined();
        });

        it('allows a tool NOT in the allow list but flags would-be denial', () => {
            const policy: ResolvedPolicy = {
                allowedTools: ['coogent.get_file_slice'],
                policySource: 'workspace_default',
                enforcementMode: 'observe',
            };

            const decision = enforcer.evaluate(policy, 'coogent.submit_execution_plan');

            expect(decision.allowed).toBe(true);
            expect(decision.reason).toBeDefined();
            expect(decision.reason).toContain('would be denied');
            expect(decision.reason).toContain('observe mode');
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    //  Compatibility mode: allows legacy workers
    // ═════════════════════════════════════════════════════════════════════════

    describe('compatibility mode', () => {
        it('always allows tools for legacy workers in compatibility mode', () => {
            const policy: ResolvedPolicy = {
                allowedTools: ['coogent.get_file_slice'],
                policySource: 'compatibility_mode',
                enforcementMode: 'compatibility',
            };

            const decision = enforcer.evaluate(policy, 'coogent.submit_execution_plan');

            expect(decision.allowed).toBe(true);
            expect(decision.policySource).toBe('compatibility_mode');
        });

        it('denies unlisted tools under compatibility mode with non-legacy source', () => {
            const policy: ResolvedPolicy = {
                allowedTools: ['coogent.get_file_slice'],
                policySource: 'worker_override',
                enforcementMode: 'compatibility',
            };

            const decision = enforcer.evaluate(policy, 'coogent.submit_execution_plan');

            expect(decision.allowed).toBe(false);
            expect(decision.reason).toContain('not in the allowed tools list');
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    //  Full enforce mode: denies unlisted tools
    // ═════════════════════════════════════════════════════════════════════════

    describe('enforce mode', () => {
        it('denies an unlisted tool under full enforcement', () => {
            const policy: ResolvedPolicy = {
                allowedTools: [],
                policySource: 'workspace_default',
                enforcementMode: 'enforce',
            };

            const decision = enforcer.evaluate(policy, 'coogent.get_file_slice');

            expect(decision.allowed).toBe(false);
            expect(decision.reason).toContain('not in the allowed tools list');
        });

        it('allows a listed tool under full enforcement', () => {
            const policy: ResolvedPolicy = {
                allowedTools: ['coogent.get_file_slice'],
                policySource: 'workspace_default',
                enforcementMode: 'enforce',
            };

            const decision = enforcer.evaluate(policy, 'coogent.get_file_slice');

            expect(decision.allowed).toBe(true);
            expect(decision.reason).toBeUndefined();
        });
    });
});
