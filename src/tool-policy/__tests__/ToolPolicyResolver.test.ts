// ─────────────────────────────────────────────────────────────────────────────
// src/tool-policy/__tests__/ToolPolicyResolver.test.ts — Unit tests for
//                                                          ToolPolicyResolver
// ─────────────────────────────────────────────────────────────────────────────

import { ToolPolicyResolver } from '../ToolPolicyResolver.js';
import { ToolRegistry } from '../ToolRegistry.js';
import type { AllowedToolsPolicy, WorkspaceToolPolicy } from '../types.js';

describe('ToolPolicyResolver', () => {
    let registry: ToolRegistry;
    let resolver: ToolPolicyResolver;

    beforeEach(() => {
        registry = new ToolRegistry();
        resolver = new ToolPolicyResolver(registry);
    });

    // ═════════════════════════════════════════════════════════════════════════
    //  ADR #1: Worker inherits workspace default
    // ═════════════════════════════════════════════════════════════════════════

    describe('worker inherits workspace default', () => {
        it('uses workspace default when worker policy mode is inherit', () => {
            const workspacePolicy: WorkspaceToolPolicy = {
                defaultPolicy: {
                    mode: 'explicit',
                    allowedTools: ['submit_execution_plan', 'get_file_slice'],
                },
                enforcementMode: 'enforce',
            };
            const workerPolicy: AllowedToolsPolicy = { mode: 'inherit' };

            const result = resolver.resolve(workspacePolicy, workerPolicy, false);

            expect(result.policySource).toBe('workspace_default');
            expect(result.allowedTools).toContain('coogent.submit_execution_plan');
            expect(result.allowedTools).toContain('coogent.get_file_slice');
            expect(result.enforcementMode).toBe('enforce');
        });

        it('uses workspace default when worker has no policy', () => {
            const workspacePolicy: WorkspaceToolPolicy = {
                defaultPolicy: {
                    mode: 'explicit',
                    allowedTools: ['get_phase_handoff'],
                },
                enforcementMode: 'observe',
            };

            const result = resolver.resolve(workspacePolicy, undefined, false);

            expect(result.policySource).toBe('workspace_default');
            expect(result.allowedTools).toContain('coogent.get_phase_handoff');
            expect(result.enforcementMode).toBe('observe');
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    //  ADR #2: Worker override replaces inherited policy
    // ═════════════════════════════════════════════════════════════════════════

    describe('worker override replaces inherited policy', () => {
        it('uses worker explicit policy instead of workspace default', () => {
            const workspacePolicy: WorkspaceToolPolicy = {
                defaultPolicy: {
                    mode: 'explicit',
                    allowedTools: ['submit_execution_plan'],
                },
                enforcementMode: 'enforce',
            };
            const workerPolicy: AllowedToolsPolicy = {
                mode: 'explicit',
                allowedTools: ['get_file_slice', 'get_symbol_context'],
            };

            const result = resolver.resolve(workspacePolicy, workerPolicy, false);

            expect(result.policySource).toBe('worker_override');
            expect(result.allowedTools).toEqual([
                'coogent.get_file_slice',
                'coogent.get_symbol_context',
            ]);
            expect(result.enforcementMode).toBe('enforce');
        });

        it('worker override with no workspace policy defaults to enforce mode', () => {
            const workerPolicy: AllowedToolsPolicy = {
                mode: 'explicit',
                allowedTools: ['submit_phase_handoff'],
            };

            const result = resolver.resolve(undefined, workerPolicy, false);

            expect(result.policySource).toBe('worker_override');
            expect(result.allowedTools).toEqual(['coogent.submit_phase_handoff']);
            expect(result.enforcementMode).toBe('enforce');
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    //  ADR #8: Legacy compatibility mode behaves as expected
    // ═════════════════════════════════════════════════════════════════════════

    describe('legacy compatibility mode', () => {
        it('grants all tools when isLegacyWorker is true and no worker policy', () => {
            const workspacePolicy: WorkspaceToolPolicy = {
                defaultPolicy: {
                    mode: 'explicit',
                    allowedTools: ['submit_execution_plan'],
                },
                enforcementMode: 'compatibility',
            };

            const result = resolver.resolve(workspacePolicy, undefined, true);

            expect(result.policySource).toBe('compatibility_mode');
            expect(result.enforcementMode).toBe('compatibility');
            // Should include ALL registered canonical IDs (all 7 MCP tools)
            expect(result.allowedTools).toHaveLength(7);
        });

        it('uses compatibility enforcement when no workspace policy and legacy worker', () => {
            const result = resolver.resolve(undefined, undefined, true);

            expect(result.policySource).toBe('compatibility_mode');
            expect(result.enforcementMode).toBe('compatibility');
            expect(result.allowedTools).toHaveLength(7);
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    //  Safe default: no workspace + no worker → deny all
    // ═════════════════════════════════════════════════════════════════════════

    describe('safe default', () => {
        it('returns empty allow list when no workspace or worker policy exists', () => {
            const result = resolver.resolve(undefined, undefined, false);

            expect(result.policySource).toBe('workspace_default');
            expect(result.allowedTools).toEqual([]);
            expect(result.enforcementMode).toBe('enforce');
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    //  Edge cases
    // ═════════════════════════════════════════════════════════════════════════

    describe('edge cases', () => {
        it('silently drops unknown tool IDs from the allowed list', () => {
            const workspacePolicy: WorkspaceToolPolicy = {
                defaultPolicy: {
                    mode: 'explicit',
                    allowedTools: ['submit_execution_plan', 'totally_unknown_tool'],
                },
                enforcementMode: 'enforce',
            };

            const result = resolver.resolve(workspacePolicy, undefined, false);

            expect(result.allowedTools).toEqual(['coogent.submit_execution_plan']);
        });

        it('handles empty allowedTools in explicit mode', () => {
            const workerPolicy: AllowedToolsPolicy = {
                mode: 'explicit',
                allowedTools: [],
            };

            const result = resolver.resolve(undefined, workerPolicy, false);

            expect(result.policySource).toBe('worker_override');
            expect(result.allowedTools).toEqual([]);
        });
    });
});
