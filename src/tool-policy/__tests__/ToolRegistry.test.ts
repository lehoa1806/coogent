// ─────────────────────────────────────────────────────────────────────────────
// src/tool-policy/__tests__/ToolRegistry.test.ts — Unit tests for ToolRegistry
// ─────────────────────────────────────────────────────────────────────────────

import { ToolRegistry } from '../ToolRegistry.js';
import { MCP_TOOLS } from '../../mcp/types.js';

describe('ToolRegistry', () => {
    let registry: ToolRegistry;

    beforeEach(() => {
        registry = new ToolRegistry();
    });

    // ═════════════════════════════════════════════════════════════════════════
    //  ADR #5: Unknown tool alias normalizes correctly
    // ═════════════════════════════════════════════════════════════════════════

    describe('alias normalization', () => {
        it('resolves raw MCP tool name to canonical ID', () => {
            const canonical = registry.normalize('submit_execution_plan');
            expect(canonical).toBe('coogent.submit_execution_plan');
        });

        it('resolves canonical ID to itself', () => {
            const canonical = registry.normalize('coogent.submit_execution_plan');
            expect(canonical).toBe('coogent.submit_execution_plan');
        });

        it('resolves custom aliases registered via register()', () => {
            registry.register('plugin.my_tool', ['my_tool', 'mt']);
            expect(registry.normalize('my_tool')).toBe('plugin.my_tool');
            expect(registry.normalize('mt')).toBe('plugin.my_tool');
            expect(registry.normalize('plugin.my_tool')).toBe('plugin.my_tool');
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    //  ADR #6: Unresolved tool ID fails closed
    // ═════════════════════════════════════════════════════════════════════════

    describe('unresolved tool ID fails closed', () => {
        it('returns null for completely unknown tool names', () => {
            expect(registry.normalize('nonexistent_tool')).toBeNull();
        });

        it('returns null for empty string', () => {
            expect(registry.normalize('')).toBeNull();
        });

        it('returns null for similar but wrong tool name', () => {
            expect(registry.normalize('submit_execution_plans')).toBeNull();
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    //  All 7 MCP tools normalize correctly
    // ═════════════════════════════════════════════════════════════════════════

    describe('built-in MCP tools', () => {
        const expectedMappings: Array<[string, string]> = [
            ['submit_execution_plan', 'coogent.submit_execution_plan'],
            ['submit_phase_handoff', 'coogent.submit_phase_handoff'],
            ['submit_consolidation_report', 'coogent.submit_consolidation_report'],
            ['get_modified_file_content', 'coogent.get_modified_file_content'],
            ['get_file_slice', 'coogent.get_file_slice'],
            ['get_phase_handoff', 'coogent.get_phase_handoff'],
            ['get_symbol_context', 'coogent.get_symbol_context'],
        ];

        it.each(expectedMappings)(
            'normalizes raw name "%s" → "%s"',
            (rawName, expectedCanonical) => {
                expect(registry.normalize(rawName)).toBe(expectedCanonical);
            },
        );

        it('registers all 7 MCP tools as canonical IDs', () => {
            const allIds = registry.getAllCanonicalIds();
            expect(allIds).toHaveLength(7);
            for (const rawName of Object.values(MCP_TOOLS)) {
                expect(allIds).toContain(`coogent.${rawName}`);
            }
        });

        it('isRegistered() returns true for all canonical MCP tool IDs', () => {
            for (const rawName of Object.values(MCP_TOOLS)) {
                expect(registry.isRegistered(`coogent.${rawName}`)).toBe(true);
            }
        });

        it('isRegistered() returns false for raw names (non-canonical)', () => {
            expect(registry.isRegistered('submit_execution_plan')).toBe(false);
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    //  Custom plugin/MCP tools can be registered and normalized
    // ═════════════════════════════════════════════════════════════════════════

    describe('custom tool registration', () => {
        it('registers a custom plugin tool and normalizes it', () => {
            registry.register('plugin.code_formatter', ['format', 'fmt']);

            expect(registry.normalize('format')).toBe('plugin.code_formatter');
            expect(registry.normalize('fmt')).toBe('plugin.code_formatter');
            expect(registry.isRegistered('plugin.code_formatter')).toBe(true);
            expect(registry.getAllCanonicalIds()).toContain('plugin.code_formatter');
        });

        it('throws when registering a duplicate canonical ID', () => {
            registry.register('plugin.unique_tool');
            expect(() => registry.register('plugin.unique_tool')).toThrow(
                'already registered',
            );
        });

        it('throws when registering an alias that collides with an existing mapping', () => {
            // 'submit_execution_plan' is already an alias for the built-in tool
            expect(() =>
                registry.register('plugin.clash', ['submit_execution_plan']),
            ).toThrow('already maps to');
        });
    });
});
