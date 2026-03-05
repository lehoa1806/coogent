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
            .mockResolvedValueOnce('') // clean dry-run
            .mockResolvedValueOnce(''); // clean

        const result = await gitManager.rollback();
        expect(result.success).toBe(true);
        expect(execSpy).toHaveBeenCalledTimes(3);
    });

    test('rollbackToCommit resets to specific commit (#70)', async () => {
        execSpy.mockResolvedValueOnce('') // reset --hard <hash>
            .mockResolvedValueOnce('') // clean dry-run
            .mockResolvedValueOnce(''); // clean

        const result = await gitManager.rollbackToCommit('abc1234');
        expect(result.success).toBe(true);
        expect(result.commitHash).toBe('abc1234');
        expect(result.message).toContain('abc1234');
    });

    test('stash pushes changes with label (#70)', async () => {
        execSpy.mockResolvedValueOnce(' M dirty.ts\n') // status --porcelain
            .mockResolvedValueOnce(''); // stash push

        const result = await gitManager.stash('before-phase-3');
        expect(result.success).toBe(true);
        expect(result.message).toContain('before-phase-3');
    });

    test('stash skips when working tree is clean (#70)', async () => {
        execSpy.mockResolvedValueOnce(''); // status --porcelain (empty)

        const result = await gitManager.stash('test');
        expect(result.success).toBe(true);
        expect(result.message).toContain('clean');
    });

    test('unstash pops the stash (#70)', async () => {
        execSpy.mockResolvedValueOnce(''); // stash pop

        const result = await gitManager.unstash();
        expect(result.success).toBe(true);
    });

    test('isGitRepo returns true when inside a git repo (#70)', async () => {
        execSpy.mockResolvedValueOnce('.git'); // rev-parse --git-dir

        const result = await gitManager.isGitRepo();
        expect(result).toBe(true);
    });

    test('isGitRepo returns false when not a git repo (#70)', async () => {
        execSpy.mockRejectedValueOnce(new Error('not a git repo'));

        const result = await gitManager.isGitRepo();
        expect(result).toBe(false);
    });
});
