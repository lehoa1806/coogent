// ─────────────────────────────────────────────────────────────────────────────
// ConsolidationImplPlanDataflow.test.ts — Integration tests for storing and
// retrieving consolidation reports and implementation plans via ArtifactDB.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { CoogentMCPServer } from '../CoogentMCPServer.js';

// ─── Test Fixtures ───────────────────────────────────────────────────────────

const VALID_MASTER_TASK_ID =
    '20260305-173000-a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const VALID_PHASE_ID =
    'phase-001-a1b2c3d4-e5f6-7890-abcd-ef1234567890';

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function createInMemoryDB(tmpDir: string) {
    const server = new CoogentMCPServer(tmpDir);
    await server.init(tmpDir);
    return server;
}

// ═════════════════════════════════════════════════════════════════════════════
//  Consolidation Report & Implementation Plan Dataflow Tests
// ═════════════════════════════════════════════════════════════════════════════

describe('Consolidation & Implementation Plan dataflow', () => {
    let tmpDir: string;
    let server: CoogentMCPServer;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(
            path.join(os.tmpdir(), 'consol-impl-dataflow-test-')
        );
        server = await createInMemoryDB(tmpDir);
    });

    afterEach(async () => {
        server.dispose();
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const getDB = () => (server as any).db;

    // ─── Test 1: Master-level implementation plan ────────────────────────────

    it('stores and retrieves a master-level implementation plan', () => {
        const plan = '# Master Plan\n\n## Phase 1\n- Step A\n- Step B';

        getDB().tasks.upsert(VALID_MASTER_TASK_ID, {
            implementationPlan: plan,
        });

        const task = getDB().tasks.get(VALID_MASTER_TASK_ID);
        expect(task).toBeDefined();
        expect(task!.implementationPlan).toBe(plan);
    });

    // ─── Test 2: Phase-level implementation plan ────────────────────────────

    it('stores and retrieves a phase-level implementation plan', () => {
        const phasePlan =
            '# Phase 1 Plan\n\n## Objectives\n- Implement auth module\n- Write tests';

        getDB().phases.upsertPlan(
            VALID_MASTER_TASK_ID,
            VALID_PHASE_ID,
            phasePlan
        );

        // Direct retrieval via PhaseRepository
        const retrieved = getDB().phases.getPlan(
            VALID_MASTER_TASK_ID,
            VALID_PHASE_ID
        );
        expect(retrieved).toBe(phasePlan);

        // Also verify via TaskRepository.get() — phase should appear in the
        // task's phases map
        const task = getDB().tasks.get(VALID_MASTER_TASK_ID);
        expect(task).toBeDefined();
        expect(task!.phases.size).toBe(1);
        expect(task!.phases.get(VALID_PHASE_ID)).toBeDefined();
        expect(task!.phases.get(VALID_PHASE_ID)!.implementationPlan).toBe(
            phasePlan
        );
    });

    // ─── Test 3: Consolidation report (Markdown) ────────────────────────────

    it('stores and retrieves a consolidation report in markdown format', () => {
        const mdReport =
            '# Consolidation Report\n\n## Summary\nAll 3 phases completed.\n\n## Decisions\n- Used JWT auth\n- Chose PostgreSQL';

        getDB().tasks.upsert(VALID_MASTER_TASK_ID, {
            consolidationReport: mdReport,
        });

        const task = getDB().tasks.get(VALID_MASTER_TASK_ID);
        expect(task).toBeDefined();
        expect(task!.consolidationReport).toBe(mdReport);
    });

    // ─── Test 4: Consolidation report (JSON) ────────────────────────────────

    it('stores and retrieves a consolidation report in JSON format', () => {
        const report = {
            projectId: VALID_MASTER_TASK_ID,
            totalPhases: 3,
            successfulPhases: 2,
            failedPhases: 1,
            skippedPhases: 0,
            allModifiedFiles: ['src/auth.ts', 'src/db.ts', 'src/main.ts'],
            allDecisions: ['Used JWT', 'Chose PostgreSQL'],
            unresolvedIssues: ['Rate limiting not implemented'],
            phaseResults: [
                {
                    phaseId: 1,
                    status: 'success',
                    decisions: ['Used JWT'],
                    modifiedFiles: ['src/auth.ts'],
                },
                {
                    phaseId: 2,
                    status: 'success',
                    decisions: ['Chose PostgreSQL'],
                    modifiedFiles: ['src/db.ts'],
                },
                {
                    phaseId: 3,
                    status: 'failed',
                    decisions: [],
                    modifiedFiles: ['src/main.ts'],
                },
            ],
            generatedAt: Date.now(),
        };

        const jsonStr = JSON.stringify(report);

        getDB().tasks.upsert(VALID_MASTER_TASK_ID, {
            consolidationReportJson: jsonStr,
        });

        const task = getDB().tasks.get(VALID_MASTER_TASK_ID);
        expect(task).toBeDefined();
        expect(task!.consolidationReportJson).toBe(jsonStr);

        // Verify round-trip parse
        const parsed = JSON.parse(task!.consolidationReportJson!);
        expect(parsed.projectId).toBe(VALID_MASTER_TASK_ID);
        expect(parsed.totalPhases).toBe(3);
        expect(parsed.successfulPhases).toBe(2);
        expect(parsed.failedPhases).toBe(1);
        expect(parsed.phaseResults).toHaveLength(3);
    });

    // ─── Test 5: Both consolidation report formats simultaneously ───────────

    it('stores both consolidation report formats simultaneously', () => {
        const mdReport = '# Report\n\nAll phases passed.';
        const jsonReport = JSON.stringify({
            projectId: VALID_MASTER_TASK_ID,
            totalPhases: 2,
            successfulPhases: 2,
            failedPhases: 0,
            skippedPhases: 0,
            allModifiedFiles: ['a.ts'],
            allDecisions: ['Decision 1'],
            unresolvedIssues: [],
            phaseResults: [],
            generatedAt: Date.now(),
        });

        getDB().tasks.upsert(VALID_MASTER_TASK_ID, {
            consolidationReport: mdReport,
            consolidationReportJson: jsonReport,
        });

        const task = getDB().tasks.get(VALID_MASTER_TASK_ID);
        expect(task).toBeDefined();
        expect(task!.consolidationReport).toBe(mdReport);
        expect(task!.consolidationReportJson).toBe(jsonReport);
    });

    // ─── Test 6: Implementation plan update overwrites previous value ───────

    it('overwrites previous implementation plan on update', () => {
        const originalPlan = '# Original Plan\n- Step 1';
        const updatedPlan = '# Updated Plan\n- Step 1 (revised)\n- Step 2';

        getDB().tasks.upsert(VALID_MASTER_TASK_ID, {
            implementationPlan: originalPlan,
        });

        // Verify original
        let task = getDB().tasks.get(VALID_MASTER_TASK_ID);
        expect(task!.implementationPlan).toBe(originalPlan);

        // Overwrite
        getDB().tasks.upsert(VALID_MASTER_TASK_ID, {
            implementationPlan: updatedPlan,
        });

        // Verify updated
        task = getDB().tasks.get(VALID_MASTER_TASK_ID);
        expect(task!.implementationPlan).toBe(updatedPlan);
    });

    // ─── Test 7: Consolidation report & impl plan coexist on same task ──────

    it('consolidation report and implementation plan coexist on the same task', () => {
        const plan = '# Implementation Plan\n\n## Phases\n1. Auth\n2. DB\n3. API';
        const mdReport = '# Consolidation\n\nAll done.';
        const jsonReport = JSON.stringify({
            projectId: VALID_MASTER_TASK_ID,
            totalPhases: 3,
            successfulPhases: 3,
            failedPhases: 0,
            skippedPhases: 0,
            allModifiedFiles: ['x.ts'],
            allDecisions: [],
            unresolvedIssues: [],
            phaseResults: [],
            generatedAt: Date.now(),
        });

        // Store all three in one call
        getDB().tasks.upsert(VALID_MASTER_TASK_ID, {
            implementationPlan: plan,
            consolidationReport: mdReport,
            consolidationReportJson: jsonReport,
        });

        const task = getDB().tasks.get(VALID_MASTER_TASK_ID);
        expect(task).toBeDefined();
        expect(task!.implementationPlan).toBe(plan);
        expect(task!.consolidationReport).toBe(mdReport);
        expect(task!.consolidationReportJson).toBe(jsonReport);
    });
});
