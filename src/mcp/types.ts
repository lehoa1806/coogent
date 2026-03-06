// ─────────────────────────────────────────────────────────────────────────────
// src/mcp/types.ts — Hierarchical state store types for the Coogent MCP Server
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hierarchical state store types for the Coogent MCP Server.
 *
 * Structure:
 *   masterTaskId (YYYYMMDD-HHMMSS-<uuid>)
 *     ├── runbook: Runbook
 *     ├── implementationPlan: string (Markdown)
 *     ├── consolidationReport: string (Markdown)
 *     └── phases: Map<phaseId, PhaseArtifacts>
 *           ├── implementationPlan: string (Markdown)
 *           └── handoff: PhaseHandoff
 */

// ═══════════════════════════════════════════════════════════════════════════════
//  Phase Handoff — artifacts produced by a completed worker phase
// ═══════════════════════════════════════════════════════════════════════════════

export interface PhaseHandoff {
    /** Phase identifier in the format `phase-<index>-<uuid>`. */
    phaseId: string;
    /** Master task identifier in the format `YYYYMMDD-HHMMSS-<uuid>`. */
    masterTaskId: string;
    /** Key decisions made during this phase. */
    decisions: string[];
    /** Relative paths to files created or modified. */
    modifiedFiles: string[];
    /** Unresolved issues or blockers encountered. */
    blockers: string[];
    /** Unix timestamp (ms) when this phase completed. */
    completedAt: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Phase Artifacts — container for all artifacts within a single phase
// ═══════════════════════════════════════════════════════════════════════════════

export interface PhaseArtifacts {
    /** Phase-level Markdown implementation plan. */
    implementationPlan?: string | undefined;
    /** Handoff data produced when the phase completes. */
    handoff?: PhaseHandoff | undefined;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Task State — top-level container for one master task
// ═══════════════════════════════════════════════════════════════════════════════

export interface TaskState {
    /** Master task identifier in the format `YYYYMMDD-HHMMSS-<uuid>`. */
    masterTaskId: string;
    /** Short human-readable summary of the task. */
    summary?: string | undefined;
    /** Master-level Markdown implementation plan. */
    implementationPlan?: string | undefined;
    /** Reducer agent's final Markdown consolidation report. */
    consolidationReport?: string | undefined;
    /** Nested phase artifacts, keyed by `phaseId`. */
    phases: Map<string, PhaseArtifacts>;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ID Validation — regex patterns for hierarchical identifiers
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Matches a master task ID in the format `YYYYMMDD-HHMMSS-<uuid>`.
 * Example: `20260305-173000-a1b2c3d4-e5f6-7890-abcd-ef1234567890`
 */
export const MASTER_TASK_ID_PATTERN =
    /^\d{8}-\d{6}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Matches a phase ID in the format `phase-<index>-<uuid>`.
 * Example: `phase-001-a1b2c3d4-e5f6-7890-abcd-ef1234567890`
 */
export const PHASE_ID_PATTERN =
    /^phase-\d{3}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ═══════════════════════════════════════════════════════════════════════════════
//  URI Parsing — extract hierarchical IDs from coogent:// resource URIs
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Extracts `masterTaskId` and optionally `phaseId` from a `coogent://` URI.
 *
 * Supported URI formats:
 *   coogent://tasks/{masterTaskId}/summary
 *   coogent://tasks/{masterTaskId}/implementation_plan
 *   coogent://tasks/{masterTaskId}/consolidation_report
 *   coogent://tasks/{masterTaskId}/phases/{phaseId}/implementation_plan
 *   coogent://tasks/{masterTaskId}/phases/{phaseId}/handoff
 */
export interface ParsedResourceURI {
    masterTaskId: string;
    phaseId?: string | undefined;
    resource: 'summary' | 'implementation_plan' | 'consolidation_report' | 'handoff';
}

/**
 * Regex for extracting the masterTaskId from a coogent:// URI segment.
 * Captures: YYYYMMDD-HHMMSS-<uuid>
 */
export const URI_MASTER_TASK_REGEX =
    /(\d{8}-\d{6}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;

/**
 * Regex for extracting the phaseId from a coogent:// URI segment.
 * Captures: phase-<index>-<uuid>
 */
export const URI_PHASE_ID_REGEX =
    /(phase-\d{3}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;

// ═══════════════════════════════════════════════════════════════════════════════
//  MCP Resource URI Templates — build coogent:// URIs for resources
// ═══════════════════════════════════════════════════════════════════════════════

export const RESOURCE_URIS = {
    /** URI for the master task's summary. */
    taskSummary: (taskId: string) => `coogent://tasks/${taskId}/summary`,
    /** URI for the master task's implementation plan. */
    taskPlan: (taskId: string) => `coogent://tasks/${taskId}/implementation_plan`,
    /** URI for the master task's consolidation report. */
    taskReport: (taskId: string) => `coogent://tasks/${taskId}/consolidation_report`,
    /** URI for a phase-level implementation plan. */
    phasePlan: (taskId: string, phaseId: string) =>
        `coogent://tasks/${taskId}/phases/${phaseId}/implementation_plan`,
    /** URI for a phase handoff artifact. */
    phaseHandoff: (taskId: string, phaseId: string) =>
        `coogent://tasks/${taskId}/phases/${phaseId}/handoff`,
} as const;

// ═══════════════════════════════════════════════════════════════════════════════
//  MCP Tool Names — canonical tool name constants
// ═══════════════════════════════════════════════════════════════════════════════

export const MCP_TOOLS = {
    SUBMIT_IMPLEMENTATION_PLAN: 'submit_implementation_plan',
    SUBMIT_PHASE_HANDOFF: 'submit_phase_handoff',
    SUBMIT_CONSOLIDATION_REPORT: 'submit_consolidation_report',
    GET_MODIFIED_FILE_CONTENT: 'get_modified_file_content',
} as const;
