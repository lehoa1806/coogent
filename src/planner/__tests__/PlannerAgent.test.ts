import { PlannerAgent } from '../PlannerAgent.js';
import type { IADKAdapter, ADKSessionHandle, ADKSessionOptions } from '../../adk/ADKController.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Mock ADK Adapter
// ═══════════════════════════════════════════════════════════════════════════════

function createMockAdapter(): IADKAdapter {
    return {
        createSession: jest.fn(async (_opts: ADKSessionOptions): Promise<ADKSessionHandle> => ({
            sessionId: 'mock-session-id',
            pid: 12345,
            onOutput: jest.fn(),
            onExit: jest.fn(),
        })),
        terminateSession: jest.fn(async () => { }),
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PlannerAgent Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('PlannerAgent', () => {
    let agent: PlannerAgent;
    let adapter: IADKAdapter;

    const validRunbookJson = JSON.stringify({
        project_id: 'test-project',
        status: 'idle',
        current_phase: 0,
        phases: [
            {
                id: 0,
                status: 'pending',
                prompt: 'Test phase 1',
                context_files: ['src/index.ts'],
                success_criteria: 'exit_code:0',
            },
        ],
    });

    const validRunbookOutput = '```json\n' + validRunbookJson + '\n```';

    beforeEach(() => {
        adapter = createMockAdapter();
        agent = new PlannerAgent(adapter, {
            workspaceRoot: '/tmp/test-workspace',
            maxTreeDepth: 1,
            maxTreeChars: 100,
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    //  extractRunbook() — basic parsing sanity
    // ═══════════════════════════════════════════════════════════════════════

    it('should extract a valid runbook from fenced JSON output', () => {
        const result = agent.extractRunbook(validRunbookOutput);
        expect(result).not.toBeNull();
        expect(result!.project_id).toBe('test-project');
        expect(result!.phases).toHaveLength(1);
    });

    it('should return null for empty output', () => {
        expect(agent.extractRunbook('')).toBeNull();
    });

    it('should return null for invalid JSON', () => {
        expect(agent.extractRunbook('```json\n{invalid}\n```')).toBeNull();
    });

    // ═══════════════════════════════════════════════════════════════════════
    //  retryParse() — timeout recovery
    // ═══════════════════════════════════════════════════════════════════════

    describe('retryParse()', () => {
        it('should emit plan:error when no cached output is available', async () => {
            const errorSpy = jest.fn();
            const statusSpy = jest.fn();
            agent.on('plan:error', errorSpy);
            agent.on('plan:status', statusSpy);

            await agent.retryParse();

            expect(errorSpy).toHaveBeenCalledWith(
                expect.objectContaining({ message: expect.stringContaining('No cached output or response file to parse') })
            );
            expect(statusSpy).toHaveBeenCalledWith('error', expect.stringContaining('No cached output or response file'));
        });

        it('should emit plan:generated when cached output contains a valid runbook', () => {
            const generatedSpy = jest.fn();
            const statusSpy = jest.fn();
            agent.on('plan:generated', generatedSpy);
            agent.on('plan:status', statusSpy);

            // Simulate cached timeout output by using internal access
            (agent as any).lastTimeoutOutput = validRunbookOutput;

            agent.retryParse();

            expect(generatedSpy).toHaveBeenCalledWith(
                expect.objectContaining({ project_id: 'test-project' }),
                expect.any(Array)
            );
            expect(statusSpy).toHaveBeenCalledWith('ready', 'Plan parsed from cached output');

            // Cache should be cleared after successful parse
            expect(agent.hasTimeoutOutput()).toBe(false);
        });

        it('should emit plan:error when cached output has invalid JSON', async () => {
            const errorSpy = jest.fn();
            const statusSpy = jest.fn();
            agent.on('plan:error', errorSpy);
            agent.on('plan:status', statusSpy);

            (agent as any).lastTimeoutOutput = 'This is not JSON at all, just some text output';

            await agent.retryParse();

            expect(errorSpy).toHaveBeenCalledWith(
                expect.objectContaining({ message: expect.stringContaining('No cached output or response file to parse') })
            );
            expect(statusSpy).toHaveBeenCalledWith('error', expect.stringContaining('No cached output or response file'));
        });

        it('should emit plan:error when cached output is whitespace-only', async () => {
            const errorSpy = jest.fn();
            agent.on('plan:error', errorSpy);

            (agent as any).lastTimeoutOutput = '   \n\t  ';

            await agent.retryParse();

            expect(errorSpy).toHaveBeenCalledWith(
                expect.objectContaining({ message: expect.stringContaining('No cached output or response file to parse') })
            );
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    //  hasTimeoutOutput()
    // ═══════════════════════════════════════════════════════════════════════

    describe('hasTimeoutOutput()', () => {
        it('should return false when no timeout has occurred', () => {
            expect(agent.hasTimeoutOutput()).toBe(false);
        });

        it('should return true when timeout output is cached', () => {
            (agent as any).lastTimeoutOutput = validRunbookOutput;
            expect(agent.hasTimeoutOutput()).toBe(true);
        });

        it('should return false when cached output is empty string', () => {
            (agent as any).lastTimeoutOutput = '';
            expect(agent.hasTimeoutOutput()).toBe(false);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    //  Timeout behavior preserves accumulated output
    // ═══════════════════════════════════════════════════════════════════════

    describe('timeout preserves accumulated output', () => {
        beforeEach(() => {
            jest.useFakeTimers();
        });

        afterEach(() => {
            jest.useRealTimers();
        });

        it('should cache accumulatedOutput and emit plan:timeout on timeout', async () => {
            const timeoutSpy = jest.fn();
            const statusSpy = jest.fn();
            agent.on('plan:timeout', timeoutSpy);
            agent.on('plan:status', statusSpy);

            // Mock createSession to return a handle that lets us control output
            let capturedOutputCb: ((stream: 'stdout' | 'stderr', chunk: string) => void) | null = null;
            (adapter.createSession as jest.Mock).mockImplementation(async () => ({
                sessionId: 'timeout-test',
                pid: 99999,
                onOutput(cb: (stream: 'stdout' | 'stderr', chunk: string) => void) { capturedOutputCb = cb; },
                onExit: jest.fn(),
            }));

            // Start planning (creates the session with timeout)
            await agent.plan('Build a todo app');

            // Simulate partial output arriving before timeout
            if (capturedOutputCb) {
                (capturedOutputCb as (stream: 'stdout' | 'stderr', chunk: string) => void)('stdout', '```json\n{"project_id":"partial"');
            }

            // Fast-forward past the 120s timeout
            jest.advanceTimersByTime(900_001);

            expect(timeoutSpy).toHaveBeenCalledWith(true);
            expect(statusSpy).toHaveBeenCalledWith('timeout', 'Planner agent timed out');
            expect(agent.hasTimeoutOutput()).toBe(true);
        });

        it('should emit plan:timeout with hasOutput=false when no output was accumulated', async () => {
            const timeoutSpy = jest.fn();
            agent.on('plan:timeout', timeoutSpy);

            (adapter.createSession as jest.Mock).mockImplementation(async () => ({
                sessionId: 'empty-timeout-test',
                pid: 99998,
                onOutput: jest.fn(),
                onExit: jest.fn(),
            }));

            await agent.plan('Build a todo app');

            // Fast-forward past the 120s timeout (no output was accumulated)
            jest.advanceTimersByTime(900_001);

            expect(timeoutSpy).toHaveBeenCalledWith(false);
            // After plan(), lastIpcSessionDir is set, so hasTimeoutOutput()
            // returns true (file-based retry path is available), even though
            // no cached streaming output exists.
            expect(agent.hasTimeoutOutput()).toBe(true);
        });
    });
});
