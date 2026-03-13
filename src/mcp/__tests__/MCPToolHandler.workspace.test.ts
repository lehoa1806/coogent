// ─────────────────────────────────────────────────────────────────────────────
// MCPToolHandler.workspace.test.ts — Regression tests for workspaceFolder
// sanitisation in get_file_slice and get_symbol_context.
// ─────────────────────────────────────────────────────────────────────────────

import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { MCPToolHandler } from '../MCPToolHandler.js';
import type { ArtifactDB } from '../ArtifactDB.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import log from '../../logger/log.js';

// ─── Mock node:fs/promises ───────────────────────────────────────────────────

jest.mock('node:fs/promises', () => ({
    readFile: jest.fn(),
    realpath: jest.fn(),
}));

import * as fs from 'node:fs/promises';

const mockReadFile = fs.readFile as jest.MockedFunction<typeof fs.readFile>;
const mockRealpath = fs.realpath as jest.MockedFunction<typeof fs.realpath>;

// ─── Mock logger ─────────────────────────────────────────────────────────────

jest.mock('../../logger/log.js', () => ({
    __esModule: true,
    default: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    },
}));

const mockLogWarn = log.warn as jest.MockedFunction<typeof log.warn>;

// ─── Test Fixtures ───────────────────────────────────────────────────────────

const WORKSPACE_ROOT = '/home/user/project';
const WORKSPACE_ROOT_B = '/home/user/other-project';
const SAMPLE_FILE_CONTENT = 'line1\nline2\nline3\nfunction foo() {}\nline5\n';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a minimal MCPToolHandler instance with mocked dependencies.
 * The Server mock captures setRequestHandler calls so we can invoke handlers directly.
 */
function createHandler(
    workspaceRoot: string = WORKSPACE_ROOT,
    allowedRoots?: string[],
) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handlers = new Map<string, (...args: any[]) => any>();
    const mockServer = {
        // Zod4 schema objects don't expose `.method` directly — extract it
        // from the Zod internal structure or fall back to stringified lookup.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        setRequestHandler: jest.fn((schema: any, handler: (...args: any[]) => any) => {
            // Try Zod4 path: def.shape.method.def.values[0]
            const method: string | undefined =
                schema?.method                                   // plain { method }
                ?? schema?.def?.shape?.method?.def?.values?.[0]  // Zod4 literal
                ?? schema?._def?.shape?.method?._def?.value;     // Zod3 literal
            if (method) {
                handlers.set(method, handler);
            }
        }),
    } as unknown as Server;

    const mockDB = {
        tasks: { get: jest.fn(), upsert: jest.fn() },
        phases: { upsertPlan: jest.fn() },
        handoffs: { upsert: jest.fn(), get: jest.fn() },
        reloadIfStale: jest.fn().mockResolvedValue(undefined),
    } as unknown as ArtifactDB;

    const emitter = new EventEmitter();

    const handler = new MCPToolHandler(mockServer, mockDB, workspaceRoot, emitter, allowedRoots);
    handler.register();

    /** Invoke the CallTool handler directly (bypasses transport layer). */
    async function callTool(name: string, args: Record<string, unknown>) {
        const callToolHandler = handlers.get('tools/call');
        if (!callToolHandler) { throw new Error('CallTool handler not registered'); }
        return callToolHandler({ params: { name, arguments: args } });
    }

    return { handler, callTool, mockDB, emitter };
}

/**
 * Configure fs mocks so that `realpath` resolves paths deterministically
 * and `readFile` returns sample content.
 */
function setupFsMocks(
    fileContent: string = SAMPLE_FILE_CONTENT,
) {
    mockRealpath.mockImplementation(async (p: any) => {
        // Resolve the path as-is (simulates a filesystem where every path exists)
        return path.resolve(String(p));
    });
    mockReadFile.mockResolvedValue(fileContent);
}

// ═════════════════════════════════════════════════════════════════════════════
//  get_file_slice — workspaceFolder validation
// ═════════════════════════════════════════════════════════════════════════════

describe('MCPToolHandler — get_file_slice workspaceFolder validation', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        setupFsMocks();
    });

    it('succeeds when workspaceFolder matches the constructor root', async () => {
        const { callTool } = createHandler();

        const result = await callTool('get_file_slice', {
            path: 'src/index.ts',
            startLine: 1,
            endLine: 3,
            workspaceFolder: WORKSPACE_ROOT,
        });

        expect(result.content).toHaveLength(1);
        expect(result.content[0].text).toBe('line1\nline2\nline3');
        expect(mockLogWarn).not.toHaveBeenCalled();
    });

    it('returns isError when workspaceFolder is /etc', async () => {
        const { callTool } = createHandler();

        const result = await callTool('get_file_slice', {
            path: 'passwd',
            startLine: 1,
            endLine: 1,
            workspaceFolder: '/etc',
        });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toBe('Access denied: workspaceFolder is not within the allowed workspace roots.');
    });

    it('returns isError when workspaceFolder is ../../', async () => {
        const { callTool } = createHandler();

        const result = await callTool('get_file_slice', {
            path: 'secrets.txt',
            startLine: 1,
            endLine: 1,
            workspaceFolder: '../../',
        });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toBe('Access denied: workspaceFolder is not within the allowed workspace roots.');
    });

    it('uses default workspaceRoot when workspaceFolder is omitted', async () => {
        const { callTool } = createHandler();

        const result = await callTool('get_file_slice', {
            path: 'src/index.ts',
            startLine: 1,
            endLine: 2,
        });

        expect(result.content).toHaveLength(1);
        expect(result.content[0].text).toBe('line1\nline2');
        expect(mockLogWarn).not.toHaveBeenCalled();
    });

    it('succeeds with a subdirectory of the allowed root', async () => {
        const { callTool } = createHandler();

        const result = await callTool('get_file_slice', {
            path: 'index.ts',
            startLine: 1,
            endLine: 1,
            workspaceFolder: path.join(WORKSPACE_ROOT, 'packages', 'core'),
        });

        expect(result.content).toHaveLength(1);
        expect(result.content[0].text).toBe('line1');
        expect(mockLogWarn).not.toHaveBeenCalled();
    });
});

