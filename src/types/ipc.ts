// ─────────────────────────────────────────────────────────────────────────────
// src/types/ipc.ts — IPC message contracts between Webview and Extension Host
// ─────────────────────────────────────────────────────────────────────────────

import type { SessionSummary } from '../session/SessionManager.js';
import type { EngineState } from './engine.js';
import type {
    PhaseId,
    PhaseStatus,
    FileTokenEntry,
    UnixTimestampMs,
    ConversationMode,
    Runbook,
    Phase,
} from './phase.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Host → Webview (state projections)
// ═══════════════════════════════════════════════════════════════════════════════

export interface StateSnapshotMessage {
    readonly type: 'STATE_SNAPSHOT';
    readonly payload: {
        runbook: Runbook;
        engineState: EngineState;
        /**
         * The real session directory name used as the MCP task key.
         * Populated from `path.basename(sessionDir)` by the Extension Host.
         * The Webview uses this (not `runbook.project_id`) for URI construction.
         */
        masterTaskId?: string;
    };
}

export interface PhaseStatusMessage {
    readonly type: 'PHASE_STATUS';
    readonly payload: {
        phaseId: PhaseId;
        status: PhaseStatus;
        durationMs?: number;
    };
}

export interface TokenBudgetMessage {
    readonly type: 'TOKEN_BUDGET';
    readonly payload: {
        phaseId: PhaseId;
        breakdown: readonly FileTokenEntry[];
        totalTokens: number;
        limit: number;
    };
}

/** Known error codes for typed error handling. */
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

export interface ErrorMessage {
    readonly type: 'ERROR';
    readonly payload: {
        code: ErrorCode;
        message: string;
        phaseId?: PhaseId;
    };
}

export interface LogEntryMessage {
    readonly type: 'LOG_ENTRY';
    readonly payload: {
        timestamp: UnixTimestampMs;
        level: 'info' | 'warn' | 'error';
        message: string;
    };
}

/** Planning draft message — planner agent produced a runbook draft. */
export interface PlanDraftMessage {
    readonly type: 'PLAN_DRAFT';
    readonly payload: {
        draft: Runbook;
        fileTree: readonly string[];
    };
}

/** Planning status message — spinner updates during planning. */
export interface PlanStatusMessage {
    readonly type: 'PLAN_STATUS';
    readonly payload: {
        status: 'generating' | 'parsing' | 'ready' | 'error' | 'timeout';
        message?: string;
    };
}

/** Session list message — recent sessions for the history drawer. */
export interface SessionListMessage {
    readonly type: 'SESSION_LIST';
    readonly payload: {
        sessions: readonly SessionSummary[];
    };
}

/** Session search results message — filtered sessions from a search query. */
export interface SessionSearchResultsMessage {
    readonly type: 'SESSION_SEARCH_RESULTS';
    readonly payload: {
        query: string;
        sessions: readonly SessionSummary[];
    };
}

/** Conversation mode sync message — tells the Webview which mode is active. */
export interface ConversationModeMessage {
    readonly type: 'CONVERSATION_MODE';
    readonly payload: {
        mode: ConversationMode;
        smartSwitchTokenThreshold: number;
    };
}

/** Consolidation report message — final report after all phases pass. */
export interface ConsolidationReportMessage {
    readonly type: 'CONSOLIDATION_REPORT';
    readonly payload: {
        /** Markdown-formatted consolidation report. */
        report: string;
    };
}

/** Per-phase worker output — routes output to specific phase detail views. */
export interface PhaseOutputMessage {
    readonly type: 'PHASE_OUTPUT';
    readonly payload: {
        phaseId: PhaseId;
        stream: 'stdout' | 'stderr';
        chunk: string;
    };
}

/** Planning summary message — delivers planning phase output for the review gate. */
export interface PlanSummaryMessage {
    readonly type: 'PLAN_SUMMARY';
    readonly payload: {
        summary: string;
    };
}

/** Execution plan message — markdown content of execution_plan.md. */
export interface ImplementationPlanMessage {
    readonly type: 'IMPLEMENTATION_PLAN';
    readonly payload: {
        /** Markdown-formatted implementation plan. */
        plan: string;
    };
}

