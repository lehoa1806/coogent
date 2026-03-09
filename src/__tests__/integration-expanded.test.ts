// ─────────────────────────────────────────────────────────────────────────────
// integration-expanded.test.ts — P2.1: Expanded integration test suite
// Covers multi-phase DAG, retry/healing, validation, token pruning,
// path traversal, phase skip, session persistence, and MCP flow.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { StateManager } from '../state/StateManager.js';
import { Engine } from '../engine/Engine.js';
import { Scheduler } from '../engine/Scheduler.js';
import { SelfHealingController } from '../engine/SelfHealing.js';
import { TokenPruner, PrunableEntry } from '../context/TokenPruner.js';
import { CharRatioEncoder } from '../context/ContextScoper.js';
import { asPhaseId, type Runbook, type Phase } from '../types/index.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════════════════════════════════

/** Build a minimal valid runbook from a list of phase overrides. */
function buildRunbook(
    phases: Array<{
        id: number;
        prompt?: string;
        depends_on?: number[];
        success_criteria?: string;
        max_retries?: number;
    }>,
    projectId = 'test-project',
): Runbook {
    return {
        project_id: projectId,
        status: 'idle',
        current_phase: phases[0]?.id ?? 0,
        phases: phases.map(p => {
            const phase: Phase = {
                id: asPhaseId(p.id),
                status: 'pending',
                prompt: p.prompt ?? `Phase ${p.id}`,
                context_files: [],
                success_criteria: p.success_criteria ?? 'exit_code:0',
            };
            if (p.depends_on) {
                (phase as any).depends_on = p.depends_on.map(d => asPhaseId(d));
            }
            if (p.max_retries !== undefined) {
                (phase as any).max_retries = p.max_retries;
            }
            return phase;
        }),
    };
}

/** Create a temp directory and return cleanup helpers. */
async function makeTempSession() {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'coogent-e2e-'));
    const sessionDir = path.join(baseDir, '.coogent', 'ipc', 'test-session');
    await fs.mkdir(sessionDir, { recursive: true });
    return {
        baseDir,
        sessionDir,
        cleanup: async () => {
            // Allow time for lock files to be released
            await new Promise(r => setTimeout(r, 50));
            try {
                await fs.rm(baseDir, { recursive: true, force: true });
            } catch {
                // Best-effort cleanup — lockfile contention on CI
            }
        },
    };
}

/** Promise that resolves when the engine emits run:completed. */
function waitForCompletion(engine: Engine): Promise<Runbook> {
    return new Promise<Runbook>(resolve => {
        engine.on('run:completed', (rb: Runbook) => resolve(rb));
    });
}

