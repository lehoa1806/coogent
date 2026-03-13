// ─────────────────────────────────────────────────────────────────────────────
// src/adk/__tests__/ADKController.injection.test.ts
// Tests for prompt construction via buildInjectionPrompt (accessed indirectly
// by capturing the initialPrompt passed to adapter.createSession)
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ADKController } from '../ADKController.js';
import { MockADKAdapter } from './mocks/MockADKAdapter.js';
import { asPhaseId, type Phase } from '../../types/index.js';

describe('ADKController — Injection Prompt Construction', () => {
    let controller: ADKController;
    let adapter: MockADKAdapter;
    let tmpDir: string;

    const basePhase: Phase = {
        id: asPhaseId(10),
        prompt: 'Implement feature X with tests',
        context_files: [],
        status: 'pending',
        success_criteria: 'exit_code:0',
    };

    beforeEach(async () => {
        jest.useFakeTimers();
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'coogent-injection-'));
        adapter = new MockADKAdapter(500);
        controller = new ADKController(adapter, tmpDir);
    });

    afterEach(async () => {
        jest.useRealTimers();
        await controller.terminateAll('TEST_CLEANUP');
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    // ═══════════════════════════════════════════════════════════════════════════
    //  Prompt Structure Tests
    // ═══════════════════════════════════════════════════════════════════════════

    it('includes the phase task prompt in the injected prompt', async () => {
        let capturedPrompt = '';
        jest.spyOn(adapter, 'createSession').mockImplementationOnce(async (options) => {
            capturedPrompt = options.initialPrompt;
            return {
                sessionId: 'prompt-capture',
                pid: 99100,
                onOutput: () => {},
                onExit: () => {},
            };
        });

        await controller.spawnWorker(basePhase, 5000);

        expect(capturedPrompt).toContain('Implement feature X with tests');
        expect(capturedPrompt).toContain('## Task');
    });

    it('includes MCP context resources when provided', async () => {
        let capturedPrompt = '';
        jest.spyOn(adapter, 'createSession').mockImplementationOnce(async (options) => {
            capturedPrompt = options.initialPrompt;
            return {
                sessionId: 'mcp-capture',
                pid: 99101,
                onOutput: () => {},
                onExit: () => {},
            };
        });

        await controller.spawnWorker(basePhase, 5000, 'master-123', {
            implementationPlan: 'coogent://tasks/master-123/execution_plan',
            parentHandoffs: [
                'coogent://tasks/master-123/phases/phase-001/handoff',
                'coogent://tasks/master-123/phases/phase-002/handoff',
            ],
        });

        expect(capturedPrompt).toContain('## MCP Context Resources');
        expect(capturedPrompt).toContain('coogent://tasks/master-123/execution_plan');
        expect(capturedPrompt).toContain('Parent Phase Handoff [1]');
        expect(capturedPrompt).toContain('Parent Phase Handoff [2]');
    });

    it('omits MCP context section when no URIs are provided', async () => {
        let capturedPrompt = '';
        jest.spyOn(adapter, 'createSession').mockImplementationOnce(async (options) => {
            capturedPrompt = options.initialPrompt;
            return {
                sessionId: 'no-mcp',
                pid: 99102,
                onOutput: () => {},
                onExit: () => {},
            };
        });

        await controller.spawnWorker(basePhase, 5000);

        expect(capturedPrompt).not.toContain('## MCP Context Resources');
    });

    it('includes context file directives when phase has context_files', async () => {
        let capturedPrompt = '';
        jest.spyOn(adapter, 'createSession').mockImplementationOnce(async (options) => {
            capturedPrompt = options.initialPrompt;
            return {
                sessionId: 'ctx-files',
                pid: 99103,
                onOutput: () => {},
                onExit: () => {},
            };
        });

        const phaseWithFiles: Phase = {
            ...basePhase,
            context_files: ['src/app.ts', 'src/utils.ts'],
        };

        await controller.spawnWorker(phaseWithFiles, 5000);

        expect(capturedPrompt).toContain('## Required Context Reads');
        expect(capturedPrompt).toContain('get_modified_file_content');
        expect(capturedPrompt).toContain('src/app.ts');
        expect(capturedPrompt).toContain('src/utils.ts');
    });

    it('omits context file section when context_files is empty', async () => {
        let capturedPrompt = '';
        jest.spyOn(adapter, 'createSession').mockImplementationOnce(async (options) => {
            capturedPrompt = options.initialPrompt;
            return {
                sessionId: 'no-ctx',
                pid: 99104,
                onOutput: () => {},
                onExit: () => {},
            };
        });

        await controller.spawnWorker(basePhase, 5000);

        expect(capturedPrompt).not.toContain('## Required Context Reads');
        expect(capturedPrompt).not.toContain('get_modified_file_content');
    });

    // ═══════════════════════════════════════════════════════════════════════════
    //  Session Options Passthrough
    // ═══════════════════════════════════════════════════════════════════════════

    it('passes masterTaskId to adapter.createSession when provided', async () => {
        const createSpy = jest.spyOn(adapter, 'createSession').mockImplementationOnce(async (_options) => {
            return {
                sessionId: 'master-test',
                pid: 99105,
                onOutput: () => {},
                onExit: () => {},
            };
        });

        await controller.spawnWorker(basePhase, 5000, 'task-abc');

        expect(createSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                masterTaskId: 'task-abc',
                phaseNumber: 10,
            }),
        );
    });

    it('passes phaseNumber to adapter.createSession', async () => {
        const createSpy = jest.spyOn(adapter, 'createSession').mockImplementationOnce(async () => ({
            sessionId: 'phase-num-test',
            pid: 99106,
            onOutput: () => {},
            onExit: () => {},
        }));

        const phase: Phase = { ...basePhase, id: asPhaseId(7) };
        await controller.spawnWorker(phase, 5000);

        expect(createSpy).toHaveBeenCalledWith(
            expect.objectContaining({ phaseNumber: 7 }),
        );
    });
});
