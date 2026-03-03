// ─────────────────────────────────────────────────────────────────────────────
// src/adk/AntigravityADKAdapter.ts — ADK adapter: file-based IPC with Antigravity chat
// ─────────────────────────────────────────────────────────────────────────────

import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { watch, type FSWatcher } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { IADKAdapter, ADKSessionOptions, ADKSessionHandle } from './ADKController.js';

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
const RESPONSE_TIMEOUT_MS = 120_000;

/** How often to poll for file-stability (ms). */
const STABILITY_POLL_MS = 2_000;

/** How long the file must remain unchanged to be considered "done" (ms). */
const STABILITY_THRESHOLD_MS = 3_000;

/** IPC subdirectory under the workspace. */
const IPC_DIR_NAME = '.isolated_agent/ipc';

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

    constructor(private readonly workspaceRoot: string) {
        this.ipcDir = path.join(workspaceRoot, IPC_DIR_NAME);
    }

    async createSession(options: ADKSessionOptions): Promise<ADKSessionHandle> {
        const sessionId = uuidv7();
        console.log(`[AntigravityADK] Creating session ${sessionId}`);
        console.log(`[AntigravityADK] Prompt length: ${options.initialPrompt.length} chars`);

        // Create a cancellation token for this session
        const cts = new vscode.CancellationTokenSource();
        const session: ActiveSession = { sessionId, cts };
        this.activeSessions.set(sessionId, session);

        // ─── Path A: vscode.lm API (primary) ────────────────────────────────
        const model = await this.tryVscodeLm(cts);

        if (model) {
            console.log(`[AntigravityADK] ✅ vscode.lm primary: using model ${model.name} (${model.id})`);
            return this.createLmSession(sessionId, model, options, cts);
        }

        console.log(`[AntigravityADK] ⚠️ No vscode.lm model available, using file-based IPC...`);

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
        cts: vscode.CancellationTokenSource
    ): Promise<vscode.LanguageModelChat | null> {
        try {
            const models = await vscode.lm.selectChatModels({});
            if (models.length > 0) {
                console.log(`[AntigravityADK] vscode.lm found ${models.length} model(s): ` +
                    models.map(m => `${m.name}(${m.id})`).join(', '));
                return models[0];
            }
            console.log(`[AntigravityADK] vscode.lm: no models returned`);
        } catch (err) {
            console.log(`[AntigravityADK] vscode.lm unavailable:`, err);
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
                console.log(`[AntigravityADK] LM session ${sessionId}: sending request...`);
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
                    console.log(`[AntigravityADK] LM session ${sessionId}: completed (${chunkCount} chunks, ${totalChars} chars)`);
                    exitCallback?.(0);
                }
            } catch (err: unknown) {
                if (cts.token.isCancellationRequested) return;
                const message = err instanceof Error ? err.message : String(err);
                console.error(`[AntigravityADK] LM session ${sessionId} ERROR:`, message);
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

        const requestFile = path.join(this.ipcDir, `request-${sessionId}.md`);
        const responseFile = path.join(this.ipcDir, `response-${sessionId}.md`);

        const runIpcSession = async () => {
            try {
                // Step 1: Ensure IPC directory exists
                await fs.mkdir(this.ipcDir, { recursive: true });

                // Step 2: Write the prompt to the request file
                await fs.writeFile(requestFile, options.initialPrompt, 'utf-8');
                console.log(`[AntigravityADK] IPC request written: ${requestFile} (${options.initialPrompt.length} chars)`);

                // Step 3: Build the meta-prompt for the chat agent
                const relRequestFile = path.relative(this.workspaceRoot, requestFile);
                const relResponseFile = path.relative(this.workspaceRoot, responseFile);

                const metaPrompt = [
                    `Read the instructions from the file: ${relRequestFile}`,
                    `Follow those instructions carefully.`,
                    `Write your COMPLETE response to the file: ${relResponseFile}`,
                    `Output ONLY the content — no explanation, no markdown code fences wrapping the file write.`,
                    `Use the file editing tools to create/write to ${relResponseFile}.`,
                ].join('\n');

                // Step 4: Inject the meta-prompt into the chat panel
                console.log(`[AntigravityADK] Injecting meta-prompt into chat...`);
                const injected = await this.injectIntoChatPanel(metaPrompt);
                if (!injected) {
                    outputCallback?.('stderr', `[AntigravityADK] Failed to inject meta-prompt into chat\n`);
                    exitCallback?.(1);
                    this.cleanupSession(sessionId);
                    return;
                }

                // Step 5: Watch for the response file
                console.log(`[AntigravityADK] Waiting for response file: ${responseFile}`);
                const content = await this.waitForResponseFile(
                    responseFile,
                    session,
                    RESPONSE_TIMEOUT_MS
                );

                if (session.cts.token.isCancellationRequested) {
                    console.log(`[AntigravityADK] Session ${sessionId} was cancelled`);
                    return;
                }

                if (content === null) {
                    const msg = `Timeout waiting for AI response file (${RESPONSE_TIMEOUT_MS / 1000}s). `
                        + `The chat agent may not have written to: ${relResponseFile}`;
                    console.error(`[AntigravityADK] ${msg}`);
                    outputCallback?.('stderr', `[AntigravityADK] ${msg}\n`);
                    exitCallback?.(1);
                } else {
                    console.log(`[AntigravityADK] ✅ Response captured: ${content.length} chars`);
                    outputCallback?.('stdout', content);
                    exitCallback?.(0);
                }
            } catch (err: unknown) {
                if (session.cts.token.isCancellationRequested) return;
                const message = err instanceof Error ? err.message : String(err);
                console.error(`[AntigravityADK] IPC session ${sessionId} ERROR:`, message);
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

            const cleanup = () => {
                if (session.watcher) {
                    session.watcher.close();
                    session.watcher = undefined;
                }
                if (session.pollTimer) {
                    clearInterval(session.pollTimer);
                    session.pollTimer = undefined;
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
                console.log(`[AntigravityADK] Response file timeout after ${timeoutMs}ms`);
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
                        console.log(`[AntigravityADK] Response file stable at ${size} bytes`);
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
            try {
                session.watcher = watch(dir, (eventType, filename) => {
                    if (filename === basename) {
                        checkStability().catch(() => { });
                    }
                });
            } catch {
                // watch might fail — fall through to polling
                console.log(`[AntigravityADK] fs.watch failed, using polling only`);
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
            console.log(`[AntigravityADK] ✅ Injected via antigravity.sendPromptToAgentPanel`);
            return true;
        } catch (err) {
            console.warn(`[AntigravityADK] sendPromptToAgentPanel failed:`, err);
        }

        // Fallback: standard VSCode Chat API
        try {
            await vscode.commands.executeCommand('workbench.action.chat.open', {
                mode: 'agent',
                query: prompt,
            });
            console.log(`[AntigravityADK] ✅ Injected via workbench.action.chat.open`);
            return true;
        } catch (err) {
            console.error(`[AntigravityADK] ❌ All chat injection methods failed:`, err);
            return false;
        }
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
            session.watcher = undefined;
        }
        if (session.pollTimer) {
            clearInterval(session.pollTimer);
            session.pollTimer = undefined;
        }

        this.activeSessions.delete(sessionId);

        // Clean up IPC files (best-effort, don't await)
        const requestFile = path.join(this.ipcDir, `request-${sessionId}.md`);
        const responseFile = path.join(this.ipcDir, `response-${sessionId}.md`);
        fs.unlink(requestFile).catch(() => { });
        fs.unlink(responseFile).catch(() => { });
    }

    async terminateSession(handle: ADKSessionHandle): Promise<void> {
        const session = this.activeSessions.get(handle.sessionId);
        if (session) {
            session.cts.cancel();
            session.cts.dispose();
            this.cleanupSession(handle.sessionId);
            console.log(`[AntigravityADK] Terminated session ${handle.sessionId}`);
        }
    }

    /**
     * Remove all IPC files from the `.isolated_agent/ipc/` directory.
     * Call this to clean up after old/stale sessions.
     */
    async cleanupAllIpc(): Promise<void> {
        try {
            const entries = await fs.readdir(this.ipcDir);
            let removed = 0;
            for (const entry of entries) {
                if (entry.startsWith('request-') || entry.startsWith('response-')) {
                    await fs.unlink(path.join(this.ipcDir, entry)).catch(() => { });
                    removed++;
                }
            }
            console.log(`[AntigravityADK] Cleaned up ${removed} IPC files from ${this.ipcDir}`);
        } catch {
            // Directory doesn't exist or is empty — nothing to clean
        }
    }
}