/** MCP resource data response — Extension Host → Webview. */
export interface MCPResourceDataMessage {
    readonly type: 'MCP_RESOURCE_DATA';
    readonly payload: {
        /** Correlation ID matching the original fetch request. */
        requestId: string;
        /** The resolved resource content (string for Markdown/plain text, object for JSON). */
        data: string | object;
        /** Error message if the resource could not be resolved. */
        error?: string;
    };
}

/** Suggestion items for @ mention and / workflow popups. */
export interface SuggestionDataMessage {
    readonly type: 'SUGGESTION_DATA';
    readonly payload: {
        mentions: readonly { label: string; description: string; insert: string }[];
        workflows: readonly { label: string; description: string; insert: string }[];
    };
}

/** File/image attachment selection result from the Extension Host. */
export interface AttachmentSelectedMessage {
    readonly type: 'ATTACHMENT_SELECTED';
    readonly payload: {
        paths: readonly string[];
    };
}

/** Workers loaded message — sends loaded worker profiles to the Webview. */
export interface WorkersLoadedMessage {
    readonly type: 'workers:loaded';
    readonly workers: readonly import('../agent-selection/types.js').AgentProfile[];
}

/**
 * Discriminated union of all messages the Extension Host sends to the Webview.
 * Use `HostToWebviewMessageType` for the `type` string literal union.
 */
export type HostToWebviewMessage =
    | StateSnapshotMessage
    | PhaseStatusMessage
    | TokenBudgetMessage
    | ErrorMessage
    | LogEntryMessage
    | PlanDraftMessage
    | PlanStatusMessage
    | SessionListMessage
    | SessionSearchResultsMessage
    | ConversationModeMessage
    | ConsolidationReportMessage
    | PhaseOutputMessage
    | PlanSummaryMessage
    | ImplementationPlanMessage
    | MCPResourceDataMessage
    | SuggestionDataMessage
    | AttachmentSelectedMessage
    | WorkersLoadedMessage;

// ═══════════════════════════════════════════════════════════════════════════════
//  Webview → Host (user commands)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Dual-purpose start/resume command.
 * When the engine is in READY state, this starts execution.
 * When the engine is paused (cooperative pause via flag), this resumes.
 */
export interface CmdStartMessage {
    readonly type: 'CMD_START';
}

export interface CmdAbortMessage {
    readonly type: 'CMD_ABORT';
}

export interface CmdRetryMessage {
    readonly type: 'CMD_RETRY';
    readonly payload: { phaseId: PhaseId };
}

export interface CmdSkipPhaseMessage {
    readonly type: 'CMD_SKIP_PHASE';
    readonly payload: { phaseId: PhaseId };
}

export interface CmdPausePhaseMessage {
    readonly type: 'CMD_PAUSE_PHASE';
    readonly payload: { phaseId: PhaseId };
}

export interface CmdStopPhaseMessage {
    readonly type: 'CMD_STOP_PHASE';
    readonly payload: { phaseId: PhaseId };
}

export interface CmdRestartPhaseMessage {
    readonly type: 'CMD_RESTART_PHASE';
    readonly payload: { phaseId: PhaseId };
}

export interface CmdEditPhaseMessage {
    readonly type: 'CMD_EDIT_PHASE';
    readonly payload: {
        phaseId: PhaseId;
        patch: Partial<Pick<Phase, 'prompt' | 'context_files' | 'success_criteria'>>;
    };
}

export interface CmdLoadRunbookMessage {
    readonly type: 'CMD_LOAD_RUNBOOK';
    readonly payload?: { filePath: string };
}

export interface CmdRequestStateMessage {
    readonly type: 'CMD_REQUEST_STATE';
}

/** User submits a prompt for the Planner Agent to generate a runbook. */
export interface CmdPlanRequestMessage {
    readonly type: 'CMD_PLAN_REQUEST';
    readonly payload: {
        prompt: string;
        feedback?: string;
    };
}

/** User approves the AI-generated plan. */
export interface CmdPlanApproveMessage {
    readonly type: 'CMD_PLAN_APPROVE';
}

/** User rejects the plan and provides feedback for re-generation. */
export interface CmdPlanRejectMessage {
    readonly type: 'CMD_PLAN_REJECT';
    readonly payload: {
        feedback: string;
    };
}

/** User edits the draft runbook directly in the review panel. */
export interface CmdPlanEditDraftMessage {
    readonly type: 'CMD_PLAN_EDIT_DRAFT';
    readonly payload: {
        draft: Runbook;
    };
}

