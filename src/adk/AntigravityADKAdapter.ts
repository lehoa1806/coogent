// ─────────────────────────────────────────────────────────────────────────────
// src/adk/AntigravityADKAdapter.ts — ADK adapter: file-based IPC with Antigravity chat
// ─────────────────────────────────────────────────────────────────────────────

import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { watch, type FSWatcher } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { IADKAdapter, ADKSessionOptions, ADKSessionHandle } from './ADKController.js';
import type { ConversationMode } from '../types/index.js';
import log from '../logger/log.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Active Session Tracking (for cancellation)
// ═══════════════════════════════════════════════════════════════════════════════

interface ActiveSession {
    sessionId: string;
    cts: vscode.CancellationTokenSource;
    watcher?: FSWatcher;
    pollTimer?: ReturnType<typeof setInterval>;
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

/** IPC subdirectory under the workspace. */
const IPC_DIR_NAME = '.coogent/ipc';

/** Approximate chars-per-token ratio for token estimation. */
const CHARS_PER_TOKEN = 4;

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
 *   2. **File-based IPC via chat**: If no `vscode.lm` model exists:
 *      a. Writes the prompt to a request file.
 *      b. Opens the Antigravity chat with a meta-prompt instructing the agent
 *         to read the request file and write its response to a response file.
 *      c. Watches the filesystem for the response file to appear and stabilize.
 *      d. Reads the response, emits it via `onOutput`, calls `onExit(0)`.
 *
 * Each `createSession()` call returns immediately with an `ADKSessionHandle`.
 * The actual work runs asynchronously.
 */
export class AntigravityADKAdapter implements IADKAdapter {
    private activeSessions = new Map<string, ActiveSession>();
    private readonly ipcDir: string;

    // ── Conversation mode state ──────────────────────────────────────────────
    /** Running estimate of tokens pumped into the current conversation. */
    private conversationTokens = 0;

    constructor(workspaceRoot: string) {
        this.ipcDir = path.join(workspaceRoot, IPC_DIR_NAME);
    }

