// ─────────────────────────────────────────────────────────────────────────────
// src/adk/AntigravityADKAdapter.ts — ADK adapter: file-based IPC with Antigravity chat
// ─────────────────────────────────────────────────────────────────────────────

import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AgentBackendProvider } from './AgentBackendProvider.js';
import type { ADKSessionOptions, ADKSessionHandle } from './ADKController.js';
import type { ConversationMode } from '../types/index.js';
import { CharRatioEncoder, type TokenEncoder } from '../context/ContextScoper.js';
import { FileStabilityWatcher } from './FileStabilityWatcher.js';
import { COOGENT_DIR, IPC_DIR, IPC_RESPONSE_FILE, RUNBOOK_FILE } from '../constants/paths.js';
import log from '../logger/log.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Execution Mode (centralized in ExecutionModeResolver)
// ═══════════════════════════════════════════════════════════════════════════════

import {
    type ExecutionMode,
    type ModeDetectionResult,
    getExecutionMode,
    getExecutionModeSync,
} from './ExecutionModeResolver.js';

/** @deprecated Use `ExecutionMode` from `./ExecutionModeResolver.js` directly. */
export type { ExecutionMode } from './ExecutionModeResolver.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Active Session Tracking (for cancellation)
// ═══════════════════════════════════════════════════════════════════════════════

interface ActiveSession {
    sessionId: string;
    cts: vscode.CancellationTokenSource;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Configuration
// ═══════════════════════════════════════════════════════════════════════════════

/** Default timeout for waiting for the response file (ms). */
const RESPONSE_TIMEOUT_MS = 900_000;

/** How often to poll for file-stability (ms). */
const STABILITY_POLL_MS = 1_000;

/** How long the file must remain unchanged to be considered "done" (ms). */
const STABILITY_THRESHOLD_MS = 1_500;

/** IPC subdirectory under the workspace — composed from COOGENT_DIR + IPC_DIR constants. */
const IPC_DIR_NAME = COOGENT_DIR + '/' + IPC_DIR;

/** Small delay after injection to let VS Code process the command before the next session. */

/** Delay after startNewConversation to let the chat panel fully initialize (ms). */
const NEW_CONVERSATION_SETTLE_MS = 500;
const INJECTION_STAGGER_MS = 200;

// ═══════════════════════════════════════════════════════════════════════════════
//  UUIDv7 Generator (time-ordered, no external dependency)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Generate a UUIDv7-style identifier: 48-bit timestamp + 80-bit random.
 * Time-ordered for easy sorting/cleanup of IPC files.
 */
function uuidv7(): string {
    const now = Date.now();
    const timeHex = now.toString(16).padStart(12, '0');
    const rand = randomBytes(10).toString('hex');
    // Format: tttttttt-tttt-7rrr-rrrr-rrrrrrrrrrrr
    return [
        timeHex.slice(0, 8),
        timeHex.slice(8, 12),
        '7' + rand.slice(0, 3),
        ((parseInt(rand.slice(3, 4), 16) & 0x3) | 0x8).toString(16) + rand.slice(4, 7),
        rand.slice(7, 19),
    ].join('-');
}

// ═══════════════════════════════════════════════════════════════════════════════
//  AntigravityADKAdapter
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * ADK adapter that communicates with the Antigravity chat agent via file-based IPC.
 *
 * Strategy (dual-path):
 *   1. **Primary — `vscode.lm` API**: If a language model is available (e.g.,
 *      GitHub Copilot Chat), streams the response directly. This is the fastest path.
 *
 *   2. **File-based IPC via chat**: If no `vscode.lm` model exists, opens the
 *      Antigravity chat with the full prompt injected directly into the
 *      conversation and watches for a response file.
 *
 * Execution mode is resolved centrally by `ExecutionModeResolver`.
 * Three certified modes: `vscode-native`, `cursor`, `antigravity`.
 * Unsupported hosts resolve to `unsupported`.
 *
 * Each `createSession()` call returns immediately with an `ADKSessionHandle`.
 * The actual work runs asynchronously.
 */
export class AntigravityADKAdapter implements AgentBackendProvider {
    readonly name = 'antigravity';
    private activeSessions = new Map<string, ActiveSession>();
    private readonly ipcDir: string;

    /** S3-3: Shared token encoder for consistent estimation across pipeline. */
    private readonly tokenEncoder: TokenEncoder;

    /** Cached mode detection result — resolved lazily on first query. */
    private cachedModeResult: ModeDetectionResult | null = null;

