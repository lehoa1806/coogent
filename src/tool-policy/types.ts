// ─────────────────────────────────────────────────────────────────────────────
// src/tool-policy/types.ts — Type definitions for the runtime tool policy system
// ─────────────────────────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════════
//  Tool Policy Mode — how a worker resolves its allowed tools
// ═══════════════════════════════════════════════════════════════════════════════

/** Whether the worker inherits the workspace default or uses an explicit list. */
export type ToolPolicyMode = 'inherit' | 'explicit';

// ═══════════════════════════════════════════════════════════════════════════════
//  Enforcement Mode — staged rollout control
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Controls how policy violations are handled during staged rollout.
 *
 * - `observe`       — log violations but never block (safe to deploy first)
 * - `compatibility` — log violations, deny only for workers with explicit policies
 * - `enforce`       — deny all violations
 */
export type EnforcementMode = 'observe' | 'compatibility' | 'enforce';

// ═══════════════════════════════════════════════════════════════════════════════
//  Allowed Tools Policy — per-worker access policy
// ═══════════════════════════════════════════════════════════════════════════════

/** The tool access policy attached to a worker profile. */
export interface AllowedToolsPolicy {
    /** Whether this worker inherits the workspace default or declares its own. */
    mode: ToolPolicyMode;
    /** Canonical tool IDs the worker is allowed to invoke (only for `explicit` mode). */
    allowedTools?: string[] | undefined;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Workspace Tool Policy — workspace-level defaults
// ═══════════════════════════════════════════════════════════════════════════════

/** Workspace-level default policy applied to all workers without an override. */
export interface WorkspaceToolPolicy {
    /** The fallback policy for workers that inherit. */
    defaultPolicy: AllowedToolsPolicy;
    /** Current enforcement stage. */
    enforcementMode: EnforcementMode;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Tool Invocation Context — runtime context for a single tool call
// ═══════════════════════════════════════════════════════════════════════════════

/** Runtime context attached to a tool invocation for policy evaluation & audit. */
export interface ToolInvocationContext {
    /** Master task run identifier. */
    runId: string;
    /** Session identifier. */
    sessionId: string;
    /** Phase identifier. */
    phaseId: string;
    /** Worker agent identifier. */
    workerId: string;
    /** The raw tool name as requested by the agent. */
    requestedToolId: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Tool Decision — the result of evaluating a policy
// ═══════════════════════════════════════════════════════════════════════════════

/** The outcome of a tool policy evaluation. */
export interface ToolDecision {
    /** Whether the tool invocation is allowed. */
    allowed: boolean;
    /** Canonical tool ID after normalization. */
    toolId: string;
    /** Which policy source produced this decision. */
    policySource: 'workspace_default' | 'worker_override' | 'compatibility_mode';
    /** Human-readable explanation (populated on denial). */
    reason?: string | undefined;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Tool Policy Error — structured error for denied tool calls
// ═══════════════════════════════════════════════════════════════════════════════

/** Structured error returned when a tool call is denied by policy. */
export interface ToolPolicyError {
    /** Error code — always `TOOL_NOT_ALLOWED`. */
    code: 'TOOL_NOT_ALLOWED';
    /** The worker that attempted the call. */
    workerId: string;
    /** The canonical tool ID that was denied. */
    toolId: string;
    /** Which policy source produced the denial. */
    policySource: 'workspace_default' | 'worker_override' | 'compatibility_mode';
    /** Human-readable error message. */
    message: string;
    /** Suggested remediation steps. */
    remediation?: string | undefined;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Audit Event Types — discriminated union of policy log events
// ═══════════════════════════════════════════════════════════════════════════════

/** Event types emitted by the tool policy subsystem for audit logging. */
export type ToolPolicyEventType =
    | 'tool_policy.allowed'
    | 'tool_policy.denied'
    | 'tool_policy.policy_resolved'
    | 'tool_policy.policy_resolution_failed';

// ═══════════════════════════════════════════════════════════════════════════════
//  Audit Entry — structured log record for policy decisions
// ═══════════════════════════════════════════════════════════════════════════════

/** A single audit log entry recording a tool policy evaluation. */
export interface ToolPolicyAuditEntry {
    /** Unix timestamp (ms) when the event occurred. */
    timestamp: number;
    /** The type of policy event. */
    eventType: ToolPolicyEventType;
    /** Master task run identifier. */
    runId: string;
    /** Session identifier. */
    sessionId: string;
    /** Phase identifier. */
    phaseId: string;
    /** Worker agent identifier. */
    workerId: string;
    /** Canonical tool ID. */
    toolId: string;
    /** Which policy source was in effect. */
    policySource: string;
    /** The final decision. */
    decision: 'allowed' | 'denied';
    /** Reason for denial, if applicable. */
    denialReason?: string | undefined;
    /** Correlation ID for linking related events. */
    correlationId: string;
}
