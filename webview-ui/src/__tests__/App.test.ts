// ─────────────────────────────────────────────────────────────────────────────
// App.test.ts — Integration tests for the root App.svelte component
//
// Verifies state-driven rendering: planning view, tab visibility, and
// view switching between Phases and Workers.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import { patchState } from '../stores/vscode.svelte.js';
import type { PhaseId } from '../types.js';

// Mock mermaid initialization — jsdom has no CSS variables for theme colors
vi.mock('../lib/mermaid.js', () => ({
    initMermaid: vi.fn().mockResolvedValue(undefined),
    refreshMermaidTheme: vi.fn().mockResolvedValue(undefined),
    renderMermaidBlocks: vi.fn().mockResolvedValue(undefined),
}));

// Mock markdown initialization
vi.mock('../lib/markdown.js', () => ({
    initMarkdown: vi.fn(),
    renderMarkdown: vi.fn((text: string) => text ?? ''),
}));

// Dynamic import to ensure mocks are registered first
const { default: App } = await import('../App.svelte');

beforeEach(() => {
    patchState({
        engineState: 'IDLE',
        phases: [],
        selectedPhaseId: null,
        userSelectedPhaseId: null,
        projectId: '',
        masterTaskId: '',
        planDraft: null,
        error: null,
        terminalOutput: '',
        lastPrompt: '',
        phaseOutputs: {},
        masterSummary: '',
        planStatus: null,
        consolidationReport: null,
        implementationPlan: null,
    });
});

describe('App', () => {
    it('renders GlobalHeader with title', () => {
        render(App);
        expect(screen.getByText('Coogent Mission Control')).toBeInTheDocument();
    });

    it('shows planning spinner when engineState is PLANNING', () => {
        patchState({ engineState: 'PLANNING' });
        render(App);
        expect(screen.getByText('Planning…')).toBeInTheDocument();
        expect(
            screen.getByRole('img', { name: 'Planning in progress' }),
        ).toBeInTheDocument();
    });

    it('displays user prompt with Preview/Raw toggle during PLANNING state', () => {
        patchState({
            engineState: 'PLANNING',
            lastPrompt: 'Build authentication module',
        });
        render(App);
        expect(screen.getByText('Your prompt')).toBeInTheDocument();
        expect(screen.getByText('Preview')).toBeInTheDocument();
        expect(screen.getByText('Raw')).toBeInTheDocument();
    });

    it('switches between Preview and Raw for the planning prompt', async () => {
        patchState({
            engineState: 'PLANNING',
            lastPrompt: '# Hello',
        });
        const { container } = render(App);

        const previewBtn = screen.getByText('Preview');
        const rawBtn = screen.getByText('Raw');

        // Click Raw to ensure we're in raw mode
        await fireEvent.click(rawBtn);
        expect(rawBtn.closest('button')).toHaveClass('active');
        // Raw mode shows the prompt inside a <p class="prompt-text">
        expect(container.querySelector('.prompt-text')).toBeInTheDocument();

        // Switch to Preview — should show rendered markdown (no .prompt-text)
        await fireEvent.click(previewBtn);
        expect(previewBtn.closest('button')).toHaveClass('active');
        expect(container.querySelector('.prompt-text')).not.toBeInTheDocument();
    });

    it('does not show tabs during PLANNING state', () => {
        patchState({ engineState: 'PLANNING' });
        render(App);
        expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    });

    it('does not show tabs during PLAN_REVIEW state', () => {
        patchState({ engineState: 'PLAN_REVIEW' });
        render(App);
        expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    });

    it('shows Phases and Workers tabs when executing', () => {
        patchState({
            engineState: 'EXECUTING_WORKER',
            phases: [
                {
                    id: 0 as PhaseId,
                    status: 'running',
                    prompt: 'Build auth',
                    context_files: [],
                    success_criteria: 'tests pass',
                },
            ],
        });
        render(App);

        expect(screen.getByRole('tablist')).toBeInTheDocument();
        // 'Phases' appears in both the tab and PhaseNavigator heading
        expect(screen.getAllByText('Phases').length).toBeGreaterThanOrEqual(1);
        expect(screen.getAllByText('Workers').length).toBeGreaterThanOrEqual(1);
    });

    it('switches view when Workers tab is clicked', async () => {
        patchState({
            engineState: 'READY',
            phases: [
                {
                    id: 0 as PhaseId,
                    status: 'pending',
                    prompt: 'Build auth',
                    context_files: [],
                    success_criteria: 'tests pass',
                },
            ],
        });
        render(App);

        const workersTab = screen.getByText('Workers');
        await fireEvent.click(workersTab);

        // After clicking Workers tab, the Workers tab should be active
        expect(workersTab.closest('button')).toHaveClass('active');
    });
});
