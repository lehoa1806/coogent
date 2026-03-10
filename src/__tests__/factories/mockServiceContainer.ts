// ─────────────────────────────────────────────────────────────────────────────
// src/__tests__/factories/mockServiceContainer.ts — Typed stubs for ServiceContainer fields
// ─────────────────────────────────────────────────────────────────────────────

import type { ServiceContainer } from '../../ServiceContainer.js';

/**
 * Service stub shapes — each key maps to a minimal jest.fn()-based mock
 * that satisfies the type contract of the corresponding ServiceContainer field.
 */

/** Minimal mock matching the SessionManager interface used in ServiceContainer. */
export function createMockSessionManager() {
    return {
        setCurrentSessionId: jest.fn(),
        setArtifactDB: jest.fn(),
    } as unknown as NonNullable<ServiceContainer['sessionManager']>;
}

/** Minimal mock matching the CoogentMCPServer interface. */
export function createMockMcpServer(overrides?: {
    getArtifactDB?: jest.Mock;
    upsertWorkerOutput?: jest.Mock;
}) {
    return {
        getArtifactDB: overrides?.getArtifactDB ?? jest.fn().mockReturnValue(undefined),
        upsertWorkerOutput: overrides?.upsertWorkerOutput ?? jest.fn(),
    } as unknown as NonNullable<ServiceContainer['mcpServer']>;
}

/** Minimal mock matching the MCPClientBridge interface. */
export function createMockMcpBridge(overrides?: {
    submitPhaseHandoff?: jest.Mock;
    submitImplementationPlan?: jest.Mock;
}) {
    return {
        submitPhaseHandoff: overrides?.submitPhaseHandoff ?? jest.fn().mockResolvedValue(undefined),
        submitImplementationPlan: overrides?.submitImplementationPlan ?? jest.fn().mockResolvedValue(undefined),
    } as unknown as NonNullable<ServiceContainer['mcpBridge']>;
}

/** Minimal mock matching the PlannerAgent interface. */
export function createMockPlannerAgent() {
    return {
        setMasterTaskId: jest.fn(),
    } as unknown as NonNullable<ServiceContainer['plannerAgent']>;
}

/** Minimal mock matching the HandoffExtractor interface. */
export function createMockHandoffExtractor(overrides?: {
    extractHandoff?: jest.Mock;
    extractImplementationPlan?: jest.Mock;
    generateDistillationPrompt?: jest.Mock;
    buildNextContext?: jest.Mock;
}) {
    return {
        extractHandoff: overrides?.extractHandoff ?? jest.fn().mockResolvedValue({
            decisions: [], modified_files: [], unresolved_issues: [],
        }),
        extractImplementationPlan: overrides?.extractImplementationPlan ?? jest.fn().mockReturnValue(null),
        generateDistillationPrompt: overrides?.generateDistillationPrompt ?? jest.fn().mockReturnValue(''),
        buildNextContext: overrides?.buildNextContext ?? jest.fn().mockResolvedValue(''),
    } as unknown as NonNullable<ServiceContainer['handoffExtractor']>;
}

/**
 * Returns a Record of opaque stubs keyed by ServiceContainer field name.
 * Use `createStubValue(key)` when you need a non-undefined value to assign
 * to a ServiceContainer field purely to test `releaseAll()` / `isRegistered()`.
 *
 * These are intentionally **opaque** — they satisfy the type system but carry
 * no meaningful behaviour. Use the typed factories above when you need real mocks.
 */
export function createOpaqueStub<K extends keyof ServiceContainer>(
    key: K,
): NonNullable<ServiceContainer[K]> {
    // String fields get a string stub; everything else gets a plain object stub
    if (key === 'currentSessionDir' || key === 'currentSessionDirName' || key === 'currentSessionId' || key === 'storageBase' || key === 'coogentDir') {
        return '/tmp/stub' as unknown as NonNullable<ServiceContainer[K]>;
    }
    if (key === 'mcpReady') {
        return Promise.resolve() as unknown as NonNullable<ServiceContainer[K]>;
    }
    if (key === 'workspaceRoots') {
        return [] as unknown as NonNullable<ServiceContainer[K]>;
    }
    return {} as NonNullable<ServiceContainer[K]>;
}

/**
 * List of all assignable service keys on ServiceContainer
 * (excludes readonly collections like workerOutputAccumulator).
 */
export const ASSIGNABLE_SERVICE_KEYS = [
    'stateManager', 'engine', 'adkController', 'contextScoper',
    'logger', 'gitManager', 'gitSandbox', 'outputRegistry',
    'plannerAgent', 'sessionManager', 'handoffExtractor', 'consolidationAgent',
    'mcpServer', 'mcpBridge', 'sidebarMenu', 'agentRegistry',
    'contextPackBuilder', 'sessionHistoryService',
] as const;
