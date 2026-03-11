// ─────────────────────────────────────────────────────────────────────────────
// src/planner/__tests__/PlannerAgent.injection.test.ts
// Tests for PlannerAgent execution mode handling and prompt adjustment
// ─────────────────────────────────────────────────────────────────────────────

jest.mock('vscode', () => ({
    commands: { registerCommand: jest.fn() },
    window: {
        showWarningMessage: jest.fn(),
        showErrorMessage: jest.fn(),
        showInformationMessage: jest.fn(),
    },
    workspace: { workspaceFolders: [] },
    Uri: { file: jest.fn((p: string) => ({ fsPath: p, scheme: 'file' })) },
}), { virtual: true });

// Mock RepoFingerprinter and PlannerPromptCompiler
jest.mock('../../prompt-compiler/index.js', () => {
    const actual = jest.requireActual('../../prompt-compiler/index.js');
    return {
        ...actual,
        RepoFingerprinter: jest.fn().mockImplementation(() => ({
            getEffectiveRoot: jest.fn(async () => '/tmp/test-workspace'),
            fingerprint: jest.fn(async () => ({})),
        })),
        PlannerPromptCompiler: jest.fn().mockImplementation(() => ({
            compile: jest.fn(async () => ({
                text: 'mock-system-prompt-for-injection-test',
                manifest: {
                    taskFamily: 'planning',
                    templateId: 'mock',
                    appliedPolicies: [],
                    fingerprintHash: 'abc123',
                },
            })),
        })),
    };
});

import { PlannerAgent } from '../PlannerAgent.js';
import type { AgentBackendProvider } from '../../adk/AgentBackendProvider.js';
import type { ADKSessionHandle, ADKSessionOptions } from '../../adk/ADKController.js';
import type { WorkspaceScanner } from '../WorkspaceScanner.js';
import type { ExecutionMode } from '../../adk/AntigravityADKAdapter.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Factories
// ═══════════════════════════════════════════════════════════════════════════════

interface MockAdapterWithMode extends AgentBackendProvider {
    getExecutionMode: () => Promise<ExecutionMode>;
}

function createMockAdapter(executionMode: ExecutionMode = 'fallback'): MockAdapterWithMode {
    return {
        name: 'test',
        createSession: jest.fn(async (_opts: ADKSessionOptions): Promise<ADKSessionHandle> => ({
            sessionId: 'mock-session-id',
            pid: 12345,
            onOutput: jest.fn(),
            onExit: jest.fn(),
        })),
        terminateSession: jest.fn(async () => {}),
        getExecutionMode: jest.fn(async () => executionMode),
    };
}

function createMockAdapterWithoutMode(): AgentBackendProvider {
    return {
        name: 'test-no-mode',
        createSession: jest.fn(async (_opts: ADKSessionOptions): Promise<ADKSessionHandle> => ({
            sessionId: 'mock-session-id-no-mode',
            pid: 54321,
            onOutput: jest.fn(),
            onExit: jest.fn(),
        })),
        terminateSession: jest.fn(async () => {}),
    };
}

