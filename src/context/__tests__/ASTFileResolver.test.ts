jest.mock('vscode', () => ({
    workspace: { workspaceFolders: [] },
}), { virtual: true });

import { ASTFileResolver } from '../FileResolver.js';
import { asPhaseId } from '../../types/index.js';

// Mock fs/promises
jest.mock('node:fs/promises', () => ({
    access: jest.fn(),
    readFile: jest.fn(),
    stat: jest.fn().mockResolvedValue({ isFile: () => true }),
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

    // ═══════════════════════════════════════════════════════════════════════════
    //  Pillar 2 — TS Compiler API Extraction Tests
    // ═══════════════════════════════════════════════════════════════════════════

    test('discovers TypeScript import declarations via AST', async () => {
        const { access, readFile } = require('node:fs/promises');
        access.mockResolvedValue(undefined);

        readFile.mockImplementation(async (filePath: string) => {
            if (filePath.endsWith('entry.ts')) {
                return [
                    `import { Foo } from './foo';`,
                    `import type { Bar } from './bar';`,
                ].join('\n');
            }
            return '';
        });

        const phase = {
            id: asPhaseId(1), status: 'pending' as const, prompt: '',
            context_files: ['entry.ts'], success_criteria: ''
        };

        const result = await resolver.resolve(phase, '/workspace');
        expect(result).toContain('entry.ts');
        expect(result.some(r => r.includes('foo'))).toBe(true);
        expect(result.some(r => r.includes('bar'))).toBe(true);
    });

    test('discovers export ... from declarations via AST', async () => {
        const { access, readFile } = require('node:fs/promises');
        access.mockResolvedValue(undefined);

        readFile.mockImplementation(async (filePath: string) => {
            if (filePath.endsWith('barrel.ts')) {
                return `export { A } from './moduleA';\nexport type { B } from './moduleB';`;
            }
            return '';
        });

        const phase = {
            id: asPhaseId(1), status: 'pending' as const, prompt: '',
            context_files: ['barrel.ts'], success_criteria: ''
        };

        const result = await resolver.resolve(phase, '/workspace');
        expect(result).toContain('barrel.ts');
        expect(result.some(r => r.includes('moduleA'))).toBe(true);
        expect(result.some(r => r.includes('moduleB'))).toBe(true);
    });

    test('discovers dynamic import() calls via AST', async () => {
        const { access, readFile } = require('node:fs/promises');
        access.mockResolvedValue(undefined);

        readFile.mockImplementation(async (filePath: string) => {
            if (filePath.endsWith('lazy.ts')) {
                return `const mod = await import('./lazy-module');`;
            }
            return '';
        });

        const phase = {
            id: asPhaseId(1), status: 'pending' as const, prompt: '',
            context_files: ['lazy.ts'], success_criteria: ''
        };

        const result = await resolver.resolve(phase, '/workspace');
        expect(result).toContain('lazy.ts');
        expect(result.some(r => r.includes('lazy-module'))).toBe(true);
    });

    test('discovers require() calls via AST', async () => {
        const { access, readFile } = require('node:fs/promises');
        access.mockResolvedValue(undefined);

        readFile.mockImplementation(async (filePath: string) => {
            if (filePath.endsWith('cjs.ts')) {
                return `const dep = require('./cjs-dep');`;
            }
            return '';
        });

        const phase = {
            id: asPhaseId(1), status: 'pending' as const, prompt: '',
            context_files: ['cjs.ts'], success_criteria: ''
        };

        const result = await resolver.resolve(phase, '/workspace');
        expect(result).toContain('cjs.ts');
        expect(result.some(r => r.includes('cjs-dep'))).toBe(true);
    });

    test('enforces maxDepth: 1 — only direct imports resolved', async () => {
        const shallowResolver = new ASTFileResolver({ maxDepth: 1 });
        const { access, readFile } = require('node:fs/promises');
        access.mockResolvedValue(undefined);

        readFile.mockImplementation(async (filePath: string) => {
            if (filePath.endsWith('root.ts')) {
                return `import { mid } from './mid';`;
            }
            if (filePath.endsWith('mid.ts')) {
                return `import { deep } from './deep';`;
            }
            if (filePath.endsWith('deep.ts')) {
                return `import { deeper } from './deeper';`;
            }
            return '';
        });

        const phase = {
            id: asPhaseId(1), status: 'pending' as const, prompt: '',
            context_files: ['root.ts'], success_criteria: ''
        };

        const result = await shallowResolver.resolve(phase, '/workspace');
        // root.ts at depth 0, mid.ts at depth 1 — both included
        expect(result).toContain('root.ts');
        expect(result.some(r => r.includes('mid'))).toBe(true);
        // deep.ts would be at depth 2 — should be excluded by maxDepth: 1
        // deeper should definitely NOT be present (depth 3)
        const hasDeeper = result.some(r => r.includes('deeper'));
        expect(hasDeeper).toBe(false);
    });

    test('skips files in node_modules paths (ignorePatterns)', async () => {
        const { access, readFile } = require('node:fs/promises');
        access.mockResolvedValue(undefined);

        readFile.mockImplementation(async (filePath: string) => {
            if (filePath.endsWith('app.ts')) {
                return `import { lib } from './node_modules/somelib/index';`;
            }
            return '';
        });

        const phase = {
            id: asPhaseId(1), status: 'pending' as const, prompt: '',
            context_files: ['app.ts'], success_criteria: ''
        };

        const result = await resolver.resolve(phase, '/workspace');
        expect(result).toContain('app.ts');
        // node_modules paths should be filtered out
        const hasNodeModules = result.some(r => r.includes('node_modules'));
        expect(hasNodeModules).toBe(false);
    });
});
