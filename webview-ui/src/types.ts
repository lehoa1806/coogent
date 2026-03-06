// ─────────────────────────────────────────────────────────────────────────────
// webview-ui/src/types.ts — Webview-side type definitions
//
// Mirrors the Extension Host's src/types/index.ts for IPC contract alignment.
// The webview cannot import directly from the Extension Host because they
// run in different execution contexts (browser sandbox vs Node.js).
// ─────────────────────────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════════
//  Phase & Runbook Models
// ═══════════════════════════════════════════════════════════════════════════════

/** Status of an individual phase within the runbook. */
export type PhaseStatus = 'pending' | 'running' | 'completed' | 'failed';

/**
 * Branded numeric type for phase identifiers.
 * Mirrors the Extension Host's `PhaseId` for compile-time safety.
 */
export type PhaseId = number & { readonly __brand: 'PhaseId' };

/** Conversation mode — controls how subtask conversations are managed. */
export type ConversationMode = 'isolated' | 'continuous' | 'smart';

/** A single micro-task within the runbook execution plan. */
export interface Phase {
    readonly id: PhaseId;
    status: PhaseStatus;
    prompt: string;
    context_files: readonly string[];
    success_criteria: string;
    depends_on?: readonly PhaseId[];
    context_summary?: string;
    /**
     * The real MCP-server phase ID string (format: `phase-NNN-<uuid>`).
     * Set by the Engine when a phase is dispatched to a worker.
     * Used to construct valid `coogent://` resource URIs.
     */
    mcpPhaseId?: string;
}

/** The persistent state file: .task-runbook.json */
export interface Runbook {
    readonly project_id: string;
    status: 'idle' | 'running' | 'paused_error' | 'completed';
    current_phase: number;
    readonly phases: readonly Phase[];
    summary?: string;
    implementation_plan?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Engine State Enum (mirrors Extension Host EngineState)
// ═══════════════════════════════════════════════════════════════════════════════

export type EngineState =
    | 'IDLE'
    | 'PLANNING'
    | 'PLAN_REVIEW'
    | 'PARSING'
    | 'READY'
    | 'EXECUTING_WORKER'
    | 'EVALUATING'
    | 'ERROR_PAUSED'
    | 'COMPLETED';

// ═══════════════════════════════════════════════════════════════════════════════
//  Session Summary (for history drawer)
// ═══════════════════════════════════════════════════════════════════════════════

export interface SessionSummary {
    readonly id: string;
    readonly timestamp: number;
    readonly projectId: string;
    readonly summary?: string;
    readonly phaseCount: number;
    readonly status: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Known Error Codes
// ═══════════════════════════════════════════════════════════════════════════════

export type ErrorCode =
    | 'RUNBOOK_NOT_FOUND'
    | 'PARSE_ERROR'
    | 'PHASE_FAILED'
    | 'WORKER_TIMEOUT'
    | 'WORKER_CRASH'
    | 'CYCLE_DETECTED'
    | 'VALIDATION_ERROR'
    | 'CONTEXT_ERROR'
    | 'PLAN_ERROR'
    | 'TOKEN_OVER_BUDGET'
    | 'COMMAND_ERROR'
    | 'GIT_DIRTY'
    | 'UNKNOWN';

// ═══════════════════════════════════════════════════════════════════════════════
//  AppState — Central UI state held by the Svelte store
// ═══════════════════════════════════════════════════════════════════════════════

export interface AppState {
    engineState: EngineState;
    phases: Phase[];
    selectedPhaseId: number | null;
    userSelectedPhaseId: number | null;
    projectId: string;
    /**
     * The real session directory name used as the MCP task key.
     * Use this (not `projectId`) for constructing `coogent://` URIs.
     */
    masterTaskId: string;
    planDraft: Runbook | null;
    elapsedSeconds: number;
    planSlideIndex: number;
    phaseOutputs: Record<number, string>;
    masterSummary: string;
    phaseTokenBudgets: Record<number, { totalTokens: number; limit: number; fileCount: number }>;

