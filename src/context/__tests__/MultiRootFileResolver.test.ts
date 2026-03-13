jest.mock('vscode', () => ({
    workspace: { workspaceFolders: [] },
}), { virtual: true });

import { ExplicitFileResolver, ASTFileResolver } from '../FileResolver.js';
import { asPhaseId } from '../../types/index.js';

// Mock fs/promises (same pattern as ASTFileResolver.test.ts)
jest.mock('node:fs/promises', () => ({
    access: jest.fn(),
    readFile: jest.fn(),
    stat: jest.fn().mockResolvedValue({ isFile: () => true }),
}));

jest.mock('node:fs', () => ({
    existsSync: jest.fn(),
}));

describe('MultiRootFileResolver', () => {
    // ═══════════════════════════════════════════════════════════════════════════
    //  ExplicitFileResolver.resolveMultiRoot
    // ═══════════════════════════════════════════════════════════════════════════

    describe('ExplicitFileResolver.resolveMultiRoot', () => {
        let resolver: ExplicitFileResolver;

        beforeEach(() => {
            resolver = new ExplicitFileResolver();
            jest.clearAllMocks();
        });

        test('absolute paths pass through unchanged', async () => {
            const { existsSync } = require('node:fs');
            existsSync.mockReturnValue(false);

            const phase = {
                id: asPhaseId(1),
                status: 'pending' as const,
                prompt: '',
                context_files: ['/absolute/path/file.ts', '/another/absolute.ts'],
                success_criteria: '',
            };

            const result = await resolver.resolveMultiRoot(phase, ['/root-a', '/root-b']);

            expect(result).toEqual(['/absolute/path/file.ts', '/another/absolute.ts']);
        });

        test('relative path found in one root → resolved', async () => {
            const { existsSync } = require('node:fs');

            // 'src/index.ts' exists only in /root-b
            existsSync.mockImplementation((p: string) => {
                return p === '/root-b/src/index.ts';
            });

            const phase = {
                id: asPhaseId(1),
                status: 'pending' as const,
                prompt: '',
                context_files: ['src/index.ts'],
                success_criteria: '',
            };

            const result = await resolver.resolveMultiRoot(phase, ['/root-a', '/root-b']);

            // Should resolve to the relative path from the matched root
            expect(result).toEqual(['src/index.ts']);
        });

        test('relative path not found in any root → passed through unchanged', async () => {
            const { existsSync } = require('node:fs');
            existsSync.mockReturnValue(false);

            const phase = {
                id: asPhaseId(1),
                status: 'pending' as const,
                prompt: '',
                context_files: ['missing/file.ts'],
                success_criteria: '',
            };

            const result = await resolver.resolveMultiRoot(phase, ['/root-a', '/root-b']);

            // Not found → pass through (worker will fail gracefully)
            expect(result).toEqual(['missing/file.ts']);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════════
    //  ASTFileResolver.resolveMultiRoot
    // ═══════════════════════════════════════════════════════════════════════════

    describe('ASTFileResolver.resolveMultiRoot', () => {
        let resolver: ASTFileResolver;

        beforeEach(() => {
            resolver = new ASTFileResolver({ maxDepth: 2 });
            jest.clearAllMocks();
        });

        test('basic multi-root resolve with imports', async () => {
            const { access, readFile } = require('node:fs/promises');
            const { existsSync } = require('node:fs');

            access.mockResolvedValue(undefined);

            // 'src/app.ts' exists in /root-a
            existsSync.mockImplementation((p: string) => {
                return p === '/root-a/src/app.ts';
            });

            readFile.mockImplementation(async (filePath: string) => {
                if (filePath === '/root-a/tsconfig.json') {
                    throw new Error('ENOENT'); // No tsconfig
                }
                if (filePath.endsWith('app.ts')) {
                    return `import { helper } from './helper';`;
                }
                return '';
            });

            const phase = {
                id: asPhaseId(1),
                status: 'pending' as const,
                prompt: '',
                context_files: ['src/app.ts'],
                success_criteria: '',
            };

            const result = await resolver.resolveMultiRoot(phase, ['/root-a']);

            // Should include the entry file
            expect(result).toContain('src/app.ts');
            // Should discover imports from the entry file
            expect(result.some(r => r.includes('helper'))).toBe(true);
        });
    });
});
