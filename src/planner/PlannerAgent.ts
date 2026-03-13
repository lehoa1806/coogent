// ─────────────────────────────────────────────────────────────────────────────
// src/planner/PlannerAgent.ts — AI-powered runbook generation from prompts
// ─────────────────────────────────────────────────────────────────────────────

import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Runbook } from '../types/index.js';
import { PromptTemplateManager, type TechStackInfo } from '../context/PromptTemplateManager.js';
import type { AgentBackendProvider } from '../adk/AgentBackendProvider.js';
import type { ADKSessionHandle } from '../adk/ADKController.js';
import type { ExecutionMode } from '../adk/ExecutionModeResolver.js';
import log from '../logger/log.js';
import { PlannerPromptCompiler, RepoFingerprinter, type CompilationManifest } from '../prompt-compiler/index.js';
import { COOGENT_DIR, IPC_DIR, RUNBOOK_FILE } from '../constants/paths.js';
import { WorkspaceScanner } from './WorkspaceScanner.js';
import { RunbookParser } from './RunbookParser.js';
import { PlannerRetryManager } from './PlannerRetryManager.js';

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
    /** Available skill tags from the AgentRegistry (injected by wiring). */
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

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export declare interface PlannerAgent {
    on<K extends keyof PlannerEvents>(event: K, listener: PlannerEvents[K]): this;
    emit<K extends keyof PlannerEvents>(event: K, ...args: Parameters<PlannerEvents[K]>): boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Collaborator options for dependency injection
// ═══════════════════════════════════════════════════════════════════════════════

export interface PlannerCollaborators {
    scanner?: WorkspaceScanner;
    parser?: RunbookParser;
    retryManager?: PlannerRetryManager;
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
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class PlannerAgent extends EventEmitter {
    private readonly config: PlannerConfig;
    private draft: Runbook | null = null;
    private fileTree: string[] = [];
    private activeSession: ADKSessionHandle | null = null;
    private accumulatedOutput = '';
    private accumulatedStderr = '';
    private planRetryCount = 0;
    private userPrompt = '';
    /** Set when timeout fires — suppresses duplicate error from the exit handler race. */
    private timedOut = false;
    /** Master task ID (session dir name) for nesting IPC files under YYYYMMDD-HHMMSS-<uuid>. */
    private masterTaskId: string | undefined;
    /** Last system prompt sent to the planner worker (S2 audit: enables prompt lineage). */
    private lastSystemPrompt = '';
    /** Lazily-initialized PlannerPromptCompiler instance. */
    private promptCompiler: PlannerPromptCompiler | null = null;
    /** Last compilation manifest from the PlannerPromptCompiler (observability). */
    private lastManifest: CompilationManifest | null = null;
    /** BL-5 audit fix: Last raw LLM output before JSON parsing (for audit trail). */
    private lastRawOutput: string | undefined;
    /** Last resolved execution mode (observability). */
    private lastExecutionMode: ExecutionMode | null = null;

    // ── Collaborators ────────────────────────────────────────────────────
    private readonly scanner: WorkspaceScanner;
    private readonly parser: RunbookParser;
    private readonly retryManager: PlannerRetryManager;

    constructor(
        private readonly adapter: AgentBackendProvider,
        config: Partial<PlannerConfig> & Pick<PlannerConfig, 'workspaceRoot'>,
        collaborators?: PlannerCollaborators,
    ) {
        super();
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.scanner = collaborators?.scanner ?? new WorkspaceScanner();
        this.parser = collaborators?.parser ?? new RunbookParser();
        this.retryManager = collaborators?.retryManager ?? new PlannerRetryManager(this.parser);
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

    /** Get the last resolved execution mode (observability). */
    getLastExecutionMode(): ExecutionMode | null {
        return this.lastExecutionMode;
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
        this.retryManager.setSessionDir(null);

        log.info(`[PlannerAgent] Starting plan generation (prompt=${prompt.slice(0, 80)}..., hasFeedback=${!!feedback})`);

        try {
            // Step 1: Resolve effective project root (may differ from workspaceRoot in wrapper dirs)
            this.emit('plan:status', 'generating', 'Scanning workspace...');
            const fingerprinter = new RepoFingerprinter(this.config.workspaceRoot);
            const effectiveRoot = await fingerprinter.getEffectiveRoot();
            log.info(`[PlannerAgent] Effective project root: ${effectiveRoot}`);

            // Step 1b: Scan file tree from the effective root (delegated to WorkspaceScanner)
            this.fileTree = await this.scanner.scan(
                effectiveRoot,
                this.config.maxTreeDepth,
                this.config.maxTreeChars,
            );
            log.info(`[PlannerAgent] File tree collected: ${this.fileTree.length} entries`);

            // Step 2: Build the planner prompt (PromptCompiler → fallback to legacy)
            let systemPrompt: string;
            try {
                const compiler = this.getPromptCompiler();
                const compiledPrompt = await compiler.compile(prompt, {
                    fileTree: this.fileTree,
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
                    undefined,
                    this.config.availableTags,
                );
            }
            this.lastSystemPrompt = systemPrompt;
            log.info(`[PlannerAgent] Prompt built: ${systemPrompt.length} chars`);

            // Step 3: Resolve execution mode for prompt adjustment and observability
            let executionMode: ExecutionMode = 'unsupported'; // safe default
            const adapterAny = this.adapter as unknown as { getExecutionMode?: () => Promise<ExecutionMode> };
            if (typeof adapterAny.getExecutionMode === 'function') {
                executionMode = await adapterAny.getExecutionMode();
            }
            this.lastExecutionMode = executionMode;
            log.info(`[PlannerAgent] Execution mode resolved: ${executionMode}`);

            // Note: For all supported execution modes, the output/response.md
            // instructions are appended by the adapter layer — no need to
            // modify the prompt here.

            // Step 4: Spawn the planner worker
            this.emit('plan:status', 'generating', 'AI agent is creating your plan...');
            log.info(`[PlannerAgent] Creating ADK session...`);
            this.activeSession = await this.adapter.createSession({
                zeroContext: true,
                workingDirectory: this.config.workspaceRoot,
                initialPrompt: systemPrompt,
                newConversation: true, // Planner must always run in a fresh conversation
                ...(this.masterTaskId !== undefined && { masterTaskId: this.masterTaskId }),
                phaseNumber: 0, // Planner is always "phase 0" in the IPC directory
            });
            log.info(`[PlannerAgent] ADK session created: ${this.activeSession.sessionId}`);

            // Store session ID for file-based retry
            this.retryManager.setSessionDir(this.activeSession.sessionId);

            // Timeout must exceed the adapter's RESPONSE_TIMEOUT_MS (900s) to avoid
            // cancelling the file watcher's CancellationToken before it resolves.
            const timeoutMs = 910_000;
            const timeoutHandle = setTimeout(() => {
                // Preserve accumulated output for potential retry before aborting
                const hasOutput = this.accumulatedOutput.length > 0;
                this.retryManager.cacheOutput(this.accumulatedOutput);
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
                if (this.retryManager.hasRetryData()) {
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
     * Delegates to PlannerRetryManager and translates result into events.
     */
    async retryParse(): Promise<void> {
        this.emit('plan:status', 'parsing', 'Re-parsing cached output...');
        const result = await this.retryManager.retryParse(
            this.config.workspaceRoot,
            this.masterTaskId,
        );

        if (result.success && result.runbook) {
            this.planRetryCount = 0;
            this.draft = result.runbook;
            this.emit('plan:status', result.statusKey, result.statusMessage);
            this.emit('plan:generated', result.runbook, this.fileTree);
        } else {
            this.emit('plan:status', result.statusKey, result.statusMessage);
            this.emit('plan:error', result.error ?? new Error(result.statusMessage));
        }
    }

    /** Check if retry parse is available (either cached output or an IPC session to check). */
    hasTimeoutOutput(): boolean {
        return this.retryManager.hasRetryData();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Private
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Lazily create and return the PlannerPromptCompiler instance.
     */
    private getPromptCompiler(): PlannerPromptCompiler {
        if (!this.promptCompiler) {
            this.promptCompiler = new PlannerPromptCompiler(this.config.workspaceRoot);
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
            this.retryManager.cacheOutput(this.accumulatedOutput);

            const detail = this.accumulatedStderr || this.accumulatedOutput || '(no output captured)';
            const errorMsg = `Planner agent exited with code ${exitCode}. Detail: ${detail.slice(0, 500)}`;
            log.error(`[PlannerAgent] ERROR: ${errorMsg}`);

            // Emit timeout-style event so the user can attempt retry parse
            this.emit('plan:status', 'timeout', errorMsg);
            this.emit('plan:timeout', this.accumulatedOutput.length > 0);
            return;
        }

        // BL-5 audit fix: Capture raw LLM output before parsing
        this.lastRawOutput = this.accumulatedOutput;

        // Strategy 0: Read .task-runbook.json from disk (file-IPC path).
        // The worker writes the runbook to .task-runbook.json in the session
        // directory. The stdout (response.md content) is NOT the runbook —
        // it contains a markdown document with an output contract JSON.
        this.emit('plan:status', 'parsing', 'Reading runbook from disk...');
        this.tryReadRunbookFromDisk()
            .then(diskRunbook => {
                if (diskRunbook) {
                    this.planRetryCount = 0;
                    log.info(`[PlannerAgent] Plan loaded from .task-runbook.json: ${diskRunbook.phases.length} phases, project_id=${diskRunbook.project_id}`);
                    this.draft = diskRunbook;
                    this.emit('plan:status', 'ready', 'Plan loaded from disk');
                    this.emit('plan:generated', diskRunbook, this.fileTree);
                    return;
                }

                // Fallback: parse stdout (vscode.lm streaming path — no files written)
                this.parseFromStdout();
            })
            .catch(err => {
                log.warn(`[PlannerAgent] Error reading .task-runbook.json, falling back to stdout:`, err);
                this.parseFromStdout();
            });
    }

    /**
     * Attempt to read and validate .task-runbook.json from the IPC session directory.
     * Returns null if the file doesn't exist or is invalid.
     */
    private async tryReadRunbookFromDisk(): Promise<Runbook | null> {
        if (!this.masterTaskId) {
            log.info('[PlannerAgent] No masterTaskId set — skipping disk read');
            return null;
        }

        const ipcBase = path.join(this.config.workspaceRoot, COOGENT_DIR, IPC_DIR);
        const runbookPath = path.join(ipcBase, this.masterTaskId, RUNBOOK_FILE);

        try {
            const content = await fs.readFile(runbookPath, 'utf-8');
            log.info(`[PlannerAgent] Read ${content.length} chars from ${runbookPath}`);
            const parsed = this.parser.parse(content);
            if (parsed) {
                return parsed;
            }
            log.warn(`[PlannerAgent] .task-runbook.json exists but failed validation`);
        } catch {
            log.info(`[PlannerAgent] .task-runbook.json not found at ${runbookPath}`);
        }

        return null;
    }

    /**
     * Parse the runbook from accumulated stdout (vscode.lm streaming path).
     * This is the original parse logic, kept as a fallback.
     */
    private parseFromStdout(): void {
        this.emit('plan:status', 'parsing', 'Parsing generated plan...');
        log.info(`[PlannerAgent] Parsing stdout (${this.accumulatedOutput.length} chars)...`);
        log.info(`[PlannerAgent] First 300 chars: ${this.accumulatedOutput.slice(0, 300)}`);

        const parsed = this.parser.parse(this.accumulatedOutput);

        if (!parsed) {
            // #42: Retry on malformed JSON (exit code 0 but no valid runbook)
            this.planRetryCount = (this.planRetryCount ?? 0) + 1;
            const maxRetries = 2;
            if (this.planRetryCount <= maxRetries) {
                log.warn(`[PlannerAgent] Malformed JSON — retrying (${this.planRetryCount}/${maxRetries})...`);
                this.emit('plan:status', 'generating', `Retrying plan generation (attempt ${this.planRetryCount + 1})...`);
                // REL-3: Use setImmediate to break call stack (no recursive plan() call)
                setImmediate(() => {
                    this.plan(this.userPrompt).catch(err => {
                        this.emit('plan:error', err instanceof Error ? err : new Error(String(err)));
                    });
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
        log.info(`[PlannerAgent] Plan parsed successfully from stdout: ${parsed.phases.length} phases, project_id=${parsed.project_id}`);
        this.draft = parsed;
        this.emit('plan:status', 'ready', 'Plan generated successfully');
        this.emit('plan:generated', parsed, this.fileTree);
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
1. Return the runbook as raw JSON only. Do not include markdown code fences. Do not include explanatory text before or after the JSON.
2. Each phase must be self-contained — its \`prompt\` must fully describe what to do.
3. \`context_files\` must list ONLY the files the worker needs to read for that phase.
4. Order phases so that dependencies are created before they are referenced.
5. Set \`success_criteria\` to a concrete verification command when available (e.g., \`npm test\`). Default: \`"exit_code:0"\`.
6. Phase IDs MUST start from 1 (id: 0 is reserved for the planner). Set \`current_phase\` to the first phase ID (1).

## JSON Schema
\`\`\`json
{
  "project_id": "<descriptive-slug>",
  "summary": "<1-2 sentence high-level summary of the entire task>",
  "execution_plan": "<detailed markdown plan describing the approach, architecture decisions, and key changes>",
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
      "required_capabilities": ["<optional-tag-1>", "<optional-tag-2>"]
    }
  ]
}
\`\`\``);

        // File tree context (keep short to save tokens)
        const treeStr = fileTree.length > 0
            ? fileTree.join('\n')
            : '(empty workspace)';
        sections.push(`## Top-Level Structure
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
When creating phases, you may optionally specify \`required_capabilities\` as an array of tags from this list:
${sortedTags.join(', ')}
Only assign capabilities when a phase genuinely needs specialized expertise. If a phase needs no special capabilities, omit \`required_capabilities\`.`);
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
        return sections.join('\n\n');
    }
}
