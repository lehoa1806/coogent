// ─────────────────────────────────────────────────────────────────────────────
// src/__tests__/factories/mockGitSandbox.ts — Typed mock for GitSandboxManager
// ─────────────────────────────────────────────────────────────────────────────

import type { GitSandboxManager } from '../../git/GitSandboxManager.js';

/** Subset of GitSandboxManager used by preFlightGitCheck. */
type PreFlightCheckable = Pick<GitSandboxManager, 'preFlightCheck'>;

/**
 * Create a typed mock matching the `preFlightCheck()` method of GitSandboxManager.
 * Returns a value typed as both `jest.Mocked<PreFlightCheckable>` (for test assertions)
 * and `GitSandboxManager` (for passing to functions that expect the full type).
 *
 * @param preFlightResult - The resolved value for `preFlightCheck()`.
 *   Use `undefined` to skip setting a return value (caller sets `.mockResolvedValue` / `.mockRejectedValue`).
 */
export function createMockGitSandbox(
    preFlightResult?: { clean: boolean; message: string; currentBranch?: string },
): jest.Mocked<PreFlightCheckable> & GitSandboxManager {
    const mock: jest.Mocked<PreFlightCheckable> = {
        preFlightCheck: jest.fn(),
    };
    if (preFlightResult) {
        mock.preFlightCheck.mockResolvedValue({
            currentBranch: preFlightResult.currentBranch ?? 'main',
            ...preFlightResult,
        });
    }
    return mock as unknown as jest.Mocked<PreFlightCheckable> & GitSandboxManager;
}
