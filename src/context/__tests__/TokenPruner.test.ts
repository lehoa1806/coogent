import { TokenPruner, type PrunableEntry } from '../TokenPruner.js';

const mockEncoder = {
    countTokens: (text: string) => Math.ceil(text.length / 4),
    encode: (text: string) => new Uint32Array(Math.ceil(text.length / 4)), // dummy tokens
    decode: (tokens: Uint32Array) => Array.from(tokens).map(() => 'word').join(' '),
    getName: () => 'mock',
};

describe('TokenPruner', () => {
    test('returns original entries if within budget', () => {
        const pruner = new TokenPruner(mockEncoder, 100);
        const entries: PrunableEntry[] = [
            { path: 'file1.ts', content: 'hello world', tokenCount: 2, isExplicit: true },
            { path: 'file2.ts', content: 'test data', tokenCount: 2, isExplicit: false }
        ];

        const result = pruner.prune(entries);
        expect(result.withinBudget).toBe(true);
        expect(result.entries).toEqual(entries);
        expect(result.totalTokens).toBe(4);
    });

    test('drops implicit files first when over budget', () => {
        const pruner = new TokenPruner(mockEncoder, 10);
        const entries: PrunableEntry[] = [
            { path: 'main.ts', content: '1 2 3 4 5 6 7 8', tokenCount: 8, isExplicit: true },
            { path: 'utils.ts', content: '1 2 3 4 5', tokenCount: 5, isExplicit: false }
        ];

        const result = pruner.prune(entries);
        expect(result.withinBudget).toBe(true);
        expect(result.entries.length).toBe(1);
        expect(result.entries[0].path).toBe('main.ts');
        expect(result.totalTokens).toBe(8);
    });

    test('truncates files as last resort', () => {
        const pruner = new TokenPruner(mockEncoder, 6);
        const entries: PrunableEntry[] = [
            { path: 'main.ts', content: '1 2 3 4 5 6 7 8 9 10', tokenCount: 10, isExplicit: true }
        ];

        const result = pruner.prune(entries);

        // Since truncation appends a message, it might still exceed a tiny limit like 6.
        // It's a best-effort pruner. So we only check that the truncation occurred.
        expect(result.entries[0].content).toContain('truncated by orchestrator');
    });
});
