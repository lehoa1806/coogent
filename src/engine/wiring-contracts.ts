// ─────────────────────────────────────────────────────────────────────────────
// src/engine/wiring-contracts.ts — Centralised adapter functions for EngineWiring
// ─────────────────────────────────────────────────────────────────────────────
// Phase 10 audit fix: Replaces the 8 inline `as unknown as` casts in
// EngineWiring.ts with typed adapter functions.  Each function documents
// *why* the cast is safe, so the rationale lives in one place instead of
// being scattered across the wiring module.

// Re-export all slim interfaces so consumers have a single import point.
export type { ContextScoperLike, ContextAssemblyLogger } from './ContextAssemblyAdapter.js';
export type { WorkerLauncherADK, WorkerLauncherLogger } from './WorkerLauncher.js';
export type {
    ResultProcessorEngine,
    ResultProcessorMCPServer,
    ResultProcessorHandoffExtractor,
    ResultProcessorMCPBridge,
} from './WorkerResultProcessor.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Typed adapter functions
// ═══════════════════════════════════════════════════════════════════════════════
// These functions centralise the structural casts between ServiceContainer
// services and the slim interfaces consumed by the extracted modules
// (ContextAssemblyAdapter, WorkerLauncher, WorkerResultProcessor).
//
// The casts are safe because:
//   • Each slim interface is a strict subset of the full service interface.
//   • The EngineWiring tests verify that all delegated calls reach the
//     underlying service methods (structural duck-typing at runtime).
//   • Centralising the casts here makes them auditable and grep-able.

import type { ContextScoperLike, ContextAssemblyLogger } from './ContextAssemblyAdapter.js';
import type { WorkerLauncherADK, WorkerLauncherLogger } from './WorkerLauncher.js';
import type {
    ResultProcessorEngine,
    ResultProcessorMCPServer,
    ResultProcessorHandoffExtractor,
    ResultProcessorMCPBridge,
} from './WorkerResultProcessor.js';

/** Adapt the context scoper to the slim ContextScoperLike interface. */
export function asContextScoper(scoper: unknown): ContextScoperLike {
    return scoper as ContextScoperLike;
}

/** Adapt the telemetry logger to the ContextAssemblyLogger interface. */
export function asAssemblyLogger(logger: unknown): ContextAssemblyLogger {
    return logger as ContextAssemblyLogger;
}

/** Adapt the engine to the ResultProcessorEngine interface. */
export function asResultProcessorEngine(engine: unknown): ResultProcessorEngine {
    return engine as ResultProcessorEngine;
}

/** Adapt the MCP server to the ResultProcessorMCPServer interface. */
export function asResultProcessorMCPServer(server: unknown): ResultProcessorMCPServer | undefined {
    return server as ResultProcessorMCPServer | undefined;
}

/** Adapt the handoff extractor to the ResultProcessorHandoffExtractor interface. */
export function asResultProcessorHandoffExtractor(extractor: unknown): ResultProcessorHandoffExtractor | undefined {
    return extractor as ResultProcessorHandoffExtractor | undefined;
}

/** Adapt the MCP bridge to the ResultProcessorMCPBridge interface. */
export function asResultProcessorMCPBridge(bridge: unknown): ResultProcessorMCPBridge | undefined {
    return bridge as ResultProcessorMCPBridge | undefined;
}

/** Adapt the ADK controller to the WorkerLauncherADK interface. */
export function asWorkerLauncherADK(adk: unknown): WorkerLauncherADK {
    return adk as WorkerLauncherADK;
}

/** Adapt the telemetry logger to the WorkerLauncherLogger interface. */
export function asWorkerLauncherLogger(logger: unknown): WorkerLauncherLogger {
    return logger as WorkerLauncherLogger;
}
