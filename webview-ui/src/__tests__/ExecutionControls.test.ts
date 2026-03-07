// ─────────────────────────────────────────────────────────────────────────────
// ExecutionControls.svelte — Integration tests
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import { patchState } from '../stores/vscode.svelte.js';
import ExecutionControls from '../components/ExecutionControls.svelte';

beforeEach(() => {
    patchState({ engineState: 'IDLE', phases: [] });
});

describe('ExecutionControls', () => {
    it('renders Start, Pause, and Abort buttons', () => {
        render(ExecutionControls);
        expect(screen.getByText(/Start/)).toBeInTheDocument();
        expect(screen.getByText(/Pause/)).toBeInTheDocument();
        expect(screen.getByText(/Abort/)).toBeInTheDocument();
    });

    it('disables Start when engine is IDLE', () => {
        patchState({ engineState: 'IDLE' });
        render(ExecutionControls);
        expect(screen.getByText(/Start/).closest('button')).toBeDisabled();
    });

    it('enables Start when engine is READY', () => {
        patchState({ engineState: 'READY' });
        render(ExecutionControls);
        expect(screen.getByText(/Start/).closest('button')).not.toBeDisabled();
    });

    it('enables Pause when engine is EXECUTING_WORKER', () => {
        patchState({ engineState: 'EXECUTING_WORKER' });
        render(ExecutionControls);
        expect(screen.getByText(/Pause/).closest('button')).not.toBeDisabled();
    });

    it('disables Abort when engine is IDLE', () => {
        patchState({ engineState: 'IDLE' });
        render(ExecutionControls);
        expect(screen.getByText(/Abort/).closest('button')).toBeDisabled();
    });

    it('disables Abort when engine is COMPLETED', () => {
        patchState({ engineState: 'COMPLETED' });
        render(ExecutionControls);
        expect(screen.getByText(/Abort/).closest('button')).toBeDisabled();
    });

    it('shows elapsed timer at 00:00', () => {
        render(ExecutionControls);
        expect(screen.getByText('00:00')).toBeInTheDocument();
    });

    it('shows report button when COMPLETED', () => {
        patchState({ engineState: 'COMPLETED' });
        render(ExecutionControls);
        expect(screen.getByTitle('View Report')).toBeInTheDocument();
    });

    it('hides report button when not COMPLETED', () => {
        patchState({ engineState: 'READY' });
        render(ExecutionControls);
        expect(screen.queryByTitle('View Report')).not.toBeInTheDocument();
    });

    it('shows plan button when phases exist', () => {
        patchState({
            engineState: 'READY',
            phases: [{ id: 1, status: 'pending', prompt: 'test', context_files: [], success_criteria: 'ok' }] as any,
        });
        render(ExecutionControls);
        expect(screen.getByTitle('View Implementation Plan')).toBeInTheDocument();
    });
});
