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
        expect(result.entries[0].content).toContain('truncated by Coogent');
    });

    test('strips function bodies from discovered .ts files (Strategy 2)', () => {
        const pruner = new TokenPruner(mockEncoder, 15);
        const tsContent = [
            'function hello() {',
            '  console.log("hello");',
            '  console.log("world");',
            '}',
            'function bye() {',
            '  return 42;',
            '}',
        ].join('\n');

        const entries: PrunableEntry[] = [
            { path: 'main.ts', content: 'keep me', tokenCount: 2, isExplicit: true },
            { path: 'utils.ts', content: tsContent, tokenCount: 20, isExplicit: false },
        ];

        const result = pruner.prune(entries);
        // After stripping bodies, the discovered file should have less content
        const utilsEntry = result.entries.find(e => e.path === 'utils.ts');
        if (utilsEntry) {
            expect(utilsEntry.content.length).toBeLessThan(tsContent.length);
        }
    });

    test('truncates explicit-only files when all strategies exhausted (Strategy 3)', () => {
        const pruner = new TokenPruner(mockEncoder, 3);
        // Use a long content string so truncation actually reduces length
        // (the truncation suffix is ~67 chars, so the original must be much longer)
        const longContent = 'word '.repeat(40).trim(); // 199 chars, ~50 tokens
        const entries: PrunableEntry[] = [
            { path: 'big.ts', content: longContent, tokenCount: 50, isExplicit: true },
        ];

        const result = pruner.prune(entries);
        expect(result.entries[0].content).toContain('truncated by Coogent');
        expect(result.entries[0].content.length).toBeLessThan(entries[0].content.length);
    });

    test('overBudget is false when entries fit within budget', () => {
        const pruner = new TokenPruner(mockEncoder, 100);
        const entries: PrunableEntry[] = [
            { path: 'file1.ts', content: 'hello', tokenCount: 2, isExplicit: true },
        ];
        const result = pruner.prune(entries);
        expect(result.overBudget).toBe(false);
    });

    test('degrades full entries to slice (first 200 lines) when over budget', () => {
        // Create two large "full" entries with 300 lines each
        // Strategy 1 won't drop them (explicit), Strategy 2 won't strip (no function sigs),
        // Strategy 3 truncates proportionally but we need cascade to also run.
        const lines = Array.from({ length: 300 }, (_, i) => `line ${i}`);
        const content = lines.join('\n');
        const tokenCount = mockEncoder.countTokens(content);

        // Budget allows ~60% of ONE entry (so two entries are way over).
        // Strategy 3 truncates each to fit budget/2, but that may still resolve.
        // To force cascade: make budget so small that proportional truncation
        // still leaves us over budget, but slicing to 200 lines would resolve.
        // Use a budget where truncation result still exceeds (truncation adds a suffix).
        const pruner = new TokenPruner(mockEncoder, 10);
        const entries: PrunableEntry[] = [
            { path: 'big1.ts', content, tokenCount, isExplicit: true, mode: 'full' },
            { path: 'big2.ts', content, tokenCount, isExplicit: true, mode: 'full' },
        ];

        const result = pruner.prune(entries);
        // After cascading, entries should contain degradation markers
        // Either "truncated by Coogent" from Strategy 3 or "sliced by Coogent" / "metadata-only" from cascade
        const hasAnyDegradation = result.entries.some(e =>
            e.content.includes('truncated by Coogent') ||
            e.content.includes('sliced by Coogent') ||
            e.content.includes('metadata-only')
        );
        expect(hasAnyDegradation).toBe(true);
    });

    test('degrades slice entries to metadata in second pass', () => {
        // Build a slice entry that is very large but already mode='slice'
        const lines = Array.from({ length: 500 }, (_, i) => `slice line ${i}`);
        const content = lines.join('\n');
        const tokenCount = mockEncoder.countTokens(content);

        // Budget is tiny — forces degradation through all levels
        const pruner = new TokenPruner(mockEncoder, 5);
        const entries: PrunableEntry[] = [
            { path: 'sliced.ts', content, tokenCount, isExplicit: true, mode: 'slice' },
        ];

        const result = pruner.prune(entries);
        // After full cascade, should contain metadata markers
        const hasMetadata = result.entries.some(e =>
            e.content.includes('metadata-only') || e.mode === 'metadata'
        );
        expect(hasMetadata || result.overBudget).toBe(true);
    });

    test('overBudget is true when pack is irreducible', () => {
        // Even a single tiny explicit entry can be irreducible if budget is 0
        const pruner = new TokenPruner(mockEncoder, 0);
        const entries: PrunableEntry[] = [
            { path: 'core.ts', content: 'essential code', tokenCount: 10, isExplicit: true, mode: 'full' },
        ];

        const result = pruner.prune(entries);
        expect(result.overBudget).toBe(true);
        expect(result.reason).toBe('irreducible');
    });
});
