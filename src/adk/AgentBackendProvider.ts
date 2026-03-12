// ─────────────────────────────────────────────────────────────────────────────
// src/adk/AgentBackendProvider.ts — Abstract agent backend interface
// ─────────────────────────────────────────────────────────────────────────────
// Post-audit Sprint 2: Extracted from IADKAdapter to enable multi-backend
// support (Antigravity, Ollama, Claude API, OpenAI Assistants).

import type { ADKSessionOptions, ADKSessionHandle } from './ADKController.js';
import type { ExecutionMode } from './ExecutionModeResolver.js';

/**
 * Abstract interface for agent backends.
 *
 * Implementations handle session lifecycle (create/terminate) and are
 * injected into `ADKController`, which manages higher-level concerns
 * (timeouts, PID tracking, output batching, watchdog timers).
 *
 * Built-in implementations:
 *   - `AntigravityADKAdapter` — Antigravity Agent Development Kit (default)
 *
 * Custom implementations can be registered via extensions or configuration
 * to support alternative LLM backends without modifying core orchestration.
 */
export interface AgentBackendProvider {
    /** Human-readable name for logging and diagnostics. */
    readonly name: string;

    /** Create an ephemeral agent session. */
    createSession(options: ADKSessionOptions): Promise<ADKSessionHandle>;

    /** Terminate an agent session and clean up resources. */
    terminateSession(handle: ADKSessionHandle): Promise<void>;

    /**
     * Optional: Determines whether a new conversation should be started
     * based on mode and prompt size (conversation mode support).
     * If not implemented, defaults to `true` (always new conversation).
     */
    shouldStartNewConversation?(
        mode: string,
        promptLength: number,
        smartSwitchTokenThreshold: number
    ): boolean;

    /**
     * Optional: Returns the resolved execution mode for this backend.
     * Used by ADKController to log and route host-specific behavior.
     */
    getExecutionMode?(): Promise<ExecutionMode>;
}
