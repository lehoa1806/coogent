// ─────────────────────────────────────────────────────────────────────────────
// src/adk/__tests__/ExecutionModeResolver.test.ts
// Unit tests for the centralized ExecutionModeResolver
// ─────────────────────────────────────────────────────────────────────────────

const CURSOR_EXTENSION_ID = 'anysphere.cursor-agent';
const ANTIGRAVITY_EXTENSION_ID = 'google.antigravity';

// ── Mock vscode before any imports ──────────────────────────────────────────

const mockSelectChatModels = jest.fn();
const mockGetExtension = jest.fn();
const mockGetCommands = jest.fn();

jest.mock('vscode', () => ({
    lm: {
        selectChatModels: mockSelectChatModels,
    },
    extensions: {
        getExtension: mockGetExtension,
    },
    commands: {
        getCommands: mockGetCommands,
    },
}), { virtual: true });

// ── Mock logger (silent) ────────────────────────────────────────────────────

jest.mock('../../logger/log.js', () => ({
    __esModule: true,
    default: {
        info: jest.fn(),
        debug: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        trace: jest.fn(),
    },
}));

// ── Imports ─────────────────────────────────────────────────────────────────

import {
    detectExecutionMode,
    getExecutionMode,
    getExecutionModeSync,
    resetExecutionModeCache,
} from '../ExecutionModeResolver.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Configure the vscode mock for a specific host environment.
 */