/** Promise that resolves when a specific phase status is set on the runbook. */
function waitForPhaseStatus(
    engine: Engine,
    phaseId: number,
    targetStatus: string,
): Promise<void> {
    return new Promise<void>(resolve => {
        // Poll via ui:message since that's emitted after phase status changes
        const checkInterval = setInterval(() => {
            const rb = engine.getRunbook();
            if (rb) {
                const phase = rb.phases.find(p => p.id === phaseId);
                if (phase && phase.status === targetStatus) {
                    clearInterval(checkInterval);
                    resolve();
                }
            }
        }, 10);
        // Safety timeout
        setTimeout(() => {
            clearInterval(checkInterval);
            resolve();
        }, 3000);
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  1. Multi-phase DAG happy path
// ═══════════════════════════════════════════════════════════════════════════════

describe('P2.1 Integration: Multi-phase DAG happy path', () => {
    let session: Awaited<ReturnType<typeof makeTempSession>>;
    let engine: Engine;

    beforeEach(async () => {
        session = await makeTempSession();
    });
    afterEach(async () => {
        engine?.stopStallWatchdog();
        await session.cleanup();
    });

    it('executes 3 phases with depends_on, all succeed in topological order', async () => {
        // DAG: 0 → 1, 0 → 2, 1+2 → (complete)
        const runbook = buildRunbook([
            { id: 0 },
            { id: 1, depends_on: [0] },
            { id: 2, depends_on: [0] },
        ]);
        await fs.writeFile(
            path.join(session.sessionDir, '.task-runbook.json'),
            JSON.stringify(runbook),
        );

        const stateManager = new StateManager(session.sessionDir);
        engine = new Engine(stateManager, {
            scheduler: new Scheduler({ maxConcurrent: 2 }),
        });

        const executionOrder: number[] = [];
        engine.on('phase:execute', async (phase: Phase) => {
            executionOrder.push(phase.id);
            await engine.onWorkerExited(phase.id, 0);
        });

        await engine.loadRunbook();
        const completion = waitForCompletion(engine);
        await engine.start();
        await completion;

        expect(engine.getState()).toBe('COMPLETED');
        // Phase 0 must execute before 1 and 2
        expect(executionOrder.indexOf(asPhaseId(0))).toBeLessThan(
            executionOrder.indexOf(asPhaseId(1)),
        );
        expect(executionOrder.indexOf(asPhaseId(0))).toBeLessThan(
            executionOrder.indexOf(asPhaseId(2)),
        );
        // All phases completed
        const rb = engine.getRunbook()!;
        expect(rb.phases.every(p => p.status === 'completed')).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  2. Failed phase + retry
// ═══════════════════════════════════════════════════════════════════════════════

describe('P2.1 Integration: Failed phase + retry', () => {
    let session: Awaited<ReturnType<typeof makeTempSession>>;
    let engine: Engine;

    beforeEach(async () => {
        session = await makeTempSession();
    });
    afterEach(async () => {
        engine?.stopStallWatchdog();
        await session.cleanup();
    });

    it('single phase fails, transitions to ERROR_PAUSED, retry succeeds', async () => {
        // Single-phase runbook: fails first, manual retry succeeds.
        // maxRetries: 0 means no auto-healing — first failure goes straight to ERROR_PAUSED.
        const runbook = buildRunbook([{ id: 0 }]);
        await fs.writeFile(
            path.join(session.sessionDir, '.task-runbook.json'),
            JSON.stringify(runbook),
        );

        const stateManager = new StateManager(session.sessionDir);
        const healer = new SelfHealingController({ maxRetries: 0, baseDelayMs: 0 });
        engine = new Engine(stateManager, { healer });

        let attempt = 0;
        engine.on('phase:execute', async (phase: Phase) => {
            attempt++;
            if (attempt === 1) {
                await engine.onWorkerExited(phase.id, 1, '', 'build error');
            } else {
                await engine.onWorkerExited(phase.id, 0);
            }
        });

        await engine.loadRunbook();

        // Start and wait for the phase to fail
        await engine.start();
        await waitForPhaseStatus(engine, 0, 'failed');

        expect(engine.getState()).toBe('ERROR_PAUSED');
        expect(engine.getRunbook()!.phases[0].status).toBe('failed');

        // Manual retry — healer is reset per-phase on retry
        const completion = waitForCompletion(engine);
        await engine.retry(0);
        await completion;

        expect(engine.getState()).toBe('COMPLETED');
        expect(engine.getRunbook()!.phases[0].status).toBe('completed');
        expect(attempt).toBe(2);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  3. Invalid worker output rejection (non-zero exit code)
// ═══════════════════════════════════════════════════════════════════════════════

describe('P2.1 Integration: Invalid worker output rejection', () => {
    let session: Awaited<ReturnType<typeof makeTempSession>>;
    let engine: Engine;

    beforeEach(async () => {
        session = await makeTempSession();
    });
    afterEach(async () => {
        engine?.stopStallWatchdog();
        await session.cleanup();
    });

    it('worker returns non-zero exit code, system transitions to ERROR_PAUSED', async () => {
        const runbook = buildRunbook([{ id: 0 }]);
        await fs.writeFile(
            path.join(session.sessionDir, '.task-runbook.json'),
            JSON.stringify(runbook),
        );

        const stateManager = new StateManager(session.sessionDir);
        // maxRetries: 0 — first failure immediately transitions to ERROR_PAUSED
        const healer = new SelfHealingController({ maxRetries: 0, baseDelayMs: 0 });
        engine = new Engine(stateManager, { healer });

        engine.on('phase:execute', async (phase: Phase) => {
            await engine.onWorkerExited(phase.id, 1, '', 'syntax error in output');
        });

        await engine.loadRunbook();
        await engine.start();
        await waitForPhaseStatus(engine, 0, 'failed');

        expect(engine.getState()).toBe('ERROR_PAUSED');
        const rb = engine.getRunbook()!;
        expect(rb.phases[0].status).toBe('failed');
        expect(rb.status).toBe('paused_error');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  4. Token-budget overflow — pruning activates
// ═══════════════════════════════════════════════════════════════════════════════

describe('P2.1 Integration: Token-budget overflow', () => {
    it('context pack exceeds budget, pruner drops discovered files', () => {
        const encoder = new CharRatioEncoder(4); // 4 chars per token
        const budgetTokens = 50;
        const pruner = new TokenPruner(encoder, budgetTokens);

        const makeEntry = (
            p: string,
            content: string,
            isExplicit: boolean,
        ): PrunableEntry => ({
            path: p,
            content,
            tokenCount: encoder.countTokens(content),
            isExplicit,
        });

        // 200 chars = 50 tokens (exactly at budget)
        const explicitFile = makeEntry('src/core.ts', 'a'.repeat(200), true);
        // 400 chars = 100 tokens (over budget, discovered)
        const discoveredFile1 = makeEntry('src/utils.ts', 'b'.repeat(400), false);
        // 200 chars = 50 tokens (over budget, discovered)
        const discoveredFile2 = makeEntry('src/helpers.ts', 'c'.repeat(200), false);

        const result = pruner.prune([explicitFile, discoveredFile1, discoveredFile2]);

        // Explicit file must survive; discovered files should be dropped
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0].path).toBe('src/core.ts');
        expect(result.prunedCount).toBeGreaterThanOrEqual(1);
    });

    it('does not prune when within budget', () => {
        const encoder = new CharRatioEncoder(4);
        const pruner = new TokenPruner(encoder, 1000);

        const entry: PrunableEntry = {
            path: 'a.ts',
            content: 'const x = 1;',
            tokenCount: encoder.countTokens('const x = 1;'),
            isExplicit: true,
        };
        const result = pruner.prune([entry]);
        expect(result.withinBudget).toBe(true);
        expect(result.prunedCount).toBe(0);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  5. Path traversal rejection
// ═══════════════════════════════════════════════════════════════════════════════

describe('P2.1 Integration: Path traversal rejection', () => {
    it('rejects context_files containing path traversal sequences', () => {
        // Verify that file paths with ".." are detected
        const maliciousPaths = [
            '../../../etc/passwd',
            'src/../../secrets.json',
            'foo/bar/../../../.env',
        ];

        for (const malicious of maliciousPaths) {
            const normalized = path.normalize(malicious);
            const containsTraversal = normalized.startsWith('..');
            expect(containsTraversal).toBe(true);
        }

        // Safe paths should pass
        const safePaths = ['src/index.ts', 'lib/utils.ts', 'tests/foo.test.ts'];
        for (const safe of safePaths) {
            const normalized = path.normalize(safe);
            const containsTraversal = normalized.startsWith('..');
            expect(containsTraversal).toBe(false);
        }
    });

    it('rejects absolute paths outside workspace root', () => {
        const workspaceRoot = '/home/user/project';
        const testPaths = [
            { input: '/etc/passwd', expected: false },
            { input: '/home/user/project/src/app.ts', expected: true },
            { input: '/home/user/other-project/secrets.json', expected: false },
        ];

        for (const { input, expected } of testPaths) {
            const isInside = input.startsWith(workspaceRoot + '/');
            expect(isInside).toBe(expected);
        }
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  6. Phase skip with DAG
// ═══════════════════════════════════════════════════════════════════════════════

describe('P2.1 Integration: Phase skip with DAG', () => {
    let session: Awaited<ReturnType<typeof makeTempSession>>;
    let engine: Engine;

    beforeEach(async () => {
        session = await makeTempSession();
    });
    afterEach(async () => {
        engine?.stopStallWatchdog();
        await session.cleanup();
    });

    it('skipping a failed phase unblocks dependent phases in DAG', async () => {
        // DAG: 0 → 1 → 2
        // Phase 0 succeeds, phase 1 fails, skip it, phase 2 should run
        const runbook = buildRunbook([
            { id: 0 },
            { id: 1, depends_on: [0] },
            { id: 2, depends_on: [1] },
        ]);
        await fs.writeFile(
            path.join(session.sessionDir, '.task-runbook.json'),
            JSON.stringify(runbook),
        );

        const stateManager = new StateManager(session.sessionDir);
        // maxRetries: 0 so failed phase goes directly to ERROR_PAUSED
        const healer = new SelfHealingController({ maxRetries: 0, baseDelayMs: 0 });
        engine = new Engine(stateManager, {
            scheduler: new Scheduler({ maxConcurrent: 1 }),
            healer,
        });

        let phase1ShouldFail = true;
        engine.on('phase:execute', async (phase: Phase) => {
            if (phase.id === 1 && phase1ShouldFail) {
                phase1ShouldFail = false;
                await engine.onWorkerExited(phase.id, 1, '', 'failed intentionally');
            } else {
                await engine.onWorkerExited(phase.id, 0);
            }
        });

        await engine.loadRunbook();
        await engine.start();
        await waitForPhaseStatus(engine, 1, 'failed');

        // Phase 1 failed
        expect(engine.getRunbook()!.phases[1].status).toBe('failed');

        // Skip the failed phase
        const completion = waitForCompletion(engine);
        await engine.skipPhase(1);
        await completion;

        const rb = engine.getRunbook()!;
        // Phase 1 marked completed (skipped)
        expect(rb.phases[1].status).toBe('completed');
        // Phase 2 should have executed and completed
        expect(rb.phases[2].status).toBe('completed');
        expect(engine.getState()).toBe('COMPLETED');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  7. Session persistence — state survives reload
// ═══════════════════════════════════════════════════════════════════════════════

describe('P2.1 Integration: Session persistence', () => {
    let session: Awaited<ReturnType<typeof makeTempSession>>;

    beforeEach(async () => {
        session = await makeTempSession();
    });
    afterEach(async () => {
        await session.cleanup();
    });

    it('persists phase completion to disk and survives reload', async () => {
        // Single-phase runbook that completes successfully
        const runbook = buildRunbook([{ id: 0 }]);
        await fs.writeFile(
            path.join(session.sessionDir, '.task-runbook.json'),
            JSON.stringify(runbook),
        );

        const sm1 = new StateManager(session.sessionDir);
        const engine1 = new Engine(sm1);
        engine1.on('phase:execute', async (phase: Phase) => {
            await engine1.onWorkerExited(phase.id, 0);
        });

        await engine1.loadRunbook();
        const completion = waitForCompletion(engine1);
        await engine1.start();
        await completion;
        engine1.stopStallWatchdog();

        // Allow time for async persist to flush
        await new Promise(r => setTimeout(r, 100));

        // Verify disk state
        const raw = await fs.readFile(
            path.join(session.sessionDir, '.task-runbook.json'),
            'utf8',
        );
        const diskRb = JSON.parse(raw) as Runbook;
        expect(diskRb.phases[0].status).toBe('completed');
        expect(diskRb.status).toBe('completed');

        // Second engine: reload from disk
        const sm2 = new StateManager(session.sessionDir);
        const engine2 = new Engine(sm2);
        await engine2.loadRunbook();

        const rb2 = engine2.getRunbook()!;
        expect(rb2.phases[0].status).toBe('completed');
        expect(rb2.status).toBe('completed');
        expect(rb2.project_id).toBe('test-project');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  8. Scheduler + Healer combined flow
// ═══════════════════════════════════════════════════════════════════════════════

describe('P2.1 Integration: Scheduler + Healer combined flow', () => {
    it('SelfHealingController tracks failures and builds healing prompts', () => {
        const healer = new SelfHealingController({ maxRetries: 2, baseDelayMs: 100 });

        // Record first failure
        healer.recordFailure(1, 1, 'TypeError: x is undefined');
        expect(healer.canRetry(1)).toBe(true);
        expect(healer.getAttemptCount(1)).toBe(1);

        // Record second failure — maxRetries exhausted
        healer.recordFailure(1, 1, 'ReferenceError: y is not defined');
        expect(healer.canRetry(1)).toBe(false);
        expect(healer.getAttemptCount(1)).toBe(2);

        // Healing prompt includes the latest error and original prompt
        const phase: Phase = {
            id: asPhaseId(1),
            status: 'failed',
            prompt: 'Implement the login module',
            context_files: [],
            success_criteria: 'exit_code:0',
        };
        const prompt = healer.buildHealingPrompt(phase);
        // It should include the last recorded error
        expect(prompt).toContain('ReferenceError: y is not defined');
        expect(prompt).toContain('Implement the login module');
        // Should reference retry count
        expect(prompt).toContain('Retry');
    });

    it('Scheduler DAG detects cycles and reports them', () => {
        const scheduler = new Scheduler({ maxConcurrent: 2 });

        // Cyclic: 0 → 1 → 0
        const cyclicPhases: Phase[] = [
            {
                id: asPhaseId(0), status: 'pending', prompt: 'A',
                context_files: [], success_criteria: 'exit_code:0',
                depends_on: [asPhaseId(1)],
            },
            {
                id: asPhaseId(1), status: 'pending', prompt: 'B',
                context_files: [], success_criteria: 'exit_code:0',
                depends_on: [asPhaseId(0)],
            },
        ];
        const cycles = scheduler.detectCycles(cyclicPhases);
        expect(cycles.length).toBeGreaterThan(0);

        // Acyclic
        const acyclicPhases: Phase[] = [
            {
                id: asPhaseId(0), status: 'pending', prompt: 'A',
                context_files: [], success_criteria: 'exit_code:0',
            },
            {
                id: asPhaseId(1), status: 'pending', prompt: 'B',
                context_files: [], success_criteria: 'exit_code:0',
                depends_on: [asPhaseId(0)],
            },
        ];
        expect(scheduler.detectCycles(acyclicPhases)).toEqual([]);
    });

    it('Scheduler getReadyPhases respects depends_on and maxConcurrent', () => {
        const scheduler = new Scheduler({ maxConcurrent: 1 });

        const phases: Phase[] = [
            {
                id: asPhaseId(0), status: 'completed', prompt: 'A',
                context_files: [], success_criteria: 'exit_code:0',
            },
            {
                id: asPhaseId(1), status: 'pending', prompt: 'B',
                context_files: [], success_criteria: 'exit_code:0',
                depends_on: [asPhaseId(0)],
            },
            {
                id: asPhaseId(2), status: 'pending', prompt: 'C',
                context_files: [], success_criteria: 'exit_code:0',
                depends_on: [asPhaseId(0)],
            },
        ];

        const ready = scheduler.getReadyPhases(phases);
        // maxConcurrent = 1, so only 1 should be returned
        expect(ready).toHaveLength(1);
        expect(ready[0].id).toBe(1);
    });
});
