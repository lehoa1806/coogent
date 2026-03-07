// ─────────────────────────────────────────────────────────────────────────────
// src/consolidation/__tests__/ConsolidationAgent.test.ts
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ConsolidationAgent, type ConsolidationReport } from '../ConsolidationAgent.js';
import type { Runbook } from '../../types/index.js';
import { asPhaseId } from '../../types/index.js';
import type { HandoffReport } from '../../context/HandoffExtractor.js';

describe('ConsolidationAgent', () => {
    let agent: ConsolidationAgent;
    let tmpDir: string;

    beforeEach(async () => {
        agent = new ConsolidationAgent();
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'consolidation-test-'));
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    // ─── Helpers ─────────────────────────────────────────────────────────

    const MCP_PHASE_0_DEFAULT = 'phase-000-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const MCP_PHASE_1_DEFAULT = 'phase-001-11111111-2222-3333-4444-555555555555';
    const DEFAULT_MASTER_TASK_ID = 'default-master-task-id';

    function makeRunbook(overrides: Partial<Runbook> = {}): Runbook {
        return {
            project_id: 'test-project',
            status: 'completed',
            current_phase: 0,
            phases: [
                {
                    id: asPhaseId(0),
                    status: 'completed',
                    prompt: 'Phase 0 prompt',
                    context_files: [],
                    success_criteria: 'exit_code:0',
                    mcpPhaseId: MCP_PHASE_0_DEFAULT,
                },
                {
                    id: asPhaseId(1),
                    status: 'completed',
                    prompt: 'Phase 1 prompt',
                    context_files: [],
                    success_criteria: 'exit_code:0',
                    mcpPhaseId: MCP_PHASE_1_DEFAULT,
                },
            ],
            ...overrides,
        };
    }

    function makeHandoff(phaseId: number, overrides: Partial<HandoffReport> = {}): HandoffReport {
        return {
            phaseId,
            decisions: [`Decision for phase ${phaseId}`],
            modified_files: [`src/file-${phaseId}.ts`],
            unresolved_issues: [],
            next_steps_context: `Context from phase ${phaseId}`,
            timestamp: Date.now(),
            ...overrides,
        };
    }

    function makeMcpHandoffJson(report: HandoffReport) {
        return JSON.stringify({
            decisions: report.decisions,
            modifiedFiles: report.modified_files,
            blockers: report.unresolved_issues,
            completedAt: report.timestamp,
        });
    }

    function makeDefaultMcpBridge(phase0: HandoffReport, phase1?: HandoffReport) {
        const responses: Record<string, string> = {};
        responses[`coogent://tasks/${DEFAULT_MASTER_TASK_ID}/phases/${MCP_PHASE_0_DEFAULT}/handoff`] = makeMcpHandoffJson(phase0);
        if (phase1) {
            responses[`coogent://tasks/${DEFAULT_MASTER_TASK_ID}/phases/${MCP_PHASE_1_DEFAULT}/handoff`] = makeMcpHandoffJson(phase1);
        }
        return {
            readResource: jest.fn((uri: string) => {
                if (responses[uri]) return Promise.resolve(responses[uri]);
                return Promise.reject(new Error(`Resource not found: ${uri}`));
            }),
        } as unknown as import('../../mcp/MCPClientBridge.js').MCPClientBridge;
    }

    // ─── generateReport ─────────────────────────────────────────────────

    describe('generateReport', () => {
        it('should aggregate all handoff reports into a consolidation report', async () => {
            const runbook = makeRunbook();
            const mockBridge = makeDefaultMcpBridge(makeHandoff(0), makeHandoff(1));

            const report = await agent.generateReport(tmpDir, runbook, mockBridge, DEFAULT_MASTER_TASK_ID);

            expect(report.projectId).toBe('test-project');
            expect(report.totalPhases).toBe(2);
            expect(report.successfulPhases).toBe(2);
            expect(report.failedPhases).toBe(0);
            expect(report.skippedPhases).toBe(0);
            expect(report.allModifiedFiles).toEqual(
                expect.arrayContaining(['src/file-0.ts', 'src/file-1.ts']),
            );
            expect(report.allDecisions).toEqual(
                expect.arrayContaining([
                    'Decision for phase 0',
                    'Decision for phase 1',
                ]),
            );
            expect(report.phaseResults).toHaveLength(2);
            expect(report.generatedAt).toBeGreaterThan(0);
        });

        it('should handle missing handoff gracefully (mark as skipped)', async () => {
            const runbook = makeRunbook();
            // Only provide handoff for phase 0, not phase 1
            const mockBridge = makeDefaultMcpBridge(makeHandoff(0));

            const report = await agent.generateReport(tmpDir, runbook, mockBridge, DEFAULT_MASTER_TASK_ID);

            expect(report.successfulPhases).toBe(1);
            expect(report.skippedPhases).toBe(1);
            expect(report.phaseResults[1].decisions).toEqual([]);
            expect(report.phaseResults[1].modifiedFiles).toEqual([]);
        });

        it('should count failed phases correctly', async () => {
            const runbook = makeRunbook({
                phases: [
                    {
                        id: asPhaseId(0),
                        status: 'completed',
                        prompt: 'p0',
                        context_files: [],
                        success_criteria: 'exit_code:0',
                        mcpPhaseId: MCP_PHASE_0_DEFAULT,
                    },
                    {
                        id: asPhaseId(1),
                        status: 'failed',
                        prompt: 'p1',
                        context_files: [],
                        success_criteria: 'exit_code:0',
                        mcpPhaseId: MCP_PHASE_1_DEFAULT,
                    },
                ],
            });
            const mockBridge = makeDefaultMcpBridge(makeHandoff(0), makeHandoff(1));

            const report = await agent.generateReport(tmpDir, runbook, mockBridge, DEFAULT_MASTER_TASK_ID);

            expect(report.successfulPhases).toBe(1);
            expect(report.failedPhases).toBe(1);
        });

        it('should deduplicate modified files across phases', async () => {
            const runbook = makeRunbook();
            const mockBridge = makeDefaultMcpBridge(
                makeHandoff(0, { modified_files: ['shared.ts'] }),
                makeHandoff(1, { modified_files: ['shared.ts'] }),
            );

            const report = await agent.generateReport(tmpDir, runbook, mockBridge, DEFAULT_MASTER_TASK_ID);

            expect(report.allModifiedFiles).toEqual(['shared.ts']);
        });

        it('should aggregate unresolved issues from all phases', async () => {
            const runbook = makeRunbook();
            const mockBridge = makeDefaultMcpBridge(
                makeHandoff(0, { unresolved_issues: ['Issue A'] }),
                makeHandoff(1, { unresolved_issues: ['Issue B', 'Issue C'] }),
            );

            const report = await agent.generateReport(tmpDir, runbook, mockBridge, DEFAULT_MASTER_TASK_ID);

            expect(report.unresolvedIssues).toEqual(['Issue A', 'Issue B', 'Issue C']);
        });

        it('should handle an empty runbook with no phases', async () => {
            const runbook = makeRunbook({ phases: [] });

            const report = await agent.generateReport(tmpDir, runbook);

            expect(report.totalPhases).toBe(0);
            expect(report.successfulPhases).toBe(0);
            expect(report.failedPhases).toBe(0);
            expect(report.skippedPhases).toBe(0);
            expect(report.allModifiedFiles).toEqual([]);
            expect(report.allDecisions).toEqual([]);
            expect(report.unresolvedIssues).toEqual([]);
            expect(report.phaseResults).toEqual([]);
        });
    });

    // ─── formatAsMarkdown ───────────────────────────────────────────────

    describe('formatAsMarkdown', () => {
        it('should produce a well-structured Markdown document', () => {
            const report: ConsolidationReport = {
                projectId: 'proj-123',
                totalPhases: 2,
                successfulPhases: 1,
                failedPhases: 1,
                skippedPhases: 0,
                allModifiedFiles: ['src/a.ts', 'src/b.ts'],
                allDecisions: ['Used factory pattern', 'Added error handling'],
                unresolvedIssues: ['Performance needs testing'],
                phaseResults: [
                    { phaseId: 0, status: 'completed', decisions: ['Used factory pattern'], modifiedFiles: ['src/a.ts'] },
                    { phaseId: 1, status: 'failed', decisions: ['Added error handling'], modifiedFiles: ['src/b.ts'] },
                ],
                generatedAt: 1700000000000,
            };

            const md = agent.formatAsMarkdown(report);

            expect(md).toContain('# Walkthrough');
            expect(md).toContain('## Summary');
            expect(md).toContain('| **Project** | proj-123 |');
            expect(md).toContain('| **Total Phases** | 2 |');
            expect(md).toContain('| **Successful** | 1 |');
            expect(md).toContain('| **Failed** | 1 |');
            expect(md).toContain('> [!WARNING]');
            expect(md).toContain('## Phase Results');
            expect(md).toContain('### ✅ Phase 0');
            expect(md).toContain('### ❌ Phase 1');
            expect(md).toContain('## All Modified Files');
            expect(md).toContain('+ src/a.ts');
            expect(md).toContain('## Decisions Made');
            expect(md).toContain('Used factory pattern');
            expect(md).toContain('> [!CAUTION]');
            expect(md).toContain('Performance needs testing');
        });

        it('should show "None" placeholders when sections are empty', () => {
            const report: ConsolidationReport = {
                projectId: 'empty-proj',
                totalPhases: 1,
                successfulPhases: 0,
                failedPhases: 0,
                skippedPhases: 1,
                allModifiedFiles: [],
                allDecisions: [],
                unresolvedIssues: [],
                phaseResults: [
                    { phaseId: 0, status: 'pending', decisions: [], modifiedFiles: [] },
                ],
                generatedAt: 1700000000000,
            };

            const md = agent.formatAsMarkdown(report);

            expect(md).toContain('_No files were modified._');
            expect(md).toContain('_No decisions recorded._');
            expect(md).toContain('_No unresolved issues._');
            expect(md).toContain('**Decisions:** _None_');
            expect(md).toContain('**Modified Files:** _None_');
        });
    });

    // ─── saveReport ─────────────────────────────────────────────────────

    describe('saveReport', () => {
        function makeMockBridge() {
            return {
                submitConsolidationReport: jest.fn().mockResolvedValue(undefined),
            } as unknown as import('../../mcp/MCPClientBridge.js').MCPClientBridge;
        }

        it('should submit the report to MCP via the bridge', async () => {
            const mockBridge = makeMockBridge();
            const report: ConsolidationReport = {
                projectId: 'save-test',
                totalPhases: 1,
                successfulPhases: 1,
                failedPhases: 0,
                skippedPhases: 0,
                allModifiedFiles: ['src/main.ts'],
                allDecisions: ['Initial implementation'],
                unresolvedIssues: [],
                phaseResults: [
                    { phaseId: 0, status: 'completed', decisions: ['Initial implementation'], modifiedFiles: ['src/main.ts'] },
                ],
                generatedAt: Date.now(),
            };

            await agent.saveReport(tmpDir, report, mockBridge, 'master-task-001');

            expect(mockBridge.submitConsolidationReport).toHaveBeenCalledTimes(1);
            expect(mockBridge.submitConsolidationReport).toHaveBeenCalledWith(
                'master-task-001',
                expect.stringContaining('# Walkthrough'),
            );
            expect(mockBridge.submitConsolidationReport).toHaveBeenCalledWith(
                'master-task-001',
                expect.stringContaining('save-test'),
            );
        });

        it('should NOT write consolidation-report.md to disk (V1 purity)', async () => {
            const mockBridge = makeMockBridge();
            const report: ConsolidationReport = {
                projectId: 'no-disk-test',
                totalPhases: 0,
                successfulPhases: 0,
                failedPhases: 0,
                skippedPhases: 0,
                allModifiedFiles: [],
                allDecisions: [],
                unresolvedIssues: [],
                phaseResults: [],
                generatedAt: Date.now(),
            };

            await agent.saveReport(tmpDir, report, mockBridge, 'master-task-002');

            // The file must NOT exist on disk
            const filePath = path.join(tmpDir, 'consolidation-report.md');
            await expect(fs.stat(filePath)).rejects.toThrow();
        });

        it('should not throw when no MCP bridge is provided', async () => {
            const report: ConsolidationReport = {
                projectId: 'no-bridge-test',
                totalPhases: 0,
                successfulPhases: 0,
                failedPhases: 0,
                skippedPhases: 0,
                allModifiedFiles: [],
                allDecisions: [],
                unresolvedIssues: [],
                phaseResults: [],
                generatedAt: Date.now(),
            };

            // Should complete without error (logs a warning internally)
            await expect(agent.saveReport(tmpDir, report)).resolves.toBeUndefined();
        });
    });

    // ─── MCP-based handoff loading ─────────────────────────────────────

    describe('loadHandoffFromMCP (via generateReport)', () => {
        const MASTER_TASK_ID = '20260306-223640-36bc870c-08aa-40b3-8c85-16400f2a6825';
        const MCP_PHASE_0 = 'phase-000-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
        const MCP_PHASE_1 = 'phase-001-11111111-2222-3333-4444-555555555555';

        function makeRunbookWithMcpIds(): import('../../types/index.js').Runbook {
            return {
                project_id: 'mcp-test',
                status: 'completed',
                current_phase: 0,
                phases: [
                    {
                        id: asPhaseId(0),
                        status: 'completed',
                        prompt: 'P0',
                        context_files: [],
                        success_criteria: 'exit_code:0',
                        mcpPhaseId: MCP_PHASE_0,
                    },
                    {
                        id: asPhaseId(1),
                        status: 'completed',
                        prompt: 'P1',
                        context_files: [],
                        success_criteria: 'exit_code:0',
                        mcpPhaseId: MCP_PHASE_1,
                    },
                ],
            };
        }

        function makeMcpHandoffJson(decisions: string[], modifiedFiles: string[], blockers: string[]) {
            return JSON.stringify({ decisions, modifiedFiles, blockers, completedAt: 1700000000000 });
        }

        it('should read handoffs from MCP using the real mcpPhaseId', async () => {
            const mockBridge = {
                readResource: jest.fn()
                    .mockResolvedValueOnce(makeMcpHandoffJson(['D0'], ['src/a.ts'], []))
                    .mockResolvedValueOnce(makeMcpHandoffJson(['D1'], ['src/b.ts'], ['blocker-1'])),
            } as unknown as import('../../mcp/MCPClientBridge.js').MCPClientBridge;

            const runbook = makeRunbookWithMcpIds();
            const report = await agent.generateReport(tmpDir, runbook, mockBridge, MASTER_TASK_ID);

            // Verify correct URIs were called
            expect(mockBridge.readResource).toHaveBeenCalledTimes(2);
            expect(mockBridge.readResource).toHaveBeenCalledWith(
                `coogent://tasks/${MASTER_TASK_ID}/phases/${MCP_PHASE_0}/handoff`,
            );
            expect(mockBridge.readResource).toHaveBeenCalledWith(
                `coogent://tasks/${MASTER_TASK_ID}/phases/${MCP_PHASE_1}/handoff`,
            );

            // Verify report aggregation
            expect(report.successfulPhases).toBe(2);
            expect(report.allDecisions).toEqual(['D0', 'D1']);
            expect(report.allModifiedFiles).toEqual(expect.arrayContaining(['src/a.ts', 'src/b.ts']));
            expect(report.unresolvedIssues).toEqual(['blocker-1']);
        });

        it('should skip phases without mcpPhaseId (Sprint 4: no file fallback)', async () => {
            // Phases without mcpPhaseId are skipped — no file fallback
            const runbook: import('../../types/index.js').Runbook = {
                project_id: 'no-mcp-test',
                status: 'completed',
                current_phase: 0,
                phases: [
                    { id: asPhaseId(0), status: 'completed', prompt: 'P0', context_files: [], success_criteria: 'exit_code:0' },
                    { id: asPhaseId(1), status: 'completed', prompt: 'P1', context_files: [], success_criteria: 'exit_code:0' },
                ],
            };

            const mockBridge = {
                readResource: jest.fn(),
            } as unknown as import('../../mcp/MCPClientBridge.js').MCPClientBridge;

            const report = await agent.generateReport(tmpDir, runbook, mockBridge, MASTER_TASK_ID);

            // MCP bridge should NOT have been called (no mcpPhaseId)
            expect(mockBridge.readResource).not.toHaveBeenCalled();
            // Sprint 4: no file fallback — both phases should be skipped
            expect(report.skippedPhases).toBe(2);
            expect(report.successfulPhases).toBe(0);
        });

        it('should skip phase when MCP read fails (Sprint 4: no file fallback)', async () => {
            const mockBridge = {
                readResource: jest.fn().mockRejectedValue(new Error('MCP error -32603')),
            } as unknown as import('../../mcp/MCPClientBridge.js').MCPClientBridge;

            const runbook = makeRunbookWithMcpIds();
            const report = await agent.generateReport(tmpDir, runbook, mockBridge, MASTER_TASK_ID);

            // Sprint 4: no file fallback — failed MCP reads skip the phase
            expect(report.skippedPhases).toBe(2);
            expect(report.successfulPhases).toBe(0);
        });
    });

    // ─── End-to-end integration ─────────────────────────────────────────

    describe('end-to-end', () => {
        it('should generate, format, and submit a complete report via MCP', async () => {
            const runbook = makeRunbook();
            const readBridge = makeDefaultMcpBridge(
                makeHandoff(0, {
                    decisions: ['Created base module'],
                    modified_files: ['src/base.ts'],
                    unresolved_issues: ['Needs documentation'],
                }),
                makeHandoff(1, {
                    decisions: ['Added tests'],
                    modified_files: ['src/base.test.ts'],
                    unresolved_issues: [],
                }),
            );
            // Add submitConsolidationReport to the bridge for saveReport
            (readBridge as any).submitConsolidationReport = jest.fn().mockResolvedValue(undefined);

            const report = await agent.generateReport(tmpDir, runbook, readBridge, DEFAULT_MASTER_TASK_ID);
            await agent.saveReport(tmpDir, report, readBridge, 'e2e-master-task');

            expect((readBridge as any).submitConsolidationReport).toHaveBeenCalledTimes(1);
            const submittedMarkdown = ((readBridge as any).submitConsolidationReport as jest.Mock).mock.calls[0][1] as string;
            expect(submittedMarkdown).toContain('Created base module');
            expect(submittedMarkdown).toContain('Added tests');
            expect(submittedMarkdown).toContain('+ src/base.ts');
            expect(submittedMarkdown).toContain('+ src/base.test.ts');
            expect(submittedMarkdown).toContain('Needs documentation');
            expect(submittedMarkdown).toContain('| **Successful** | 2 |');
        });
    });
});
