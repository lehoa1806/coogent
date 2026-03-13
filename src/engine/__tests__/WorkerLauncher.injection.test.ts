// ─────────────────────────────────────────────────────────────────────────────
// src/engine/__tests__/WorkerLauncher.injection.test.ts
// Tests for WorkerLauncher execution mode propagation and prompt assembly
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

// Mock MissionControlPanel to prevent broadcast errors
jest.mock('../../webview/MissionControlPanel.js', () => ({
    MissionControlPanel: {
        broadcast: jest.fn(),
    },
}));

// Mock logger — must use __esModule for correct default import interop
jest.mock('../../logger/log.js', () => ({
    __esModule: true,
    default: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        onError: jest.fn(),
    },
}));

import {
    WorkerLauncher,
    type WorkerLauncherADK,
    type WorkerLauncherLogger,
    type WorkerLauncherEngine,
} from '../WorkerLauncher.js';
import type { ServiceContainer } from '../../ServiceContainer.js';
import type { HandoffExtractor } from '../../context/HandoffExtractor.js';
import type { AgentRegistry } from '../../agent-selection/AgentRegistry.js';
import type { ExecutionMode } from '../../adk/ExecutionModeResolver.js';
import { asPhaseId, type Phase } from '../../types/index.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Factory Helpers
// ═══════════════════════════════════════════════════════════════════════════════

function createPhase(overrides: Partial<Phase> = {}): Phase {
    return {
        id: asPhaseId(1),
        prompt: 'Implement user auth with JWT tokens',
        context_files: [],
        status: 'pending',
        success_criteria: 'exit_code:0',
        ...overrides,
    };
}

function createMockADK(executionMode: ExecutionMode = 'unsupported'): WorkerLauncherADK & { getExecutionMode: () => Promise<ExecutionMode> } {
    return {
        spawnWorker: jest.fn(async () => {}),
        getExecutionMode: jest.fn(async () => executionMode),
    };
}

function createMockADKWithoutMode(): WorkerLauncherADK {
    return {
        spawnWorker: jest.fn(async () => {}),
    };
}

function createMockLogger(): WorkerLauncherLogger {
    return {
        logPhasePrompt: jest.fn(async () => {}),
        initRun: jest.fn(async () => {}),
    };
}

