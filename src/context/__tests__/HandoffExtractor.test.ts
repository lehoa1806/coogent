// ─────────────────────────────────────────────────────────────────────────────
// src/context/__tests__/HandoffExtractor.test.ts — Unit tests for HandoffExtractor
// ─────────────────────────────────────────────────────────────────────────────

// Jest globals (describe, it, expect, etc.) are provided automatically
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { HandoffExtractor, type HandoffReport } from '../HandoffExtractor.js';
import type { Phase } from '../../types/index.js';
import { asPhaseId } from '../../types/index.js';

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
        it('should include the phase ID in the prompt', () => {
            const prompt = extractor.generateDistillationPrompt(3);
            expect(prompt).toContain('Phase 3');
        });

        it('should reference all four required JSON keys', () => {
            const prompt = extractor.generateDistillationPrompt(1);
            expect(prompt).toContain('decisions');
            expect(prompt).toContain('modified_files');
            expect(prompt).toContain('unresolved_issues');
            expect(prompt).toContain('next_steps_context');
        });

        it('should include a JSON code fence', () => {
            const prompt = extractor.generateDistillationPrompt(1);
            expect(prompt).toContain('```json');
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

            const report = await extractor.extractHandoff(1, workerOutput, tmpDir);

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

            const report = await extractor.extractHandoff(2, workerOutput, tmpDir);
            expect(report.decisions).toEqual(['second']);
            expect(report.next_steps_context).toBe('final');
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

            const report = await extractor.extractHandoff(10, workerOutput, tmpDir);

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
            const report = await extractor.extractHandoff(5, workerOutput, tmpDir);

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
            const report = await extractor.extractHandoff(6, workerOutput, tmpDir);

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

            const report = await extractor.extractHandoff(7, workerOutput, tmpDir);
            expect(report.modified_files).toEqual(['does/not/exist.ts']);
            // file_contents removed (CF-1 Pull Model): workers now fetch via MCP
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    //  saveHandoff / loadHandoff
    // ═════════════════════════════════════════════════════════════════════════

    describe('saveHandoff / loadHandoff', () => {
        const sampleReport: HandoffReport = {
            phaseId: 1,
            decisions: ['Decision A'],
            modified_files: ['src/a.ts'],
            unresolved_issues: [],
            next_steps_context: 'Context for next phase',
            timestamp: 1700000000000,
        };

        it('should save and load a handoff report round-trip', async () => {
            await extractor.saveHandoff(1, sampleReport, tmpDir);

            // Verify file was created
            const filePath = path.join(tmpDir, 'handoffs', 'phase-1.json');
            const raw = await fs.readFile(filePath, 'utf-8');
            const parsed = JSON.parse(raw);
            expect(parsed.phaseId).toBe(1);

            // Load
            const loaded = await extractor.loadHandoff(1, tmpDir);
            expect(loaded).toEqual(sampleReport);
        });

        it('should return null for a non-existent handoff', async () => {
            const loaded = await extractor.loadHandoff(999, tmpDir);
            expect(loaded).toBeNull();
        });

        it('should create the handoffs directory automatically', async () => {
            await extractor.saveHandoff(2, { ...sampleReport, phaseId: 2 }, tmpDir);
            const dirPath = path.join(tmpDir, 'handoffs');
            const stat = await fs.stat(dirPath);
            expect(stat.isDirectory()).toBe(true);
        });
    });

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

            const ctx = await extractor.buildNextContext(phase, tmpDir, tmpDir);
            expect(ctx).toBe('');
        });

        it('should build context from dependent phases', async () => {
            // Create a workspace file
            const testFile = path.join(tmpDir, 'src', 'bar.ts');
            await fs.mkdir(path.dirname(testFile), { recursive: true });
            await fs.writeFile(testFile, 'export const bar = true;', 'utf-8');

            // Save handoff for phase 1
            const report1: HandoffReport = {
                phaseId: 1,
                decisions: ['Chose TypeScript'],
                modified_files: ['src/bar.ts'],
                unresolved_issues: ['Need tests'],
                next_steps_context: 'Bar module ready',
                timestamp: 1700000000000,
            };
            await extractor.saveHandoff(1, report1, tmpDir);

            // Save handoff for phase 2
            const report2: HandoffReport = {
                phaseId: 2,
                decisions: ['Added validation'],
                modified_files: [],
                unresolved_issues: [],
                next_steps_context: 'Validation done',
                timestamp: 1700000001000,
            };
            await extractor.saveHandoff(2, report2, tmpDir);

            const phase: Phase = {
                id: asPhaseId(3),
                status: 'pending',
                prompt: 'Test',
                context_files: [],
                success_criteria: 'exit_code:0',
                depends_on: [asPhaseId(1), asPhaseId(2)],
            };

            const ctx = await extractor.buildNextContext(phase, tmpDir, tmpDir);

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

            const ctx = await extractor.buildNextContext(phase, tmpDir, tmpDir);
            expect(ctx).toContain('Phase 99 Handoff');
            expect(ctx).toContain('No handoff report found');
        });
    });
});
