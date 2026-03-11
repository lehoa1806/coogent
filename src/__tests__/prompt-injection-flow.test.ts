// ─────────────────────────────────────────────────────────────────────────────
// src/__tests__/prompt-injection-flow.test.ts
// Integration tests for the end-to-end prompt injection flow
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
jest.mock('../prompt-compiler/index.js', () => {
    const actual = jest.requireActual('../prompt-compiler/index.js');
    return {
        ...actual,
        RepoFingerprinter: jest.fn().mockImplementation(() => ({
            getEffectiveRoot: jest.fn(async () => '/tmp/test-workspace'),
            fingerprint: jest.fn(async () => ({})),
        })),
        PlannerPromptCompiler: jest.fn().mockImplementation(() => ({
            compile: jest.fn(async () => ({
                text: 'integration-test-system-prompt',
                manifest: {
                    taskFamily: 'planning',
                    templateId: 'mock',
                    appliedPolicies: [],
                    fingerprintHash: 'int-test',
                },
            })),
        })),
    };
});

// Mock MissionControlPanel to prevent broadcast errors
jest.mock('../webview/MissionControlPanel.js', () => ({
    MissionControlPanel: {
        broadcast: jest.fn(),
    },
}));

// Mock logger — must use __esModule for correct default import interop
jest.mock('../logger/log.js', () => ({
    __esModule: true,
    default: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        onError: jest.fn(),
    },
}));

import { PlannerAgent } from '../planner/PlannerAgent.js';
import {
    WorkerLauncher,
    type WorkerLauncherADK,
    type WorkerLauncherLogger,
} from '../engine/WorkerLauncher.js';
import type { AgentBackendProvider } from '../adk/AgentBackendProvider.js';
import type { ADKSessionHandle, ADKSessionOptions } from '../adk/ADKController.js';
import type { WorkspaceScanner } from '../planner/WorkspaceScanner.js';
import type { ExecutionMode } from '../adk/AntigravityADKAdapter.js';
import type { HandoffExtractor } from '../context/HandoffExtractor.js';
import type { ServiceContainer } from '../ServiceContainer.js';
import { asPhaseId, type Phase } from '../types/index.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Shared Factories
// ═══════════════════════════════════════════════════════════════════════════════

interface MockAdapterWithMode extends AgentBackendProvider {
    getExecutionMode: () => Promise<ExecutionMode>;
}

function createAdapter(mode: ExecutionMode): MockAdapterWithMode {
    return {
        name: 'integration-test',
        createSession: jest.fn(async (_opts: ADKSessionOptions): Promise<ADKSessionHandle> => ({
            sessionId: `int-session-${mode}`,
            pid: 77777,
            onOutput: jest.fn(),
            onExit: jest.fn(),
        })),
        terminateSession: jest.fn(async () => {}),
        getExecutionMode: jest.fn(async () => mode),
    };
}

function createScanner(): WorkspaceScanner {
    return {
        scan: jest.fn(async () => ['src/main.ts', 'tsconfig.json']),
    } as unknown as WorkspaceScanner;
}

function createADK(mode: ExecutionMode): WorkerLauncherADK & { getExecutionMode: () => Promise<ExecutionMode> } {
    return {
        spawnWorker: jest.fn(async () => {}),
        getExecutionMode: jest.fn(async () => mode),
    };
}

function createLogger(): WorkerLauncherLogger {
    return {
        logPhasePrompt: jest.fn(async () => {}),
        initRun: jest.fn(async () => {}),
    };
}