/** User requests re-parsing of cached timeout output (no full re-generation). */
export interface CmdPlanRetryParseMessage {
    readonly type: 'CMD_PLAN_RETRY_PARSE';
}

/** User requests a full reset (start new chat) from COMPLETED state. */
export interface CmdResetMessage {
    readonly type: 'CMD_RESET';
}

/** User requests the list of recent/past sessions. */
export interface CmdListSessionsMessage {
    readonly type: 'CMD_LIST_SESSIONS';
}

/** User searches past sessions by query string. */
export interface CmdSearchSessionsMessage {
    readonly type: 'CMD_SEARCH_SESSIONS';
    readonly payload: {
        query: string;
    };
}

/** User loads a specific past session by ID. */
export interface CmdLoadSessionMessage {
    readonly type: 'CMD_LOAD_SESSION';
    readonly payload: {
        sessionId: string;
    };
}

/** User sets the conversation mode via the toggle. */
export interface CmdSetConversationModeMessage {
    readonly type: 'CMD_SET_CONVERSATION_MODE';
    readonly payload: {
        mode: ConversationMode;
    };
}

/** User requests the consolidation report for the current session. */
export interface CmdRequestReportMessage {
    readonly type: 'CMD_REQUEST_REPORT';
}

/** User requests the implementation plan for the current session. */
export interface CmdRequestPlanMessage {
    readonly type: 'CMD_REQUEST_PLAN';
}

/** User deletes a session from history. */
export interface CmdDeleteSessionMessage {
    readonly type: 'CMD_DELETE_SESSION';
    readonly payload: {
        sessionId: string;
    };
}

/** User requests to review a diff for a specific phase. */
export interface CmdReviewDiffMessage {
    readonly type: 'CMD_REVIEW_DIFF';
    readonly payload: {
        phaseId: PhaseId;
    };
}

/** User requests to resume all pending phases with satisfied dependencies. */
export interface CmdResumePendingMessage {
    readonly type: 'CMD_RESUME_PENDING';
}

/** Webview requests a specific MCP resource by URI. */
export interface MCPFetchResourceMessage {
    readonly type: 'MCP_FETCH_RESOURCE';
    readonly payload: {
        /** The `coogent://` URI to resolve. */
        uri: string;
        /** Unique correlation ID for async response matching. */
        requestId: string;
    };
}

/** User requests to attach a file from the workspace. */
export interface CmdUploadFileMessage {
    readonly type: 'CMD_UPLOAD_FILE';
}

/** User requests to attach an image from the workspace. */
export interface CmdUploadImageMessage {
    readonly type: 'CMD_UPLOAD_IMAGE';
}

/** Webview requests the list of loaded worker profiles. */
export interface CmdWorkersRequestMessage {
    readonly type: 'workers:request';
}

/**
 * Discriminated union of all messages the Webview sends to the Extension Host.
 * Use `WebviewToHostMessageType` for the `type` string literal union.
 */
export type WebviewToHostMessage =
    | CmdStartMessage
    | CmdAbortMessage
    | CmdRetryMessage
    | CmdSkipPhaseMessage
    | CmdPausePhaseMessage
    | CmdStopPhaseMessage
    | CmdRestartPhaseMessage
    | CmdEditPhaseMessage
    | CmdLoadRunbookMessage
    | CmdResetMessage
    | CmdRequestStateMessage
    | CmdPlanRequestMessage
    | CmdPlanApproveMessage
    | CmdPlanRejectMessage
    | CmdPlanEditDraftMessage
    | CmdPlanRetryParseMessage
    | CmdSetConversationModeMessage
    | CmdRequestReportMessage
    | CmdRequestPlanMessage
    | CmdReviewDiffMessage
    | CmdResumePendingMessage
    | MCPFetchResourceMessage
    | CmdUploadFileMessage
    | CmdUploadImageMessage
    | CmdWorkersRequestMessage
    | CmdListSessionsMessage
    | CmdSearchSessionsMessage
    | CmdLoadSessionMessage
    | CmdDeleteSessionMessage;

/** Helper: union of all Host → Webview message type string literals (#95). */
export type HostToWebviewMessageType = HostToWebviewMessage['type'];

/** Helper: union of all Webview → Host message type string literals (#95). */
export type WebviewToHostMessageType = WebviewToHostMessage['type'];
