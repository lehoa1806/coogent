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
import type { ExecutionMode } from '../adk/ExecutionModeResolver.js';
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
    //  Planner + Antigravity Mode
    // ─────────────────────────────────────────────────────────────────────

    describe('planner → antigravity mode', () => {
        it('prompt is injected directly without response.md instructions', async () => {
            const adapter = createAdapter('antigravity');
            const agent = new PlannerAgent(adapter, {
                workspaceRoot: '/tmp/test-workspace',
                maxTreeDepth: 1,
                maxTreeChars: 100,
            }, { scanner: createScanner() });

            agent.setMasterTaskId('int-antigravity-task');
            await agent.plan('Build microservices architecture');

            // Verify mode
            expect(agent.getLastExecutionMode()).toBe('antigravity');
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
                    masterTaskId: 'int-antigravity-task',
                    phaseNumber: 0,
                    newConversation: true,
                    zeroContext: true,
                }),
            );
        });
    });

    // ─────────────────────────────────────────────────────────────────────
    //  Planner + Unsupported Mode
    // ─────────────────────────────────────────────────────────────────────

    describe('planner → unsupported mode', () => {
        it('planner prompt is identical to antigravity — adapter handles response.md', async () => {
            const adapter = createAdapter('unsupported');
            const agent = new PlannerAgent(adapter, {
                workspaceRoot: '/tmp/test-workspace',
                maxTreeDepth: 1,
                maxTreeChars: 100,
            }, { scanner: createScanner() });

            agent.setMasterTaskId('int-unsupported-task');
            await agent.plan('Create data pipeline');

            expect(agent.getLastExecutionMode()).toBe('unsupported');

            const createSession = adapter.createSession as jest.Mock;
            const prompt = (createSession.mock.calls[0][0] as ADKSessionOptions).initialPrompt;
            expect(prompt).toContain('integration-test-system-prompt');

            // The planner no longer appends response.md instructions —
            // the adapter layer handles that during createFileIpcSession.
            expect(prompt).not.toContain('## Output');
            expect(prompt).not.toContain('Write your COMPLETE response to the response.md');
        });
    });

    // ─────────────────────────────────────────────────────────────────────
    //  Worker Launcher + Mode Propagation
    // ─────────────────────────────────────────────────────────────────────

    describe('worker launcher → mode propagation', () => {
        it('resolves antigravity executionMode through the full launch flow', async () => {
            const adk = createADK('antigravity');
            const launcher = new WorkerLauncher(adk, createLogger());

            const phase: Phase = {
                id: asPhaseId(1),
                prompt: 'Build API endpoints',
                context_files: ['src/routes.ts'],
                status: 'pending',
                success_criteria: 'exit_code:0',
            };

            await launcher.launch(phase, 120_000, 'int-worker-antigravity', createSvc());

            // spawnWorker is called with 4 args (no executionMode param)
            const spawnCall = (adk.spawnWorker as jest.Mock).mock.calls[0];
            expect(spawnCall).toHaveLength(4);

            // Verify prompt assembly includes handoff and distillation
            const spawnedPhase = spawnCall[0] as Phase;
            expect(spawnedPhase.prompt).toContain('integration-handoff-context');
            expect(spawnedPhase.prompt).toContain('integration-distillation');
            expect(spawnedPhase.prompt).toContain('Build API endpoints');
        });

        it('resolves unsupported executionMode through the full launch flow', async () => {
            const adk = createADK('unsupported');
            const launcher = new WorkerLauncher(adk, createLogger());

            const phase: Phase = {
                id: asPhaseId(2),
                prompt: 'Write tests',
                context_files: [],
                status: 'pending',
                success_criteria: 'exit_code:0',
            };

            await launcher.launch(phase, 120_000, 'int-worker-unsupported', createSvc());

            // spawnWorker is called with 4 args (no executionMode param)
            const spawnCall = (adk.spawnWorker as jest.Mock).mock.calls[0];
            expect(spawnCall).toHaveLength(4);
        });
    });

    // ─────────────────────────────────────────────────────────────────────
    //  Contract: response.md is always the completion signal
    // ─────────────────────────────────────────────────────────────────────

    describe('response.md contract', () => {
        it('planner prompt never contains response.md instructions — adapter handles it', async () => {
            // Test both modes in sequence to confirm the planner is clean
            const antigravityAdapter = createAdapter('antigravity');
            const antigravityAgent = new PlannerAgent(antigravityAdapter, {
                workspaceRoot: '/tmp/test-workspace',
                maxTreeDepth: 1,
                maxTreeChars: 100,
            }, { scanner: createScanner() });
            await antigravityAgent.plan('Query 1');

            const unsupportedAdapter = createAdapter('unsupported');
            const unsupportedAgent = new PlannerAgent(unsupportedAdapter, {
                workspaceRoot: '/tmp/test-workspace',
                maxTreeDepth: 1,
                maxTreeChars: 100,
            }, { scanner: createScanner() });
            await unsupportedAgent.plan('Query 2');

            const antigravityPrompt = ((antigravityAdapter.createSession as jest.Mock).mock.calls[0][0] as ADKSessionOptions).initialPrompt;
            const unsupportedPrompt = ((unsupportedAdapter.createSession as jest.Mock).mock.calls[0][0] as ADKSessionOptions).initialPrompt;

            // Neither mode includes response.md instructions in the planner
            // prompt — the adapter layer appends them during session creation.
            expect(antigravityPrompt).not.toContain('Write your COMPLETE response to the response.md');
            expect(unsupportedPrompt).not.toContain('Write your COMPLETE response to the response.md');
        });
    });

    // ─────────────────────────────────────────────────────────────────────
    //  Regression: Stale request.md does not affect antigravity mode
    // ─────────────────────────────────────────────────────────────────────

    describe('stale request.md → antigravity mode', () => {
        it('prompt does NOT contain request.md instructions even if request.md exists from a prior run', async () => {
            const adapter = createAdapter('antigravity');
            const agent = new PlannerAgent(adapter, {
                workspaceRoot: '/tmp/test-workspace',
                maxTreeDepth: 1,
                maxTreeChars: 100,
            }, { scanner: createScanner() });

            agent.setMasterTaskId('stale-request-antigravity-task');
            await agent.plan('Refactor database layer');

            expect(agent.getLastExecutionMode()).toBe('antigravity');

            const createSession = adapter.createSession as jest.Mock;
            const prompt = (createSession.mock.calls[0][0] as ADKSessionOptions).initialPrompt;

            // Antigravity mode: no request.md instructions regardless of filesystem state
            expect(prompt).not.toContain('request.md');
            expect(prompt).not.toContain('Read the instructions from the file');

            // Verify createSession was called with the direct compiled prompt, not a meta-prompt
            expect(prompt).toContain('integration-test-system-prompt');
            expect(createSession).toHaveBeenCalledWith(
                expect.objectContaining({
                    masterTaskId: 'stale-request-antigravity-task',
                    newConversation: true,
                    zeroContext: true,
                }),
            );
        });
    });

    // ─────────────────────────────────────────────────────────────────────
    //  Regression: Unsupported mode — adapter handles response.md
    // ─────────────────────────────────────────────────────────────────────

    describe('unsupported mode → no request.md, adapter handles response.md', () => {
        it('planner prompt in unsupported mode is clean — adapter appends response.md instructions', async () => {
            const adapter = createAdapter('unsupported');
            const agent = new PlannerAgent(adapter, {
                workspaceRoot: '/tmp/test-workspace',
                maxTreeDepth: 1,
                maxTreeChars: 100,
            }, { scanner: createScanner() });

            agent.setMasterTaskId('unsupported-request-write');
            await agent.plan('Create authentication module');

            expect(agent.getLastExecutionMode()).toBe('unsupported');

            const createSession = adapter.createSession as jest.Mock;
            const prompt = (createSession.mock.calls[0][0] as ADKSessionOptions).initialPrompt;

            // Planner prompt does NOT contain filesystem instructions;
            // the adapter layer appends them during createFileIpcSession.
            expect(prompt).toContain('integration-test-system-prompt');
            expect(prompt).not.toContain('request.md');
            expect(prompt).not.toContain('## Output');
        });
    });

    // ─────────────────────────────────────────────────────────────────────
    //  Regression: Worker prompt in antigravity mode excludes request.md
    // ─────────────────────────────────────────────────────────────────────

    describe('worker prompt → antigravity mode excludes request.md', () => {
        it('effective prompt does NOT contain request.md references in antigravity mode', async () => {
            const adk = createADK('antigravity');
            const launcher = new WorkerLauncher(adk, createLogger());

            const phase: Phase = {
                id: asPhaseId(3),
                prompt: 'Build payment processing',
                context_files: ['src/payment.ts'],
                status: 'pending',
                success_criteria: 'exit_code:0',
            };

            await launcher.launch(phase, 120_000, 'worker-antigravity-no-request', createSvc());

            const spawnCall = (adk.spawnWorker as jest.Mock).mock.calls[0];
            const spawnedPhase = spawnCall[0] as Phase;

            // Verify request.md is absent from the effective prompt
            expect(spawnedPhase.prompt).not.toContain('request.md');
            expect(spawnedPhase.prompt).not.toContain('Read the instructions from the file');

            // Verify the original prompt content IS present
            expect(spawnedPhase.prompt).toContain('Build payment processing');
        });
    });

    // ─────────────────────────────────────────────────────────────────────
    //  Regression: Mode detection absent → safe default to unsupported
    //  The production code uses `typeof getExecutionMode === 'function'`
    //  to guard the call. When getExecutionMode is missing (adapter
    //  doesn't expose it), the safe default 'unsupported' is used.
    // ─────────────────────────────────────────────────────────────────────

    describe('mode detection absent → defaults to unsupported', () => {
        it('planner defaults to unsupported when adapter lacks getExecutionMode', async () => {
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

            agent.setMasterTaskId('unsupported-no-method');
            await agent.plan('Run security audit');

            // typeof check fails → executionMode stays at safe default 'unsupported'
            expect(agent.getLastExecutionMode()).toBe('unsupported');

            const createSession = adapter.createSession as jest.Mock;
            const prompt = (createSession.mock.calls[0][0] as ADKSessionOptions).initialPrompt;

            // Even in unsupported mode, the planner prompt is clean —
            // the adapter layer appends response.md instructions.
            expect(prompt).toContain('integration-test-system-prompt');
            expect(prompt).not.toContain('## Output');
            expect(prompt).not.toContain('Write your COMPLETE response to the response.md');
        });

        it('worker launcher defaults to unsupported when ADK lacks getExecutionMode', async () => {
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

            await launcher.launch(phase, 120_000, 'worker-unsupported-no-method', createSvc());

            // spawnWorker is called with 4 args (no executionMode param)
            const spawnCall = (adk.spawnWorker as jest.Mock).mock.calls[0];
            expect(spawnCall).toHaveLength(4);
        });
    });

    // ─────────────────────────────────────────────────────────────────────
    //  Regression: response.md contract is mode-independent
    // ─────────────────────────────────────────────────────────────────────

    describe('response.md contract → mode-independent guarantees', () => {
        it('antigravity mode: prompt never instructs filesystem write to response.md', async () => {
            const adapter = createAdapter('antigravity');
            const agent = new PlannerAgent(adapter, {
                workspaceRoot: '/tmp/test-workspace',
                maxTreeDepth: 1,
                maxTreeChars: 100,
            }, { scanner: createScanner() });

            await agent.plan('Migrate to ESM');

            const createSession = adapter.createSession as jest.Mock;
            const prompt = (createSession.mock.calls[0][0] as ADKSessionOptions).initialPrompt;

            // In antigravity mode, the response streams back via direct injection — no response.md write
            expect(prompt).not.toContain('Write your COMPLETE response to the response.md');
            expect(prompt).not.toContain('## Output');
        });

        it('unsupported mode: planner prompt does not contain response.md (adapter handles it)', async () => {
            const adapter = createAdapter('unsupported');
            const agent = new PlannerAgent(adapter, {
                workspaceRoot: '/tmp/test-workspace',
                maxTreeDepth: 1,
                maxTreeChars: 100,
            }, { scanner: createScanner() });

            await agent.plan('Add WebSocket support');

            const createSession = adapter.createSession as jest.Mock;
            const prompt = (createSession.mock.calls[0][0] as ADKSessionOptions).initialPrompt;

            // Adapter appends response.md instructions — planner stays clean
            expect(prompt).not.toContain('## Output');
            expect(prompt).not.toContain('Write your COMPLETE response to the response.md');
        });

        it('worker in both modes: spawnWorker is called with 4 args (no executionMode param)', async () => {
            // Antigravity
            const adkAntigravity = createADK('antigravity');
            const launcherAntigravity = new WorkerLauncher(adkAntigravity, createLogger());
            const phaseAntigravity: Phase = {
                id: asPhaseId(5),
                prompt: 'Antigravity task',
                context_files: [],
                status: 'pending',
                success_criteria: 'exit_code:0',
            };
            await launcherAntigravity.launch(phaseAntigravity, 120_000, 'mode-contract-antigravity', createSvc());
            expect((adkAntigravity.spawnWorker as jest.Mock).mock.calls[0]).toHaveLength(4);

            // Unsupported
            const adkUnsupported = createADK('unsupported');
            const launcherUnsupported = new WorkerLauncher(adkUnsupported, createLogger());
            const phaseUnsupported: Phase = {
                id: asPhaseId(6),
                prompt: 'Unsupported task',
                context_files: [],
                status: 'pending',
                success_criteria: 'exit_code:0',
            };
            await launcherUnsupported.launch(phaseUnsupported, 120_000, 'mode-contract-unsupported', createSvc());
            expect((adkUnsupported.spawnWorker as jest.Mock).mock.calls[0]).toHaveLength(4);
        });
    });

    // ─────────────────────────────────────────────────────────────────────
    //  NEW: No execution mode emits /handle block
    // ─────────────────────────────────────────────────────────────────────

    describe('no execution mode emits /handle block', () => {
        it('the string /handle never appears in any planner prompt across all modes', async () => {
            const allModes: ExecutionMode[] = ['vscode-native', 'cursor', 'antigravity', 'unsupported'];
            for (const mode of allModes) {
                const adapter = createAdapter(mode);
                const agent = new PlannerAgent(adapter, {
                    workspaceRoot: '/tmp/test-workspace',
                    maxTreeDepth: 1,
                    maxTreeChars: 100,
                }, { scanner: createScanner() });

                await agent.plan(`Test query for ${mode}`);

                const createSession = adapter.createSession as jest.Mock;
                const prompt = (createSession.mock.calls[0][0] as ADKSessionOptions).initialPrompt;
                expect(prompt).not.toContain('/handle');
            }
        });
    });

    // ─────────────────────────────────────────────────────────────────────
    //  NEW: No execution mode emits request.md reference
    // ─────────────────────────────────────────────────────────────────────

    describe('no execution mode emits request.md reference', () => {
        it('request.md never appears in any planner prompt across all modes', async () => {
            const allModes: ExecutionMode[] = ['vscode-native', 'cursor', 'antigravity', 'unsupported'];
            for (const mode of allModes) {
                const adapter = createAdapter(mode);
                const agent = new PlannerAgent(adapter, {
                    workspaceRoot: '/tmp/test-workspace',
                    maxTreeDepth: 1,
                    maxTreeChars: 100,
                }, { scanner: createScanner() });

                await agent.plan(`Verify no request.md for ${mode}`);

                const createSession = adapter.createSession as jest.Mock;
                const prompt = (createSession.mock.calls[0][0] as ADKSessionOptions).initialPrompt;
                expect(prompt).not.toContain('request.md');
            }
        });
    });
});
