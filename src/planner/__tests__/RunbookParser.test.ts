jest.mock('vscode', () => ({
    commands: { registerCommand: jest.fn() },
    window: { showWarningMessage: jest.fn(), showErrorMessage: jest.fn(), showInformationMessage: jest.fn() },
    workspace: { workspaceFolders: [] },
    Uri: { file: jest.fn() },
}), { virtual: true });

import { RunbookParser } from '../RunbookParser.js';

describe('RunbookParser', () => {
    let parser: RunbookParser;

    const validRunbookObj = {
        project_id: 'test-project',
        status: 'idle',
        current_phase: 1,
        phases: [
            {
                id: 1,
                status: 'pending',
                prompt: 'Test phase 1',
                context_files: ['src/index.ts'],
                success_criteria: 'exit_code:0',
            },
        ],
    };

    const validRunbookJson = JSON.stringify(validRunbookObj);
    const validRunbookFenced = '```json\n' + validRunbookJson + '\n```';

    beforeEach(() => {
        parser = new RunbookParser();
    });

    // ═════════════════════════════════════════════════════════════════════
    //  Fenced JSON
    // ═════════════════════════════════════════════════════════════════════

    it('should parse a valid runbook from fenced JSON output', () => {
        const result = parser.parse(validRunbookFenced);
        expect(result).not.toBeNull();
        expect(result!.project_id).toBe('test-project');
        expect(result!.phases).toHaveLength(1);
        expect(result!.phases[0].prompt).toBe('Test phase 1');
    });

    it('should parse fenced JSON surrounded by other text', () => {
        const output = 'Here is the plan:\n\n' + validRunbookFenced + '\n\nDone.';
        const result = parser.parse(output);
        expect(result).not.toBeNull();
        expect(result!.project_id).toBe('test-project');
    });

    // ═════════════════════════════════════════════════════════════════════
    //  Raw JSON
    // ═════════════════════════════════════════════════════════════════════

    it('should return null for raw JSON with nested brackets (known #44 limitation)', () => {
        // The non-greedy regex (#44) cannot reliably match raw (unfenced) JSON
        // that contains nested arrays/objects. The fenced ```json path is the
        // reliable primary strategy. Raw JSON matching is best-effort.
        const rawJson = '{"project_id":"raw-test","phases":[{"id":1,"prompt":"Do X","context_files":["a.ts"],"success_criteria":"exit_code:0"}]}';
        const result = parser.parse(rawJson);
        // Returns null because the non-greedy regex can't handle nested brackets
        expect(result).toBeNull();
    });

    // ═════════════════════════════════════════════════════════════════════
    //  Invalid JSON
    // ═════════════════════════════════════════════════════════════════════

    it('should return null for empty output', () => {
        expect(parser.parse('')).toBeNull();
    });

    it('should return null for invalid JSON in fenced block', () => {
        expect(parser.parse('```json\n{invalid json}\n```')).toBeNull();
    });

    it('should return null for plain text without JSON', () => {
        expect(parser.parse('Hello world, this is just text')).toBeNull();
    });

    it('should return null when required fields are missing', () => {
        const noPhases = JSON.stringify({ project_id: 'test' });
        expect(parser.parse('```json\n' + noPhases + '\n```')).toBeNull();
    });

    it('should return null when phases array is empty', () => {
        const emptyPhases = JSON.stringify({ project_id: 'test', phases: [] });
        expect(parser.parse('```json\n' + emptyPhases + '\n```')).toBeNull();
    });

    it('should return null when a phase is missing required fields', () => {
        const missingPrompt = JSON.stringify({
            project_id: 'test',
            phases: [{ id: 1, context_files: [], success_criteria: 'exit_code:0' }],
        });
        expect(parser.parse('```json\n' + missingPrompt + '\n```')).toBeNull();
    });

    // ═════════════════════════════════════════════════════════════════════
    //  Duplicate IDs
    // ═════════════════════════════════════════════════════════════════════

    it('should return null for duplicate phase IDs', () => {
        const duplicate = JSON.stringify({
            project_id: 'test',
            phases: [
                { id: 1, prompt: 'A', context_files: [], success_criteria: 'exit_code:0' },
                { id: 1, prompt: 'B', context_files: [], success_criteria: 'exit_code:0' },
            ],
        });
        expect(parser.parse('```json\n' + duplicate + '\n```')).toBeNull();
    });

    // ═════════════════════════════════════════════════════════════════════
    //  depends_on validation
    // ═════════════════════════════════════════════════════════════════════

    it('should return null for invalid depends_on reference', () => {
        const badDep = JSON.stringify({
            project_id: 'test',
            phases: [
                { id: 1, prompt: 'A', context_files: [], success_criteria: 'exit_code:0' },
                { id: 2, prompt: 'B', context_files: [], success_criteria: 'exit_code:0', depends_on: [99] },
            ],
        });
        expect(parser.parse('```json\n' + badDep + '\n```')).toBeNull();
    });

    it('should parse valid depends_on references', () => {
        const goodDep = JSON.stringify({
            project_id: 'test',
            phases: [
                { id: 1, prompt: 'A', context_files: [], success_criteria: 'exit_code:0' },
                { id: 2, prompt: 'B', context_files: [], success_criteria: 'exit_code:0', depends_on: [1] },
            ],
        });
        const result = parser.parse('```json\n' + goodDep + '\n```');
        expect(result).not.toBeNull();
        expect(result!.phases).toHaveLength(2);
    });

    // ═════════════════════════════════════════════════════════════════════
    //  Multi-phase validation
    // ═════════════════════════════════════════════════════════════════════

    it('should parse multi-phase runbook with summary and implementation_plan', () => {
        const multi = JSON.stringify({
            project_id: 'multi-test',
            summary: 'A complex project',
            implementation_plan: '## Approach\nDo the thing.',
            phases: [
                { id: 1, prompt: 'P1', context_files: ['a.ts'], success_criteria: 'exit_code:0' },
                { id: 2, prompt: 'P2', context_files: ['b.ts'], success_criteria: 'exit_code:0', depends_on: [1], context_summary: 'Fix B' },
            ],
        });
        const result = parser.parse('```json\n' + multi + '\n```');
        expect(result).not.toBeNull();
        expect(result!.summary).toBe('A complex project');
        expect(result!.implementation_plan).toBe('## Approach\nDo the thing.');
        expect(result!.phases).toHaveLength(2);
        expect(result!.phases[1].context_summary).toBe('Fix B');
    });
});