    // ── Dispatch serialization ───────────────────────────────────────────────
    /**
     * Serialization lock: ensures `startNewConversation()` + `injectIntoChatPanel()`
     * are atomic. Without this, parallel DAG phases race on the single chat panel,
     * causing prompts to be injected into the wrong conversation or lost entirely.
     */
    private dispatchLock: Promise<void> = Promise.resolve();

    // ── Conversation mode state ──────────────────────────────────────────────
    /** Running estimate of tokens pumped into the current conversation. */
    private conversationTokens = 0;

    constructor(workspaceRoot: string, tokenEncoder?: TokenEncoder) {
        this.ipcDir = path.join(workspaceRoot, IPC_DIR_NAME);
        this.tokenEncoder = tokenEncoder ?? new CharRatioEncoder();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Execution Mode Detection
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Determine the current execution mode.
     *
     * Delegates to the centralized `ExecutionModeResolver` which probes VS Code
     * APIs to detect one of three certified modes:
     *   - `vscode-native`: LM API + Copilot models available
     *   - `cursor`: Cursor extension + chat command available
     *   - `antigravity`: Antigravity extension + agent/chat command available
     *   - `unsupported`: None of the above detected
     *
     * Result is cached for the lifetime of the adapter instance.
     */
    public async getExecutionMode(): Promise<ExecutionMode> {
        if (!this.cachedModeResult) {
            this.cachedModeResult = await getExecutionMode();
            log.info(`[AntigravityADKAdapter] ExecutionMode resolved: ${this.cachedModeResult.mode} (host: ${this.cachedModeResult.host})`);
        }
        return this.cachedModeResult.mode;
    }

    /**
     * Synchronous getter for callers that need the mode after it has been resolved.
     * Returns null if neither the adapter nor the global resolver has been called yet.
     */
    public getExecutionModeSync(): ExecutionMode | null {
        return this.cachedModeResult?.mode ?? getExecutionModeSync()?.mode ?? null;
    }

    async createSession(options: ADKSessionOptions): Promise<ADKSessionHandle> {
        // ── Serialize through dispatchLock ────────────────────────────────────
        // Parallel DAG phases call createSession() concurrently. The chat panel
        // is a single shared resource — `startNewConversation()` + `injectIntoChatPanel()`
        // MUST be atomic. The lock guarantees sequential dispatch.
        const previousLock = this.dispatchLock;
        let releaseLock!: () => void;
        this.dispatchLock = new Promise<void>(resolve => { releaseLock = resolve; });
        await previousLock;

        try {
            return await this._createSessionInner(options);
        } finally {
            releaseLock();
        }
    }

    /**
     * Inner session-creation logic, called under the dispatch lock.
     * Separated to keep the lock acquire/release in createSession() clean.
     */
    private async _createSessionInner(options: ADKSessionOptions): Promise<ADKSessionHandle> {
        const sessionId = uuidv7();
        log.info(`[AntigravityADK] Creating session ${sessionId}`);
        log.info(`[AntigravityADK] Prompt length: ${options.initialPrompt.length} chars`);

        // Handle conversation mode: start new conversation if needed
        if (options.newConversation) {
            await this.startNewConversation();
        }

        // Track token usage
        const estimatedTokens = this.tokenEncoder.countTokens(options.initialPrompt);
        this.conversationTokens += estimatedTokens;
        log.info(`[AntigravityADK] Conversation tokens: ${this.conversationTokens} (+${estimatedTokens})`);

        // Create a cancellation token for this session
        const cts = new vscode.CancellationTokenSource();
        const session: ActiveSession = { sessionId, cts };
        this.activeSessions.set(sessionId, session);

        // ─── Path A: vscode.lm API (primary) ────────────────────────────────
        const model = await this.tryVscodeLm(cts);

        if (model) {
            log.info(`[AntigravityADK] ✅ vscode.lm primary: using model ${model.name} (${model.id})`);
            return this.createLmSession(sessionId, model, options, cts);
        }

        log.info(`[AntigravityADK] ⚠️ No vscode.lm model available, using file-based IPC...`);

        // ─── Path B: File-based IPC via Antigravity chat ────────────────────
        // createFileIpcSession is async — it completes the file-write + chat
        // injection before returning, so the lock covers the critical section.
        return await this.createFileIpcSession(sessionId, options, session);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Path A: vscode.lm — Primary
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Attempt to acquire a language model via the vscode.lm API.
     * Returns the first available model, or null if none found.
     */
    private async tryVscodeLm(
        _cts: vscode.CancellationTokenSource
    ): Promise<vscode.LanguageModelChat | null> {
        try {
            const models = await vscode.lm.selectChatModels({});
            if (models.length > 0) {
                log.info(`[AntigravityADK] vscode.lm found ${models.length} model(s): ` +
                    models.map(m => `${m.name}(${m.id})`).join(', '));
                return models[0];
            }
            log.info(`[AntigravityADK] vscode.lm: no models returned`);
        } catch (err) {
            log.info(`[AntigravityADK] vscode.lm unavailable:`, err);
        }
        return null;
    }

    /**
     * Create a session using the vscode.lm API (primary path).
     * Streams the model's response chunk-by-chunk via the onOutput callback.
     */
    private createLmSession(
        sessionId: string,
        model: vscode.LanguageModelChat,
        options: ADKSessionOptions,
        cts: vscode.CancellationTokenSource
    ): ADKSessionHandle {
        let outputCallback: ((stream: 'stdout' | 'stderr', chunk: string) => void) | null = null;
        let exitCallback: ((code: number) => void) | null = null;

        const messages = [
            vscode.LanguageModelChatMessage.User(options.initialPrompt),
        ];

        const runSession = async () => {
            try {
                log.info(`[AntigravityADK] LM session ${sessionId}: sending request...`);
                const response = await model.sendRequest(messages, {}, cts.token);
                let chunkCount = 0;
                let totalChars = 0;

                for await (const chunk of response.text) {
                    if (cts.token.isCancellationRequested) break;
                    chunkCount++;
                    totalChars += chunk.length;
                    outputCallback?.('stdout', chunk);
                }

                if (!cts.token.isCancellationRequested) {
                    log.info(`[AntigravityADK] LM session ${sessionId}: completed (${chunkCount} chunks, ${totalChars} chars)`);
                    exitCallback?.(0);
                } else {
                    log.info(`[AntigravityADK] LM session ${sessionId}: cancelled`);
                    exitCallback?.(1);
                }
            } catch (err: unknown) {
                if (cts.token.isCancellationRequested) {
                    exitCallback?.(1);
                    return;
                }
                const message = err instanceof Error ? err.message : String(err);
                log.error(`[AntigravityADK] LM session ${sessionId} ERROR:`, message);
                outputCallback?.('stderr', `[AntigravityADK Error] ${message}\n`);
                exitCallback?.(1);
            } finally {
                this.activeSessions.delete(sessionId);
            }
        };

        // Kick off after onOutput/onExit are registered
        setImmediate(() => runSession());

        return {
            sessionId,
            pid: process.pid,
            onOutput(cb) { outputCallback = cb; },
            onExit(cb) { exitCallback = cb; },
        };
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Path B: File-Based IPC via Antigravity Chat
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Create a session using file-based IPC:
     *   1. Write prompt to a request file.
     *   2. Open the chat with a meta-prompt instructing the agent to respond via file.
     *   3. Watch for the response file, read it when stable.
     *
     * The file-write + chat-injection steps execute synchronously (awaited) so
     * the dispatch lock in createSession() covers the full critical section.
     * Only the response-watching phase runs in the background.
     */
    private async createFileIpcSession(
        sessionId: string,
        options: ADKSessionOptions,
        session: ActiveSession
    ): Promise<ADKSessionHandle> {
        let outputCallback: ((stream: 'stdout' | 'stderr', chunk: string) => void) | null = null;
        let exitCallback: ((code: number) => void) | null = null;

        // Build hierarchical path: .coogent/ipc/<masterTaskId>/phase-NNN-<subTaskId>/
        const subTaskName = options.phaseNumber != null
            ? `phase-${String(options.phaseNumber).padStart(3, '0')}-${sessionId}`
            : sessionId;
        const subDir = options.masterTaskId
            ? path.join(this.ipcDir, options.masterTaskId, subTaskName)
            : path.join(this.ipcDir, subTaskName);
        const responseFile = path.join(subDir, IPC_RESPONSE_FILE);
        const masterDir = options.masterTaskId
            ? path.join(this.ipcDir, options.masterTaskId)
            : subDir;
        const runbookFile = path.join(masterDir, RUNBOOK_FILE);

        // ── Critical section: chat injection ─────────────────────────────────
        // These steps MUST complete before the next session starts, otherwise
        // the next session's startNewConversation() replaces the active chat
        // panel and this session's prompt targets the wrong conversation.

        // Step 1: Ensure sub-task directory exists (for response.md)
        await fs.mkdir(subDir, { recursive: true });

        // Step 2: Build the injection prompt — the full task prompt + persistence contract.
        // The prompt is injected directly into the chat conversation; no request.md is written.
        // Only response.md serves as the file-based completion signal.
        const injectionPrompt = [
            options.initialPrompt,
            '',
            '## Orchestration Persistence Contract (Runtime Metadata — Non-Output)',
            'This section is runtime metadata for the orchestration system. Do not include it in the runbook.',
            'The orchestration runtime must persist artifacts in this order:',
            '1. Parse and validate the planner output as runbook JSON',
            `2. Store the validated runbook at: ${runbookFile}`,
            `3. Store the planner's raw output at: ${responseFile}`,
            'The runbook file must exist on disk before the response file is written, because the response file is the completion signal.'
        ].join('\n');

        // Step 3: Inject the full prompt directly into the chat panel
        log.info(`[AntigravityADK] Injecting prompt directly into chat (${injectionPrompt.length} chars)...`);
        const injected = await this.injectIntoChatPanel(injectionPrompt);
        if (!injected) {
            // Return a dead handle — callbacks fire immediately on registration
            this.cleanupSession(sessionId);
            return {
                sessionId,
                pid: process.pid,
                onOutput() { /* dead handle */ },
                onExit(cb) { cb(1); },
            };
        }

        // Brief stagger so the chat panel registers the prompt before
        // the next session's startNewConversation() switches conversations.
        await new Promise(r => setTimeout(r, INJECTION_STAGGER_MS));

        // ── Non-critical: response watching runs in background ───────────────
        const waitForResponse = async () => {
            try {
                // Step 5: Watch for the response file
                log.info(`[AntigravityADK] Waiting for response file: ${responseFile}`);
                const watcher = new FileStabilityWatcher();
                const content = await watcher.waitForStableFile(
                    responseFile,
                    {
                        timeoutMs: RESPONSE_TIMEOUT_MS,
                        pollMs: STABILITY_POLL_MS,
                        stabilityThresholdMs: STABILITY_THRESHOLD_MS,
                        cancellationToken: session.cts.token,
                    },
                );

                if (session.cts.token.isCancellationRequested) {
                    log.info(`[AntigravityADK] Session ${sessionId} was cancelled`);
                    exitCallback?.(1);
                    return;
                }

                if (content === null) {
                    const msg = `Timeout waiting for AI response file (${RESPONSE_TIMEOUT_MS / 1000}s). `
                        + `The chat agent may not have written to: ${responseFile}`;
                    log.error(`[AntigravityADK] ${msg}`);
                    outputCallback?.('stderr', `[AntigravityADK] ${msg}\n`);
                    exitCallback?.(1);
                } else {
                    log.info(`[AntigravityADK] ✅ Response captured: ${content.length} chars`);
                    outputCallback?.('stdout', content);
                    exitCallback?.(0);
                }
            } catch (err: unknown) {
                if (session.cts.token.isCancellationRequested) {
                    exitCallback?.(1);
                    return;
                }
                const message = err instanceof Error ? err.message : String(err);
                log.error(`[AntigravityADK] IPC session ${sessionId} ERROR:`, message);
                outputCallback?.('stderr', `[AntigravityADK Error] ${message}\n`);
                exitCallback?.(1);
            } finally {
                this.cleanupSession(sessionId);
            }
        };

        // Kick off after onOutput/onExit are registered
        setImmediate(() => waitForResponse());

        return {
            sessionId,
            pid: process.pid,
            onOutput(cb) { outputCallback = cb; },
            onExit(cb) { exitCallback = cb; },
        };
    }



    // ═══════════════════════════════════════════════════════════════════════════
    //  Chat Injection
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Inject a prompt into the Antigravity chat panel.
     * Uses the recommended `antigravity.sendPromptToAgentPanel` command,
     * with `workbench.action.chat.open` as a fallback.
     * Returns true if injected successfully.
     */
    private async injectIntoChatPanel(prompt: string): Promise<boolean> {
        // Primary: antigravity.sendPromptToAgentPanel (recommended launch pattern)
        try {
            await vscode.commands.executeCommand('antigravity.sendPromptToAgentPanel', prompt);
            log.info(`[AntigravityADK] ✅ Injected via antigravity.sendPromptToAgentPanel`);
            return true;
        } catch (err) {
            log.warn(`[AntigravityADK] sendPromptToAgentPanel failed:`, err);
        }

        // Fallback: standard VSCode Chat API
        try {
            await vscode.commands.executeCommand('workbench.action.chat.open', {
                mode: 'agent',
                query: prompt,
            });
            log.info(`[AntigravityADK] ✅ Injected via workbench.action.chat.open`);
            return true;
        } catch (err) {
            log.error(`[AntigravityADK] ❌ All chat injection methods failed:`, err);
            return false;
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Conversation Mode Support
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Start a new conversation in the Antigravity chat panel.
     * Uses `antigravity.startNewConversation` command with fallback.
     */
    async startNewConversation(): Promise<void> {
        log.info(`[AntigravityADK] Starting new conversation...`);

        try {
            await vscode.commands.executeCommand('antigravity.startNewConversation');
            log.info(`[AntigravityADK] ✅ New conversation via antigravity.startNewConversation`);
        } catch (err) {
            log.warn(`[AntigravityADK] startNewConversation failed, trying fallback:`, err);
            try {
                // Fallback: open a fresh chat via standard API (no query = fresh)
                await vscode.commands.executeCommand('workbench.action.chat.open', {
                    mode: 'agent',
                });
                log.info(`[AntigravityADK] ✅ New conversation via workbench.action.chat.open`);
            } catch (err2) {
                log.error(`[AntigravityADK] ❌ Failed to start new conversation:`, err2);
            }
        }

        // Settlement delay: the VS Code command resolves when dispatched,
        // not when the new conversation panel is fully initialized.
        // Without this, the next prompt injection may target the old conversation.
        await new Promise(r => setTimeout(r, NEW_CONVERSATION_SETTLE_MS));
        log.info(`[AntigravityADK] New conversation settled (${NEW_CONVERSATION_SETTLE_MS}ms)`);

        this.conversationTokens = 0;
    }

    /**
     * Determine if a new conversation should be started before the next subtask.
     * Decision logic:
     * - `isolated`: always `true`
     * - `continuous`: always `false`
     * - `smart`: `true` when cumulative tokens + estimated tokens exceed threshold
     */
    shouldStartNewConversation(
        mode: ConversationMode,
        promptLength: number,
        threshold: number
    ): boolean {
        switch (mode) {
            case 'isolated':
                return true;
            case 'continuous':
                return false;
            case 'smart': {
                const estimated = this.tokenEncoder.countTokens('x'.repeat(promptLength));
                const wouldExceed = (this.conversationTokens + estimated) > threshold;
                log.info(
                    `[AntigravityADK] Smart switch: current=${this.conversationTokens}, ` +
                    `incoming=${estimated}, threshold=${threshold}, switch=${wouldExceed}`
                );
                return wouldExceed;
            }
            default:
                return true;
        }
    }

    /** Reset the conversation token counter (called after starting a new conversation). */
    resetTokenCounter(): void {
        this.conversationTokens = 0;
    }

    /** Get the current cumulative token estimate for the active conversation. */
    getConversationTokens(): number {
        return this.conversationTokens;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Session Management
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Clean up session resources.
     */
    private cleanupSession(sessionId: string): void {
        const session = this.activeSessions.get(sessionId);
        if (!session) return;

        this.activeSessions.delete(sessionId);

        // IPC files are preserved for audit/debugging — no cleanup.
    }

    async terminateSession(handle: ADKSessionHandle): Promise<void> {
        const session = this.activeSessions.get(handle.sessionId);
        if (session) {
            session.cts.cancel();
            session.cts.dispose();
            this.cleanupSession(handle.sessionId);
            log.info(`[AntigravityADK] Terminated session ${handle.sessionId}`);
        }
    }

    /**
     * TTL-based IPC cleanup: delete session directories older than 7 days.
     * Parses the UUIDv7 timestamp embedded in the directory name to determine age.
     * Preserves the current session and any directories younger than the TTL.
     */
    async cleanupAllIpc(): Promise<void> {
        const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
        const cutoff = Date.now() - TTL_MS;
        const SESSION_DIR_REGEX = /^\d{8}-\d{6}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

        let entries: import('node:fs').Dirent[];
        try {
            entries = await fs.readdir(this.ipcDir, { withFileTypes: true });
        } catch {
            // ipcDir may not exist yet — nothing to clean
            log.info('[AntigravityADK] cleanupAllIpc(): ipc directory not found, skipping.');
            return;
        }

        let cleaned = 0;
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const match = entry.name.match(SESSION_DIR_REGEX);
            if (!match) continue;

            // Extract timestamp from UUIDv7 portion
            const uuid = match[1];
            const parts = uuid.split('-');
            if (parts.length < 2) continue;
            const tsMs = parseInt(parts[0] + parts[1], 16) || 0;

            if (tsMs > 0 && tsMs < cutoff) {
                const dirPath = path.join(this.ipcDir, entry.name);
                try {
                    await fs.rm(dirPath, { recursive: true, force: true });
                    cleaned++;
                } catch (err) {
                    log.warn(`[AntigravityADK] Failed to clean IPC dir ${entry.name}:`, err);
                }
            }
        }

        log.info(`[AntigravityADK] cleanupAllIpc(): cleaned ${cleaned} old session(s).`);
    }
}
