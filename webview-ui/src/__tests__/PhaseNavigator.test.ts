// ─────────────────────────────────────────────────────────────────────────────
// PhaseNavigator.svelte — Integration tests
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import { appState, patchState } from '../stores/vscode.svelte.js';
import type { Phase, PhaseId } from '../types.js';
import PhaseNavigator from '../components/PhaseNavigator.svelte';

function makePhase(id: number, prompt: string, status = 'pending', deps?: number[]): Phase {
    return {
        id: id as PhaseId,
        status: status as any,
        prompt,
        context_files: [],
        success_criteria: 'test',
        depends_on: deps as PhaseId[] | undefined,
    };
}

beforeEach(() => {
    patchState({
        phases: [],
        selectedPhaseId: null,
        userSelectedPhaseId: null,
    });
});

describe('PhaseNavigator', () => {
    it('renders the "Phases" header', () => {
        render(PhaseNavigator);
        expect(screen.getByText('Phases')).toBeInTheDocument();
    });

    it('renders phase items with truncated prompts', () => {
        patchState({
            phases: [
                makePhase(1, 'Set up authentication module'),
                makePhase(2, 'Build REST API endpoints'),
            ],
        });
        render(PhaseNavigator);
        expect(screen.getByText('Set up authentication module')).toBeInTheDocument();
        expect(screen.getByText('Build REST API endpoints')).toBeInTheDocument();
    });

    it('displays status pills with correct text', () => {
        patchState({
            phases: [
                makePhase(1, 'Phase A', 'completed'),
                makePhase(2, 'Phase B', 'failed'),
                makePhase(3, 'Phase C', 'pending'),
            ],
        });
        render(PhaseNavigator);
        expect(screen.getByText('Done')).toBeInTheDocument();
        expect(screen.getByText('Failed')).toBeInTheDocument();
        expect(screen.getByText('Pending')).toBeInTheDocument();
    });

    it('displays phase numbers', () => {
        patchState({
            phases: [makePhase(1, 'First'), makePhase(2, 'Second')],
        });
        render(PhaseNavigator);
        expect(screen.getByText('1')).toBeInTheDocument();
        expect(screen.getByText('2')).toBeInTheDocument();
    });

    it('selects a phase on click', async () => {
        patchState({
            phases: [makePhase(1, 'Click me'), makePhase(2, 'Not me')],
        });
        render(PhaseNavigator);
        const item = screen.getByText('Click me').closest('[role="listitem"]')!;
        await fireEvent.click(item);
        expect(appState.selectedPhaseId).toBe(1);
        expect(appState.userSelectedPhaseId).toBe(1);
    });

    it('shows dependency badges', () => {
        patchState({
            phases: [
                makePhase(1, 'Phase A'),
                makePhase(2, 'Phase B', 'pending', [1]),
            ],
        });
        render(PhaseNavigator);
        expect(screen.getByText('← #1')).toBeInTheDocument();
    });
});