// ═════════════════════════════════════════════════════════════════════════════
//  get_symbol_context — workspaceFolder validation
// ═════════════════════════════════════════════════════════════════════════════

describe('MCPToolHandler — get_symbol_context workspaceFolder validation', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        setupFsMocks();
    });

    it('returns isError when workspaceFolder is external', async () => {
        const { callTool } = createHandler();

        const result = await callTool('get_symbol_context', {
            path: 'src/index.ts',
            symbol: 'foo',
            workspaceFolder: '/tmp/evil',
        });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toBe('Access denied: workspaceFolder is not within the allowed workspace roots.');
    });

    it('succeeds with a subdirectory of the allowed root', async () => {
        const { callTool } = createHandler();

        const result = await callTool('get_symbol_context', {
            path: 'index.ts',
            symbol: 'foo',
            workspaceFolder: path.join(WORKSPACE_ROOT, 'src'),
        });

        expect(result.content).toHaveLength(1);
        // The symbol "foo" is on line 4 of SAMPLE_FILE_CONTENT — context should include it
        expect(result.content[0].text).toContain('function foo() {}');
        expect(mockLogWarn).not.toHaveBeenCalled();
    });

    it('uses default workspaceRoot when workspaceFolder is omitted', async () => {
        const { callTool } = createHandler();

        const result = await callTool('get_symbol_context', {
            path: 'src/index.ts',
            symbol: 'foo',
        });

        expect(result.content).toHaveLength(1);
        expect(result.content[0].text).toContain('function foo() {}');
        expect(mockLogWarn).not.toHaveBeenCalled();
    });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Multiple allowedWorkspaceRoots
// ═════════════════════════════════════════════════════════════════════════════

describe('MCPToolHandler — multiple allowedWorkspaceRoots', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        setupFsMocks();
    });

    it('both allowed roots succeed, a third root fails', async () => {
        const { callTool } = createHandler(WORKSPACE_ROOT, [
            WORKSPACE_ROOT,
            WORKSPACE_ROOT_B,
        ]);

        // Root A should succeed
        const resultA = await callTool('get_file_slice', {
            path: 'src/a.ts',
            startLine: 1,
            endLine: 1,
            workspaceFolder: WORKSPACE_ROOT,
        });
        expect(resultA.content).toHaveLength(1);
        expect(resultA.content[0].text).toBe('line1');

        // Root B should succeed
        const resultB = await callTool('get_file_slice', {
            path: 'src/b.ts',
            startLine: 1,
            endLine: 1,
            workspaceFolder: WORKSPACE_ROOT_B,
        });
        expect(resultB.content).toHaveLength(1);
        expect(resultB.content[0].text).toBe('line1');

        // Root C (not allowed) should fail
        const resultC = await callTool('get_file_slice', {
            path: 'src/c.ts',
            startLine: 1,
            endLine: 1,
            workspaceFolder: '/home/user/malicious-project',
        });
        expect(resultC.isError).toBe(true);
        expect(resultC.content[0].text).toBe('Access denied: workspaceFolder is not within the allowed workspace roots.');

        // Verify log.warn was NOT called for the two successful requests
        // (it may have been called for the failed one, but not for the successes)
        expect(mockLogWarn).not.toHaveBeenCalled();
    });

    it('get_symbol_context also respects multi-root allowlist', async () => {
        const { callTool } = createHandler(WORKSPACE_ROOT, [
            WORKSPACE_ROOT,
            WORKSPACE_ROOT_B,
        ]);

        // Root B should succeed
        const result = await callTool('get_symbol_context', {
            path: 'lib/utils.ts',
            symbol: 'foo',
            workspaceFolder: WORKSPACE_ROOT_B,
        });
        expect(result.content).toHaveLength(1);
        expect(result.content[0].text).toContain('function foo() {}');

        // Disallowed root should fail
        const resultFail = await callTool('get_symbol_context', {
            path: 'lib/utils.ts',
            symbol: 'foo',
            workspaceFolder: '/var/log',
        });
        expect(resultFail.isError).toBe(true);
        expect(resultFail.content[0].text).toBe('Access denied: workspaceFolder is not within the allowed workspace roots.');
    });
});
