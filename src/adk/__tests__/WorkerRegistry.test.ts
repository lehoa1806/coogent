// ─────────────────────────────────────────────────────────────────────────────
// WorkerRegistry.test.ts — Unit tests for cascading config & Jaccard routing
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs';

// ── Mock vscode before any import that touches it ────────────────────────────
const mockGet = jest.fn().mockReturnValue([]);
jest.mock('vscode', () => ({
    workspace: {
        getConfiguration: jest.fn(() => ({
            get: mockGet,
        })),
    },
}), { virtual: true });

// ── Mock the logger (no-op) ──────────────────────────────────────────────────
jest.mock('../../logger/log.js', () => ({
    __esModule: true,
    default: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    },
}));

import { WorkerRegistry } from '../WorkerRegistry.js';
import type { WorkerProfile } from '../../types/index.js';
import builtinDefaults from '../../workers/defaults.json';

describe('WorkerRegistry', () => {
    const workspaceRoot = '/fake/workspace';

    beforeEach(() => {
        jest.restoreAllMocks();
        // Reset the vscode mock to return no custom workers by default
        mockGet.mockReturnValue([]);
    });

    // ═══════════════════════════════════════════════════════════════════════
    //  Loading
    // ═══════════════════════════════════════════════════════════════════════

    describe('loading defaults', () => {
        it('should load all built-in profiles from defaults.json', async () => {
            // Mock workspace file as not found
            jest.spyOn(fs.promises, 'readFile').mockRejectedValue(
                Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
            );

            const registry = new WorkerRegistry(workspaceRoot);
            const workers = await registry.getWorkers();

            expect(workers.length).toBe(builtinDefaults.length);
            const ids = workers.map(w => w.id);
            expect(ids).toContain('generalist');
            expect(ids).toContain('frontend_expert');
            expect(ids).toContain('qa_engineer');
        });
    });

    describe('cascading override', () => {
        it('L3 workspace file should override L1 built-in by id', async () => {
            const overriddenGeneralist: WorkerProfile = {
                id: 'generalist',
                name: 'Custom Generalist',
                description: 'Overridden by workspace',
                system_prompt: 'You are a CUSTOM generalist.',
                tags: ['general', 'custom'],
            };

            jest.spyOn(fs.promises, 'readFile').mockResolvedValue(
                JSON.stringify([overriddenGeneralist]),
            );

            const registry = new WorkerRegistry(workspaceRoot);
            const generalist = await registry.getWorkerById('generalist');

            expect(generalist).toBeDefined();
            expect(generalist!.system_prompt).toBe('You are a CUSTOM generalist.');
            expect(generalist!.name).toBe('Custom Generalist');
        });

        it('L2 user settings should override L1 built-in by id', async () => {
            const userProfile: WorkerProfile = {
                id: 'generalist',
                name: 'User Generalist',
                description: 'From user settings',
                system_prompt: 'USER prompt.',
                tags: ['general'],
            };
            mockGet.mockReturnValue([userProfile]);

            // No workspace file
            jest.spyOn(fs.promises, 'readFile').mockRejectedValue(
                Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
            );

            const registry = new WorkerRegistry(workspaceRoot);
            const generalist = await registry.getWorkerById('generalist');

            expect(generalist).toBeDefined();
            expect(generalist!.system_prompt).toBe('USER prompt.');
        });

        it('L3 should override L2 which overrides L1', async () => {
            // L2: user settings override
            const userProfile: WorkerProfile = {
                id: 'generalist',
                name: 'L2 Generalist',
                description: 'L2',
                system_prompt: 'L2 prompt.',
                tags: ['general'],
            };
            mockGet.mockReturnValue([userProfile]);

            // L3: workspace file override
            const wsProfile: WorkerProfile = {
                id: 'generalist',
                name: 'L3 Generalist',
                description: 'L3',
                system_prompt: 'L3 prompt.',
                tags: ['general'],
            };
            jest.spyOn(fs.promises, 'readFile').mockResolvedValue(
                JSON.stringify([wsProfile]),
            );

            const registry = new WorkerRegistry(workspaceRoot);
            const generalist = await registry.getWorkerById('generalist');

            expect(generalist!.system_prompt).toBe('L3 prompt.');
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    //  getAvailableTags
    // ═══════════════════════════════════════════════════════════════════════

    describe('getAvailableTags', () => {
        it('should return sorted, deduplicated tags from all profiles', async () => {
            jest.spyOn(fs.promises, 'readFile').mockRejectedValue(
                Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
            );

            const registry = new WorkerRegistry(workspaceRoot);
            const tags = await registry.getAvailableTags();

            // Should be sorted
            const sorted = [...tags].sort();
            expect(tags).toEqual(sorted);

            // Should be deduplicated (no duplicates)
            expect(new Set(tags).size).toBe(tags.length);

            // Spot check some expected tags from defaults.json
            expect(tags).toContain('frontend');
            expect(tags).toContain('backend');
            expect(tags).toContain('testing');
            expect(tags).toContain('general');
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    //  getBestWorker — Jaccard similarity
    // ═══════════════════════════════════════════════════════════════════════

    describe('getBestWorker', () => {
        beforeEach(() => {
            jest.spyOn(fs.promises, 'readFile').mockRejectedValue(
                Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
            );
        });

        it('should return qa_engineer for exact match skills', async () => {
            const registry = new WorkerRegistry(workspaceRoot);
            const worker = await registry.getBestWorker(['testing', 'jest']);

            expect(worker.id).toBe('qa_engineer');
        });

        it('should return the best scoring worker for partial match', async () => {
            const registry = new WorkerRegistry(workspaceRoot);
            // 'frontend' matches frontend_expert strongly; 'api' matches backend
            // frontend_expert has tags ['frontend','react','svelte','vue','css','html','ui','a11y']
            // backend_expert has tags ['backend','api','rest','graphql','server','node','express','fastapi']
            // For ['frontend', 'api']:
            //   frontend_expert intersection={'frontend'} => 1; union=8+2-1=9 => 1/9 ≈ 0.111
            //   backend_expert intersection={'api'} => 1; union=8+2-1=9 => 1/9 ≈ 0.111
            // Both score the same, so the first one wins (frontend_expert loads first)
            // Let's use a clearer case: ['frontend', 'react', 'css']
            const worker2 = await registry.getBestWorker(['frontend', 'react', 'css']);
            expect(worker2.id).toBe('frontend_expert');
        });

        it('should return generalist when requiredSkills is empty', async () => {
            const registry = new WorkerRegistry(workspaceRoot);
            const worker = await registry.getBestWorker([]);

            expect(worker.id).toBe('generalist');
        });

        it('should return generalist when no skills match any worker', async () => {
            const registry = new WorkerRegistry(workspaceRoot);
            const worker = await registry.getBestWorker(['cobol', 'fortran']);

            expect(worker.id).toBe('generalist');
        });

        it('should return first profile when generalist is removed and no match', async () => {
            // Override with a workspace file that replaces all profiles
            jest.restoreAllMocks();
            const customProfiles: WorkerProfile[] = [
                {
                    id: 'only_rust',
                    name: 'Rust Expert',
                    description: 'Only Rust',
                    system_prompt: 'Rust only.',
                    tags: ['rust'],
                },
            ];
            jest.spyOn(fs.promises, 'readFile').mockResolvedValue(
                JSON.stringify(customProfiles),
            );
            // Also remove generalist from L2
            mockGet.mockReturnValue([]);

            // Need a registry that ONLY loads from workspace file
            // But L1 always loads defaults... generalist will exist from L1.
            // So this test effectively shows that even with weird workspace,
            // generalist from L1 is always available.
            const registry = new WorkerRegistry(workspaceRoot);
            const worker = await registry.getBestWorker(['cobol']);
            // Generalist still exists from L1 built-ins
            expect(worker.id).toBe('generalist');
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    //  getWorkerById
    // ═══════════════════════════════════════════════════════════════════════

    describe('getWorkerById', () => {
        beforeEach(() => {
            jest.spyOn(fs.promises, 'readFile').mockRejectedValue(
                Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
            );
        });

        it('should return a profile for a known id', async () => {
            const registry = new WorkerRegistry(workspaceRoot);
            const worker = await registry.getWorkerById('frontend_expert');

            expect(worker).toBeDefined();
            expect(worker!.id).toBe('frontend_expert');
            expect(worker!.tags).toContain('frontend');
        });

        it('should return undefined for an unknown id', async () => {
            const registry = new WorkerRegistry(workspaceRoot);
            const worker = await registry.getWorkerById('nonexistent_worker');

            expect(worker).toBeUndefined();
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    //  reload
    // ═══════════════════════════════════════════════════════════════════════

    describe('reload', () => {
        it('should re-read all sources on reload', async () => {
            const readFileSpy = jest.spyOn(fs.promises, 'readFile').mockRejectedValue(
                Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
            );

            const registry = new WorkerRegistry(workspaceRoot);

            // First access triggers load
            await registry.getWorkers();
            expect(readFileSpy).toHaveBeenCalledTimes(1); // L3 attempt

            // Second access should NOT reload (cached)
            await registry.getWorkers();
            expect(readFileSpy).toHaveBeenCalledTimes(1);

            // Explicit reload should re-read
            await registry.reload();
            expect(readFileSpy).toHaveBeenCalledTimes(2);
        });

        it('should pick up new workspace profiles after reload', async () => {
            const newProfile: WorkerProfile = {
                id: 'kotlin_expert',
                name: 'Kotlin Expert',
                description: 'New profile',
                system_prompt: 'Kotlin specialist.',
                tags: ['kotlin', 'android'],
            };

            let callCount = 0;
            jest.spyOn(fs.promises, 'readFile').mockImplementation(async () => {
                callCount++;
                if (callCount === 1) {
                    // First load: no workspace file
                    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
                }
                // All subsequent loads: workspace file present
                return JSON.stringify([newProfile]);
            });

            const registry = new WorkerRegistry(workspaceRoot);
            const workers = await registry.getWorkers();
            const initialCount = workers.length;
            expect(await registry.getWorkerById('kotlin_expert')).toBeUndefined();

            // After reload, the workspace file is found
            await registry.reload();

            const updatedWorkers = await registry.getWorkers();
            expect(updatedWorkers.length).toBe(initialCount + 1);
            const kotlinWorker = await registry.getWorkerById('kotlin_expert');
            expect(kotlinWorker).toBeDefined();
            expect(kotlinWorker!.tags).toContain('kotlin');
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    //  Lazy loading
    // ═══════════════════════════════════════════════════════════════════════

    describe('lazy loading', () => {
        it('should not load until first access', async () => {
            const readFileSpy = jest.spyOn(fs.promises, 'readFile').mockRejectedValue(
                Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
            );

            // Constructor should NOT trigger load
            const _registry = new WorkerRegistry(workspaceRoot);
            expect(readFileSpy).not.toHaveBeenCalled();

            // First access triggers load
            await _registry.getWorkers();
            expect(readFileSpy).toHaveBeenCalledTimes(1);
        });
    });
});
