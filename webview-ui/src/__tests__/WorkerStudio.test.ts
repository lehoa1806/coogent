// ─────────────────────────────────────────────────────────────────────────────
// WorkerStudio.svelte — Integration tests
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import { patchState } from '../stores/vscode.svelte.js';
import type { WorkerProfile } from '../types.js';
import WorkerStudio from '../components/WorkerStudio.svelte';

const MOCK_WORKERS: WorkerProfile[] = [
    {
        id: 'frontend',
        name: 'Frontend Engineer',
        description: 'React, CSS, and UI development',
        system_prompt: 'You are a frontend engineer.',
        tags: ['react', 'css', 'a11y'],
    },
    {
        id: 'backend',
        name: 'Backend Engineer',
        description: 'APIs, databases, and server development',
        system_prompt: 'You are a backend engineer.',
        tags: ['node', 'postgres', 'rest'],
    },
];

beforeEach(() => {
    patchState({ workers: [] });
});

describe('WorkerStudio', () => {
    it('shows empty state when no workers are loaded', () => {
        render(WorkerStudio);
        expect(screen.getByText('No worker profiles loaded.')).toBeInTheDocument();
    });

    it('shows the worker count in the header', () => {
        patchState({ workers: MOCK_WORKERS });
        render(WorkerStudio);
        expect(screen.getByText('Loaded Workers (2)')).toBeInTheDocument();
    });

    it('renders worker names', () => {
        patchState({ workers: MOCK_WORKERS });
        render(WorkerStudio);
        expect(screen.getByText('Frontend Engineer')).toBeInTheDocument();
        expect(screen.getByText('Backend Engineer')).toBeInTheDocument();
    });

    it('renders worker descriptions', () => {
        patchState({ workers: MOCK_WORKERS });
        render(WorkerStudio);
        expect(screen.getByText('React, CSS, and UI development')).toBeInTheDocument();
        expect(screen.getByText('APIs, databases, and server development')).toBeInTheDocument();
    });

    it('renders tag badges', () => {
        patchState({ workers: MOCK_WORKERS });
        render(WorkerStudio);
        expect(screen.getByText('react')).toBeInTheDocument();
        expect(screen.getByText('node')).toBeInTheDocument();
        expect(screen.getByText('postgres')).toBeInTheDocument();
    });

    it('renders worker IDs', () => {
        patchState({ workers: MOCK_WORKERS });
        render(WorkerStudio);
        expect(screen.getByText('(frontend)')).toBeInTheDocument();
        expect(screen.getByText('(backend)')).toBeInTheDocument();
    });
});
