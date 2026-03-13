// ─────────────────────────────────────────────────────────────────────────────
// src/context/__tests__/HandoffExtractor.test.ts — Unit tests for HandoffExtractor
// ─────────────────────────────────────────────────────────────────────────────

// Jest globals (describe, it, expect, etc.) are provided automatically
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { HandoffExtractor } from '../HandoffExtractor.js';
import { asPhaseId, type Phase } from '../../types/index.js';

describe('HandoffExtractor', () => {
    let extractor: HandoffExtractor;
    let tmpDir: string;

    beforeEach(async () => {
        extractor = new HandoffExtractor();
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'handoff-test-'));
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    // ═════════════════════════════════════════════════════════════════════════
    //  generateDistillationPrompt
    // ═════════════════════════════════════════════════════════════════════════

    describe('generateDistillationPrompt', () => {
        it('should reference the Output Contract section', () => {
            const prompt = extractor.generateDistillationPrompt(3);
            expect(prompt).toContain('Output Contract');
        });

        it('should reference all four required JSON keys indirectly', () => {
            const prompt = extractor.generateDistillationPrompt(1);
            expect(prompt).toContain('JSON block');
            expect(prompt).toContain('Do NOT omit any key');
        });

        it('should not hardcode a phase number', () => {
            const prompt = extractor.generateDistillationPrompt(7);
            expect(prompt).not.toContain('Phase 7');
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    //  extractHandoff — valid worker output
    // ═════════════════════════════════════════════════════════════════════════

    describe('extractHandoff — valid output', () => {
        it('should extract a well-formed handoff JSON from fenced block', async () => {
            // Create a mock modified file
            const testFile = path.join(tmpDir, 'src', 'foo.ts');
            await fs.mkdir(path.dirname(testFile), { recursive: true });
            await fs.writeFile(testFile, 'export const x = 42;', 'utf-8');

            const workerOutput = [
                'I completed the task. Here is my summary...',
                '',
                '```json',
                JSON.stringify({
                    decisions: ['Used singleton pattern'],
                    modified_files: ['src/foo.ts'],
                    unresolved_issues: [],
                    next_steps_context: 'Consider adding tests',
                }),
                '```',
            ].join('\n');

            const report = await extractor.extractHandoff(1, workerOutput);

            expect(report.phaseId).toBe(1);
            expect(report.decisions).toEqual(['Used singleton pattern']);
            expect(report.modified_files).toEqual(['src/foo.ts']);
            expect(report.unresolved_issues).toEqual([]);
            expect(report.next_steps_context).toBe('Consider adding tests');
            // file_contents removed (CF-1 Pull Model): workers now fetch via MCP
            expect(report.timestamp).toBeGreaterThan(0);
        });

        it('should use the last fenced block when multiple exist', async () => {
            const workerOutput = [
                '```json',
                '{"decisions":["first"],"modified_files":[],"unresolved_issues":[],"next_steps_context":""}',
                '```',
                'More output...',
                '```json',
                '{"decisions":["second"],"modified_files":[],"unresolved_issues":[],"next_steps_context":"final"}',
                '```',
            ].join('\n');

            const report = await extractor.extractHandoff(2, workerOutput);
            expect(report.decisions).toEqual(['second']);
            expect(report.next_steps_context).toBe('final');
        });

        it('should extract enriched fields (summary, rationale, remaining_work, constraints, warnings)', async () => {
            const workerOutput = [
                '```json',
                JSON.stringify({
                    decisions: ['Refactored auth module'],
                    modified_files: ['src/auth.ts'],
                    unresolved_issues: [],
                    next_steps_context: 'Ready for integration tests',
                    summary: 'Completed auth module refactoring with JWT support',
                    rationale: 'JWT chosen for stateless authentication',
                    remaining_work: ['Add refresh token rotation', 'Update API docs'],
                    constraints: ['Must preserve existing session cookies'],
                    warnings: ['Rate limiting not yet implemented'],
                }),
                '```',
            ].join('\n');

            const report = await extractor.extractHandoff(1, workerOutput);

            expect(report.summary).toBe('Completed auth module refactoring with JWT support');
            expect(report.rationale).toBe('JWT chosen for stateless authentication');
            expect(report.remaining_work).toEqual(['Add refresh token rotation', 'Update API docs']);
            expect(report.constraints).toEqual(['Must preserve existing session cookies']);
            expect(report.warnings).toEqual(['Rate limiting not yet implemented']);
        });

        it('should leave enriched fields undefined when absent in worker output', async () => {
            const workerOutput = [
                '```json',
                JSON.stringify({
                    decisions: ['Done'],
                    modified_files: [],
                    unresolved_issues: [],
                    next_steps_context: '',
                }),
                '```',
            ].join('\n');

            const report = await extractor.extractHandoff(1, workerOutput);

            expect(report.summary).toBeUndefined();
            expect(report.rationale).toBeUndefined();
            expect(report.remaining_work).toBeUndefined();
            expect(report.constraints).toBeUndefined();
            expect(report.warnings).toBeUndefined();
        });

        it('should redact secrets in decisions, unresolved_issues, and next_steps_context', async () => {
            // Construct synthetic keys from parts to avoid GitHub Push Protection (GH013)
            const stripeKey = ['sk', 'live', '4eC39HqLyjWDarjtT1zdp7dc'].join('_');

            const workerOutput = [
                '```json',
                JSON.stringify({
                    decisions: ['Used key AKIAIOSFODNN7EXAMPLE for auth'],
                    modified_files: [],
                    unresolved_issues: ['Token sk-AbCdEfGhIjKlMnOpQrStUvWx needs rotation'],
                    next_steps_context: `Stripe key ${stripeKey} requires vault`,
                }),
                '```',
            ].join('\n');

            const report = await extractor.extractHandoff(10, workerOutput);

            // AWS key should be redacted in decisions
            expect(report.decisions[0]).toContain('[REDACTED]');
            expect(report.decisions[0]).not.toContain('AKIAIOSFODNN7EXAMPLE');

            // OpenAI key should be redacted in unresolved_issues
            expect(report.unresolved_issues[0]).toContain('[REDACTED]');
            expect(report.unresolved_issues[0]).not.toContain('sk-AbCdEfGhIjKl');

            // Stripe key should be redacted in next_steps_context
            expect(report.next_steps_context).toContain('[REDACTED]');
            expect(report.next_steps_context).not.toContain('sk_live_');
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    //  extractHandoff — invalid worker output
    // ═════════════════════════════════════════════════════════════════════════

    describe('extractHandoff — invalid output', () => {
        it('should return a minimal report when no JSON is found', async () => {
            const workerOutput = 'Just some text without any JSON.';
            const report = await extractor.extractHandoff(5, workerOutput);

            expect(report.phaseId).toBe(5);
            expect(report.decisions).toEqual([]);
            expect(report.modified_files).toEqual([]);
            expect(report.unresolved_issues).toContain(
                'Handoff JSON could not be parsed from worker output',
            );
            expect(report.timestamp).toBeGreaterThan(0);
        });

        it('should return a minimal report when JSON is malformed', async () => {
            const workerOutput = '```json\n{not valid json}\n```';
            const report = await extractor.extractHandoff(6, workerOutput);

            // Falls through to raw regex attempt, which also fails
            expect(report.phaseId).toBe(6);
            expect(report.decisions).toEqual([]);
        });

        it('should handle missing file gracefully during content reading', async () => {
            const workerOutput = [
                '```json',
                JSON.stringify({
                    decisions: ['ok'],
                    modified_files: ['does/not/exist.ts'],
                    unresolved_issues: [],
                    next_steps_context: '',
                }),
                '```',
            ].join('\n');

            const report = await extractor.extractHandoff(7, workerOutput);
            expect(report.modified_files).toEqual(['does/not/exist.ts']);
            // file_contents removed (CF-1 Pull Model): workers now fetch via MCP
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    // ═════════════════════════════════════════════════════════════════════════
    //  buildNextContext
    // ═════════════════════════════════════════════════════════════════════════

    describe('buildNextContext', () => {
        it('should return empty string for phases with no dependencies', async () => {
            const phase: Phase = {
                id: asPhaseId(3),
                status: 'pending',
                prompt: 'Test',
                context_files: [],
                success_criteria: 'exit_code:0',
            };

            const ctx = await extractor.buildNextContext(phase);
            expect(ctx).toBe('');
        });

        it('should build context from dependent phases via DB', async () => {
            // Wire a mock ArtifactDB that returns handoff data for phases 1 and 2
            const masterTaskId = 'test-task';
            const mockHandoffs: Record<string, any> = {
                'phase-001-00000000-0000-0000-0000-000000000000': {
                    phaseId: 'phase-001-00000000-0000-0000-0000-000000000000',
                    masterTaskId,
                    decisions: ['Chose TypeScript'],
                    modifiedFiles: ['src/bar.ts'],
                    blockers: ['Need tests'],
                    completedAt: 1700000000000,
                    nextStepsContext: 'Bar module ready',
                    summary: 'Implemented the bar module with full type safety',
                    rationale: 'TypeScript was chosen for strict type checking',
                    remainingWork: ['Add unit tests', 'Write docs'],
                    constraints: ['Must use existing DB schema'],
                    warnings: ['Performance not optimized yet'],
                },
                'phase-002-00000000-0000-0000-0000-000000000000': {
                    phaseId: 'phase-002-00000000-0000-0000-0000-000000000000',
                    masterTaskId,
                    decisions: ['Added validation'],
                    modifiedFiles: [],
                    blockers: [],
                    completedAt: 1700000001000,
                    nextStepsContext: 'Validation done',
                },
            };
            const mockDB = {
                handoffs: { get: (_tid: string, pid: string) => mockHandoffs[pid] ?? undefined },
            };
            extractor.setArtifactDB(mockDB as any, masterTaskId);
            extractor.setPhaseIdMap([
                { id: 1, mcpPhaseId: 'phase-001-00000000-0000-0000-0000-000000000000' },
                { id: 2, mcpPhaseId: 'phase-002-00000000-0000-0000-0000-000000000000' },
            ]);

            const phase: Phase = {
                id: asPhaseId(3),
                status: 'pending',
                prompt: 'Test',
                context_files: [],
                success_criteria: 'exit_code:0',
                depends_on: [asPhaseId(1), asPhaseId(2)],
            };

            const ctx = await extractor.buildNextContext(phase);

            // Should include both phases
            expect(ctx).toContain('Phase 1 Handoff');
            expect(ctx).toContain('Phase 2 Handoff');
            expect(ctx).toContain('Chose TypeScript');
            expect(ctx).toContain('Added validation');
            expect(ctx).toContain('Need tests');
            expect(ctx).toContain('Bar module ready');
            // CF-1 Pull Model: should include tool directives, not raw file content
            expect(ctx).toContain('get_modified_file_content');
            expect(ctx).toContain('src/bar.ts');
            // Enriched fields should be present for phase 1
            expect(ctx).toContain('Implemented the bar module with full type safety');
            expect(ctx).toContain('TypeScript was chosen for strict type checking');
            expect(ctx).toContain('Add unit tests');
            expect(ctx).toContain('Must use existing DB schema');
            expect(ctx).toContain('Performance not optimized yet');
        });

        it('should handle missing handoff reports gracefully', async () => {
            const phase: Phase = {
                id: asPhaseId(5),
                status: 'pending',
                prompt: 'Test',
                context_files: [],
                success_criteria: 'exit_code:0',
                depends_on: [asPhaseId(99)],
            };

            const ctx = await extractor.buildNextContext(phase);
            expect(ctx).toContain('Phase 99 Handoff');
            expect(ctx).toContain('No handoff report found');
        });

        it('should render enriched section headings when fields are populated', async () => {
            const masterTaskId = 'test-enriched';
            const mockHandoffs: Record<string, any> = {
                'phase-010-00000000-0000-0000-0000-000000000000': {
                    phaseId: 'phase-010-00000000-0000-0000-0000-000000000000',
                    masterTaskId,
                    decisions: ['D1'],
                    modifiedFiles: [],
                    blockers: [],
                    completedAt: 1700000000000,
                    nextStepsContext: 'next',
                    summary: 'Phase summary text',
                    rationale: 'Phase rationale text',
                    remainingWork: ['R1', 'R2'],
                    constraints: ['C1'],
                    warnings: ['W1'],
                },
            };
            const mockDB = {
                handoffs: { get: (_tid: string, pid: string) => mockHandoffs[pid] ?? undefined },
            };
            extractor.setArtifactDB(mockDB as any, masterTaskId);
            extractor.setPhaseIdMap([
                { id: 10, mcpPhaseId: 'phase-010-00000000-0000-0000-0000-000000000000' },
            ]);

            const phase: Phase = {
                id: asPhaseId(11),
                status: 'pending',
                prompt: 'Test',
                context_files: [],
                success_criteria: 'exit_code:0',
                depends_on: [asPhaseId(10)],
            };

            const ctx = await extractor.buildNextContext(phase);

            expect(ctx).toContain('### Summary');
            expect(ctx).toContain('Phase summary text');
            expect(ctx).toContain('### Rationale');
            expect(ctx).toContain('Phase rationale text');
            expect(ctx).toContain('### Remaining Work');
            expect(ctx).toContain('- R1');
            expect(ctx).toContain('- R2');
            expect(ctx).toContain('### Constraints');
            expect(ctx).toContain('- C1');
            expect(ctx).toContain('### Warnings');
            expect(ctx).toContain('W1');
        });

        it('should omit enriched sections when fields are absent', async () => {
            const masterTaskId = 'test-legacy';
            const mockHandoffs: Record<string, any> = {
                'phase-020-00000000-0000-0000-0000-000000000000': {
                    phaseId: 'phase-020-00000000-0000-0000-0000-000000000000',
                    masterTaskId,
                    decisions: ['D1'],
                    modifiedFiles: [],
                    blockers: [],
                    completedAt: 1700000000000,
                    nextStepsContext: 'next',
                    // No enriched fields
                },
            };
            const mockDB = {
                handoffs: { get: (_tid: string, pid: string) => mockHandoffs[pid] ?? undefined },
            };
            extractor.setArtifactDB(mockDB as any, masterTaskId);
            extractor.setPhaseIdMap([
                { id: 20, mcpPhaseId: 'phase-020-00000000-0000-0000-0000-000000000000' },
            ]);

            const phase: Phase = {
                id: asPhaseId(21),
                status: 'pending',
                prompt: 'Test',
                context_files: [],
                success_criteria: 'exit_code:0',
                depends_on: [asPhaseId(20)],
            };

            const ctx = await extractor.buildNextContext(phase);

            // Core sections present
            expect(ctx).toContain('### Decisions');
            expect(ctx).toContain('### Unresolved Issues');
            expect(ctx).toContain('### Next Steps Context');

            // Summary section now appears using nextStepsContext as fallback
            expect(ctx).toContain('### Summary');

            // Other enriched sections absent
            expect(ctx).not.toContain('### Rationale');
            expect(ctx).not.toContain('### Remaining Work');
            expect(ctx).not.toContain('### Constraints');
            expect(ctx).not.toContain('### Warnings');
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    //  extractImplementationPlan (file-IPC fallback)
    // ═════════════════════════════════════════════════════════════════════════

    describe('extractImplementationPlan', () => {
        it('should extract plan from fenced execution_plan block', () => {
            const planContent = [
                '## Proposed Changes',
                '',
                '### Component A',
                '#### [MODIFY] [foo.ts](file:///workspace/foo.ts)',
                'Add error handling to the fetch call.',
                '',
                '### Component B',
                '#### [NEW] [bar.ts](file:///workspace/bar.ts)',
                'Create the new utility module.',
            ].join('\n');

            const workerOutput = [
                'Working on the task...',
                '',
                '```execution_plan',
                planContent,
                '```',
                '',
                'Done!',
            ].join('\n');

            const result = extractor.extractImplementationPlan(workerOutput);
            expect(result).not.toBeNull();
            expect(result).toContain('## Proposed Changes');
            expect(result).toContain('Component A');
            expect(result).toContain('Component B');
        });

        it('should extract plan from ## Proposed Changes heading', () => {
            const workerOutput = [
                'Analyzing the codebase...',
                '',
                '## Proposed Changes',
                '',
                '### Auth Module',
                '#### [MODIFY] [auth.ts](file:///workspace/auth.ts)',
                'Implement JWT refresh token rotation.',
                '',
                '### Database Layer',
                '#### [MODIFY] [db.ts](file:///workspace/db.ts)',
                'Add connection pooling configuration.',
                '',
                '## Verification Plan',
                'Run tests with `npm test`.',
            ].join('\n');

            const result = extractor.extractImplementationPlan(workerOutput);
            expect(result).not.toBeNull();
            expect(result).toContain('## Proposed Changes');
            expect(result).toContain('Auth Module');
            expect(result).toContain('Database Layer');
            // Should NOT include the Verification section
            expect(result).not.toContain('## Verification Plan');
        });

        it('should extract plan from ## Implementation Plan heading', () => {
            const workerOutput = [
                '## Implementation Plan',
                '',
                'We need to refactor the router module to support middleware chains.',
                'The changes span three files and require careful ordering.',
                '',
                '### Step 1: Router.ts',
                'Add the middleware array to the route definition.',
                '',
                '### Step 2: Middleware.ts',
                'Create the middleware chain runner.',
            ].join('\n');

            const result = extractor.extractImplementationPlan(workerOutput);
            expect(result).not.toBeNull();
            expect(result).toContain('## Implementation Plan');
            expect(result).toContain('Router.ts');
            expect(result).toContain('Middleware.ts');
        });

        it('should stop extraction before handoff JSON block', () => {
            const workerOutput = [
                '## Proposed Changes',
                '',
                '### Module X',
                '#### [MODIFY] [x.ts](file:///workspace/x.ts)',
                'Update the handler to validate input before dispatching.',
                '',
                '```json',
                '{"decisions":["Updated handler"],"modified_files":["x.ts"],"unresolved_issues":[],"next_steps_context":"Done"}',
                '```',
            ].join('\n');

            const result = extractor.extractImplementationPlan(workerOutput);
            expect(result).not.toBeNull();
            expect(result).toContain('## Proposed Changes');
            expect(result).toContain('Module X');
            expect(result).not.toContain('"decisions"');
        });

        it('should return null when no plan is found', () => {
            const workerOutput = [
                'Just doing some work...',
                'No plan here, just execution.',
                '',
                '```json',
                '{"decisions":["Done"],"modified_files":[],"unresolved_issues":[],"next_steps_context":""}',
                '```',
            ].join('\n');

            const result = extractor.extractImplementationPlan(workerOutput);
            expect(result).toBeNull();
        });

        it('should return null for plans shorter than minimum threshold', () => {
            const workerOutput = [
                '## Proposed Changes',
                '',
                'Short plan.',
            ].join('\n');

            // Plan content is < 200 chars for heading heuristic
            const result = extractor.extractImplementationPlan(workerOutput);
            expect(result).toBeNull();
        });

        it('should skip extraction when plan already exists in ArtifactDB (dedup)', () => {
            const mockDB = {
                tasks: {
                    get: () => ({
                        phases: {
                            get: () => ({
                                executionPlan: '# Existing plan\nAlready submitted.',
                            }),
                        },
                    }),
                },
            };
            extractor.setArtifactDB(mockDB as any, 'task-001');

            const workerOutput = [
                '```execution_plan',
                '## Proposed Changes\n\n### A\nLine '.repeat(20), // > 100 chars
                '```',
            ].join('\n');

            const result = extractor.extractImplementationPlan(
                workerOutput,
                'task-001',
                'phase-001-uuid',
            );
            expect(result).toBeNull();
        });
    });
});
