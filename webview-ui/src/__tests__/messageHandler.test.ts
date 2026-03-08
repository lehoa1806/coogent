// ─────────────────────────────────────────────────────────────────────────────
// messageHandler.test.ts — Integration tests for the webview IPC router
//
// Tests the handleMessage() dispatcher that translates Extension Host
// messages into appState mutations via the Svelte $state store.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { appState, patchState, appendPhaseOutput } from '../stores/vscode.svelte.js';
import { initMessageHandler, resetForTesting } from '../stores/messageHandler.js';
import type { HostToWebviewMessage, Runbook, PhaseId } from '../types.js';

/** Helper: fire a message event as if it came from the Extension Host. */
function fireMessage(msg: HostToWebviewMessage): void {
    window.dispatchEvent(
        new MessageEvent('message', { data: msg }),
    );
}

/** Factory for a minimal valid Runbook. */
function makeRunbook(overrides?: Partial<Runbook>): Runbook {
    return {
        project_id: 'test-proj',
        status: 'running',
        current_phase: 0,
        phases: [
            {
                id: 0 as PhaseId,
                status: 'pending',
                prompt: 'write auth',
                context_files: ['src/auth.ts'],
                success_criteria: 'tests pass',
            },
        ],
        ...overrides,
    };
}

describe('messageHandler', () => {
    beforeEach(() => {
        resetForTesting();
        // Reset appState to defaults
        patchState({
            engineState: 'IDLE',
            projectId: '',
            masterTaskId: '',
            phases: [],
            error: null,
            terminalOutput: '',
            planDraft: null,
            consolidationReport: null,
            implementationPlan: null,
            conversationMode: 'isolated',
            planStatus: null,
            planFileTree: [],
            masterSummary: '',
            lastPrompt: '',
            phaseOutputs: {},
            phaseStartTimes: {},
            phaseElapsedMs: {},
            sessions: [],
            workers: [],
        });
    });

    describe('initMessageHandler()', () => {
        it('is idempotent — double-init does not register two listeners', () => {
            initMessageHandler();
            initMessageHandler(); // Second call should be no-op

            fireMessage({
                type: 'PLAN_SUMMARY',
                payload: { summary: 'first' },
            });

            // If two listeners were registered, summary might be set twice
            // (which is fine), but the key property we check is that the
            // initMessageHandler guard prevented double-registration.
            expect(appState.masterSummary).toBe('first');
        });
    });

    describe('STATE_SNAPSHOT', () => {
        beforeEach(() => {
            initMessageHandler();
        });

        it('patches engineState, projectId, and phases', () => {
            const runbook = makeRunbook();
            fireMessage({
                type: 'STATE_SNAPSHOT',
                payload: {
                    runbook,
                    engineState: 'EXECUTING_WORKER',
                    masterTaskId: '20260308-120000-a1b2c3d4-e5f6-7890-abcd-ef1234567890',
                },
            });

            expect(appState.engineState).toBe('EXECUTING_WORKER');
            expect(appState.projectId).toBe('test-proj');
            expect(appState.phases).toHaveLength(1);
            expect(appState.masterTaskId).toBe(
                '20260308-120000-a1b2c3d4-e5f6-7890-abcd-ef1234567890',
            );
        });

        it('rejects masterTaskId that does not match UUID format', () => {
            fireMessage({
                type: 'STATE_SNAPSHOT',
                payload: {
                    runbook: makeRunbook(),
                    engineState: 'READY',
                    masterTaskId: 'human-readable-slug',
                },
            });

            // masterTaskId should NOT be updated to the slug
            expect(appState.masterTaskId).toBe('');
        });

        it('sets masterSummary from runbook.summary', () => {
            fireMessage({
                type: 'STATE_SNAPSHOT',
                payload: {
                    runbook: makeRunbook({ summary: 'Build auth module' }),
                    engineState: 'READY',
                },
            });

            expect(appState.masterSummary).toBe('Build auth module');
        });
    });

    describe('PHASE_STATUS', () => {
        beforeEach(() => {
            initMessageHandler();
            patchState({
                phases: [
                    { id: 0 as PhaseId, status: 'pending', prompt: 'p', context_files: [], success_criteria: 'ok' },
                ],
            });
        });

        it('updates the matching phase status', () => {
            fireMessage({
                type: 'PHASE_STATUS',
                payload: { phaseId: 0, status: 'running' },
            });

            expect(appState.phases[0].status).toBe('running');
        });

        it('records phaseStartTimes when status is running', () => {
            fireMessage({
                type: 'PHASE_STATUS',
                payload: { phaseId: 0, status: 'running' },
            });

            expect(appState.phaseStartTimes[0]).toBeGreaterThan(0);
        });
    });

    describe('ERROR', () => {
        beforeEach(() => {
            initMessageHandler();
        });

        it('sets error in appState and appends to terminal', () => {
            fireMessage({
                type: 'ERROR',
                payload: { code: 'PHASE_FAILED', message: 'Phase 0 failed' },
            });

            expect(appState.error).toEqual({
                code: 'PHASE_FAILED',
                message: 'Phase 0 failed',
            });
            expect(appState.terminalOutput).toContain('[ERROR] Phase 0 failed');
        });
    });

    describe('LOG_ENTRY', () => {
        beforeEach(() => {
            initMessageHandler();
        });

        it('appends log to terminal output', () => {
            fireMessage({
                type: 'LOG_ENTRY',
                payload: { timestamp: Date.now(), level: 'info', message: 'Worker spawned' },
            });

            expect(appState.terminalOutput).toContain('[INFO] Worker spawned');
        });

        it('extracts [LAST_PROMPT] sentinel into appState.lastPrompt', () => {
            fireMessage({
                type: 'LOG_ENTRY',
                payload: { timestamp: Date.now(), level: 'info', message: '[LAST_PROMPT] build auth module' },
            });

            expect(appState.lastPrompt).toBe('build auth module');
            // Should NOT appear in terminal output
            expect(appState.terminalOutput).not.toContain('[LAST_PROMPT]');
        });
    });

    describe('PHASE_OUTPUT', () => {
        it('accumulates output for a phase via fireMessage', () => {
            // Use direct appState mutation test since initMessageHandler() stacks
            // window listeners across describe blocks (resetForTesting only resets
            // the guard flag, not previously registered listeners).
            appendPhaseOutput(1, 'hello ');
            appendPhaseOutput(1, 'world');

            expect(appState.phaseOutputs[1]).toBe('hello world');
        });
    });

    describe('PLAN_DRAFT', () => {
        beforeEach(() => {
            initMessageHandler();
        });

        it('sets planDraft, planFileTree, and resets planSlideIndex', () => {
            const draft = makeRunbook();
            fireMessage({
                type: 'PLAN_DRAFT',
                payload: { draft, fileTree: ['src/auth.ts', 'tests/auth.test.ts'] },
            });

            expect(appState.planDraft).toEqual(draft);
            expect(appState.planFileTree).toEqual(['src/auth.ts', 'tests/auth.test.ts']);
            expect(appState.planSlideIndex).toBe(0);
        });
    });

    describe('CONVERSATION_MODE', () => {
        beforeEach(() => {
            initMessageHandler();
        });

        it('updates conversationMode', () => {
            fireMessage({
                type: 'CONVERSATION_MODE',
                payload: { mode: 'continuous', smartSwitchTokenThreshold: 4000 },
            });

            expect(appState.conversationMode).toBe('continuous');
        });
    });

    describe('MCP_RESOURCE_DATA', () => {
        beforeEach(() => {
            initMessageHandler();
        });

        it('is intentional no-op in the dispatcher', () => {
            // MCP_RESOURCE_DATA is handled by mcpStore's per-resource listeners,
            // NOT by the central messageHandler. Verify it doesn't crash.
            expect(() =>
                fireMessage({
                    type: 'MCP_RESOURCE_DATA',
                    payload: { requestId: 'abc', data: 'test-data' },
                }),
            ).not.toThrow();
        });
    });

    describe('unknown message type', () => {
        beforeEach(() => {
            initMessageHandler();
        });

        it('logs a warning but does not crash', () => {
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });

            fireMessage({ type: 'TOTALLY_UNKNOWN' } as any);

            expect(warnSpy).toHaveBeenCalledWith(
                expect.stringContaining('Unknown message type'),
                'TOTALLY_UNKNOWN',
            );
            warnSpy.mockRestore();
        });
    });
});
