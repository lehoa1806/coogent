// ─────────────────────────────────────────────────────────────────────────────
// Store-level integration tests for vscode.svelte.ts
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect } from 'vitest';
import { postedMessages } from './setup.js';
import { appState, patchState, postMessage, appendPhaseOutput } from '../stores/vscode.svelte.js';

describe('patchState()', () => {
    it('merges a partial update into appState', () => {
        patchState({ projectId: 'test-project' });
        expect(appState.projectId).toBe('test-project');
    });

    it('preserves unmodified fields', () => {
        const prevMode = appState.conversationMode;
        patchState({ projectId: 'new-proj' });
        expect(appState.conversationMode).toBe(prevMode);
    });

    it('can set engineState', () => {
        patchState({ engineState: 'EXECUTING_WORKER' });
        expect(appState.engineState).toBe('EXECUTING_WORKER');
        // Reset for other tests
        patchState({ engineState: 'IDLE' });
    });
});

describe('appendPhaseOutput()', () => {
    it('accumulates output for a single phase', () => {
        appendPhaseOutput(1, 'hello ');
        appendPhaseOutput(1, 'world');
        expect(appState.phaseOutputs[1]).toBe('hello world');
    });

    it('keeps separate outputs per phase', () => {
        appendPhaseOutput(10, 'alpha');
        appendPhaseOutput(20, 'beta');
        expect(appState.phaseOutputs[10]).toBe('alpha');
        expect(appState.phaseOutputs[20]).toBe('beta');
    });
});

describe('postMessage()', () => {
    it('sends a CMD_START message to the VS Code host', () => {
        postMessage({ type: 'CMD_START' });
        expect(postedMessages).toContainEqual({ type: 'CMD_START' });
    });

    it('sends a CMD_PLAN_REQUEST with payload', () => {
        postMessage({ type: 'CMD_PLAN_REQUEST', payload: { prompt: 'build auth' } });
        expect(postedMessages).toContainEqual({
            type: 'CMD_PLAN_REQUEST',
            payload: { prompt: 'build auth' },
        });
    });
});