function createMockScanner(): WorkspaceScanner {
    return {
        scan: jest.fn(async () => ['src/index.ts', 'package.json']),
    } as unknown as WorkspaceScanner;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('PlannerAgent — Execution Mode & Prompt Injection', () => {
    // ─────────────────────────────────────────────────────────────────────
    //  Fallback Mode
    // ─────────────────────────────────────────────────────────────────────

    describe('fallback mode', () => {
        it('planner prompt is clean in fallback mode — adapter handles response.md', async () => {
            const adapter = createMockAdapter('fallback');
            const agent = new PlannerAgent(adapter, {
                workspaceRoot: '/tmp/test-workspace',
                maxTreeDepth: 1,
                maxTreeChars: 100,
            }, { scanner: createMockScanner() });

            await agent.plan('Build a REST API');

            const createSession = adapter.createSession as jest.Mock;
            expect(createSession).toHaveBeenCalledTimes(1);

            const passedOptions = createSession.mock.calls[0][0] as ADKSessionOptions;
            const prompt = passedOptions.initialPrompt;

            // Planner no longer appends response.md instructions —
            // the adapter layer handles that during createFileIpcSession.
            expect(prompt).toContain('mock-system-prompt-for-injection-test');
            expect(prompt).not.toContain('## Output');
            expect(prompt).not.toContain('Write your COMPLETE response');
        });

        it('preserves the compiled system prompt in fallback mode', async () => {
            const adapter = createMockAdapter('fallback');
            const agent = new PlannerAgent(adapter, {
                workspaceRoot: '/tmp/test-workspace',
                maxTreeDepth: 1,
                maxTreeChars: 100,
            }, { scanner: createMockScanner() });

            await agent.plan('Deploy infrastructure');

            const createSession = adapter.createSession as jest.Mock;
            const prompt = (createSession.mock.calls[0][0] as ADKSessionOptions).initialPrompt;

            // The mock PlannerPromptCompiler returns 'mock-system-prompt-for-injection-test'
            expect(prompt).toContain('mock-system-prompt-for-injection-test');
        });

        it('stores lastExecutionMode as fallback', async () => {
            const adapter = createMockAdapter('fallback');
            const agent = new PlannerAgent(adapter, {
                workspaceRoot: '/tmp/test-workspace',
                maxTreeDepth: 1,
                maxTreeChars: 100,
            }, { scanner: createMockScanner() });

            await agent.plan('Test query');

            expect(agent.getLastExecutionMode()).toBe('fallback');
        });
    });

    // ─────────────────────────────────────────────────────────────────────
    //  Primary Mode
    // ─────────────────────────────────────────────────────────────────────

    describe('primary mode', () => {
        it('does NOT append response.md write instructions in primary mode', async () => {
            const adapter = createMockAdapter('primary');
            const agent = new PlannerAgent(adapter, {
                workspaceRoot: '/tmp/test-workspace',
                maxTreeDepth: 1,
                maxTreeChars: 100,
            }, { scanner: createMockScanner() });

            await agent.plan('Build a REST API');

            const createSession = adapter.createSession as jest.Mock;
            expect(createSession).toHaveBeenCalledTimes(1);

            const passedOptions = createSession.mock.calls[0][0] as ADKSessionOptions;
            const prompt = passedOptions.initialPrompt;

            // Must NOT contain response.md file write instructions in primary mode
            expect(prompt).not.toContain('## Output');
            expect(prompt).not.toContain('Write your COMPLETE response to the response.md');
        });

        it('still contains the compiled system prompt in primary mode', async () => {
            const adapter = createMockAdapter('primary');
            const agent = new PlannerAgent(adapter, {
                workspaceRoot: '/tmp/test-workspace',
                maxTreeDepth: 1,
                maxTreeChars: 100,
            }, { scanner: createMockScanner() });

            await agent.plan('Deploy infrastructure');

            const createSession = adapter.createSession as jest.Mock;
            const prompt = (createSession.mock.calls[0][0] as ADKSessionOptions).initialPrompt;

            expect(prompt).toContain('mock-system-prompt-for-injection-test');
        });

        it('stores lastExecutionMode as primary', async () => {
            const adapter = createMockAdapter('primary');
            const agent = new PlannerAgent(adapter, {
                workspaceRoot: '/tmp/test-workspace',
                maxTreeDepth: 1,
                maxTreeChars: 100,
            }, { scanner: createMockScanner() });

            await agent.plan('Test query');

            expect(agent.getLastExecutionMode()).toBe('primary');
        });
    });

    // ─────────────────────────────────────────────────────────────────────
    //  Missing getExecutionMode (adapter without the method)
    // ─────────────────────────────────────────────────────────────────────

    describe('adapter without getExecutionMode()', () => {
        it('defaults to fallback mode when adapter lacks getExecutionMode', async () => {
            const adapter = createMockAdapterWithoutMode();
            const agent = new PlannerAgent(adapter, {
                workspaceRoot: '/tmp/test-workspace',
                maxTreeDepth: 1,
                maxTreeChars: 100,
            }, { scanner: createMockScanner() });

            await agent.plan('Refactor database');

            // Should default to fallback → response.md instructions appended
            expect(agent.getLastExecutionMode()).toBe('fallback');

            const createSession = adapter.createSession as jest.Mock;
            const prompt = (createSession.mock.calls[0][0] as ADKSessionOptions).initialPrompt;

            // Planner prompt is clean — adapter handles response.md instructions.
            expect(prompt).toContain('mock-system-prompt-for-injection-test');
            expect(prompt).not.toContain('response.md');
        });
    });

    // ─────────────────────────────────────────────────────────────────────
    //  Session Options
    // ─────────────────────────────────────────────────────────────────────

    describe('session options', () => {
        it('passes masterTaskId when set', async () => {
            const adapter = createMockAdapter('primary');
            const agent = new PlannerAgent(adapter, {
                workspaceRoot: '/tmp/test-workspace',
                maxTreeDepth: 1,
                maxTreeChars: 100,
            }, { scanner: createMockScanner() });

            agent.setMasterTaskId('task-xyz-123');
            await agent.plan('Build auth system');

            const createSession = adapter.createSession as jest.Mock;
            const passedOptions = createSession.mock.calls[0][0] as ADKSessionOptions;
            expect(passedOptions.masterTaskId).toBe('task-xyz-123');
        });

        it('always uses phaseNumber=0 for planner', async () => {
            const adapter = createMockAdapter('primary');
            const agent = new PlannerAgent(adapter, {
                workspaceRoot: '/tmp/test-workspace',
                maxTreeDepth: 1,
                maxTreeChars: 100,
            }, { scanner: createMockScanner() });

            await agent.plan('Build payments');

            const createSession = adapter.createSession as jest.Mock;
            const passedOptions = createSession.mock.calls[0][0] as ADKSessionOptions;
            expect(passedOptions.phaseNumber).toBe(0);
        });

        it('always passes newConversation=true for planner', async () => {
            const adapter = createMockAdapter('primary');
            const agent = new PlannerAgent(adapter, {
                workspaceRoot: '/tmp/test-workspace',
                maxTreeDepth: 1,
                maxTreeChars: 100,
            }, { scanner: createMockScanner() });

            await agent.plan('Clean up codebase');

            const createSession = adapter.createSession as jest.Mock;
            const passedOptions = createSession.mock.calls[0][0] as ADKSessionOptions;
            expect(passedOptions.newConversation).toBe(true);
        });
    });
});
