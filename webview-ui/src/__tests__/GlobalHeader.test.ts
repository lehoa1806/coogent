// ─────────────────────────────────────────────────────────────────────────────
// GlobalHeader.svelte — Integration tests
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import { patchState } from '../stores/vscode.svelte.js';
import type { EngineState } from '../types.js';
import GlobalHeader from '../components/GlobalHeader.svelte';

beforeEach(() => {
    patchState({ engineState: 'IDLE' });
});

describe('GlobalHeader', () => {
    it('renders the title', () => {
        render(GlobalHeader);
        expect(screen.getByText('Coogent Mission Control')).toBeInTheDocument();
    });

    it('displays the current engine state in a badge', () => {
        patchState({ engineState: 'EXECUTING_WORKER' });
        render(GlobalHeader);
        expect(screen.getByText('EXECUTING_WORKER')).toBeInTheDocument();
    });

    it.each<EngineState>([
        'IDLE', 'READY', 'COMPLETED', 'ERROR_PAUSED',
    ])('shows "+ New Chat" button when engine is %s', (state) => {
        patchState({ engineState: state });
        render(GlobalHeader);
        expect(screen.getByText('+ New Chat')).toBeInTheDocument();
    });

    it.each<EngineState>([
        'EXECUTING_WORKER', 'PLANNING', 'EVALUATING',
    ])('hides "+ New Chat" button when engine is %s', (state) => {
        patchState({ engineState: state });
        render(GlobalHeader);
        expect(screen.queryByText('+ New Chat')).not.toBeInTheDocument();
    });

    it('displays the conversation mode badge', () => {
        patchState({ conversationMode: 'isolated' });
        render(GlobalHeader);
        expect(screen.getByText('isolated')).toBeInTheDocument();
    });

    it('renders the terminal toggle button', () => {
        render(GlobalHeader);
        expect(screen.getByLabelText('Toggle worker terminal')).toBeInTheDocument();
    });
});
