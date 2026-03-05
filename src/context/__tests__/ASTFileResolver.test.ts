import { ASTFileResolver } from '../FileResolver.js';
import { asPhaseId } from '../../types/index.js';

// Mock fs/promises
jest.mock('node:fs/promises', () => ({
    access: jest.fn(),
    readFile: jest.fn(),
}));

jest.mock('node:fs', () => ({
    existsSync: jest.fn(),
}));

describe('ASTFileResolver', () => {
    let resolver: ASTFileResolver;

    beforeEach(() => {
        resolver = new ASTFileResolver({ maxDepth: 2 });
        jest.clearAllMocks();
    });

    test('resolves explicit files when no imports exist', async () => {
        const { access, readFile } = require('node:fs/promises');
        access.mockResolvedValue(undefined);
        readFile.mockResolvedValue('const a = 1;');

        const phase = {
            id: asPhaseId(1), status: 'pending' as const, prompt: '', context_files: ['index.ts'], success_criteria: ''
        };

        const result = await resolver.resolve(phase, '/workspace');
        expect(result).toEqual(['index.ts']);
    });

    test('discovers relative imports recursively', async () => {
        const { access, readFile } = require('node:fs/promises');
        const { existsSync } = require('node:fs');

        access.mockResolvedValue(undefined);
        existsSync.mockReturnValue(true);

        readFile.mockImplementation(async (filePath: string) => {
            if (filePath.endsWith('index.ts')) {
                return `import { helper } from './utils';\nexport * from './types';`;
            }
            return '';
        });

        const phase = {
            id: asPhaseId(1), status: 'pending' as const, prompt: '', context_files: ['index.ts'], success_criteria: ''
        };

        const result = await resolver.resolve(phase, '/workspace');
        expect(result.length).toBeGreaterThan(1);
        expect(result).toContain('index.ts');
        expect(result.some(r => r.includes('utils'))).toBe(true);
        expect(result.some(r => r.includes('types'))).toBe(true);
    });

    test('handles circular imports without infinite recursion', async () => {
        const { access, readFile } = require('node:fs/promises');

        access.mockResolvedValue(undefined);

        // A imports B, B imports A — cycle
        readFile.mockImplementation(async (filePath: string) => {
            if (filePath.endsWith('a.ts')) {
                return `import { bar } from './b';`;
            }
            if (filePath.endsWith('b.ts')) {
                return `import { foo } from './a';`;
            }
            return '';
        });

        const phase = {
            id: asPhaseId(1), status: 'pending' as const, prompt: '', context_files: ['a.ts'], success_criteria: ''
        };

        const result = await resolver.resolve(phase, '/workspace');

        // Should contain both files exactly once — no infinite loop
        expect(result).toContain('a.ts');
        const aCount = result.filter(r => r === 'a.ts').length;
        expect(aCount).toBe(1);
    });
});