function configureMocks(opts: {
    antigravityExtension?: boolean;
    cursorExtension?: boolean;
    copilotModels?: 'available' | 'empty' | 'throws';
    commands?: string[];
    lmApiAvailable?: boolean;
}) {
    // Extensions
    mockGetExtension.mockImplementation((id: string) => {
        if (id === ANTIGRAVITY_EXTENSION_ID && opts.antigravityExtension) return {};
        if (id === CURSOR_EXTENSION_ID && opts.cursorExtension) return {};
        return undefined;
    });

    // LM API — if lmApiAvailable is explicitly false, make selectChatModels non-function
    // However, since the mock always provides selectChatModels as a function,
    // we handle the "no LM API" case by adjusting the mock module.
    // For the standard tests, selectChatModels is always a function (hasVsCodeLmApi = true).

    // Copilot models
    if (opts.copilotModels === 'throws') {
        mockSelectChatModels.mockRejectedValue(new Error('API unavailable'));
    } else if (opts.copilotModels === 'available') {
        mockSelectChatModels.mockResolvedValue([{ vendor: 'copilot', id: 'test-model' }]);
    } else {
        // 'empty' or default
        mockSelectChatModels.mockResolvedValue([]);
    }

    // Commands
    mockGetCommands.mockResolvedValue(opts.commands ?? []);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('ExecutionModeResolver', () => {
    beforeEach(() => {
        resetExecutionModeCache();
        mockSelectChatModels.mockReset();
        mockGetExtension.mockReset();
        mockGetCommands.mockReset();
    });

    // ─────────────────────────────────────────────────────────────────────────
    //  Host Detection
    // ─────────────────────────────────────────────────────────────────────────

    describe('Host Detection', () => {
        it('detects antigravity host when Antigravity extension is present', async () => {
            configureMocks({
                antigravityExtension: true,
                copilotModels: 'empty',
                commands: ['antigravity.sendPromptToAgentPanel'],
            });

            const result = await detectExecutionMode();
            expect(result.host).toBe('antigravity');
        });

        it('detects cursor host when Cursor extension is present', async () => {
            configureMocks({
                cursorExtension: true,
                copilotModels: 'empty',
                commands: ['workbench.action.chat.open'],
            });

            const result = await detectExecutionMode();
            expect(result.host).toBe('cursor');
        });

        it('detects vscode host when neither extension is present', async () => {
            configureMocks({
                copilotModels: 'available',
                commands: [],
            });

            const result = await detectExecutionMode();
            expect(result.host).toBe('vscode');
        });

        it('detects antigravity host when both extensions are present (Antigravity takes priority)', async () => {
            configureMocks({
                antigravityExtension: true,
                cursorExtension: true,
                copilotModels: 'empty',
                commands: ['antigravity.sendPromptToAgentPanel', 'workbench.action.chat.open'],
            });

            const result = await detectExecutionMode();
            expect(result.host).toBe('antigravity');
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    //  Mode Resolution
    // ─────────────────────────────────────────────────────────────────────────

    describe('Mode Resolution', () => {
        it('resolves vscode-native when VS Code host + LM API + Copilot models', async () => {
            configureMocks({
                copilotModels: 'available',
                commands: [],
            });

            const result = await detectExecutionMode();
            expect(result.host).toBe('vscode');
            expect(result.mode).toBe('vscode-native');
        });

        it('resolves unsupported when VS Code host + no LM API', async () => {
            // To simulate no LM API, we need to temporarily make selectChatModels non-function
            const vscode = jest.requireMock('vscode');
            const originalSelectChatModels = vscode.lm.selectChatModels;
            vscode.lm.selectChatModels = undefined;

            configureMocks({
                copilotModels: 'empty',
                commands: [],
            });

            const result = await detectExecutionMode();
            // Without LM API and no extensions → host = 'unknown', mode = 'unsupported'
            expect(result.mode).toBe('unsupported');

            // Restore
            vscode.lm.selectChatModels = originalSelectChatModels;
        });

        it('resolves unsupported when VS Code host + LM API + no Copilot models', async () => {
            configureMocks({
                copilotModels: 'empty',
                commands: [],
            });

            // No extensions → hasVsCodeLmApi = true → host = 'vscode'
            // No copilot models → mode = 'unsupported'
            const result = await detectExecutionMode();
            expect(result.host).toBe('vscode');
            expect(result.mode).toBe('unsupported');
        });

        it('resolves cursor when Cursor host + Cursor extension + chat command', async () => {
            configureMocks({
                cursorExtension: true,
                copilotModels: 'empty',
                commands: ['workbench.action.chat.open'],
            });

            const result = await detectExecutionMode();
            expect(result.host).toBe('cursor');
            expect(result.mode).toBe('cursor');
        });

        it('resolves unsupported when Cursor host + no chat command', async () => {
            configureMocks({
                cursorExtension: true,
                copilotModels: 'empty',
                commands: [],
            });

            const result = await detectExecutionMode();
            expect(result.host).toBe('cursor');
            expect(result.mode).toBe('unsupported');
        });

        it('resolves antigravity when Antigravity host + extension + agent command', async () => {
            configureMocks({
                antigravityExtension: true,
                copilotModels: 'empty',
                commands: ['antigravity.sendPromptToAgentPanel'],
            });

            const result = await detectExecutionMode();
            expect(result.host).toBe('antigravity');
            expect(result.mode).toBe('antigravity');
        });

        it('resolves antigravity when Antigravity host + extension + chat command (no agent command)', async () => {
            configureMocks({
                antigravityExtension: true,
                copilotModels: 'empty',
                commands: ['workbench.action.chat.open'],
            });

            const result = await detectExecutionMode();
            expect(result.host).toBe('antigravity');
            expect(result.mode).toBe('antigravity');
        });

        it('resolves unsupported when Antigravity host + no commands', async () => {
            configureMocks({
                antigravityExtension: true,
                copilotModels: 'empty',
                commands: [],
            });

            const result = await detectExecutionMode();
            expect(result.host).toBe('antigravity');
            expect(result.mode).toBe('unsupported');
        });

        it('resolves unsupported for unknown host', async () => {
            // No extensions, no LM API
            const vscode = jest.requireMock('vscode');
            const originalSelectChatModels = vscode.lm.selectChatModels;
            vscode.lm.selectChatModels = undefined;

            mockGetExtension.mockReturnValue(undefined);
            mockGetCommands.mockResolvedValue([]);

            const result = await detectExecutionMode();
            expect(result.host).toBe('unknown');
            expect(result.mode).toBe('unsupported');

            // Restore
            vscode.lm.selectChatModels = originalSelectChatModels;
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    //  Caching
    // ─────────────────────────────────────────────────────────────────────────

    describe('Caching', () => {
        it('getExecutionMode() caches result after first call', async () => {
            configureMocks({
                copilotModels: 'available',
                commands: [],
            });

            const first = await getExecutionMode();
            const second = await getExecutionMode();

            expect(first).toBe(second);
            expect(first.mode).toBe('vscode-native');
            // selectChatModels should only be called once due to caching
            expect(mockSelectChatModels).toHaveBeenCalledTimes(1);
        });

        it('getExecutionModeSync() returns null before first resolution', () => {
            expect(getExecutionModeSync()).toBeNull();
        });

        it('resetExecutionModeCache() clears the cache', async () => {
            configureMocks({
                copilotModels: 'available',
                commands: [],
            });

            const first = await getExecutionMode();
            expect(first.mode).toBe('vscode-native');

            resetExecutionModeCache();
            expect(getExecutionModeSync()).toBeNull();

            // Reconfigure for a different result
            configureMocks({
                cursorExtension: true,
                copilotModels: 'empty',
                commands: ['workbench.action.chat.open'],
            });

            const second = await getExecutionMode();
            expect(second.mode).toBe('cursor');
            expect(second).not.toBe(first);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    //  Signals
    // ─────────────────────────────────────────────────────────────────────────

    describe('Signals', () => {
        it('correctly populates all signals in the result', async () => {
            configureMocks({
                antigravityExtension: true,
                cursorExtension: true,
                copilotModels: 'available',
                commands: [
                    'workbench.action.chat.open',
                    'antigravity.sendPromptToAgentPanel',
                ],
            });

            const result = await detectExecutionMode();

            expect(result.signals).toEqual({
                hasVsCodeLmApi: true,
                hasCopilotModels: true,
                hasCursorExtension: true,
                hasAntigravityExtension: true,
                hasCursorChatCommand: true,
                hasAntigravityChatCommand: true,
                hasAntigravityAgentCommand: true,
            });
        });

        it('reasons array contains descriptive text', async () => {
            configureMocks({
                copilotModels: 'available',
                commands: [],
            });

            const result = await detectExecutionMode();

            expect(result.reasons).toBeInstanceOf(Array);
            expect(result.reasons.length).toBeGreaterThan(0);
            result.reasons.forEach((reason) => {
                expect(typeof reason).toBe('string');
                expect(reason.length).toBeGreaterThan(0);
            });
            // Check for key descriptive entries
            expect(result.reasons).toEqual(
                expect.arrayContaining([
                    expect.stringContaining('vscode.lm API'),
                    expect.stringContaining('Detected host'),
                    expect.stringContaining('Mode:'),
                ])
            );
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    //  Error Handling
    // ─────────────────────────────────────────────────────────────────────────

    describe('Error Handling', () => {
        it('gracefully degrades when vscode.lm.selectChatModels throws', async () => {
            configureMocks({
                copilotModels: 'throws',
                commands: [],
            });

            // Should not throw, should gracefully degrade
            const result = await detectExecutionMode();

            // selectChatModels threw → hasCopilotModels = false
            expect(result.signals.hasCopilotModels).toBe(false);
            // Host is still 'vscode' because LM API exists (function exists)
            expect(result.host).toBe('vscode');
            // No copilot models → unsupported
            expect(result.mode).toBe('unsupported');
        });

        it('returns empty commands when vscode.commands.getCommands throws', async () => {
            mockGetExtension.mockReturnValue(undefined);
            mockSelectChatModels.mockResolvedValue([{ vendor: 'copilot', id: 'test-model' }]);
            mockGetCommands.mockRejectedValue(new Error('Commands unavailable'));

            const result = await detectExecutionMode();

            // Commands threw → all command-based signals false
            expect(result.signals.hasCursorChatCommand).toBe(false);
            expect(result.signals.hasAntigravityChatCommand).toBe(false);
            expect(result.signals.hasAntigravityAgentCommand).toBe(false);
        });
    });
});