    // Extended fields for Svelte migration
    error: { code: ErrorCode; message: string } | null;
    terminalOutput: string;
    sessions: SessionSummary[];
    consolidationReport: string | null;
    implementationPlan: string | null;
    conversationMode: ConversationMode;
    planStatus: { status: string; message?: string } | null;
    planFileTree: string[];
}

/** Default initial state. */
export const DEFAULT_APP_STATE: AppState = {
    engineState: 'IDLE',
    phases: [],
    selectedPhaseId: null,
    userSelectedPhaseId: null,
    projectId: '',
    masterTaskId: '',
    planDraft: null,
    elapsedSeconds: 0,
    planSlideIndex: 0,
    phaseOutputs: {},
    masterSummary: '',
    phaseTokenBudgets: {},
    error: null,
    terminalOutput: '',
    sessions: [],
    consolidationReport: null,
    implementationPlan: null,
    conversationMode: 'isolated',
    planStatus: null,
    planFileTree: [],
};

// ═══════════════════════════════════════════════════════════════════════════════
//  Host → Webview Messages (discriminated union)
// ═══════════════════════════════════════════════════════════════════════════════

export type HostToWebviewMessage =
    | { type: 'STATE_SNAPSHOT'; payload: { runbook: Runbook; engineState: EngineState; masterTaskId?: string } }
    | { type: 'PHASE_STATUS'; payload: { phaseId: number; status: PhaseStatus; durationMs?: number } }
    | { type: 'WORKER_OUTPUT'; payload: { phaseId: number; stream: 'stdout' | 'stderr'; chunk: string } }
    | { type: 'TOKEN_BUDGET'; payload: { phaseId: number; breakdown: { path: string; tokens: number }[]; totalTokens: number; limit: number } }
    | { type: 'ERROR'; payload: { code: ErrorCode; message: string; phaseId?: number } }
    | { type: 'LOG_ENTRY'; payload: { timestamp: number; level: 'info' | 'warn' | 'error'; message: string } }
    | { type: 'PLAN_DRAFT'; payload: { draft: Runbook; fileTree: string[] } }
    | { type: 'PLAN_STATUS'; payload: { status: string; message?: string } }
    | { type: 'SESSION_LIST'; payload: { sessions: SessionSummary[] } }
    | { type: 'SESSION_SEARCH_RESULTS'; payload: { query: string; sessions: SessionSummary[] } }
    | { type: 'CONVERSATION_MODE'; payload: { mode: ConversationMode; smartSwitchTokenThreshold: number } }
    | { type: 'CONSOLIDATION_REPORT'; payload: { report: string } }
    | { type: 'PHASE_OUTPUT'; payload: { phaseId: number; stream: 'stdout' | 'stderr'; chunk: string } }
    | { type: 'PLAN_SUMMARY'; payload: { summary: string } }
    | { type: 'IMPLEMENTATION_PLAN'; payload: { plan: string } }
    | { type: 'MCP_RESOURCE_DATA'; payload: { requestId: string; data: string | object; error?: string } };

// ═══════════════════════════════════════════════════════════════════════════════
//  Webview → Host Messages (discriminated union)
// ═══════════════════════════════════════════════════════════════════════════════

export type WebviewToHostMessage =
    | { type: 'CMD_START' }
    | { type: 'CMD_PAUSE' }
    | { type: 'CMD_ABORT' }
    | { type: 'CMD_RETRY'; payload: { phaseId: number } }
    | { type: 'CMD_SKIP_PHASE'; payload: { phaseId: number } }
    | { type: 'CMD_PAUSE_PHASE'; payload: { phaseId: number } }
    | { type: 'CMD_STOP_PHASE'; payload: { phaseId: number } }
    | { type: 'CMD_RESTART_PHASE'; payload: { phaseId: number } }
    | { type: 'CMD_EDIT_PHASE'; payload: { phaseId: number; patch: Partial<Pick<Phase, 'prompt' | 'context_files' | 'success_criteria'>> } }
    | { type: 'CMD_LOAD_RUNBOOK'; payload?: { filePath: string } }
    | { type: 'CMD_RESET' }
    | { type: 'CMD_REQUEST_STATE' }
    | { type: 'CMD_PLAN_REQUEST'; payload: { prompt: string; feedback?: string } }
    | { type: 'CMD_PLAN_APPROVE' }
    | { type: 'CMD_PLAN_REJECT'; payload: { feedback: string } }
    | { type: 'CMD_PLAN_EDIT_DRAFT'; payload: { draft: Runbook } }
    | { type: 'CMD_PLAN_RETRY_PARSE' }
    | { type: 'CMD_LIST_SESSIONS' }
    | { type: 'CMD_SEARCH_SESSIONS'; payload: { query: string } }
    | { type: 'CMD_LOAD_SESSION'; payload: { sessionId: string } }
    | { type: 'CMD_SET_CONVERSATION_MODE'; payload: { mode: ConversationMode } }
    | { type: 'CMD_REQUEST_REPORT' }
    | { type: 'CMD_REQUEST_PLAN' }
    | { type: 'CMD_DELETE_SESSION'; payload: { sessionId: string } }
    | { type: 'CMD_REVIEW_DIFF'; payload: { phaseId: number } }
    | { type: 'CMD_RESUME_PENDING' }
    | { type: 'MCP_FETCH_RESOURCE'; payload: { uri: string; requestId: string } };
