// ─────────────────────────────────────────────────────────────────────────────
// src/adk/ADKController.ts — Agent spawn, terminate, and lifecycle management
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { DEFAULT_CONVERSATION_SETTINGS, type Phase, type ConversationSettings } from '../types/index.js';
import { getPidDir } from '../constants/paths.js';
import log from '../logger/log.js';

import type { AgentBackendProvider } from './AgentBackendProvider.js';
import { INJECTION_PATTERNS } from './injection-patterns.js';
import { PromptInjectionBlockedError } from './PromptInjectionBlockedError.js';
import type { ExecutionMode } from './ExecutionModeResolver.js';
import { TypedEventEmitter } from '../engine/TypedEventEmitter.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  S1-2 (EDGE-2): Worker output size cap
// ═══════════════════════════════════════════════════════════════════════════════

/** Maximum worker output size in bytes (default 10 MB). Configurable via setting. */
const MAX_WORKER_OUTPUT_BYTES = 10 * 1024 * 1024;

export interface ADKSessionOptions {
    /** Start with zero context (no history, no files). */
    zeroContext: boolean;
    /** Working directory for the agent. */
    workingDirectory: string;
    /** The prompt to inject (includes file context). */
    initialPrompt: string;
    /** Whether to start a new conversation before injecting the prompt. */
    newConversation?: boolean;
    /** Master task ID — determines the parent folder for IPC files. */
    masterTaskId?: string;
    /** Phase number — used to build the `phase-NNN-<uuid>` sub-task directory. */
    phaseNumber?: number;
    /**
     * Optional MCP resource URIs for warm-start context injection.
     * When provided, workers can read context from the local MCP server
     * instead of relying solely on file-based context injection.
     */
    mcpResourceUris?: {
        /** URI to the master-level execution plan. e.g. coogent://tasks/{id}/execution_plan */
        executionPlan?: string;
        /** URIs to parent phase handoff artifacts — one per depends_on entry. e.g. coogent://tasks/{id}/phases/{parentPhaseId}/handoff */
        parentHandoffs?: string[];  // PLURAL — supports all parent dependencies in multi-phase DAGs
    };
}

export interface ADKSessionHandle {
    /** Unique session identifier. */
    sessionId: string;
    /** OS process ID (for orphan cleanup). */
    pid: number;
    /** Register a callback for stdout/stderr output. */
    onOutput(callback: (stream: 'stdout' | 'stderr', chunk: string) => void): void;
    /** Register a callback for process exit. */
    onExit(callback: (exitCode: number) => void): void;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Worker Handle
// ═══════════════════════════════════════════════════════════════════════════════

export interface WorkerHandle {
    handle: ADKSessionHandle;
    phaseId: number;
    startedAt: number;
    timeoutTimer: ReturnType<typeof setTimeout>;
    watchdogTimer: ReturnType<typeof setTimeout>;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ADK Controller Events
// ═══════════════════════════════════════════════════════════════════════════════

export interface ADKControllerEvents {
    /** Fired when a worker produces output. */
    'worker:output': (phaseId: number, stream: 'stdout' | 'stderr', chunk: string) => void;
    /** Fired when a worker exits normally. */
    'worker:exited': (phaseId: number, exitCode: number) => void;
    /** Fired when a worker times out. */
    'worker:timeout': (phaseId: number) => void;
    /** Fired when a worker crashes. */
    'worker:crash': (phaseId: number, error: Error) => void;
    // Index signature required by TypedEventEmitter<T> constraint
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: (...args: any[]) => void;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ADK Controller
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Manages the lifecycle of ephemeral ADK worker agents.
 *
 * Responsibilities:
 * - Spawn workers with zero-context sessions.
 * - Monitor output streams and exit signals.
 * - Enforce per-phase timeouts.
 * - Prevent orphaned processes (terminate before spawn, PID registry).
 *
 * See TDD §4 for the full specification.
 */
export class ADKController extends TypedEventEmitter<ADKControllerEvents> {
    private readonly activeWorkers = new Map<number, WorkerHandle>();
    private readonly activePids = new Set<number>();
    private readonly pidDir: string;
    private _conversationSettings: ConversationSettings = { ...DEFAULT_CONVERSATION_SETTINGS };

    /** R2: Configurable maximum concurrent workers. Default: 4. */
    private _maxConcurrent = 4;

    /** R1: Whether to block execution when prompt injection patterns are detected. */
    private _blockOnInjection = false;

    /** Configurable idle timeout for the watchdog (ms). Default: 15 minutes. */
    private watchdogTimeoutMs = 900_000;
    private _disposed = false;

