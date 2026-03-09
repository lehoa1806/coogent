// ─────────────────────────────────────────────────────────────────────────────
// MCPPromptHandler.test.ts — Unit tests for MCP Prompt handlers
// ─────────────────────────────────────────────────────────────────────────────
// P4: Validates prompt listing, message composition, argument validation,
// and invocation logging.

// Mock the logger before any imports
jest.mock('../../logger/log.js', () => ({
    __esModule: true,
    default: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    },
}));

import log from '../../logger/log.js';

// ── Minimal MCP Server mock ──────────────────────────────────────────────────
// The MCPPromptHandler calls server.setRequestHandler(schema, handler).
// We capture the handlers in registration order (ListPrompts first, GetPrompt second).

type HandlerFn = (request: unknown) => Promise<unknown>;

function createMockServer() {
    const handlers: HandlerFn[] = [];
    return {
        setRequestHandler(_schema: unknown, handler: HandlerFn) {
            handlers.push(handler);
        },
        /** Returns the Nth handler registered (0-indexed). */
        getHandlerByIndex(index: number): HandlerFn | undefined {
            return handlers[index];
        },
    };
}

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { MCPPromptHandler } from '../MCPPromptHandler.js';

describe('MCPPromptHandler', () => {
    let mockServer: ReturnType<typeof createMockServer>;
    let listPrompts: HandlerFn;
    let getPrompt: HandlerFn;

    beforeEach(() => {
        jest.clearAllMocks();
        mockServer = createMockServer();
        const handler = new MCPPromptHandler(mockServer as unknown as Server);
        handler.register();
        // Registration order: registerListPrompts() first, registerGetPrompt() second
        listPrompts = mockServer.getHandlerByIndex(0)!;
        getPrompt = mockServer.getHandlerByIndex(1)!;
    });

    // ═══════════════════════════════════════════════════════════════════════
    //  ListPrompts
    // ═══════════════════════════════════════════════════════════════════════

    describe('ListPrompts', () => {
        it('returns exactly 5 prompts', async () => {
            const result = (await listPrompts({})) as { prompts: unknown[] };
            expect(result.prompts).toHaveLength(5);
        });

        it('includes all expected prompt names', async () => {
            const result = (await listPrompts({})) as { prompts: Array<{ name: string }> };
            const names = result.prompts.map((p) => p.name);
            expect(names).toContain('plan_repo_task');
            expect(names).toContain('review_generated_runbook');
            expect(names).toContain('repair_failed_phase');
            expect(names).toContain('consolidate_session');
            expect(names).toContain('architecture_review_workspace');
        });

        it('each prompt includes a version in its description', async () => {
            const result = (await listPrompts({})) as { prompts: Array<{ description: string }> };
            for (const p of result.prompts) {
                expect(p.description).toContain('[v1.0.0]');
            }
        });

        it('each prompt includes at least one argument', async () => {
            const result = (await listPrompts({})) as { prompts: Array<{ arguments: unknown[] }> };
            for (const p of result.prompts) {
                expect(p.arguments.length).toBeGreaterThanOrEqual(1);
            }
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    //  GetPrompt — Valid invocations
    // ═══════════════════════════════════════════════════════════════════════

    describe('GetPrompt — valid invocations', () => {
        it('plan_repo_task returns valid messages with required args', async () => {
            const result = (await getPrompt({
                params: {
                    name: 'plan_repo_task',
                    arguments: { task: 'Add user authentication' },
                },
            })) as { messages: Array<{ role: string; content: { type: string; text: string } }> };

            expect(result.messages).toHaveLength(2);
            expect(result.messages[0].role).toBe('user');
            expect(result.messages[0].content.type).toBe('text');
            expect(result.messages[0].content.text).toContain('Add user authentication');
            expect(result.messages[1].role).toBe('assistant');
        });

        it('plan_repo_task includes optional args when provided', async () => {
            const result = (await getPrompt({
                params: {
                    name: 'plan_repo_task',
                    arguments: {
                        task: 'Refactor DB layer',
                        repo_summary: 'TypeScript monorepo',
                        constraints: 'No breaking changes',
                        preferred_workers: 'code_editor,reviewer',
                    },
                },
            })) as { messages: Array<{ role: string; content: { type: string; text: string } }> };

            expect(result.messages[0].content.text).toContain('TypeScript monorepo');
            expect(result.messages[0].content.text).toContain('No breaking changes');
            expect(result.messages[0].content.text).toContain('code_editor,reviewer');
        });

        it('review_generated_runbook returns valid messages', async () => {
            const result = (await getPrompt({
                params: {
                    name: 'review_generated_runbook',
                    arguments: { runbook: '{"phases":[]}' },
                },
            })) as { messages: Array<{ role: string; content: { type: string; text: string } }> };

            expect(result.messages).toHaveLength(2);
            expect(result.messages[0].content.text).toContain('{"phases":[]}');
        });

        it('repair_failed_phase returns valid messages', async () => {
            const result = (await getPrompt({
                params: {
                    name: 'repair_failed_phase',
                    arguments: {
                        phase_context: 'Fix CSS',
                        prior_output: 'partial changes',
                        failure_reason: 'timeout',
                        retry_count: '2',
                    },
                },
            })) as { messages: Array<{ role: string; content: { type: string; text: string } }> };

            expect(result.messages).toHaveLength(2);
            expect(result.messages[0].content.text).toContain('Fix CSS');
            expect(result.messages[0].content.text).toContain('timeout');
            expect(result.messages[0].content.text).toContain('2');
        });

        it('consolidate_session returns valid messages', async () => {
            const result = (await getPrompt({
                params: {
                    name: 'consolidate_session',
                    arguments: {
                        handoffs: '[{"phaseId":"p1"}]',
                        modified_files: '["src/a.ts"]',
                    },
                },
            })) as { messages: Array<{ role: string; content: { type: string; text: string } }> };

            expect(result.messages).toHaveLength(2);
            expect(result.messages[0].content.text).toContain('[{"phaseId":"p1"}]');
            expect(result.messages[0].content.text).toContain('["src/a.ts"]');
        });

        it('architecture_review_workspace returns valid messages', async () => {
            const result = (await getPrompt({
                params: {
                    name: 'architecture_review_workspace',
                    arguments: {
                        workspace_summary: 'Monorepo with 5 packages',
                        output_style: 'brief',
                    },
                },
            })) as { messages: Array<{ role: string; content: { type: string; text: string } }> };

            expect(result.messages).toHaveLength(2);
            expect(result.messages[0].content.text).toContain('Monorepo with 5 packages');
            expect(result.messages[0].content.text).toContain('brief');
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    //  GetPrompt — Missing required args
    // ═══════════════════════════════════════════════════════════════════════

    describe('GetPrompt — missing required args', () => {
        it('throws when plan_repo_task is called without task', async () => {
            await expect(
                getPrompt({ params: { name: 'plan_repo_task', arguments: {} } })
            ).rejects.toThrow(/Missing required argument 'task'/);
        });

        it('throws when review_generated_runbook is called without runbook', async () => {
            await expect(
                getPrompt({ params: { name: 'review_generated_runbook', arguments: {} } })
            ).rejects.toThrow(/Missing required argument 'runbook'/);
        });

        it('throws when repair_failed_phase is called without phase_context', async () => {
            await expect(
                getPrompt({
                    params: {
                        name: 'repair_failed_phase',
                        arguments: { prior_output: 'x', failure_reason: 'y', retry_count: '1' },
                    },
                })
            ).rejects.toThrow(/Missing required argument 'phase_context'/);
        });

        it('throws when repair_failed_phase is called without prior_output', async () => {
            await expect(
                getPrompt({
                    params: {
                        name: 'repair_failed_phase',
                        arguments: { phase_context: 'x', failure_reason: 'y', retry_count: '1' },
                    },
                })
            ).rejects.toThrow(/Missing required argument 'prior_output'/);
        });

        it('throws when consolidate_session is called without handoffs', async () => {
            await expect(
                getPrompt({
                    params: {
                        name: 'consolidate_session',
                        arguments: { modified_files: '[]' },
                    },
                })
            ).rejects.toThrow(/Missing required argument 'handoffs'/);
        });

        it('throws when architecture_review_workspace is called without workspace_summary', async () => {
            await expect(
                getPrompt({
                    params: { name: 'architecture_review_workspace', arguments: {} },
                })
            ).rejects.toThrow(/Missing required argument 'workspace_summary'/);
        });

        it('throws for an unknown prompt name', async () => {
            await expect(
                getPrompt({ params: { name: 'nonexistent_prompt', arguments: {} } })
            ).rejects.toThrow(/Unknown prompt: nonexistent_prompt/);
        });

        it('throws when required arg is an empty string', async () => {
            await expect(
                getPrompt({ params: { name: 'plan_repo_task', arguments: { task: '   ' } } })
            ).rejects.toThrow(/Missing required argument 'task'/);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    //  Prompt invocation logging
    // ═══════════════════════════════════════════════════════════════════════

    describe('Prompt invocation logging', () => {
        it('logs prompt name, version, argument keys, and timestamp', async () => {
            await getPrompt({
                params: {
                    name: 'plan_repo_task',
                    arguments: { task: 'test task', constraints: 'none' },
                },
            });

            expect(log.info).toHaveBeenCalledWith(
                expect.stringContaining('[MCPPromptHandler] Prompt invoked: plan_repo_task')
            );
            expect(log.info).toHaveBeenCalledWith(
                expect.stringContaining('v1.0.0')
            );
            expect(log.info).toHaveBeenCalledWith(
                expect.stringContaining('args=[task, constraints]')
            );
        });

        it('does not log when listing prompts (only on GetPrompt)', async () => {
            jest.clearAllMocks();
            await listPrompts({});
            expect(log.info).not.toHaveBeenCalled();
        });
    });
});
