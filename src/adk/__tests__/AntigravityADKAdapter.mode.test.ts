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

import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import { AntigravityADKAdapter } from '../AntigravityADKAdapter.js';

const mockSelectChatModels = vscode.lm.selectChatModels as jest.Mock;
const mockWriteFile = fs.writeFile as jest.Mock;

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

// ═══════════════════════════════════════════════════════════════════════════════
//  getExecutionMode() Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('AntigravityADKAdapter — ExecutionMode', () => {
    let adapter: AntigravityADKAdapter;

    beforeEach(() => {
        adapter = new AntigravityADKAdapter('/tmp/test-workspace');
        mockSelectChatModels.mockReset();
        mockWriteFile.mockClear();
    });

    describe('getExecutionMode()', () => {
        it('returns "primary" when vscode.lm models are available', async () => {
            mockSelectChatModels.mockResolvedValue([createMockModel()]);

            const mode = await adapter.getExecutionMode();
            expect(mode).toBe('primary');
        });

        it('returns "fallback" when no vscode.lm models are available', async () => {
            mockSelectChatModels.mockResolvedValue([]);

            const mode = await adapter.getExecutionMode();
            expect(mode).toBe('fallback');
        });

        it('returns "fallback" when vscode.lm.selectChatModels throws', async () => {
            mockSelectChatModels.mockRejectedValue(new Error('API unavailable'));

            const mode = await adapter.getExecutionMode();
            expect(mode).toBe('fallback');
        });

        it('caches the result after the first call', async () => {
            mockSelectChatModels.mockResolvedValue([createMockModel()]);

            const first = await adapter.getExecutionMode();
            const second = await adapter.getExecutionMode();

            expect(first).toBe('primary');
            expect(second).toBe('primary');
            // selectChatModels should only be called once due to caching
            expect(mockSelectChatModels).toHaveBeenCalledTimes(1);
        });

        it('getExecutionModeSync() returns null before first resolution', () => {
            expect(adapter.getExecutionModeSync()).toBeNull();
        });

        it('getExecutionModeSync() returns cached value after resolution', async () => {
            mockSelectChatModels.mockResolvedValue([createMockModel()]);

            await adapter.getExecutionMode();
            expect(adapter.getExecutionModeSync()).toBe('primary');
        });
    });

    // ═══════════════════════════════════════════════════════════════════════════
    //  Session Path Routing Tests
    // ═══════════════════════════════════════════════════════════════════════════

    describe('createSession() path routing', () => {
        it('uses LM session (primary path) when vscode.lm model is available', async () => {
            const model = createMockModel();
            mockSelectChatModels.mockResolvedValue([model]);

            const handle = await adapter.createSession({
                zeroContext: true,
                workingDirectory: '/tmp/test-workspace',
                initialPrompt: 'Test prompt',
                newConversation: false,
            });

            // Primary path should NOT write request.md
            expect(mockWriteFile).not.toHaveBeenCalled();
            // Should have a valid session handle
            expect(handle.sessionId).toBeDefined();
            expect(handle.pid).toBeDefined();
        });

        it('uses file-based IPC (fallback path) when no vscode.lm model is available', async () => {
            mockSelectChatModels.mockResolvedValue([]);

            // Mock executeCommand to simulate successful chat injection
            (vscode.commands.executeCommand as jest.Mock).mockResolvedValue(undefined);

            const handle = await adapter.createSession({
                zeroContext: true,
                workingDirectory: '/tmp/test-workspace',
                initialPrompt: 'Test prompt for fallback',
                newConversation: false,
                masterTaskId: 'test-task',
                phaseNumber: 1,
            });

            // Fallback path DOES write request.md
            expect(mockWriteFile).toHaveBeenCalledWith(
                expect.stringContaining('request.md'),
                'Test prompt for fallback',
                'utf-8',
            );
            expect(handle.sessionId).toBeDefined();
        });

        it('in primary mode, prompt is passed directly to LM model', async () => {
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
