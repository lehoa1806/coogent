// ─────────────────────────────────────────────────────────────────────────────
// src/adk/__tests__/mocks/MockADKAdapter.ts — Mock ADK adapter for testing
// ─────────────────────────────────────────────────────────────────────────────

import type { AgentBackendProvider } from '../../AgentBackendProvider.js';
import type { ADKSessionOptions, ADKSessionHandle } from '../../ADKController.js';

/**
 * Mock ADK adapter that simulates agent behavior for testing.
 * Immediately exits with code 0 after a configurable delay.
 */
export class MockADKAdapter implements AgentBackendProvider {
    readonly name = 'mock';
    private sessionCounter = 0;
    private pidCounter = 90_000;

    constructor(
        private readonly exitDelay = 100,
        private readonly exitCode = 0
    ) { }

    async createSession(options: ADKSessionOptions): Promise<ADKSessionHandle> {
        const sessionId = `mock-${++this.sessionCounter}`;
        let outputCallback: ((stream: 'stdout' | 'stderr', chunk: string) => void) | null = null;
        let exitCallback: ((code: number) => void) | null = null;

        // Determine if this is a planner session (needs JSON runbook output)
        const isPlannerSession = options.initialPrompt.includes('Planning Agent')
            || options.initialPrompt.includes('## JSON Schema');

        // Simulate async agent work
        setTimeout(() => {
            if (outputCallback) {
                if (isPlannerSession) {
                    // Extract a project slug from the prompt if possible
                    const slugMatch = options.initialPrompt.match(/## User Request\n(.+)/);
                    const slug = slugMatch
                        ? slugMatch[1].slice(0, 40).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '')
                        : 'mock-project';

                    // Return a valid JSON runbook so the planner can parse it
                    outputCallback('stdout', '```json\n');
                    outputCallback('stdout', JSON.stringify({
                        project_id: slug,
                        status: 'idle',
                        current_phase: 1,
                        phases: [
                            {
                                id: 1,
                                status: 'pending',
                                prompt: 'Implement the requested changes based on the user\'s requirements.',
                                context_files: [],
                                success_criteria: 'exit_code:0',
                            },
                        ],
                    }, null, 2));
                    outputCallback('stdout', '\n```\n');
                } else {
                    outputCallback('stdout', `[Mock] Executing: ${options.initialPrompt.slice(0, 100)}...\n`);
                    outputCallback('stdout', `[Mock] Task completed successfully.\n`);
                }
            }
            if (exitCallback) {
                exitCallback(this.exitCode);
            }
        }, this.exitDelay);

        return {
            sessionId,
            pid: ++this.pidCounter, // Counter-based fake PID (avoids colliding with real PIDs)
            onOutput(cb) { outputCallback = cb; },
            onExit(cb) { exitCallback = cb; },
        };
    }

    async terminateSession(_handle: ADKSessionHandle): Promise<void> {
        // No-op for mock
    }
}
