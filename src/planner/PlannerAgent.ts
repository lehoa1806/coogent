// ─────────────────────────────────────────────────────────────────────────────
// src/planner/PlannerAgent.ts — AI-powered runbook generation from prompts
// ─────────────────────────────────────────────────────────────────────────────

import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Runbook } from '../types/index.js';
import type { IADKAdapter, ADKSessionHandle } from '../adk/ADKController.js';

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
    'plan:status': (status: 'generating' | 'parsing' | 'ready' | 'error', message?: string) => void;
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
    private userPrompt = '';

    constructor(
        private readonly adapter: IADKAdapter,
        config: Partial<PlannerConfig> & Pick<PlannerConfig, 'workspaceRoot'>
    ) {
        super();
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Public API
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Generate a runbook from a user prompt.
     * Optionally includes feedback from a previous rejected plan.
     */
    async plan(prompt: string, feedback?: string): Promise<void> {
        this.userPrompt = prompt;
        this.accumulatedOutput = '';
        this.accumulatedStderr = '';
        this.draft = null;

        console.log(`[PlannerAgent] Starting plan generation (prompt=${prompt.slice(0, 80)}..., hasFeedback=${!!feedback})`);

        try {
            // Step 1: Scan workspace
            this.emit('plan:status', 'generating', 'Scanning workspace...');
            this.fileTree = await this.collectFileTree(
                this.config.workspaceRoot,
                this.config.maxTreeDepth
            );
            console.log(`[PlannerAgent] File tree collected: ${this.fileTree.length} entries`);

            // Step 2: Build the planner prompt
            const systemPrompt = this.buildPlannerPrompt(prompt, this.fileTree, feedback);
            console.log(`[PlannerAgent] Prompt built: ${systemPrompt.length} chars`);

            // Step 3: Spawn the planner worker
            this.emit('plan:status', 'generating', 'AI agent is creating your plan...');
            console.log(`[PlannerAgent] Creating ADK session...`);
            this.activeSession = await this.adapter.createSession({
                zeroContext: true,
                workingDirectory: this.config.workspaceRoot,
                initialPrompt: systemPrompt,
            });
            console.log(`[PlannerAgent] ADK session created: ${this.activeSession.sessionId}`);

            // Wire output accumulation
            this.activeSession.onOutput((stream, chunk) => {
                this.accumulatedOutput += chunk;
                if (stream === 'stderr') {
                    this.accumulatedStderr += chunk;
                }
            });

            // Wire exit handler
            this.activeSession.onExit((exitCode) => {
                console.log(`[PlannerAgent] Worker exited with code ${exitCode}`);
                this.activeSession = null;
                this.onWorkerExited(exitCode);
            });
        } catch (err) {
            this.activeSession = null;
            const error = err instanceof Error ? err : new Error(String(err));
            console.error(`[PlannerAgent] plan() threw:`, error.message, error.stack);
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

    // ═══════════════════════════════════════════════════════════════════════════
    //  Private
    // ═══════════════════════════════════════════════════════════════════════════

    private onWorkerExited(exitCode: number): void {
        console.log(`[PlannerAgent] onWorkerExited(${exitCode}), accumulatedOutput (${this.accumulatedOutput.length} chars):\n${this.accumulatedOutput || '(empty)'}\nstderr (${this.accumulatedStderr.length} chars):\n${this.accumulatedStderr || '(empty)'}`);


        if (exitCode !== 0) {
            const detail = this.accumulatedStderr || this.accumulatedOutput || '(no output captured)';
            const errorMsg = `Planner agent exited with code ${exitCode}. Detail: ${detail.slice(0, 500)}`;
            console.error(`[PlannerAgent] ERROR: ${errorMsg}`);
            this.emit('plan:status', 'error', errorMsg);
            this.emit('plan:error', new Error(errorMsg));
            return;
        }

        // Parse the accumulated output for a JSON runbook
        this.emit('plan:status', 'parsing', 'Parsing generated plan...');
        console.log(`[PlannerAgent] Parsing output (${this.accumulatedOutput.length} chars)...`);
        console.log(`[PlannerAgent] First 300 chars: ${this.accumulatedOutput.slice(0, 300)}`);
        const parsed = this.extractRunbook(this.accumulatedOutput);

        if (!parsed) {
            const errorMsg = 'Planner agent did not produce a valid JSON runbook. Raw output:\n' +
                this.accumulatedOutput.slice(0, 500);
            console.error(`[PlannerAgent] Parse FAILED: ${errorMsg}`);
            this.emit('plan:status', 'error', 'Failed to parse runbook from agent output');
            this.emit('plan:error', new Error(errorMsg));
            return;
        }

        console.log(`[PlannerAgent] Plan parsed successfully: ${parsed.phases.length} phases, project_id=${parsed.project_id}`);
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
        const fencedMatch = output.match(/```json\s*\n([\s\S]*?)\n```/);
        if (fencedMatch) {
            try {
                return this.validateRunbook(JSON.parse(fencedMatch[1]));
            } catch { /* fall through */ }
        }

        // Strategy 2: Look for raw JSON object { ... }
        const jsonMatch = output.match(/\{[\s\S]*"phases"\s*:\s*\[[\s\S]*\]\s*[\s\S]*\}/);
        if (jsonMatch) {
            try {
                return this.validateRunbook(JSON.parse(jsonMatch[0]));
            } catch { /* fall through */ }
        }

        return null;
    }

    /**
     * Validate that parsed JSON has the minimum required Runbook shape.
     */
    private validateRunbook(obj: unknown): Runbook | null {
        if (!obj || typeof obj !== 'object') return null;
        const r = obj as Record<string, unknown>;

        if (typeof r.project_id !== 'string') return null;
        if (!Array.isArray(r.phases) || r.phases.length === 0) return null;

        // Validate each phase has required fields
        for (const p of r.phases) {
            if (typeof p !== 'object' || p === null) return null;
            const phase = p as Record<string, unknown>;
            if (typeof phase.id !== 'number') return null;
            if (typeof phase.prompt !== 'string') return null;
            if (!Array.isArray(phase.context_files)) return null;
            if (typeof phase.success_criteria !== 'string') return null;
        }

        // Ensure default fields
        return {
            project_id: r.project_id as string,
            status: 'idle',
            current_phase: 0,
            phases: (r.phases as Array<Record<string, unknown>>).map((p, i) => ({
                id: typeof p.id === 'number' ? p.id : i,
                status: 'pending' as const,
                prompt: p.prompt as string,
                context_files: p.context_files as string[],
                success_criteria: (p.success_criteria as string) || 'exit_code:0',
                ...(Array.isArray(p.depends_on) ? { depends_on: p.depends_on as number[] } : {}),
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
            '.isolated_agent',
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
     */
    private buildPlannerPrompt(
        userPrompt: string,
        fileTree: string[],
        feedback?: string
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

## JSON Schema
\`\`\`json
{
  "project_id": "<descriptive-slug>",
  "status": "idle",
  "current_phase": 0,
  "phases": [
    {
      "id": 0,
      "status": "pending",
      "prompt": "<detailed instruction for the AI worker>",
      "context_files": ["<relative/path/to/file.ts>"],
      "success_criteria": "exit_code:0"
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
