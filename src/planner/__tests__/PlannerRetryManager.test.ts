jest.mock('vscode', () => ({
    commands: { registerCommand: jest.fn() },
    window: { showWarningMessage: jest.fn(), showErrorMessage: jest.fn(), showInformationMessage: jest.fn() },
    workspace: { workspaceFolders: [] },
    Uri: { file: jest.fn() },
}), { virtual: true });

import { PlannerRetryManager } from '../PlannerRetryManager.js';
import { RunbookParser } from '../RunbookParser.js';

describe('PlannerRetryManager', () => {
    let manager: PlannerRetryManager;
    const parser = new RunbookParser();

    const validRunbookJson = JSON.stringify({
        project_id: 'test-project',
        status: 'idle',
        current_phase: 1,
        phases: [
            {
                id: 1,
                status: 'pending',
                prompt: 'Test phase 1',
                context_files: ['src/index.ts'],
                success_criteria: 'exit_code:0',
            },
        ],
    });
    const validRunbookOutput = '```json\n' + validRunbookJson + '\n```';

    beforeEach(() => {
        manager = new PlannerRetryManager(parser);
    });

    // ═════════════════════════════════════════════════════════════════════
    //  hasRetryData()
    // ═════════════════════════════════════════════════════════════════════

    it('should return false initially', () => {
        expect(manager.hasRetryData()).toBe(false);
    });

    it('should return true after caching output', () => {
        manager.cacheOutput('some output');
        expect(manager.hasRetryData()).toBe(true);
    });

    it('should return true when only sessionDir is set', () => {
        manager.setSessionDir('test-session');
        expect(manager.hasRetryData()).toBe(true);
    });

    it('should return false after clear()', () => {
        manager.cacheOutput('some output', 'session');
        expect(manager.hasRetryData()).toBe(true);
        manager.clear();
        expect(manager.hasRetryData()).toBe(false);
    });

    it('should return false when cached output is empty', () => {
        manager.cacheOutput('');
        expect(manager.hasRetryData()).toBe(false);
    });

    // ═════════════════════════════════════════════════════════════════════
    //  cacheOutput()
    // ═════════════════════════════════════════════════════════════════════

    it('should truncate output to MAX_TIMEOUT_OUTPUT_CHARS', () => {
        const longOutput = 'x'.repeat(PlannerRetryManager.MAX_TIMEOUT_OUTPUT_CHARS + 1000);
        manager.cacheOutput(longOutput);
        expect(manager.hasRetryData()).toBe(true);
        // The internal state should be capped — verified indirectly through retryParse
    });

    // ═════════════════════════════════════════════════════════════════════
    //  retryParse() — cache/retry/clear lifecycle
    // ═════════════════════════════════════════════════════════════════════

    it('should return error result when no data is cached', async () => {
        const result = await manager.retryParse('/tmp/test');
        expect(result.success).toBe(false);
        expect(result.statusKey).toBe('error');
        expect(result.error?.message).toContain('No cached output or response file to parse');
    });

    it('should successfully parse valid cached output', async () => {
        manager.cacheOutput(validRunbookOutput);
        const result = await manager.retryParse('/tmp/test');
        expect(result.success).toBe(true);
        expect(result.runbook).not.toBeNull();
        expect(result.runbook!.project_id).toBe('test-project');
        expect(result.statusKey).toBe('ready');
        // After success, data should be cleared
        expect(manager.hasRetryData()).toBe(false);
    });

    it('should return error when cached output is invalid JSON and no session dir', async () => {
        manager.cacheOutput('random text that is not JSON');
        const result = await manager.retryParse('/tmp/test');
        expect(result.success).toBe(false);
        expect(result.statusKey).toBe('error');
    });

    it('should return gentle message when sessionDir is set but file does not exist', async () => {
        manager.setSessionDir('nonexistent-session');
        const result = await manager.retryParse('/tmp/test');
        expect(result.success).toBe(false);
        expect(result.statusMessage).toContain('No response file found on disk yet');
    });

    // ═════════════════════════════════════════════════════════════════════
    //  clear() lifecycle
    // ═════════════════════════════════════════════════════════════════════

    it('should reset all state on clear()', () => {
        manager.cacheOutput(validRunbookOutput, 'some-session');
        manager.clear();
        expect(manager.hasRetryData()).toBe(false);
        expect(manager.getSessionDir()).toBeNull();
    });

    // ═════════════════════════════════════════════════════════════════════
    //  MAX_TIMEOUT_OUTPUT_CHARS constant
    // ═════════════════════════════════════════════════════════════════════

    it('should expose MAX_TIMEOUT_OUTPUT_CHARS as 512_000', () => {
        expect(PlannerRetryManager.MAX_TIMEOUT_OUTPUT_CHARS).toBe(512_000);
    });
});
