// ─────────────────────────────────────────────────────────────────────────────
// src/adk/__tests__/AntigravityADKAdapter.mode.test.ts
// Unit tests for ExecutionMode detection and session creation path routing
// ─────────────────────────────────────────────────────────────────────────────

// Mock vscode BEFORE any imports that reference it
jest.mock('vscode', () => ({
    lm: {
        selectChatModels: jest.fn(),
    },
    commands: {
        executeCommand: jest.fn(),
        getCommands: jest.fn().mockResolvedValue([]),
    },
    window: {
        showWarningMessage: jest.fn(),
        showErrorMessage: jest.fn(),
        showInformationMessage: jest.fn(),
    },
    workspace: { workspaceFolders: [] },
    Uri: {
        file: jest.fn((p: string) => ({ fsPath: p, scheme: 'file' })),
        joinPath: jest.fn((...parts: string[]) => ({ fsPath: parts.join('/') })),
    },
    CancellationTokenSource: jest.fn().mockImplementation(() => ({
        token: { isCancellationRequested: false, onCancellationRequested: jest.fn() },
        cancel: jest.fn(),
        dispose: jest.fn(),
    })),
    LanguageModelChatMessage: {
        User: jest.fn((text: string) => ({ role: 'user', text })),
    },
    extensions: {
        getExtension: jest.fn(),
    },
}), { virtual: true });

// Mock filesystem to prevent real I/O
jest.mock('node:fs/promises', () => ({
    mkdir: jest.fn().mockResolvedValue(undefined),
    writeFile: jest.fn().mockResolvedValue(undefined),
    readFile: jest.fn().mockResolvedValue(''),
    stat: jest.fn().mockRejectedValue(new Error('ENOENT')),
    readdir: jest.fn().mockResolvedValue([]),
    rm: jest.fn().mockResolvedValue(undefined),
    unlink: jest.fn().mockResolvedValue(undefined),
}));

// Mock FileStabilityWatcher to avoid real file watching
jest.mock('../FileStabilityWatcher.js', () => ({
    FileStabilityWatcher: jest.fn().mockImplementation(() => ({
        waitForStableFile: jest.fn().mockResolvedValue('mock-response'),
    })),
}));

// Mock the ExecutionModeResolver so we can control detection results
jest.mock('../ExecutionModeResolver.js', () => ({
    getExecutionMode: jest.fn(),
    getExecutionModeSync: jest.fn(),
    resetExecutionModeCache: jest.fn(),
    detectExecutionMode: jest.fn(),
}));

// Mock logger
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

import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import { AntigravityADKAdapter } from '../AntigravityADKAdapter.js';
import { getExecutionMode, getExecutionModeSync, type ModeDetectionResult } from '../ExecutionModeResolver.js';

const mockSelectChatModels = vscode.lm.selectChatModels as jest.Mock;
const mockWriteFile = fs.writeFile as jest.Mock;
const mockGetExtension = vscode.extensions.getExtension as jest.Mock;
const mockGetExecutionMode = getExecutionMode as jest.Mock;
const mockGetExecutionModeSync = getExecutionModeSync as jest.Mock;

// ─────────────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a mock vscode.LanguageModelChat that returns an empty stream.
 */
function createMockModel() {
    return {
        id: 'mock-model-id',
        name: 'MockModel',
        vendor: 'test',
        family: 'test',
        maxInputTokens: 100000,
        countTokens: jest.fn().mockResolvedValue(100),
        sendRequest: jest.fn().mockResolvedValue({
            text: (async function* () {
                yield 'mock response';
            })(),
        }),
    };
}

/**
 * Create a mock ModeDetectionResult for the given mode.
 */
