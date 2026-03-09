// ─────────────────────────────────────────────────────────────────────────────
// src/mcp/MCPPromptHandler.ts — MCP Prompt handlers (stateless message composers)
// ─────────────────────────────────────────────────────────────────────────────
// P4: Expose Coogent's internal workflows as discoverable MCP Prompts.
// Each prompt composes a messages array from arguments — they do NOT execute
// workflows. Follows the handler delegation pattern from MCPResourceHandler
// and MCPToolHandler.

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
    ListPromptsRequestSchema,
    GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import log from '../logger/log.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Prompt Definitions
// ═══════════════════════════════════════════════════════════════════════════════

/** Metadata version embedded in every prompt description for contract tracking. */
const PROMPT_VERSION = '1.0.0';

/**
 * Argument descriptor used in ListPrompts responses.
 */
interface PromptArgument {
    name: string;
    description: string;
    required?: boolean;
}

/**
 * Canonical prompt definition used for both listing and dispatch.
 */
interface PromptDefinition {
    name: string;
    description: string;
    arguments: PromptArgument[];
    compose: (args: Record<string, string>) => Array<{ role: string; content: { type: string; text: string } }>;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Prompt Composers — pure functions that build message arrays
// ═══════════════════════════════════════════════════════════════════════════════

function composePlanRepoTask(args: Record<string, string>): Array<{ role: string; content: { type: string; text: string } }> {
    const sections = [
        `## Task\n${args['task']}`,
    ];
    if (args['repo_summary']) {
        sections.push(`## Repository Summary\n${args['repo_summary']}`);
    }
    if (args['constraints']) {
        sections.push(`## Constraints\n${args['constraints']}`);
    }
    if (args['preferred_workers']) {
        sections.push(`## Preferred Workers\n${args['preferred_workers']}`);
    }
    return [
        {
            role: 'user',
            content: {
                type: 'text',
                text: sections.join('\n\n'),
            },
        },
        {
            role: 'assistant',
            content: {
                type: 'text',
                text: 'I will create a detailed implementation plan for this task, breaking it into phases with clear dependencies and success criteria.',
            },
        },
    ];
}

function composeReviewGeneratedRunbook(args: Record<string, string>): Array<{ role: string; content: { type: string; text: string } }> {
    const sections = [
        `## Runbook to Review\n\`\`\`json\n${args['runbook']}\n\`\`\``,
    ];
    if (args['review_focus']) {
        sections.push(`## Review Focus\n${args['review_focus']}`);
    }
    if (args['risk_tolerance']) {
        sections.push(`## Risk Tolerance: ${args['risk_tolerance']}`);
    }
    return [
        {
            role: 'user',
            content: {
                type: 'text',
                text: sections.join('\n\n'),
            },
        },
        {
            role: 'assistant',
            content: {
                type: 'text',
                text: 'I will review this runbook for correctness, completeness, dependency ordering, and risk assessment.',
            },
        },
    ];
}

function composeRepairFailedPhase(args: Record<string, string>): Array<{ role: string; content: { type: string; text: string } }> {
    return [
        {
            role: 'user',
            content: {
                type: 'text',
                text: [
                    `## Phase Context\n${args['phase_context']}`,
                    `## Prior Output\n${args['prior_output']}`,
                    `## Failure Reason\n${args['failure_reason']}`,
                    `## Retry Count: ${args['retry_count']}`,
                ].join('\n\n'),
            },
        },
        {
            role: 'assistant',
            content: {
                type: 'text',
                text: 'I will analyze the failure, identify the root cause, and produce a corrected output for this phase.',
            },
        },
    ];
}

function composeConsolidateSession(args: Record<string, string>): Array<{ role: string; content: { type: string; text: string } }> {
    const sections = [
        `## Phase Handoffs\n\`\`\`json\n${args['handoffs']}\n\`\`\``,
        `## Modified Files\n\`\`\`json\n${args['modified_files']}\n\`\`\``,
    ];
    if (args['unresolved_issues']) {
        sections.push(`## Unresolved Issues\n${args['unresolved_issues']}`);
    }
    return [
        {
            role: 'user',
            content: {
                type: 'text',
                text: sections.join('\n\n'),
            },
        },
        {
            role: 'assistant',
            content: {
                type: 'text',
                text: 'I will consolidate all phase results into a comprehensive session report with decisions, changes, and outstanding issues.',
            },
        },
    ];
}

function composeArchitectureReviewWorkspace(args: Record<string, string>): Array<{ role: string; content: { type: string; text: string } }> {
    const sections = [
        `## Workspace Summary\n${args['workspace_summary']}`,
    ];
    if (args['review_scope']) {
        sections.push(`## Review Scope\n${args['review_scope']}`);
    }
    if (args['output_style']) {
        sections.push(`## Output Style: ${args['output_style']}`);
    }
    return [
        {
            role: 'user',
            content: {
                type: 'text',
                text: sections.join('\n\n'),
            },
        },
        {
            role: 'assistant',
            content: {
                type: 'text',
                text: 'I will review the workspace architecture, identifying strengths, risks, and recommendations for improvement.',
            },
        },
    ];
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Prompt Registry
// ═══════════════════════════════════════════════════════════════════════════════

const PROMPTS: PromptDefinition[] = [
    {
        name: 'plan_repo_task',
        description: `[v${PROMPT_VERSION}] Generate a phased implementation plan for a repository task, with DAG dependencies and success criteria.`,
        arguments: [
            { name: 'task', description: 'Description of the task to plan.', required: true },
            { name: 'repo_summary', description: 'Optional summary of the repository structure and conventions.' },
            { name: 'constraints', description: 'Optional constraints or requirements to respect.' },
            { name: 'preferred_workers', description: 'Optional comma-separated list of preferred worker agent types.' },
        ],
        compose: composePlanRepoTask,
    },
    {
        name: 'review_generated_runbook',
        description: `[v${PROMPT_VERSION}] Review a generated runbook JSON for correctness, completeness, and risk.`,
        arguments: [
            { name: 'runbook', description: 'JSON string of the runbook to review.', required: true },
            { name: 'review_focus', description: 'Optional area to focus the review on.' },
            { name: 'risk_tolerance', description: "Optional risk tolerance level: 'low', 'medium', or 'high'." },
        ],
        compose: composeReviewGeneratedRunbook,
    },
    {
        name: 'repair_failed_phase',
        description: `[v${PROMPT_VERSION}] Diagnose and repair a failed phase, analyzing context, prior output, and failure reason.`,
        arguments: [
            { name: 'phase_context', description: 'Context and prompt for the failed phase.', required: true },
            { name: 'prior_output', description: 'The output produced before the failure.', required: true },
            { name: 'failure_reason', description: 'Description of why the phase failed.', required: true },
            { name: 'retry_count', description: 'Number of retry attempts so far.', required: true },
        ],
        compose: composeRepairFailedPhase,
    },
    {
        name: 'consolidate_session',
        description: `[v${PROMPT_VERSION}] Consolidate all phase handoffs and modified files into a final session report.`,
        arguments: [
            { name: 'handoffs', description: 'JSON string of all phase handoff objects.', required: true },
            { name: 'modified_files', description: 'JSON string of all modified file paths.', required: true },
            { name: 'unresolved_issues', description: 'Optional description of unresolved issues or blockers.' },
        ],
        compose: composeConsolidateSession,
    },
    {
        name: 'architecture_review_workspace',
        description: `[v${PROMPT_VERSION}] Review the architecture of a workspace, identifying strengths, risks, and improvement areas.`,
        arguments: [
            { name: 'workspace_summary', description: 'Summary of the workspace structure and key components.', required: true },
            { name: 'review_scope', description: 'Optional scope to limit the review (e.g., "security", "performance").' },
            { name: 'output_style', description: "Optional output style: 'brief', 'detailed', or 'executive'." },
        ],
        compose: composeArchitectureReviewWorkspace,
    },
];

// ═══════════════════════════════════════════════════════════════════════════════
//  MCPPromptHandler
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Registers MCP Prompt handlers (stateless) on a given MCP Server instance.
 *
 * Prompts:
 *   - plan_repo_task
 *   - review_generated_runbook
 *   - repair_failed_phase
 *   - consolidate_session
 *   - architecture_review_workspace
 */
export class MCPPromptHandler {
    constructor(private readonly server: Server) { }

    /**
     * Register all prompt-related protocol handlers on the MCP server.
     * Must be called once during server initialisation.
     */
    register(): void {
        this.registerListPrompts();
        this.registerGetPrompt();
    }

    // ── ListPromptsRequest ───────────────────────────────────────────────

    private registerListPrompts(): void {
        this.server.setRequestHandler(ListPromptsRequestSchema, async () => {
            return {
                prompts: PROMPTS.map((p) => ({
                    name: p.name,
                    description: p.description,
                    arguments: p.arguments,
                })),
            };
        });
    }

    // ── GetPromptRequest ─────────────────────────────────────────────────

    private registerGetPrompt(): void {
        this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
            const { name } = request.params;
            const args = (request.params.arguments ?? {}) as Record<string, string>;

            const prompt = PROMPTS.find((p) => p.name === name);
            if (!prompt) {
                throw new Error(`Unknown prompt: ${name}`);
            }

            // Validate required arguments
            for (const arg of prompt.arguments) {
                if (arg.required && (!args[arg.name] || args[arg.name].trim() === '')) {
                    throw new Error(
                        `Missing required argument '${arg.name}' for prompt '${name}'.`
                    );
                }
            }

            // Log prompt invocation
            log.info(
                `[MCPPromptHandler] Prompt invoked: ${name} (v${PROMPT_VERSION}) — ` +
                `args=[${Object.keys(args).join(', ')}] at ${new Date().toISOString()}`
            );

            const messages = prompt.compose(args);

            return {
                description: prompt.description,
                messages,
            };
        });
    }
}
