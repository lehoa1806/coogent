// ─────────────────────────────────────────────────────────────────────────────
// src/planner/PlannerAgent.ts — AI-powered runbook generation from prompts
// ─────────────────────────────────────────────────────────────────────────────

import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Runbook } from '../types/index.js';
import { PromptTemplateManager } from '../context/PromptTemplateManager.js';
import type { TechStackInfo } from '../context/PromptTemplateManager.js';
import { asPhaseId } from '../types/index.js';
import type { AgentBackendProvider } from '../adk/AgentBackendProvider.js';
import type { ADKSessionHandle } from '../adk/ADKController.js';
import log from '../logger/log.js';
import { PromptCompiler } from '../prompt-compiler/index.js';
import type { CompilationManifest } from '../prompt-compiler/index.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Configuration
// ═══════════════════════════════════════════════════════════════════════════════

export interface PlannerConfig {
    /** Workspace root path. */
    workspaceRoot: string;
    /** Maximum depth for file tree scanning. */
    maxTreeDepth: number;
    /** Maximum characters for the file tree summary. */
    maxTreeChars: number;
    /** Available skill tags from the WorkerRegistry (injected by wiring). */
    availableTags?: string[];
}

const DEFAULT_CONFIG: Omit<PlannerConfig, 'workspaceRoot'> = {
    maxTreeDepth: 4,
    maxTreeChars: 8000,
};

// ═══════════════════════════════════════════════════════════════════════════════
//  Planner Events
// ═══════════════════════════════════════════════════════════════════════════════

export interface PlannerEvents {
    /** Emitted when the planner produces a valid runbook draft. */
    'plan:generated': (draft: Runbook, fileTree: string[]) => void;
    /** Emitted when the planner fails to produce a valid plan. */
    'plan:error': (error: Error) => void;
    /** Emitted for status updates during planning. */
    'plan:status': (status: 'generating' | 'parsing' | 'ready' | 'error' | 'timeout', message?: string) => void;
    /** Emitted when the planner times out but may have recoverable output cached. */
    'plan:timeout': (hasOutput: boolean) => void;
}

export declare interface PlannerAgent {
    on<K extends keyof PlannerEvents>(event: K, listener: PlannerEvents[K]): this;
    emit<K extends keyof PlannerEvents>(event: K, ...args: Parameters<PlannerEvents[K]>): boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Planner Agent
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * AI-powered planning agent that generates `.task-runbook.json` from
 * a user's high-level conversational prompt.
 *
 * Workflow:
 * 1. Scans workspace file tree (respecting depth limits).
 * 2. Builds a system prompt with schema requirements + file tree.
 * 3. Spawns an ephemeral ADK worker to generate the plan.
 * 4. Parses worker output for valid JSON runbook.
 * 5. Emits `plan:generated` with the parsed draft.
 */
export class PlannerAgent extends EventEmitter {
    private readonly config: PlannerConfig;
    private draft: Runbook | null = null;
    private fileTree: string[] = [];
    private activeSession: ADKSessionHandle | null = null;
    private accumulatedOutput = '';
    private accumulatedStderr = '';
    private planRetryCount = 0;
    private userPrompt = '';
    /** Cached accumulated output from the last timeout/error, available for retryParse(). */
    private lastTimeoutOutput: string | null = null;
    /** Set when timeout fires — suppresses duplicate error from the exit handler race. */
    private timedOut = false;
    /** Last IPC session directory — used by retryParse() to read response.md from disk. */
    private lastIpcSessionDir: string | null = null;
    /** Master task ID (session dir name) for nesting IPC files under YYYYMMDD-HHMMSS-<uuid>. */
    private masterTaskId: string | undefined;
    /** Last system prompt sent to the planner worker (S2 audit: enables prompt lineage). */
    private lastSystemPrompt = '';
    /** Lazily-initialized PromptCompiler instance. */
    private promptCompiler: PromptCompiler | null = null;
    /** Last compilation manifest from the PromptCompiler (observability). */
    private lastManifest: CompilationManifest | null = null;
    /** BL-5 audit fix: Last raw LLM output before JSON parsing (for audit trail). */
    private lastRawOutput: string | undefined;