    constructor(
        private readonly adapter: AgentBackendProvider,
        private readonly workspaceRoot: string,
    ) {
        super();
        this.pidDir = getPidDir(workspaceRoot);
    }

    /** Get current conversation settings. */
    get conversationSettings(): ConversationSettings {
        return { ...this._conversationSettings };
    }

    /** Update conversation settings. */
    setConversationSettings(settings: Partial<ConversationSettings>): void {
        this._conversationSettings = { ...this._conversationSettings, ...settings };
        log.info(`[ADKController] Conversation mode: ${this._conversationSettings.mode} (threshold: ${this._conversationSettings.smartSwitchTokenThreshold})`);
    }

    /** Set the watchdog idle timeout (ms). 0 disables the watchdog. */
    setWatchdogTimeout(ms: number): void {
        this.watchdogTimeoutMs = ms;
    }

    /** R2: Set the maximum number of concurrent workers (1–16). */
    setMaxConcurrent(n: number): void {
        this._maxConcurrent = Math.max(1, Math.min(16, n));
        log.info(`[ADKController] Max concurrent workers: ${this._maxConcurrent}`);
    }

    /** R1: Enable or disable blocking on prompt injection detection. */
    setBlockOnInjection(block: boolean): void {
        this._blockOnInjection = block;
        log.info(`[ADKController] Block on prompt injection: ${this._blockOnInjection}`);
    }