function createModeResult(mode: 'vscode-native' | 'cursor' | 'antigravity' | 'unsupported'): ModeDetectionResult {
    return {
        host: mode === 'antigravity' ? 'antigravity' : mode === 'cursor' ? 'cursor' : mode === 'vscode-native' ? 'vscode' : 'unknown',
        mode,
        reasons: [`Test mode: ${mode}`],
        signals: {
            hasVsCodeLmApi: mode === 'vscode-native',
            hasCopilotModels: mode === 'vscode-native',
            hasCursorExtension: mode === 'cursor',
            hasAntigravityExtension: mode === 'antigravity',
            hasCursorChatCommand: mode === 'cursor',
            hasAntigravityChatCommand: mode === 'antigravity',
            hasAntigravityAgentCommand: mode === 'antigravity',
        },
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  getExecutionMode() Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('AntigravityADKAdapter — ExecutionMode', () => {
    let adapter: AntigravityADKAdapter;

    beforeEach(() => {
        adapter = new AntigravityADKAdapter('/tmp/test-workspace');
        mockSelectChatModels.mockReset();
        mockWriteFile.mockClear();
        mockGetExtension.mockReset();
        mockGetExecutionMode.mockReset();
        mockGetExecutionModeSync.mockReset();

        // Default: Antigravity extension is installed (this is AntigravityADKAdapter)
        mockGetExtension.mockImplementation((id: string) => {
            if (id === 'google.antigravity') return { id };
            return undefined;
        });
    });

    describe('getExecutionMode()', () => {
        it('returns "antigravity" when resolver detects antigravity host', async () => {
            mockGetExecutionMode.mockResolvedValue(createModeResult('antigravity'));

            const mode = await adapter.getExecutionMode();
            expect(mode).toBe('antigravity');
        });

        it('returns "unsupported" when resolver detects unsupported environment', async () => {
            mockGetExecutionMode.mockResolvedValue(createModeResult('unsupported'));

            const mode = await adapter.getExecutionMode();
            expect(mode).toBe('unsupported');
        });

        it('returns "vscode-native" when resolver detects vscode host with LM API', async () => {
            mockGetExecutionMode.mockResolvedValue(createModeResult('vscode-native'));

            const mode = await adapter.getExecutionMode();
            expect(mode).toBe('vscode-native');
        });

        it('caches the result after the first call', async () => {
            mockGetExecutionMode.mockResolvedValue(createModeResult('antigravity'));

            const first = await adapter.getExecutionMode();
            const second = await adapter.getExecutionMode();

            expect(first).toBe('antigravity');
            expect(second).toBe('antigravity');
            // getExecutionMode should only be called once due to caching
            expect(mockGetExecutionMode).toHaveBeenCalledTimes(1);
        });

        it('getExecutionModeSync() returns null before first resolution', () => {
            mockGetExecutionModeSync.mockReturnValue(null);
            expect(adapter.getExecutionModeSync()).toBeNull();
        });

        it('getExecutionModeSync() returns cached value after resolution', async () => {
            mockGetExecutionMode.mockResolvedValue(createModeResult('antigravity'));

            await adapter.getExecutionMode();
            expect(adapter.getExecutionModeSync()).toBe('antigravity');
        });
    });

    // ═══════════════════════════════════════════════════════════════════════════
    //  Session Path Routing Tests
    // ═══════════════════════════════════════════════════════════════════════════

    describe('createSession() path routing', () => {
        it('uses LM session when vscode.lm model is available', async () => {
            const model = createMockModel();
            mockSelectChatModels.mockResolvedValue([model]);

            const handle = await adapter.createSession({
                zeroContext: true,
                workingDirectory: '/tmp/test-workspace',
                initialPrompt: 'Test prompt',
                newConversation: false,
            });

            // Should NOT write request.md
            expect(mockWriteFile).not.toHaveBeenCalled();
            // Should have a valid session handle
            expect(handle.sessionId).toBeDefined();
            expect(handle.pid).toBeDefined();
        });

        it('uses file-based IPC when no vscode.lm model is available', async () => {
            mockSelectChatModels.mockResolvedValue([]);

            // Mock executeCommand to simulate successful chat injection
            (vscode.commands.executeCommand as jest.Mock).mockResolvedValue(undefined);

            const handle = await adapter.createSession({
                zeroContext: true,
                workingDirectory: '/tmp/test-workspace',
                initialPrompt: 'Test prompt for file IPC',
                newConversation: false,
                masterTaskId: 'test-task',
                phaseNumber: 1,
            });

            // No request.md is written — prompts are injected directly
            expect(mockWriteFile).not.toHaveBeenCalledWith(
                expect.stringContaining('request.md'),
                expect.anything(),
                expect.anything(),
            );

            // Prompt is injected via vscode.commands.executeCommand
            expect(vscode.commands.executeCommand).toHaveBeenCalled();
            expect(handle.sessionId).toBeDefined();
        });

        it('prompt is passed directly to LM model when available', async () => {
            const model = createMockModel();
            mockSelectChatModels.mockResolvedValue([model]);

            const testPrompt = 'Direct injection test prompt';
            await adapter.createSession({
                zeroContext: true,
                workingDirectory: '/tmp/test-workspace',
                initialPrompt: testPrompt,
                newConversation: false,
            });

            // The model should receive the prompt via sendRequest
            // (called asynchronously via setImmediate, but the mock tracks calls)
            // Give setImmediate a chance to fire
            await new Promise(resolve => setImmediate(resolve));

            expect(model.sendRequest).toHaveBeenCalled();
        });
    });
});