    constructor(
        private readonly adapter: AgentBackendProvider,
        config: Partial<PlannerConfig> & Pick<PlannerConfig, 'workspaceRoot'>
    ) {
        super();
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    /** Set the master task ID so planner IPC files nest under the session directory. */
    setMasterTaskId(id: string): void {
        this.masterTaskId = id;
    }

    /** Update the available worker skill tags (called by PlannerWiring before each plan). */
    setAvailableTags(tags: string[]): void {
        (this.config as { availableTags?: string[] }).availableTags = tags;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Public API
    // ═══════════════════════════════════════════════════════════════════════════

    /** Get the last compilation manifest from PromptCompiler (for observability). */
    getLastManifest(): CompilationManifest | null {
        return this.lastManifest;
    }

    /** BL-5 audit fix: Get the last raw LLM output before parsing. */
    getLastRawOutput(): string | undefined {
        return this.lastRawOutput;
    }

    /**
     * Generate a runbook from a user prompt.
     * Optionally includes feedback from a previous rejected plan.
     */
    async plan(prompt: string, feedback?: string): Promise<void> {
        // Abort any existing session
        await this.abort();

        this.userPrompt = prompt;
        this.accumulatedOutput = '';
        this.accumulatedStderr = '';
        this.draft = null;
        this.timedOut = false;
        this.lastIpcSessionDir = null;

        log.info(`[PlannerAgent] Starting plan generation (prompt=${prompt.slice(0, 80)}..., hasFeedback=${!!feedback})`);

        try {
            // Step 1: Scan workspace
            this.emit('plan:status', 'generating', 'Scanning workspace...');
            this.fileTree = await this.collectFileTree(
                this.config.workspaceRoot,
                this.config.maxTreeDepth
            );
            log.info(`[PlannerAgent] File tree collected: ${this.fileTree.length} entries`);

            // Step 1b: Discover tech stack (non-blocking — failures are swallowed)
            let techStack: TechStackInfo | undefined;
            try {
                const promptManager = new PromptTemplateManager(this.config.workspaceRoot);
                techStack = await promptManager.discoverTechStack();
                log.info(`[PlannerAgent] Tech stack discovered: runtime=${techStack.runtime}, frameworks=[${techStack.frameworks.join(', ')}]`);
            } catch (err) {
                log.warn('[PlannerAgent] Tech stack discovery failed — continuing without:', err);
            }

            // Step 2: Build the planner prompt (PromptCompiler → fallback to legacy)
            let systemPrompt: string;
            try {
                const compiler = this.getPromptCompiler();
                const compiledPrompt = await compiler.compile(prompt, {
                    fileTree: this.fileTree,
                    ...(techStack !== undefined && { techStack }),
                    ...(this.config.availableTags !== undefined && { availableTags: this.config.availableTags }),
                    ...(feedback !== undefined && { feedback }),
                });
                systemPrompt = compiledPrompt.text;
                this.lastManifest = compiledPrompt.manifest;
                log.info('[PromptCompiler] Compilation complete', {
                    taskFamily: compiledPrompt.manifest.taskFamily,
                    templateId: compiledPrompt.manifest.templateId,
                    appliedPolicies: compiledPrompt.manifest.appliedPolicies,
                    promptLength: compiledPrompt.text.length,
                    fingerprintHash: compiledPrompt.manifest.fingerprintHash,
                });
            } catch (compilerErr) {
                const err = compilerErr instanceof Error ? compilerErr : new Error(String(compilerErr));
                log.warn('[PromptCompiler] Compilation failed, falling back to legacy prompt', { error: err.message });
                this.lastManifest = null;
                systemPrompt = this.buildLegacyPlannerPrompt(
                    prompt,
                    this.fileTree,
                    feedback,
                    techStack,
                    this.config.availableTags,
                );
            }
            this.lastSystemPrompt = systemPrompt;
            log.info(`[PlannerAgent] Prompt built: ${systemPrompt.length} chars`);

            // Step 3: Spawn the planner worker
            this.emit('plan:status', 'generating', 'AI agent is creating your plan...');
            log.info(`[PlannerAgent] Creating ADK session...`);
            this.activeSession = await this.adapter.createSession({
                zeroContext: true,
                workingDirectory: this.config.workspaceRoot,
                initialPrompt: systemPrompt,
                ...(this.masterTaskId !== undefined && { masterTaskId: this.masterTaskId }),
                phaseNumber: 0, // Planner is always "phase 0" in the IPC directory
            });
            log.info(`[PlannerAgent] ADK session created: ${this.activeSession.sessionId}`);

            // Store session ID for file-based retry
            this.lastIpcSessionDir = this.activeSession.sessionId;

            // Timeout must exceed the adapter's RESPONSE_TIMEOUT_MS (900s) to avoid
            // cancelling the file watcher's CancellationToken before it resolves.
            const timeoutMs = 910_000;
            const timeoutHandle = setTimeout(() => {
                // Preserve accumulated output for potential retry before aborting
                const hasOutput = this.accumulatedOutput.length > 0;
                this.lastTimeoutOutput = hasOutput ? this.accumulatedOutput : null;
                this.timedOut = true; // Suppress duplicate error from exit handler
                log.error(
                    `[PlannerAgent] Timeout after ${timeoutMs}ms — ` +
                    `cached ${this.accumulatedOutput.length} chars for retry`
                );
                this.emit('plan:status', 'timeout', 'Planner agent timed out');
                this.emit('plan:timeout', hasOutput);
                this.abort().catch(log.onError);

                // Auto-retryParse: if an IPC session exists, the agent may have
                // written response.md after the adapter's watcher timed out.
                // Try reading it once automatically before requiring manual retry.
                if (this.lastIpcSessionDir || hasOutput) {
                    log.info('[PlannerAgent] Auto-retrying parse from timeout...');
                    // Delay slightly to let abort() finish cleaning up
                    setTimeout(() => {
                        this.retryParse().catch(err => {
                            log.error('[PlannerAgent] Auto-retryParse failed:', err);
                        });
                    }, 500);
                }
            }, timeoutMs);

            // Wire output accumulation
            this.activeSession.onOutput((stream, chunk) => {
                if (stream === 'stderr') {
                    this.accumulatedStderr += chunk;
                } else if (stream === 'stdout') {
                    this.accumulatedOutput += chunk;
                }
            });

            // Wire exit handler
            this.activeSession.onExit((exitCode) => {
                clearTimeout(timeoutHandle);
                log.info(`[PlannerAgent] Worker exited with code ${exitCode}`);
                this.activeSession = null;
                this.onWorkerExited(exitCode);
            });
        } catch (err) {
            this.activeSession = null;
            const error = err instanceof Error ? err : new Error(String(err));
            log.error(`[PlannerAgent] plan() threw:`, error.message, error.stack);
            this.emit('plan:status', 'error', error.message);
            this.emit('plan:error', error);
        }
    }

    /** Get the last generated draft runbook. */
    getDraft(): Runbook | null {
        return this.draft;
    }

    /** Get the last collected file tree. */
    getFileTree(): string[] {
        return this.fileTree;
    }

    /** Get the user's original prompt. */
    getPrompt(): string {
        return this.userPrompt;
    }

    /** Get the last system prompt sent to the planner worker (S2 audit). */
    getLastSystemPrompt(): string {
        return this.lastSystemPrompt;
    }

    /** Terminate any active planning session. */
    async abort(): Promise<void> {
        if (this.activeSession) {
            try {
                await this.adapter.terminateSession(this.activeSession);
            } catch {
                // Best-effort
            }
            this.activeSession = null;
        }
    }

    /** Update the in-memory draft (from user edits in the UI). */
    setDraft(draft: Runbook): void {
        this.draft = draft;
    }

    /**
     * Re-attempt parsing from cached output or from the response file on disk.
     * Called when the user chooses "Retry Parse" after a timeout,
     * avoiding the need to retrigger the full plan generation.
     *
     * Strategy:
     *  1. If `lastTimeoutOutput` has content, parse that (vscode.lm streaming path).
     *  2. Otherwise, try reading response.md from the last IPC session directory
     *     (file-based IPC path — the chat agent may have written it after timeout).
     */
    async retryParse(): Promise<void> {
        // Strategy 1: Use cached streaming output (vscode.lm path)
        if (this.lastTimeoutOutput && this.lastTimeoutOutput.trim().length > 0) {
            log.info(`[PlannerAgent] retryParse() — parsing ${this.lastTimeoutOutput.length} cached chars`);
            this.emit('plan:status', 'parsing', 'Re-parsing cached output...');
            const parsed = this.extractRunbook(this.lastTimeoutOutput);
            if (parsed) {
                this.lastTimeoutOutput = null;
                this.planRetryCount = 0;
                this.draft = parsed;
                this.emit('plan:status', 'ready', 'Plan parsed from cached output');
                this.emit('plan:generated', parsed, this.fileTree);
                return;
            }
            // Fall through to Strategy 2 if cached output doesn't parse
        }

        // Strategy 2: Read response.md from disk (file-based IPC path)
        if (this.lastIpcSessionDir) {
            const ipcBase = path.join(this.config.workspaceRoot, '.coogent', 'ipc');
            const candidates: string[] = [];

            // Primary: use masterTaskId-nested path (YYYYMMDD-HHMMSS-<uuid>/phase-000-<sessionId>)
            if (this.masterTaskId) {
                candidates.push(
                    path.join(ipcBase, this.masterTaskId, `phase-000-${this.lastIpcSessionDir}`, 'response.md')
                );
            }

            // Fallback: direct session dir (legacy or no masterTaskId)
            candidates.push(
                path.join(ipcBase, this.lastIpcSessionDir, 'response.md'),
            );

            for (const responseFile of candidates) {
                try {
                    const content = await fs.readFile(responseFile, 'utf-8');
                    if (content.trim().length > 0) {
                        log.info(`[PlannerAgent] retryParse() — read ${content.length} chars from ${responseFile}`);
                        this.emit('plan:status', 'parsing', 'Parsing response file from disk...');
                        const parsed = this.extractRunbook(content);
                        if (parsed) {
                            this.lastTimeoutOutput = null;
                            this.lastIpcSessionDir = null;
                            this.planRetryCount = 0;
                            this.draft = parsed;
                            this.emit('plan:status', 'ready', 'Plan loaded from response file');
                            this.emit('plan:generated', parsed, this.fileTree);
                            return;
                        }
                        // Content exists but didn't parse — report what we found
                        const errorMsg = 'Response file exists but does not contain a valid JSON runbook.\n' +
                            `File: ${responseFile}\nFirst 500 chars:\n${content.slice(0, 500)}`;
                        log.error(`[PlannerAgent] retryParse() FAILED: ${errorMsg}`);
                        this.emit('plan:status', 'error', 'Response file found but failed to parse');
                        this.emit('plan:error', new Error(errorMsg));
                        return;
                    }
                } catch {
                    // File doesn't exist at this path — try next candidate
                }
            }
        }

        // Nothing found
        const msg = this.lastIpcSessionDir
            ? 'No response file found on disk yet. The chat agent may still be writing. Try again in a moment.'
            : 'No cached output or response file to parse — please regenerate the plan.';
        log.warn(`[PlannerAgent] retryParse() — ${msg}`);
        this.emit('plan:status', 'error', msg);
        this.emit('plan:error', new Error(msg));
    }

    /** Check if retry parse is available (either cached output or an IPC session to check). */
    hasTimeoutOutput(): boolean {
        return (
            (this.lastTimeoutOutput !== null && this.lastTimeoutOutput.trim().length > 0) ||
            this.lastIpcSessionDir !== null
        );
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Private
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Lazily create and return the PromptCompiler instance.
     */
    private getPromptCompiler(): PromptCompiler {
        if (!this.promptCompiler) {
            this.promptCompiler = new PromptCompiler(this.config.workspaceRoot);
        }
        return this.promptCompiler;
    }

    private onWorkerExited(exitCode: number): void {
        log.info(`[PlannerAgent] onWorkerExited(${exitCode}), accumulatedOutput (${this.accumulatedOutput.length} chars):\n${this.accumulatedOutput || '(empty)'}\nstderr (${this.accumulatedStderr.length} chars):\n${this.accumulatedStderr || '(empty)'}`);

        // If timeout already fired, the exit handler is a duplicate from abort().
        // The timeout handler already cached output and emitted plan:timeout.
        // Suppress to avoid undoing the timeout recovery.
        if (this.timedOut) {
            log.info('[PlannerAgent] Suppressing exit handler — timeout already handled');
            return;
        }

        if (exitCode !== 0) {
            // Cache any accumulated output so the user can retry parsing
            const hasOutput = this.accumulatedOutput.length > 0;
            this.lastTimeoutOutput = hasOutput ? this.accumulatedOutput : null;

            const detail = this.accumulatedStderr || this.accumulatedOutput || '(no output captured)';
            const errorMsg = `Planner agent exited with code ${exitCode}. Detail: ${detail.slice(0, 500)}`;
            log.error(`[PlannerAgent] ERROR: ${errorMsg}`);

            // Emit timeout-style event so the user can attempt retry parse
            this.emit('plan:status', 'timeout', errorMsg);
            this.emit('plan:timeout', hasOutput);
            return;
        }

        // Parse the accumulated output for a JSON runbook
        this.emit('plan:status', 'parsing', 'Parsing generated plan...');
        log.info(`[PlannerAgent] Parsing output (${this.accumulatedOutput.length} chars)...`);
        log.info(`[PlannerAgent] First 300 chars: ${this.accumulatedOutput.slice(0, 300)}`);

        // BL-5 audit fix: Capture raw LLM output before parsing
        this.lastRawOutput = this.accumulatedOutput;

        const parsed = this.extractRunbook(this.accumulatedOutput);

        if (!parsed) {
            // #42: Retry on malformed JSON (exit code 0 but no valid runbook)
            this.planRetryCount = (this.planRetryCount ?? 0) + 1;
            const maxRetries = 2;
            if (this.planRetryCount <= maxRetries) {
                log.warn(`[PlannerAgent] Malformed JSON — retrying (${this.planRetryCount}/${maxRetries})...`);
                this.emit('plan:status', 'generating', `Retrying plan generation (attempt ${this.planRetryCount + 1})...`);
                this.plan(this.userPrompt).catch(err => {
                    this.emit('plan:error', err instanceof Error ? err : new Error(String(err)));
                });
                return;
            }

            const errorMsg = 'Planner agent did not produce a valid JSON runbook after ' +
                `${maxRetries + 1} attempts. Raw output:\n` +
                this.accumulatedOutput.slice(0, 500);
            log.error(`[PlannerAgent] Parse FAILED: ${errorMsg}`);
            this.emit('plan:status', 'error', 'Failed to parse runbook from agent output');
            this.emit('plan:error', new Error(errorMsg));
            return;
        }

        this.planRetryCount = 0; // Reset on success
        log.info(`[PlannerAgent] Plan parsed successfully: ${parsed.phases.length} phases, project_id=${parsed.project_id}`);
        this.draft = parsed;
        this.emit('plan:status', 'ready', 'Plan generated successfully');
        this.emit('plan:generated', parsed, this.fileTree);
    }

    /**
     * Extract a JSON runbook from the agent's raw output.
     * Looks for ```json fenced blocks first, then tries raw JSON parse.
     */
    extractRunbook(output: string): Runbook | null {
        // Strategy 1: Look for ```json ... ``` fenced code block
        // #44: Use non-greedy pattern to avoid over-capturing
        const fencedMatch = output.match(/```json\s*\n([\s\S]*?)\n```/);
        if (fencedMatch) {
            try {
                return this.validateRunbook(JSON.parse(fencedMatch[1]));
            } catch { /* fall through */ }
        }

        // Strategy 2: Look for raw JSON object { ... } — non-greedy (#44)
        const jsonMatch = output.match(/\{[\s\S]*?"phases"\s*:\s*\[[\s\S]*?\]\s*[\s\S]*?\}/);
        if (jsonMatch) {
            try {
                return this.validateRunbook(JSON.parse(jsonMatch[0]));
            } catch { /* fall through */ }
        }

        return null;
    }

    /**
     * Validate that parsed JSON has the minimum required Runbook shape.
     * #43: Also validates depends_on refs and checks for duplicate phase IDs.
     */
    private validateRunbook(obj: unknown): Runbook | null {
        if (!obj || typeof obj !== 'object') return null;
        const r = obj as Record<string, unknown>;

        if (typeof r.project_id !== 'string') return null;
        if (!Array.isArray(r.phases) || r.phases.length === 0) return null;

        // Validate each phase has required fields
        const seenIds = new Set<number>();
        for (const p of r.phases) {
            if (typeof p !== 'object' || p === null) return null;
            const phase = p as Record<string, unknown>;
            if (typeof phase.id !== 'number') return null;
            if (typeof phase.prompt !== 'string') return null;
            if (!Array.isArray(phase.context_files)) return null;
            if (typeof phase.success_criteria !== 'string') return null;

            // #43: Check for duplicate phase IDs
            if (seenIds.has(phase.id as number)) {
                log.warn(`[PlannerAgent] Duplicate phase ID: ${phase.id}`);
                return null;
            }
            seenIds.add(phase.id as number);
        }

        // #43: Validate depends_on references
        for (const p of r.phases) {
            const phase = p as Record<string, unknown>;
            if (Array.isArray(phase.depends_on)) {
                for (const dep of phase.depends_on) {
                    if (typeof dep !== 'number' || !seenIds.has(dep)) {
                        log.warn(`[PlannerAgent] Invalid depends_on reference: phase ${phase.id} depends on non-existent phase ${dep}`);
                        return null;
                    }
                }
            }
        }

        // Ensure default fields
        return {
            project_id: r.project_id as string,
            status: 'idle',
            current_phase: (r.phases as Array<Record<string, unknown>>).length > 0
                ? ((r.phases as Array<Record<string, unknown>>)[0] as Record<string, unknown>).id as number
                : 1,
            ...(typeof r.summary === 'string' ? { summary: r.summary } : {}),
            ...(typeof r.implementation_plan === 'string' ? { implementation_plan: r.implementation_plan } : {}),
            phases: (r.phases as Array<Record<string, unknown>>).map((p, i) => ({
                id: asPhaseId(typeof p.id === 'number' ? p.id : i),
                status: 'pending' as const,
                prompt: p.prompt as string,
                context_files: p.context_files as string[],
                success_criteria: (p.success_criteria as string) || 'exit_code:0',
                ...(Array.isArray(p.depends_on) ? { depends_on: (p.depends_on as number[]).map(asPhaseId) } : {}),
                ...(typeof p.context_summary === 'string' ? { context_summary: p.context_summary } : {}),
            })),
        };
    }

    /**
     * Collect the workspace file tree up to the specified depth.
     * Respects common ignore patterns (.git, node_modules, etc.).
     */
    async collectFileTree(rootDir: string, maxDepth: number): Promise<string[]> {
        const IGNORE = new Set([
            '.git', 'node_modules', '.next', 'dist', 'out', 'build',
            '.cache', '.vscode', '__pycache__', '.DS_Store', 'coverage',
            '.coogent',
        ]);

        const result: string[] = [];
        let charCount = 0;

        const walk = async (dir: string, depth: number, prefix: string): Promise<void> => {
            if (depth > maxDepth || charCount > this.config.maxTreeChars) return;

            let entries: import('node:fs').Dirent[];
            try {
                entries = await fs.readdir(dir, { withFileTypes: true }) as import('node:fs').Dirent[];
            } catch {
                return;
            }

            // Sort: directories first, then files
            const sorted = [...entries].sort((a, b) => {
                if (a.isDirectory() && !b.isDirectory()) return -1;
                if (!a.isDirectory() && b.isDirectory()) return 1;
                return String(a.name).localeCompare(String(b.name));
            });

            for (const entry of sorted) {
                const name = String(entry.name);
                if (IGNORE.has(name)) continue;
                if (charCount > this.config.maxTreeChars) break;

                const relativePath = path.join(prefix, name);

                if (entry.isDirectory()) {
                    const line = `${relativePath}/`;
                    result.push(line);
                    charCount += line.length;
                    await walk(path.join(dir, name), depth + 1, relativePath);
                } else {
                    result.push(relativePath);
                    charCount += relativePath.length;
                }
            }
        };

        await walk(rootDir, 0, '');
        return result;
    }

    /**
     * Build the system prompt for the planner agent.
     * @deprecated Kept as fallback — PromptCompiler is now the default path.
     */
    private buildLegacyPlannerPrompt(
        userPrompt: string,
        fileTree: string[],
        feedback?: string,
        techStack?: TechStackInfo,
        availableTags?: string[],
    ): string {
        const sections: string[] = [];

        sections.push(`## Your Role
You are a Planning Agent. Your job is to analyze a codebase and break down a user's request into a sequential execution plan (a "runbook"). Each phase in the runbook is a micro-task that will be executed by an isolated AI agent with zero prior context.

## Critical Rules
1. Output ONLY a valid JSON object — no markdown, no explanation, no commentary outside the JSON.
2. Wrap the JSON in a \`\`\`json fenced code block.
3. Each phase must be self-contained — its \`prompt\` must fully describe what to do.
4. \`context_files\` must list ONLY the files the worker needs to read for that phase.
5. Order phases so that dependencies are created before they are referenced.
6. Use \`success_criteria\` of \`"exit_code:0"\` for all phases unless you have a specific test command.
7. Phase IDs MUST start from 1 (id: 0 is reserved for the planner). Set \`current_phase\` to the first phase ID (1).

## JSON Schema
\`\`\`json
{
  "project_id": "<descriptive-slug>",
  "summary": "<1-2 sentence high-level summary of the entire task>",
  "implementation_plan": "<detailed markdown plan describing the approach, architecture decisions, and key changes>",
  "status": "idle",
  "current_phase": 1,
  "phases": [
    {
      "id": 1,
      "status": "pending",
      "prompt": "<detailed instruction for the AI worker>",
      "context_files": ["<relative/path/to/file.ts>"],
      "success_criteria": "exit_code:0",
      "context_summary": "<1-2 sentence summary of what this phase does and why>",
      "required_skills": ["<optional-tag-1>", "<optional-tag-2>"]
    }
  ]
}
\`\`\``);

        // File tree context
        const treeStr = fileTree.length > 0
            ? fileTree.join('\n')
            : '(empty workspace)';
        sections.push(`## Workspace File Tree
\`\`\`
${treeStr}
\`\`\``);

        // Tech stack context (if available)
        if (techStack && techStack.runtime !== 'unknown') {
            const promptManager = new PromptTemplateManager(this.config.workspaceRoot);
            sections.push(`## Workspace Tech Stack
${promptManager.formatTechStack(techStack)}`);
        }

        // Available worker skills (if tags provided)
        if (availableTags && availableTags.length > 0) {
            const sortedTags = [...availableTags].sort();
            sections.push(`## Available Worker Skills
When creating phases, you may optionally specify \`required_skills\` as an array of tags from this list:
${sortedTags.join(', ')}
Only assign skills when a phase genuinely needs specialized expertise. If a phase needs no special skills, omit \`required_skills\`.`);
        }

        // User prompt
        sections.push(`## User Request
${userPrompt}`);

        // Re-plan feedback
        if (feedback) {
            sections.push(`## Feedback on Previous Plan (MUST Address)
The user reviewed the previous plan and rejected it with this feedback:
${feedback}

Regenerate the plan addressing this feedback.`);
        }

        sections.push(`## Generate the Runbook Now
Analyze the workspace and the user's request, then output the runbook JSON.`);

        return sections.join('\n\n');
    }
}
