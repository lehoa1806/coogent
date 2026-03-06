// ─────────────────────────────────────────────────────────────────────────────
// src/adk/ADKController.ts — Agent spawn, terminate, and lifecycle management
// ─────────────────────────────────────────────────────────────────────────────

import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Phase, ConversationSettings } from '../types/index.js';
import { DEFAULT_CONVERSATION_SETTINGS } from '../types/index.js';
import log from '../logger/log.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  ADK Adapter Interface (decoupled from real ADK)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Abstract interface over the Antigravity Agent Development Kit.
 * Decoupled from the real ADK to enable testing with MockADKAdapter.
 */
export interface IADKAdapter {
    /** Create an ephemeral agent session. */
    createSession(options: ADKSessionOptions): Promise<ADKSessionHandle>;
    /** Terminate an agent session. */
    terminateSession(handle: ADKSessionHandle): Promise<void>;
}

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
        /** URI to the master-level implementation plan. e.g. coogent://tasks/{id}/implementation_plan */
        implementationPlan?: string;
        /** URI to the parent phase's handoff artifact. e.g. coogent://tasks/{id}/phases/{parentPhaseId}/handoff */
        parentHandoff?: string;
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
}

export declare interface ADKController {
    on<K extends keyof ADKControllerEvents>(event: K, listener: ADKControllerEvents[K]): this;
    emit<K extends keyof ADKControllerEvents>(event: K, ...args: Parameters<ADKControllerEvents[K]>): boolean;
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
export class ADKController extends EventEmitter {
    private readonly activeWorkers = new Map<number, WorkerHandle>();
    private readonly activePids = new Set<number>();
    private readonly pidDir: string;
    private _conversationSettings: ConversationSettings = { ...DEFAULT_CONVERSATION_SETTINGS };

    /** Configurable idle timeout for the watchdog (ms). Default: 15 minutes. */
    private watchdogTimeoutMs = 900_000;
    private _disposed = false;