    async createSession(options: ADKSessionOptions): Promise<ADKSessionHandle> {
        const sessionId = uuidv7();
        log.info(`[AntigravityADK] Creating session ${sessionId}`);
        log.info(`[AntigravityADK] Prompt length: ${options.initialPrompt.length} chars`);

        // Handle conversation mode: start new conversation if needed
        if (options.newConversation) {
            await this.startNewConversation();
        }

        // Track token usage
        const estimatedTokens = Math.ceil(options.initialPrompt.length / CHARS_PER_TOKEN);
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
        return this.createFileIpcSession(sessionId, options, session);
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
     */
    private createFileIpcSession(
        sessionId: string,
        options: ADKSessionOptions,
        session: ActiveSession
    ): ADKSessionHandle {
        let outputCallback: ((stream: 'stdout' | 'stderr', chunk: string) => void) | null = null;
        let exitCallback: ((code: number) => void) | null = null;

        // Build hierarchical path: .coogent/ipc/<masterTaskId>/phase-NNN-<subTaskId>/
        const subTaskName = options.phaseNumber != null
            ? `phase-${String(options.phaseNumber).padStart(3, '0')}-${sessionId}`
            : sessionId;
        const subDir = options.masterTaskId
            ? path.join(this.ipcDir, options.masterTaskId, subTaskName)
            : path.join(this.ipcDir, subTaskName);
        const requestFile = path.join(subDir, 'request.md');
        const responseFile = path.join(subDir, 'response.md');

        const runIpcSession = async () => {
            try {
                // Step 1: Ensure sub-task directory exists
                await fs.mkdir(subDir, { recursive: true });

                // Step 2: Write the prompt to the request file
                await fs.writeFile(requestFile, options.initialPrompt, 'utf-8');
                log.info(`[AntigravityADK] IPC request written: ${requestFile} (${options.initialPrompt.length} chars)`);

                // Step 3: Build the meta-prompt for the chat agent
                // Use ABSOLUTE paths — relative paths broke when the agent's
                // working directory differed from the VS Code workspace root.
                const metaPrompt = [
                    `Read the instructions from the file: ${requestFile}`,
                    `Follow those instructions carefully.`,
                    `Write your COMPLETE response to the file: ${responseFile}`,
                    `Output ONLY the content — no explanation, no markdown code fences wrapping the file write.`,
                    `Use the file editing tools to create/write to ${responseFile}.`,
                ].join('\n');

                // Step 4: Inject the meta-prompt into the chat panel
                log.info(`[AntigravityADK] Injecting meta-prompt into chat...`);
                const injected = await this.injectIntoChatPanel(metaPrompt);
                if (!injected) {
                    outputCallback?.('stderr', `[AntigravityADK] Failed to inject meta-prompt into chat\n`);
                    exitCallback?.(1);
                    this.cleanupSession(sessionId);
                    return;
                }

                // Step 5: Watch for the response file
                log.info(`[AntigravityADK] Waiting for response file: ${responseFile}`);
                const content = await this.waitForResponseFile(
                    responseFile,
                    session,
                    RESPONSE_TIMEOUT_MS
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
        setImmediate(() => runIpcSession());

        return {
            sessionId,
            pid: process.pid,
            onOutput(cb) { outputCallback = cb; },
            onExit(cb) { exitCallback = cb; },
        };
    }

    /**
     * Watch for a response file to appear and stabilize (no writes for STABILITY_THRESHOLD_MS).
     * Returns the file content, or null on timeout/cancellation.
     */
    private async waitForResponseFile(
        responseFile: string,
        session: ActiveSession,
        timeoutMs: number
    ): Promise<string | null> {
        return new Promise<string | null>((resolve) => {
            const dir = path.dirname(responseFile);
            const basename = path.basename(responseFile);
            let lastSize = -1;
            let lastSizeTime = 0;
            let resolved = false;

            let stabilityRecheck: ReturnType<typeof setTimeout> | null = null;
            const cleanup = () => {
                if (session.watcher) {
                    session.watcher.close();
                    delete session.watcher;
                }
                if (session.pollTimer) {
                    clearInterval(session.pollTimer);
                    delete session.pollTimer;
                }
                if (stabilityRecheck) {
                    clearTimeout(stabilityRecheck);
                    stabilityRecheck = null;
                }
                clearTimeout(timeoutHandle);
            };

            const finish = (result: string | null) => {
                if (resolved) return;
                resolved = true;
                cleanup();
                resolve(result);
            };

            // Timeout handler
            const timeoutHandle = setTimeout(() => {
                log.info(`[AntigravityADK] Response file timeout after ${timeoutMs}ms`);
                finish(null);
            }, timeoutMs);

            // Cancellation handler
            session.cts.token.onCancellationRequested(() => {
                finish(null);
            });

            // Check if the file is "stable" (written and no longer changing)
            const checkStability = async () => {
                if (resolved || session.cts.token.isCancellationRequested) return;

                try {
                    const stat = await fs.stat(responseFile);
                    const size = stat.size;

                    if (size === 0) {
                        // File exists but is empty — agent hasn't written yet
                        lastSize = 0;
                        lastSizeTime = Date.now();
                        return;
                    }

                    if (size !== lastSize) {
                        // File is still being written
                        lastSize = size;
                        lastSizeTime = Date.now();
                        return;
                    }

                    // Size hasn't changed — check if stable long enough
                    if (Date.now() - lastSizeTime >= STABILITY_THRESHOLD_MS) {
                        log.info(`[AntigravityADK] Response file stable at ${size} bytes`);
                        const content = await fs.readFile(responseFile, 'utf-8');
                        if (content.trim().length > 0) {
                            finish(content);
                        }
                        // If empty after stability, keep waiting (agent might rewrite)
                    }
                } catch {
                    // File doesn't exist yet — keep waiting
                }
            };

            // Set up fs.watch for fast detection of file creation
            let stabilityTimer: ReturnType<typeof setTimeout> | null = null;
            try {
                session.watcher = watch(dir, (_eventType, filename) => {
                    if (filename === basename) {
                        checkStability().catch(() => { });
                        // Schedule a deferred re-check to guarantee the stability
                        // window is fully evaluated even if no poll aligns with it.
                        if (stabilityTimer) clearTimeout(stabilityTimer);
                        stabilityTimer = setTimeout(() => {
                            stabilityTimer = null;
                            checkStability().catch(() => { });
                        }, STABILITY_THRESHOLD_MS + 200);
                    }
                });
            } catch {
                // watch might fail — fall through to polling
                log.info(`[AntigravityADK] fs.watch failed, using polling only`);
            }

            // Poll periodically as a reliable fallback (fs.watch can be unreliable)
            session.pollTimer = setInterval(() => {
                checkStability().catch(() => { });
            }, STABILITY_POLL_MS);

            // Initial check in case the file already exists
            checkStability().catch(() => { });
        });
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
                const estimated = Math.ceil(promptLength / CHARS_PER_TOKEN);
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
     * Clean up session resources (watcher, timer, IPC files).
     */
    private cleanupSession(sessionId: string): void {
        const session = this.activeSessions.get(sessionId);
        if (!session) return;

        if (session.watcher) {
            session.watcher.close();
            delete session.watcher;
        }
        if (session.pollTimer) {
            clearInterval(session.pollTimer);
            delete session.pollTimer;
        }

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
     * No-op: IPC files are preserved for audit/debugging.
     * Previously removed all IPC files from the `.coogent/ipc/` directory.
     */
    async cleanupAllIpc(): Promise<void> {
        log.info('[AntigravityADK] cleanupAllIpc() is no-op (files preserved).');
    }
}