    /** Get all currently tracked worker PIDs. */
    getActivePids(): ReadonlySet<number> {
        return this.activePids;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Spawn & Terminate
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Spawn an ephemeral worker for a phase.
     * Terminates any existing active worker first (orphan prevention).
     */
    async spawnWorker(
        phase: Phase,
        timeoutMs = 900_000,
        masterTaskId?: string,
        mcpResourceUris?: {
            executionPlan?: string;
            parentHandoffs?: string[];  // PLURAL — supports multi-dependency DAG phases
        },
    ): Promise<WorkerHandle | null> {
        // B-3: Warn when mcpResourceUris is absent for phases that have parent dependencies.
        // This surfaces silent Pull→Push degradation that would otherwise be invisible.
        if (!mcpResourceUris && phase.depends_on && (phase.depends_on as unknown[]).length > 0) {
            log.warn(
                `[ADKController] spawnWorker: mcpResourceUris not provided for phase ${phase.id} ` +
                `which has parent dependencies. Warm-start context will be missing.`
            );
        }
        // S4-2 (CQ-4): R2 — use configurable max concurrent workers
        if (this.activeWorkers.size >= this._maxConcurrent) {
            log.warn(`[ADKController] Max concurrent workers reached (${this._maxConcurrent}). Skipping phase ${phase.id}`);
            return null;
        }

        // Orphan/Duplicate prevention for this phase
        if (this.activeWorkers.has(phase.id)) {
            await this.terminateWorker(phase.id, 'ORPHAN_PREVENTION');
        }

        // Resolve execution mode from the centralized resolver
        let executionMode: ExecutionMode = 'unsupported';
        if (this.adapter.getExecutionMode) {
            executionMode = await this.adapter.getExecutionMode();
        }
        log.info(`[ADKController] spawnWorker: executionMode=${executionMode}`);

        const prompt = this.buildInjectionPrompt(phase, mcpResourceUris);

        // Determine if a new conversation should be started based on mode.
        // Isolated mode: ALWAYS start a new conversation — guaranteed regardless
        // of whether the adapter implements the optional helper. This ensures
        // every subtask runs with zero prior context as the mode promises.
        let newConversation: boolean;
        if (this._conversationSettings.mode === 'isolated') {
            newConversation = true;
        } else if (typeof this.adapter.shouldStartNewConversation === 'function') {
            newConversation = this.adapter.shouldStartNewConversation(
                this._conversationSettings.mode,
                prompt.length,
                this._conversationSettings.smartSwitchTokenThreshold
            );
        } else {
            newConversation = false;
        }

        let handle;
        try {
            handle = await this.adapter.createSession({
                zeroContext: true,
                workingDirectory: this.workspaceRoot,
                initialPrompt: prompt,
                newConversation,
                ...(masterTaskId !== undefined && { masterTaskId }),
                phaseNumber: phase.id as number,
            });
        } catch (err) {
            log.error(`[ADKController] Failed to create session for phase ${phase.id}:`, err);
            this.emit('worker:crash', phase.id, err instanceof Error ? err : new Error(String(err)));
            return null;
        }

        // Register PID for orphan recovery
        await this.registerPID(phase.id, handle.pid);
        this.activePids.add(handle.pid);

        // Set up timeout
        const timeoutTimer = setTimeout(
            () => this.onTimeout(phase.id),
            timeoutMs
        );

        // Set up watchdog timer (idle detection)
        const watchdogTimer = this.createWatchdogTimer(phase.id);

        const worker: WorkerHandle = {
            handle,
            phaseId: phase.id,
            startedAt: Date.now(),
            timeoutTimer,
            watchdogTimer,
        };

        this.activeWorkers.set(phase.id, worker);

        // Wire output streams — S1-2 (EDGE-2): cap output size
        const outputSize = { stdout: 0, stderr: 0 };
        handle.onOutput((stream, chunk) => {
            const key = stream as 'stdout' | 'stderr';
            outputSize[key] += Buffer.byteLength(chunk, 'utf-8');

            if (outputSize[key] > MAX_WORKER_OUTPUT_BYTES) {
                if (outputSize[key] - Buffer.byteLength(chunk, 'utf-8') <= MAX_WORKER_OUTPUT_BYTES) {
                    // First time exceeding — emit truncation marker
                    this.emit('worker:output', phase.id, stream,
                        `\n[TRUNCATED: ${stream} exceeded ${MAX_WORKER_OUTPUT_BYTES} bytes]\n`);
                    log.warn(`[ADKController] Phase ${phase.id} ${stream} truncated at ${MAX_WORKER_OUTPUT_BYTES} bytes`);
                }
                // Drop further chunks for this stream
                return;
            }

            this.emit('worker:output', phase.id, stream, chunk);
            // Reset the watchdog timer on each output — process is still alive
            this.resetWatchdog(phase.id);
        });

        // Wire exit handler
        handle.onExit((exitCode) => {
            this.onExit(phase.id, exitCode);
        });

        return worker;
    }

    /**
     * Terminate a specific active worker.
     */
    async terminateWorker(phaseId: number, reason: string): Promise<void> {
        const worker = this.activeWorkers.get(phaseId);
        if (!worker) return;

        // Delete from map FIRST — blocks onExit re-entry during async termination.
        // This prevents the timeout/exit double-fire race (P1-1 fix).
        this.activeWorkers.delete(phaseId);
        clearTimeout(worker.timeoutTimer);
        clearTimeout(worker.watchdogTimer);

        try {
            await this.adapter.terminateSession(worker.handle);
        } catch (err) {
            log.error(`[ADKController] Terminate failed for phase ${phaseId} (${reason}):`, err);
        }

        // Remove PID from active set
        this.activePids.delete(worker.handle.pid);

        // Clean up PID file
        await this.unregisterPID(phaseId);

        log.info(
            `[ADKController] Worker terminated (phase=${phaseId}, reason=${reason})`
        );
    }

    /**
     * Terminate all active workers.
     */
    async terminateAll(reason: string): Promise<void> {
        // #36: Parallelize termination for faster shutdown
        await Promise.all(
            Array.from(this.activeWorkers.keys()).map(phaseId =>
                this.terminateWorker(phaseId, reason)
            )
        );
    }

    /** Get the active worker for a given phase (if any). */
    getActiveWorker(phaseId: number): WorkerHandle | undefined {
        return this.activeWorkers.get(phaseId);
    }

    /**
     * Kill ALL active worker processes using OS signals.
     * Sends SIGTERM first, then escalates to SIGKILL after 5s if the process
     * hasn't exited. This is the nuclear option — used on ABORT and extension shutdown.
     */
    async killAllWorkers(): Promise<void> {
        const pids = Array.from(this.activePids);
        if (pids.length === 0) return;

        log.info(`[ADKController] killAllWorkers: sending SIGTERM to ${pids.length} PIDs: [${pids.join(', ')}]`);

        // Phase 1: SIGTERM
        for (const pid of pids) {
            try {
                process.kill(pid, 'SIGTERM');
            } catch {
                // Process already dead — clean up
                this.activePids.delete(pid);
            }
        }

        // Wait 5s for graceful shutdown
        await new Promise<void>(resolve => setTimeout(resolve, 5000));

        // Phase 2: SIGKILL any survivors
        for (const pid of Array.from(this.activePids)) {
            try {
                process.kill(pid, 0); // Check if still alive
                process.kill(pid, 'SIGKILL');
                log.info(`[ADKController] Escalated to SIGKILL for PID ${pid}`);
            } catch {
                // Process already dead
            }
            this.activePids.delete(pid);
        }

        // Also terminate all tracked workers via the adapter (cleanup state)
        await this.terminateAll('KILL_ALL');
    }

    /**
     * Dispose the controller — called during extension deactivation.
     * Kills all remaining worker processes and clears all state.
     */
    async dispose(): Promise<void> {
        if (this._disposed) return;
        this._disposed = true;

        log.info('[ADKController] Disposing — killing all workers...');
        await this.killAllWorkers();
        this.removeAllListeners();
        log.info('[ADKController] Disposed.');
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Orphan Recovery
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Scan for stale PID files and terminate orphaned workers.
     * Called on extension activation.
     * W-5: Parallelized — sends all SIGTERMs first, single 5s wait, then SIGKILL survivors.
     */
    async cleanupOrphanedWorkers(): Promise<void> {
        try {
            await fs.mkdir(this.pidDir, { recursive: true });
            const pidFiles = await fs.readdir(this.pidDir);

            // Phase 0: Read all PID files and filter to live processes
            const entries: { file: string; pid: number }[] = [];
            for (const file of pidFiles) {
                const filePath = path.join(this.pidDir, file);
                const pid = parseInt(await fs.readFile(filePath, 'utf-8'), 10);
                if (isNaN(pid)) {
                    await fs.unlink(filePath).catch(() => { });
                    continue;
                }
                entries.push({ file, pid });
            }

            if (entries.length === 0) return;

            // Phase 1: SIGTERM all live orphans
            const liveOrphans: { file: string; pid: number }[] = [];
            for (const { file, pid } of entries) {
                try {
                    process.kill(pid, 0); // Check if process exists
                    process.kill(pid, 'SIGTERM');
                    log.info(`[ADKController] Sent SIGTERM to orphaned worker PID ${pid}`);
                    liveOrphans.push({ file, pid });
                } catch {
                    // Process already dead — just clean up PID file
                    await fs.unlink(path.join(this.pidDir, file)).catch(() => { });
                }
            }

            if (liveOrphans.length === 0) return;

            // Phase 2: Single 5s wait for graceful shutdown
            await new Promise<void>(resolve => setTimeout(resolve, 5000));

            // Phase 3: SIGKILL survivors and clean up all PID files
            for (const { file, pid } of liveOrphans) {
                try {
                    process.kill(pid, 0); // Still alive?
                    process.kill(pid, 'SIGKILL');
                    log.info(`[ADKController] Escalated to SIGKILL for PID ${pid}`);
                } catch {
                    // Process died from SIGTERM — good
                }
                await fs.unlink(path.join(this.pidDir, file)).catch(() => { });
            }
        } catch {
            // PID directory doesn't exist — nothing to clean
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Private Handlers
    // ═══════════════════════════════════════════════════════════════════════════

    private onExit(phaseId: number, exitCode: number): void {
        const worker = this.activeWorkers.get(phaseId);
        if (!worker) return;

        clearTimeout(worker.timeoutTimer);
        clearTimeout(worker.watchdogTimer);
        this.activePids.delete(worker.handle.pid);
        this.unregisterPID(phaseId).catch(() => { });
        this.activeWorkers.delete(phaseId);

        this.emit('worker:exited', phaseId, exitCode);
    }

    private onTimeout(phaseId: number): void {
        const worker = this.activeWorkers.get(phaseId);
        if (!worker) return;

        log.warn(`[ADKController] Worker timeout (phase=${phaseId})`);

        // Force terminate
        this.terminateWorker(phaseId, 'TIMEOUT').catch(log.onError);
        this.emit('worker:timeout', phaseId);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  PID Registry
    // ═══════════════════════════════════════════════════════════════════════════

    private async registerPID(phaseId: number, pid: number): Promise<void> {
        try {
            await fs.mkdir(this.pidDir, { recursive: true });
            await fs.writeFile(
                path.join(this.pidDir, `phase-${phaseId}.pid`),
                String(pid),
                { mode: 0o600 }
            );
        } catch (err) {
            log.error('[ADKController] PID registration failed:', err);
        }
    }

    private async unregisterPID(phaseId: number): Promise<void> {
        try {
            await fs.unlink(path.join(this.pidDir, `phase-${phaseId}.pid`));
        } catch {
            // Best-effort
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Watchdog — idle process detection
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Create a watchdog timer for a worker. Fires if no output is received
     * for `watchdogTimeoutMs`. Logs a warning and optionally kills the process.
     */
    private createWatchdogTimer(phaseId: number): ReturnType<typeof setTimeout> {
        if (this.watchdogTimeoutMs <= 0) {
            // Watchdog disabled
            return setTimeout(() => { }, 0);
        }
        return setTimeout(
            () => this.onWatchdogFired(phaseId),
            this.watchdogTimeoutMs
        );
    }

    /** Reset the watchdog timer for a worker (called on each output event). */
    private resetWatchdog(phaseId: number): void {
        const worker = this.activeWorkers.get(phaseId);
        if (!worker || this.watchdogTimeoutMs <= 0) return;

        clearTimeout(worker.watchdogTimer);
        worker.watchdogTimer = setTimeout(
            () => this.onWatchdogFired(phaseId),
            this.watchdogTimeoutMs
        );
    }

    /** Called when a worker has been idle for too long. */
    private onWatchdogFired(phaseId: number): void {
        const worker = this.activeWorkers.get(phaseId);
        if (!worker) return;

        const idleSec = Math.round(this.watchdogTimeoutMs / 1000);
        log.warn(
            `[ADKController] Watchdog: worker for phase ${phaseId} ` +
            `(PID ${worker.handle.pid}) has been idle for ${idleSec}s. Killing.`
        );

        // Kill the idle process
        this.terminateWorker(phaseId, 'WATCHDOG_IDLE').catch(log.onError);
        this.emit('worker:timeout', phaseId);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Prompt Builder
    // ═══════════════════════════════════════════════════════════════════════════

    private buildInjectionPrompt(
        phase: Phase,
        mcpResourceUris?: {
            executionPlan?: string;
            parentHandoffs?: string[];  // PLURAL — one URI per depends_on parent
        },
    ): string {
        // S1-4 (SEC-3, AI-5): Prompt injection detection
        // R1: When blockOnInjection is enabled, throw instead of warn-only.
        const injectionMatches: string[] = [];
        for (const pattern of INJECTION_PATTERNS) {
            if (pattern.test(phase.prompt)) {
                log.warn(
                    `[ADKController] ⚠ Potential prompt injection detected in phase ${phase.id}: ` +
                    `matched pattern ${pattern.source}`
                );
                injectionMatches.push(pattern.source);
            }
        }
        if (injectionMatches.length > 0 && this._blockOnInjection) {
            throw new PromptInjectionBlockedError(
                `Prompt injection detected in phase ${phase.id}: ` +
                `matched ${injectionMatches.length} pattern(s)`,
                injectionMatches,
            );
        }

        const sections: string[] = [
            `## Task`,
            phase.prompt,
            ``,
            `## Critical Rules`,
            `- **No piped output** — Do NOT pipe command output through another command (e.g., \`| cat\`, \`| tee\`, \`| grep\`). Run commands directly so built-in reporters and interactive features work correctly.`,
            `- **Scope expansion** — Begin by reviewing the known modified files. If verification exposes related issues in adjacent code or tests, make only the smallest necessary additional changes to restore correctness.`,
        ];

        // B-1: enforce the Pull Model / Pointer Method.
        // When the phase declares context_files, emit MCP tool-call directives
        // so the worker fetches content on demand — never inject raw file bytes.
        if (phase.context_files && phase.context_files.length > 0) {
            const fileUris = phase.context_files.map(
                (f) => `- \`get_modified_file_content\` → \`${f}\``
            );
            sections.push(
                ``,
                `## Required Context Reads`,
                `Read the following files using the available repository context tools (preferring \`get_modified_file_content\` when available) before making changes:`,
                ...fileUris
            );
        }

        // Append MCP context resources when available (warm-start injection)
        if (mcpResourceUris) {
            const uriLines: string[] = [];

            if (mcpResourceUris.executionPlan) {
                uriLines.push(`- Implementation Plan: ${mcpResourceUris.executionPlan}`);
            }
            // Iterate all parent handoff URIs — supports multi-dependency DAG phases
            if (mcpResourceUris.parentHandoffs && mcpResourceUris.parentHandoffs.length > 0) {
                mcpResourceUris.parentHandoffs.forEach((uri, idx) => {
                    uriLines.push(`- Parent Phase Handoff [${idx + 1}]: ${uri}`);
                });
            }

            if (uriLines.length > 0) {
                sections.push(
                    ``,
                    `## MCP Context Resources`,
                    `You have access to a local MCP server. Use these resource URIs to read context:`,
                    ...uriLines,
                    ``,
                    `Read the implementation plan resource before making changes. Base your work on retrieved repository context, not assumptions.`
                );
            }
        }

        return sections.join('\n');
    }
}