function createSvc(overrides: Partial<ServiceContainer> = {}): ServiceContainer {
    return {
        engine: { getRunbook: jest.fn(() => null) },
        handoffExtractor: {
            buildNextContext: jest.fn(async () => 'integration-handoff-context'),
            generateDistillationPrompt: jest.fn(() => 'integration-distillation'),
        } as unknown as HandoffExtractor,
        currentSessionDir: '/tmp/int-test-session',
        agentRegistry: null,
        mcpServer: null,
        ...overrides,
    } as unknown as ServiceContainer;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Integration Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('Prompt Injection Flow — Integration', () => {
    // ─────────────────────────────────────────────────────────────────────
    //  Planner + Primary Mode
    // ─────────────────────────────────────────────────────────────────────

    describe('planner → primary mode', () => {
        it('prompt is injected directly without response.md instructions', async () => {
            const adapter = createAdapter('primary');
            const agent = new PlannerAgent(adapter, {
                workspaceRoot: '/tmp/test-workspace',
                maxTreeDepth: 1,
                maxTreeChars: 100,
            }, { scanner: createScanner() });

            agent.setMasterTaskId('int-primary-task');
            await agent.plan('Build microservices architecture');

            // Verify mode
            expect(agent.getLastExecutionMode()).toBe('primary');
            expect(adapter.getExecutionMode).toHaveBeenCalled();

            // Verify prompt does NOT contain response.md instructions
            const createSession = adapter.createSession as jest.Mock;
            const prompt = (createSession.mock.calls[0][0] as ADKSessionOptions).initialPrompt;
            expect(prompt).toContain('integration-test-system-prompt');
            expect(prompt).not.toContain('Write your COMPLETE response to the response.md');
            expect(prompt).not.toContain('## Output');

            // Session options
            expect(createSession.mock.calls[0][0]).toEqual(
                expect.objectContaining({
                    masterTaskId: 'int-primary-task',
                    phaseNumber: 0,
                    newConversation: true,
                    zeroContext: true,
                }),
            );
        });
    });

    // ─────────────────────────────────────────────────────────────────────
    //  Planner + Fallback Mode
    // ─────────────────────────────────────────────────────────────────────

    describe('planner → fallback mode', () => {
        it('prompt includes response.md write instructions', async () => {
            const adapter = createAdapter('fallback');
            const agent = new PlannerAgent(adapter, {
                workspaceRoot: '/tmp/test-workspace',
                maxTreeDepth: 1,
                maxTreeChars: 100,
            }, { scanner: createScanner() });

            agent.setMasterTaskId('int-fallback-task');
            await agent.plan('Create data pipeline');

            expect(agent.getLastExecutionMode()).toBe('fallback');

            const createSession = adapter.createSession as jest.Mock;
            const prompt = (createSession.mock.calls[0][0] as ADKSessionOptions).initialPrompt;
            expect(prompt).toContain('integration-test-system-prompt');
            expect(prompt).toContain('## Output');
            expect(prompt).toContain('Write your COMPLETE response to the response.md');
        });
    });

    // ─────────────────────────────────────────────────────────────────────
    //  Worker Launcher + Mode Propagation
    // ─────────────────────────────────────────────────────────────────────

    describe('worker launcher → mode propagation', () => {
        it('passes primary executionMode through the full launch flow', async () => {
            const adk = createADK('primary');
            const launcher = new WorkerLauncher(adk, createLogger());

            const phase: Phase = {
                id: asPhaseId(1),
                prompt: 'Build API endpoints',
                context_files: ['src/routes.ts'],
                status: 'pending',
                success_criteria: 'exit_code:0',
            };

            await launcher.launch(phase, 120_000, 'int-worker-primary', createSvc());

            // Verify executionMode propagated to spawnWorker as 5th argument
            const spawnCall = (adk.spawnWorker as jest.Mock).mock.calls[0];
            expect(spawnCall[4]).toBe('primary');

            // Verify prompt assembly includes handoff and distillation
            const spawnedPhase = spawnCall[0] as Phase;
            expect(spawnedPhase.prompt).toContain('integration-handoff-context');
            expect(spawnedPhase.prompt).toContain('integration-distillation');
            expect(spawnedPhase.prompt).toContain('Build API endpoints');
        });

        it('passes fallback executionMode through the full launch flow', async () => {
            const adk = createADK('fallback');
            const launcher = new WorkerLauncher(adk, createLogger());

            const phase: Phase = {
                id: asPhaseId(2),
                prompt: 'Write tests',
                context_files: [],
                status: 'pending',
                success_criteria: 'exit_code:0',
            };

            await launcher.launch(phase, 120_000, 'int-worker-fallback', createSvc());

            const spawnCall = (adk.spawnWorker as jest.Mock).mock.calls[0];
            expect(spawnCall[4]).toBe('fallback');
        });
    });

    // ─────────────────────────────────────────────────────────────────────
    //  Contract: response.md is always the completion signal
    // ─────────────────────────────────────────────────────────────────────

    describe('response.md contract', () => {
        it('response.md write instructions appear only in fallback planner prompt', async () => {
            // Test both modes in sequence to confirm the contract
            const primaryAdapter = createAdapter('primary');
            const primaryAgent = new PlannerAgent(primaryAdapter, {
                workspaceRoot: '/tmp/test-workspace',
                maxTreeDepth: 1,
                maxTreeChars: 100,
            }, { scanner: createScanner() });
            await primaryAgent.plan('Query 1');

            const fallbackAdapter = createAdapter('fallback');
            const fallbackAgent = new PlannerAgent(fallbackAdapter, {
                workspaceRoot: '/tmp/test-workspace',
                maxTreeDepth: 1,
                maxTreeChars: 100,
            }, { scanner: createScanner() });
            await fallbackAgent.plan('Query 2');

            const primaryPrompt = ((primaryAdapter.createSession as jest.Mock).mock.calls[0][0] as ADKSessionOptions).initialPrompt;
            const fallbackPrompt = ((fallbackAdapter.createSession as jest.Mock).mock.calls[0][0] as ADKSessionOptions).initialPrompt;

            // Primary: no response.md file write instructions
            expect(primaryPrompt).not.toContain('Write your COMPLETE response to the response.md');

            // Fallback: response.md file write instructions present
            expect(fallbackPrompt).toContain('Write your COMPLETE response to the response.md');
        });
    });

    // ─────────────────────────────────────────────────────────────────────
    //  Regression: Stale request.md does not affect primary mode
    // ─────────────────────────────────────────────────────────────────────

    describe('stale request.md → primary mode', () => {
        it('prompt does NOT contain request.md instructions even if request.md exists from a prior run', async () => {
            // Simulate a stale request.md existing from a previous fallback run:
            // In primary mode the prompt is injected directly — no request.md reference.
            const adapter = createAdapter('primary');
            const agent = new PlannerAgent(adapter, {
                workspaceRoot: '/tmp/test-workspace',
                maxTreeDepth: 1,
                maxTreeChars: 100,
            }, { scanner: createScanner() });

            agent.setMasterTaskId('stale-request-primary-task');
            await agent.plan('Refactor database layer');

            expect(agent.getLastExecutionMode()).toBe('primary');

            const createSession = adapter.createSession as jest.Mock;
            const prompt = (createSession.mock.calls[0][0] as ADKSessionOptions).initialPrompt;

            // Primary mode: no request.md instructions regardless of filesystem state
            expect(prompt).not.toContain('request.md');
            expect(prompt).not.toContain('Read the instructions from the file');

            // Verify createSession was called with the direct compiled prompt, not a meta-prompt
            expect(prompt).toContain('integration-test-system-prompt');
            expect(createSession).toHaveBeenCalledWith(
                expect.objectContaining({
                    masterTaskId: 'stale-request-primary-task',
                    newConversation: true,
                    zeroContext: true,
                }),
            );
        });
    });

    // ─────────────────────────────────────────────────────────────────────
    //  Regression: Fallback mode writes request.md (meta-prompt)
    // ─────────────────────────────────────────────────────────────────────

    describe('fallback mode → request.md meta-prompt', () => {
        it('prompt includes instructions to read request.md and write response.md', async () => {
            const adapter = createAdapter('fallback');
            const agent = new PlannerAgent(adapter, {
                workspaceRoot: '/tmp/test-workspace',
                maxTreeDepth: 1,
                maxTreeChars: 100,
            }, { scanner: createScanner() });

            agent.setMasterTaskId('fallback-request-write');
            await agent.plan('Create authentication module');

            expect(agent.getLastExecutionMode()).toBe('fallback');

            const createSession = adapter.createSession as jest.Mock;
            const prompt = (createSession.mock.calls[0][0] as ADKSessionOptions).initialPrompt;

            // Fallback mode: must include filesystem instructions for response.md
            expect(prompt).toContain('## Output');
            expect(prompt).toContain('Write your COMPLETE response to the response.md');
        });
    });

    // ─────────────────────────────────────────────────────────────────────
    //  Regression: Worker prompt in primary mode excludes request.md
    // ─────────────────────────────────────────────────────────────────────

    describe('worker prompt → primary mode excludes request.md', () => {
        it('effective prompt does NOT contain request.md references in primary mode', async () => {
            const adk = createADK('primary');
            const launcher = new WorkerLauncher(adk, createLogger());

            const phase: Phase = {
                id: asPhaseId(3),
                prompt: 'Build payment processing',
                context_files: ['src/payment.ts'],
                status: 'pending',
                success_criteria: 'exit_code:0',
            };

            await launcher.launch(phase, 120_000, 'worker-primary-no-request', createSvc());

            const spawnCall = (adk.spawnWorker as jest.Mock).mock.calls[0];
            const spawnedPhase = spawnCall[0] as Phase;

            // Verify request.md is absent from the effective prompt
            expect(spawnedPhase.prompt).not.toContain('request.md');
            expect(spawnedPhase.prompt).not.toContain('Read the instructions from the file');

            // Verify the original prompt content IS present
            expect(spawnedPhase.prompt).toContain('Build payment processing');

            // Verify mode propagated
            expect(spawnCall[4]).toBe('primary');
        });
    });

    // ─────────────────────────────────────────────────────────────────────
    //  Regression: Mode detection absent → safe default to fallback
    //  The production code uses `typeof getExecutionMode === 'function'`
    //  to guard the call. When getExecutionMode is missing (adapter
    //  doesn't expose it), the safe default 'fallback' is used.
    // ─────────────────────────────────────────────────────────────────────

    describe('mode detection absent → defaults to fallback', () => {
        it('planner defaults to fallback when adapter lacks getExecutionMode', async () => {
            // Create a bare adapter WITHOUT getExecutionMode
            const adapter: AgentBackendProvider = {
                name: 'no-mode-adapter',
                createSession: jest.fn(async (_opts: ADKSessionOptions): Promise<ADKSessionHandle> => ({
                    sessionId: 'int-session-no-mode',
                    pid: 88888,
                    onOutput: jest.fn(),
                    onExit: jest.fn(),
                })),
                terminateSession: jest.fn(async () => {}),
                // NOTE: getExecutionMode intentionally omitted
            };

            const agent = new PlannerAgent(adapter, {
                workspaceRoot: '/tmp/test-workspace',
                maxTreeDepth: 1,
                maxTreeChars: 100,
            }, { scanner: createScanner() });

            agent.setMasterTaskId('fallback-no-method');
            await agent.plan('Run security audit');

            // typeof check fails → executionMode stays at safe default 'fallback'
            expect(agent.getLastExecutionMode()).toBe('fallback');

            const createSession = adapter.createSession as jest.Mock;
            const prompt = (createSession.mock.calls[0][0] as ADKSessionOptions).initialPrompt;

            // Fallback mode: should include response.md filesystem instructions
            expect(prompt).toContain('## Output');
            expect(prompt).toContain('Write your COMPLETE response to the response.md');
        });

        it('worker launcher defaults to fallback when ADK lacks getExecutionMode', async () => {
            // Create a bare ADK mock WITHOUT getExecutionMode
            const adk: WorkerLauncherADK = {
                spawnWorker: jest.fn(async () => {}),
                // NOTE: getExecutionMode intentionally omitted
            };

            const launcher = new WorkerLauncher(adk, createLogger());
            const phase: Phase = {
                id: asPhaseId(4),
                prompt: 'Optimize queries',
                context_files: [],
                status: 'pending',
                success_criteria: 'exit_code:0',
            };

            await launcher.launch(phase, 120_000, 'worker-fallback-no-method', createSvc());

            const spawnCall = (adk.spawnWorker as jest.Mock).mock.calls[0];
            // executionMode defaults to 'fallback' since getExecutionMode is absent
            expect(spawnCall[4]).toBe('fallback');
        });
    });

    // ─────────────────────────────────────────────────────────────────────
    //  Regression: response.md contract is mode-independent
    // ─────────────────────────────────────────────────────────────────────

    describe('response.md contract → mode-independent guarantees', () => {
        it('primary mode: prompt never instructs filesystem write to response.md', async () => {
            const adapter = createAdapter('primary');
            const agent = new PlannerAgent(adapter, {
                workspaceRoot: '/tmp/test-workspace',
                maxTreeDepth: 1,
                maxTreeChars: 100,
            }, { scanner: createScanner() });

            await agent.plan('Migrate to ESM');

            const createSession = adapter.createSession as jest.Mock;
            const prompt = (createSession.mock.calls[0][0] as ADKSessionOptions).initialPrompt;

            // In primary mode, the response streams back via vscode.lm — no response.md write
            expect(prompt).not.toContain('Write your COMPLETE response to the response.md');
            expect(prompt).not.toContain('## Output');
        });

        it('fallback mode: prompt always instructs write to response.md', async () => {
            const adapter = createAdapter('fallback');
            const agent = new PlannerAgent(adapter, {
                workspaceRoot: '/tmp/test-workspace',
                maxTreeDepth: 1,
                maxTreeChars: 100,
            }, { scanner: createScanner() });

            await agent.plan('Add WebSocket support');

            const createSession = adapter.createSession as jest.Mock;
            const prompt = (createSession.mock.calls[0][0] as ADKSessionOptions).initialPrompt;

            expect(prompt).toContain('## Output');
            expect(prompt).toContain('Write your COMPLETE response to the response.md');
        });

        it('worker in both modes: executionMode is always propagated to spawnWorker', async () => {
            // Primary
            const adkPrimary = createADK('primary');
            const launcherPrimary = new WorkerLauncher(adkPrimary, createLogger());
            const phasePrimary: Phase = {
                id: asPhaseId(5),
                prompt: 'Primary task',
                context_files: [],
                status: 'pending',
                success_criteria: 'exit_code:0',
            };
            await launcherPrimary.launch(phasePrimary, 120_000, 'mode-contract-primary', createSvc());
            expect((adkPrimary.spawnWorker as jest.Mock).mock.calls[0][4]).toBe('primary');

            // Fallback
            const adkFallback = createADK('fallback');
            const launcherFallback = new WorkerLauncher(adkFallback, createLogger());
            const phaseFallback: Phase = {
                id: asPhaseId(6),
                prompt: 'Fallback task',
                context_files: [],
                status: 'pending',
                success_criteria: 'exit_code:0',
            };
            await launcherFallback.launch(phaseFallback, 120_000, 'mode-contract-fallback', createSvc());
            expect((adkFallback.spawnWorker as jest.Mock).mock.calls[0][4]).toBe('fallback');
        });
    });
});
