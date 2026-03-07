// ─────────────────────────────────────────────────────────────────────────────
// src/__tests__/CommandRegistry.test.ts — Unit tests for the R1 command registry
// ─────────────────────────────────────────────────────────────────────────────

jest.mock('vscode', () => ({
    commands: { registerCommand: jest.fn() },
    window: { showWarningMessage: jest.fn(), showErrorMessage: jest.fn(), showInformationMessage: jest.fn(), showInputBox: jest.fn() },
    workspace: { workspaceFolders: [] },
    Uri: { file: jest.fn() },
}), { virtual: true });


import { preFlightGitCheck } from '../CommandRegistry.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  preFlightGitCheck (exported helper)
// ═══════════════════════════════════════════════════════════════════════════════

describe('preFlightGitCheck', () => {
    it('returns { blocked: false } when sandbox is undefined', async () => {
        const result = await preFlightGitCheck(undefined);
        expect(result.blocked).toBe(false);
    });

    it('returns { blocked: false } when preFlightCheck reports clean=true', async () => {
        const mockSandbox = {
            preFlightCheck: jest.fn().mockResolvedValue({ clean: true, message: 'All clean' }),
        };
        const result = await preFlightGitCheck(mockSandbox as any);
        expect(result.blocked).toBe(false);
        expect(mockSandbox.preFlightCheck).toHaveBeenCalledTimes(1);
    });

    it('returns { blocked: true, message } when preFlightCheck reports clean=false', async () => {
        const mockSandbox = {
            preFlightCheck: jest.fn().mockResolvedValue({
                clean: false,
                message: 'Uncommitted changes detected',
            }),
        };
        const result = await preFlightGitCheck(mockSandbox as any);
        expect(result.blocked).toBe(true);
        if (result.blocked) {
            expect(result.message).toBe('Uncommitted changes detected');
        }
    });

    it('returns { blocked: false } when preFlightCheck throws (non-blocking)', async () => {
        const mockSandbox = {
            preFlightCheck: jest.fn().mockRejectedValue(new Error('Git API unavailable')),
        };
        const result = await preFlightGitCheck(mockSandbox as any);
        expect(result.blocked).toBe(false);
    });
});
