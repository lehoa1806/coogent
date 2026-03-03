import { GitManager } from '../GitManager';

describe('GitManager', () => {
    let gitManager: GitManager;
    let execSpy: jest.SpyInstance;

    beforeEach(() => {
        gitManager = new GitManager('/test/workspace');
        execSpy = jest.spyOn(gitManager as any, 'gitExec');
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('snapshotCommit creates a commit when there are changes', async () => {
        execSpy.mockResolvedValueOnce('') // git add
            .mockResolvedValueOnce(' M file.ts\n') // git status
            .mockResolvedValueOnce('') // git commit
            .mockResolvedValueOnce('abc1234'); // git rev-parse

        const result = await gitManager.snapshotCommit(1);
        expect(result.success).toBe(true);
        expect(result.commitHash).toBe('abc1234');
        expect(result.message).toContain('Committed as abc1234');
        expect(execSpy).toHaveBeenCalledTimes(4);
    });

    test('snapshotCommit skips commit when no changes', async () => {
        execSpy.mockResolvedValueOnce('') // git add
            .mockResolvedValueOnce(''); // git status

        const result = await gitManager.snapshotCommit(2);
        expect(result.success).toBe(true);
        expect(result.message).toContain('No changes to commit');
        expect(execSpy).toHaveBeenCalledTimes(2);
    });

    test('rollback does a hard reset and clean', async () => {
        execSpy.mockResolvedValueOnce('') // reset
            .mockResolvedValueOnce(''); // clean

        const result = await gitManager.rollback();
        expect(result.success).toBe(true);
        expect(execSpy).toHaveBeenCalledTimes(2);
    });
});