    constructor(
        private readonly adapter: IADKAdapter,
        private readonly workspaceRoot: string,
        pidDirName = '.coogent/pid'
    ) {
        super();
        this.pidDir = path.join(workspaceRoot, pidDirName);
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
        contextPayload: string,
        timeoutMs = 900_000,
        masterTaskId?: string,
        mcpResourceUris?: {
            implementationPlan?: string;
            parentHandoff?: string;
        }
    ): Promise<WorkerHandle | null> {
        // Limit check
        if (this.activeWorkers.size >= 4) {
            log.warn(`[ADKController] Max concurrent workers reached (4). Skipping phase ${phase.id}`);
            return null;
        }

        // Orphan/Duplicate prevention for this phase
        if (this.activeWorkers.has(phase.id)) {
            await this.terminateWorker(phase.id, 'ORPHAN_PREVENTION');
        }

        const prompt = this.buildInjectionPrompt(phase, contextPayload, mcpResourceUris);

        // Determine if a new conversation should be started based on mode
        let newConversation = false;
        const adapterAny = this.adapter as any;
        if (typeof adapterAny.shouldStartNewConversation === 'function') {
            newConversation = adapterAny.shouldStartNewConversation(
                this._conversationSettings.mode,
                prompt.length,
                this._conversationSettings.smartSwitchTokenThreshold
            );
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

        // Wire output streams
        handle.onOutput((stream, chunk) => {
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
     */
    async cleanupOrphanedWorkers(): Promise<void> {
        try {
            await fs.mkdir(this.pidDir, { recursive: true });
            const pidFiles = await fs.readdir(this.pidDir);

            for (const file of pidFiles) {
                const filePath = path.join(this.pidDir, file);
                const pid = parseInt(await fs.readFile(filePath, 'utf-8'), 10);

                if (isNaN(pid)) {
                    await fs.unlink(filePath).catch(() => { });
                    continue;
                }

                try {
                    process.kill(pid, 0); // Check if process exists
                    // #35: SIGTERM first for graceful shutdown
                    process.kill(pid, 'SIGTERM');
                    log.info(`[ADKController] Sent SIGTERM to orphaned worker PID ${pid}`);

                    // Wait 5s then escalate to SIGKILL if still alive
                    await new Promise<void>(resolve => setTimeout(resolve, 5000));
                    try {
                        process.kill(pid, 0); // Still alive?
                        process.kill(pid, 'SIGKILL');
                        log.info(`[ADKController] Escalated to SIGKILL for PID ${pid}`);
                    } catch {
                        // Process died from SIGTERM — good
                    }
                } catch {
                    // Process already dead — just clean up
                }

                await fs.unlink(filePath).catch(() => { });
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
        contextPayload: string,
        mcpResourceUris?: {
            implementationPlan?: string;
            parentHandoff?: string;
        }
    ): string {
        const sections: string[] = [
            `## Task`,
            phase.prompt,
            ``,
            `## Context Files`,
            `The following files are provided for reference. Work ONLY with these files.`,
            ``,
            contextPayload,
        ];

        // Append MCP context resources when available (warm-start injection)
        if (mcpResourceUris) {
            const uriLines: string[] = [];

            if (mcpResourceUris.implementationPlan) {
                uriLines.push(`- Implementation Plan: ${mcpResourceUris.implementationPlan}`);
            }
            if (mcpResourceUris.parentHandoff) {
                uriLines.push(`- Parent Phase Handoff: ${mcpResourceUris.parentHandoff}`);
            }

            if (uriLines.length > 0) {
                sections.push(
                    ``,
                    `## MCP Context Resources`,
                    `You have access to a local MCP server. Use these resource URIs to read context:`,
                    ...uriLines,
                    `DO NOT GUESS context. Read these resources to understand your task.`
                );
            }
        }

        return sections.join('\n');
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Mock ADK Adapter (for testing)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Mock ADK adapter that simulates agent behavior for testing.
 * Immediately exits with code 0 after a configurable delay.
 */
export class MockADKAdapter implements IADKAdapter {
    private sessionCounter = 0;
    private pidCounter = 90_000;

    constructor(
        private readonly exitDelay = 100,
        private readonly exitCode = 0
    ) { }

    async createSession(options: ADKSessionOptions): Promise<ADKSessionHandle> {
        const sessionId = `mock-${++this.sessionCounter}`;
        let outputCallback: ((stream: 'stdout' | 'stderr', chunk: string) => void) | null = null;
        let exitCallback: ((code: number) => void) | null = null;

        // Determine if this is a planner session (needs JSON runbook output)
        const isPlannerSession = options.initialPrompt.includes('Planning Agent')
            || options.initialPrompt.includes('## JSON Schema');

        // Simulate async agent work
        setTimeout(() => {
            if (outputCallback) {
                if (isPlannerSession) {
                    // Extract a project slug from the prompt if possible
                    const slugMatch = options.initialPrompt.match(/## User Request\n(.+)/);
                    const slug = slugMatch
                        ? slugMatch[1].slice(0, 40).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '')
                        : 'mock-project';

                    // Return a valid JSON runbook so the planner can parse it
                    outputCallback('stdout', '```json\n');
                    outputCallback('stdout', JSON.stringify({
                        project_id: slug,
                        status: 'idle',
                        current_phase: 1,
                        phases: [
                            {
                                id: 1,
                                status: 'pending',
                                prompt: 'Implement the requested changes based on the user\'s requirements.',
                                context_files: [],
                                success_criteria: 'exit_code:0',
                            },
                        ],
                    }, null, 2));
                    outputCallback('stdout', '\n```\n');
                } else {
                    outputCallback('stdout', `[Mock] Executing: ${options.initialPrompt.slice(0, 100)}...\n`);
                    outputCallback('stdout', `[Mock] Task completed successfully.\n`);
                }
            }
            if (exitCallback) {
                exitCallback(this.exitCode);
            }
        }, this.exitDelay);

        return {
            sessionId,
            pid: ++this.pidCounter, // Counter-based fake PID (avoids colliding with real PIDs)
            onOutput(cb) { outputCallback = cb; },
            onExit(cb) { exitCallback = cb; },
        };
    }

    async terminateSession(_handle: ADKSessionHandle): Promise<void> {
        // No-op for mock
    }
}