function createMockServiceContainer(overrides: Partial<ServiceContainer> = {}): ServiceContainer {
    return {
        engine: { getRunbook: jest.fn(() => null) } as unknown as WorkerLauncherEngine,
        handoffExtractor: {
            buildNextContext: jest.fn(async () => ''),
            generateDistillationPrompt: jest.fn(() => ''),
        } as unknown as HandoffExtractor,
        currentSessionDir: '/tmp/test-session',
        agentRegistry: null,
        mcpServer: null,
        ...overrides,
    } as unknown as ServiceContainer;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('WorkerLauncher — Execution Mode & Prompt Assembly', () => {
    // ─────────────────────────────────────────────────────────────────────
    //  Execution Mode Resolution
    // ─────────────────────────────────────────────────────────────────────

    describe('executionMode resolution', () => {
        it('resolves "antigravity" executionMode and calls spawnWorker with 4 args', async () => {
            const adk = createMockADK('antigravity');
            const logger = createMockLogger();
            const launcher = new WorkerLauncher(adk, logger);

            await launcher.launch(
                createPhase(),
                60_000,
                'master-task-1',
                createMockServiceContainer(),
            );

            // spawnWorker is now called with 4 args (no executionMode param)
            expect(adk.spawnWorker).toHaveBeenCalledWith(
                expect.objectContaining({ prompt: expect.any(String) }),
                60_000,
                'master-task-1',
                expect.objectContaining({ executionPlan: expect.any(String) }),
            );
            expect((adk.spawnWorker as jest.Mock).mock.calls[0]).toHaveLength(4);
        });

        it('resolves "unsupported" executionMode and calls spawnWorker with 4 args', async () => {
            const adk = createMockADK('unsupported');
            const logger = createMockLogger();
            const launcher = new WorkerLauncher(adk, logger);

            await launcher.launch(
                createPhase(),
                60_000,
                'master-task-2',
                createMockServiceContainer(),
            );

            expect(adk.spawnWorker).toHaveBeenCalledWith(
                expect.anything(),
                60_000,
                'master-task-2',
                expect.anything(),
            );
            expect((adk.spawnWorker as jest.Mock).mock.calls[0]).toHaveLength(4);
        });

        it('defaults to "unsupported" when ADK adapter lacks getExecutionMode', async () => {
            const adk = createMockADKWithoutMode();
            const logger = createMockLogger();
            const launcher = new WorkerLauncher(adk, logger);

            await launcher.launch(
                createPhase(),
                60_000,
                'master-task-3',
                createMockServiceContainer(),
            );

            // spawnWorker is called with 4 args (no executionMode param)
            const spawnCall = (adk.spawnWorker as jest.Mock).mock.calls[0];
            expect(spawnCall).toHaveLength(4);
        });
    });

    // ─────────────────────────────────────────────────────────────────────
    //  Effective Prompt Assembly
    // ─────────────────────────────────────────────────────────────────────

    describe('effectivePrompt assembly', () => {
        it('includes handoff context when extractor returns content', async () => {
            const adk = createMockADK('antigravity');
            const logger = createMockLogger();
            const launcher = new WorkerLauncher(adk, logger);

            const svc = createMockServiceContainer({
                handoffExtractor: {
                    buildNextContext: jest.fn(async () => 'Previous phase decided to use PostgreSQL.'),
                    generateDistillationPrompt: jest.fn(() => ''),
                } as unknown as HandoffExtractor,
            });

            await launcher.launch(createPhase(), 60_000, 'master-task-4', svc);

            const spawnedPhase = (adk.spawnWorker as jest.Mock).mock.calls[0][0] as Phase;
            expect(spawnedPhase.prompt).toContain('Context from Previous Phases');
            expect(spawnedPhase.prompt).toContain('Previous phase decided to use PostgreSQL.');
        });

        it('includes distillation prompt when extractor returns one', async () => {
            const adk = createMockADK('antigravity');
            const logger = createMockLogger();
            const launcher = new WorkerLauncher(adk, logger);

            const svc = createMockServiceContainer({
                handoffExtractor: {
                    buildNextContext: jest.fn(async () => ''),
                    generateDistillationPrompt: jest.fn(() => 'Distill: focus on API routes'),
                } as unknown as HandoffExtractor,
            });

            await launcher.launch(createPhase(), 60_000, 'master-task-5', svc);

            const spawnedPhase = (adk.spawnWorker as jest.Mock).mock.calls[0][0] as Phase;
            expect(spawnedPhase.prompt).toContain('Distill: focus on API routes');
        });

        it('does NOT inject agent system_prompt into effective prompt (redundant persona layer)', async () => {
            const adk = createMockADK('antigravity');
            const logger = createMockLogger();
            const launcher = new WorkerLauncher(adk, logger);

            const svc = createMockServiceContainer({
                agentRegistry: {
                    getBestAgent: jest.fn(async () => ({
                        id: 'backend-engineer',
                        name: 'Backend Engineer',
                        system_prompt: 'You are a senior backend engineer focused on TypeScript.',
                        default_output: 'code_changes',
                    })),
                } as unknown as AgentRegistry,
            });

            await launcher.launch(createPhase(), 60_000, 'master-task-6', svc);

            const spawnedPhase = (adk.spawnWorker as jest.Mock).mock.calls[0][0] as Phase;
            expect(spawnedPhase.prompt).not.toContain('## Worker Role');
            expect(spawnedPhase.prompt).not.toContain('You are a senior backend engineer focused on TypeScript.');
            // The original phase prompt is preserved as-is
            expect(spawnedPhase.prompt).toContain('Implement user auth with JWT tokens');
        });

        it('preserves the original phase prompt in effective prompt', async () => {
            const adk = createMockADK('antigravity');
            const logger = createMockLogger();
            const launcher = new WorkerLauncher(adk, logger);

            const phase = createPhase({ prompt: 'Build the payment gateway' });
            await launcher.launch(phase, 60_000, 'master-task-7', createMockServiceContainer());

            const spawnedPhase = (adk.spawnWorker as jest.Mock).mock.calls[0][0] as Phase;
            expect(spawnedPhase.prompt).toContain('Build the payment gateway');
        });

        it('builds effective prompt without handoff or distillation when extractors return empty', async () => {
            const adk = createMockADK('antigravity');
            const logger = createMockLogger();
            const launcher = new WorkerLauncher(adk, logger);

            const svc = createMockServiceContainer({
                handoffExtractor: {
                    buildNextContext: jest.fn(async () => ''),
                    generateDistillationPrompt: jest.fn(() => ''),
                } as unknown as HandoffExtractor,
            });

            const phase = createPhase({ prompt: 'Create the UI' });
            await launcher.launch(phase, 60_000, 'master-task-8', svc);

            const spawnedPhase = (adk.spawnWorker as jest.Mock).mock.calls[0][0] as Phase;
            // Without handoff, distillation, or agent profile, prompt should be the original
            expect(spawnedPhase.prompt).toBe('Create the UI');
        });
    });

    // ─────────────────────────────────────────────────────────────────────
    //  MCP Resource URIs
    // ─────────────────────────────────────────────────────────────────────

    describe('MCP resource URIs', () => {
        it('always includes executionPlan URI', async () => {
            const adk = createMockADK('antigravity');
            const logger = createMockLogger();
            const launcher = new WorkerLauncher(adk, logger);

            await launcher.launch(createPhase(), 60_000, 'master-task-9', createMockServiceContainer());

            const mcpUris = (adk.spawnWorker as jest.Mock).mock.calls[0][3];
            expect(mcpUris).toHaveProperty('executionPlan');
            expect(mcpUris.executionPlan).toContain('master-task-9');
        });
    });

    // ─────────────────────────────────────────────────────────────────────
    //  Telemetry
    // ─────────────────────────────────────────────────────────────────────

    describe('telemetry', () => {
        it('logs the phase prompt via logger.logPhasePrompt', async () => {
            const adk = createMockADK('antigravity');
            const logger = createMockLogger();
            const launcher = new WorkerLauncher(adk, logger);

            const phase = createPhase({ id: asPhaseId(3), prompt: 'Refactor database' });
            await launcher.launch(phase, 60_000, 'master-task-10', createMockServiceContainer());

            expect(logger.logPhasePrompt).toHaveBeenCalledWith(3, 'Refactor database');
        });
    });
});
