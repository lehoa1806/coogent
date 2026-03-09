// ─────────────────────────────────────────────────────────────────────────────
// src/types/context.ts — Context-sharing type contracts for master↔worker handoffs
// ─────────────────────────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════════
//  File Context Modes — granularity levels for injected file content
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Controls how much of a file is included in the context payload.
 * - `metadata`: Only symbol names and summary — minimal token cost.
 * - `patch`: Git diff of recent changes — good for review-oriented phases.
 * - `slice`: Selected line ranges (edited regions, symbols) — balanced cost.
 * - `full`: Entire file content — maximum fidelity, highest token cost.
 */
export type FileContextMode = 'metadata' | 'patch' | 'slice' | 'full';

// ═══════════════════════════════════════════════════════════════════════════════
//  Changed-File Handoff — per-file metadata passed between phases
// ═══════════════════════════════════════════════════════════════════════════════

/** Describes a file that was modified during a phase, for handoff to downstream phases. */
export interface ChangedFileHandoff {
    /** Workspace folder the file belongs to (multi-root support). */
    workspaceFolder?: string;
    /** Workspace-relative path to the changed file. */
    path: string;
    /** SHA-256 hash of the file snapshot at handoff time. */
    snapshotHash?: string;
    /** Git commit SHA the file was based on before edits. */
    baseCommit?: string;
    /** Suggested context mode for downstream phases to use. */
    modeHint?: FileContextMode;
    /** Unified diff patch of the changes made. */
    patch?: string;
    /** Fully-qualified symbols (functions, classes) touched by the edits. */
    symbolsTouched?: string[];
    /** Line ranges that were edited (1-indexed, inclusive). */
    editRegions?: Array<{ startLine: number; endLine: number }>;
    /** Human-readable summary of what changed and why. */
    summary?: string;
    /** Explanation of why these changes were made. */
    rationale?: string;
    /** Caveats or potential issues downstream phases should be aware of. */
    warnings?: string[];
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Handoff Packet — structured context passed from one phase to the next
// ═══════════════════════════════════════════════════════════════════════════════

/** A complete handoff packet produced by a phase for consumption by downstream phases. */
export interface HandoffPacket {
    /** Unique identifier for this handoff. */
    handoffId: string;
    /** Session this handoff belongs to. */
    sessionId: string;
    /** Task (runbook) this handoff belongs to. */
    taskId: string;
    /** The phase that produced this handoff. */
    fromPhaseId: string;
    /** Target phase IDs that should consume this handoff. */
    toPhaseIds?: string[];
    /** Workspace folder context for the handoff. */
    workspaceFolder?: string;
    /** Human-readable summary of the work completed. */
    summary: string;
    /** Explanation of the approach taken. */
    rationale?: string;
    /** Items explicitly left for downstream phases. */
    remainingWork?: string[];
    /** Constraints or invariants downstream phases must respect. */
    constraints?: string[];
    /** Potential issues or risks for downstream phases. */
    warnings?: string[];
    /** Repository state at the time of handoff. */
    repoState?: { baseCommit?: string; workingTree: 'clean' | 'patched' | 'unknown' };
    /** Files that were modified during the originating phase. */
    changedFiles: ChangedFileHandoff[];
    /** Key design or implementation decisions made. */
    decisions?: string[];
    /** Unresolved questions for downstream phases or the user. */
    openQuestions?: string[];
    /** ISO-8601 timestamp when this handoff was produced. */
    producedAt: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  File Slice — a contiguous range of lines extracted from a file
// ═══════════════════════════════════════════════════════════════════════════════

/** A contiguous range of lines extracted from a source file for context injection. */
export interface FileSlice {
    /** Workspace folder the file belongs to (multi-root support). */
    workspaceFolder?: string;
    /** Workspace-relative path to the source file. */
    path: string;
    /** First line of the slice (1-indexed, inclusive). */
    startLine: number;
    /** Last line of the slice (1-indexed, inclusive). */
    endLine: number;
    /** The extracted text content of the slice. */
    content: string;
    /** Why this particular slice was selected. */
    reason: 'edited-region' | 'symbol-neighborhood' | 'imports' | 'export-surface' | 'dependency';
}

// ═══════════════════════════════════════════════════════════════════════════════
//  File Context Entry — discriminated union of file inclusion strategies
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Discriminated union describing how a file is represented in the context pack.
 * The `mode` field determines which payload fields are present.
 */
export type FileContextEntry =
    | { /** Full file content. */ mode: 'full'; workspaceFolder?: string; path: string; snapshotHash?: string; content: string }
    | { /** Selected line-range slices. */ mode: 'slice'; workspaceFolder?: string; path: string; snapshotHash?: string; slices: FileSlice[] }
    | { /** Git diff patch only. */ mode: 'patch'; workspaceFolder?: string; path: string; snapshotHash?: string; patch: string }
    | { /** Metadata only (symbols, summary). */ mode: 'metadata'; workspaceFolder?: string; path: string; snapshotHash?: string; symbolsTouched?: string[]; summary?: string };

// ═══════════════════════════════════════════════════════════════════════════════
//  Context Pack — assembled context payload for a phase's worker agent
// ═══════════════════════════════════════════════════════════════════════════════

/** The fully-assembled context payload injected into a worker agent for a specific phase. */
export interface ContextPack {
    /** Phase this context pack was assembled for. */
    phaseId: string;
    /** Workspace folder context (multi-root support). */
    workspaceFolder?: string;
    /** The compiled prompt for the target phase. */
    targetPrompt: string;
    /** Handoff packets from upstream phases. */
    handoffs: HandoffPacket[];
    /** File contents included via the selected context modes. */
    fileContexts: FileContextEntry[];
    /** Dependencies explicitly included alongside context files. */
    includedDependencies: Array<{ workspaceFolder?: string; path: string; reason: string }>;
    /** Token usage breakdown for budget tracking. */
    tokenUsage: { handoffs: number; files: number; dependencies: number; total: number; budget: number };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Context Manifest — audit trail of context assembly decisions
// ═══════════════════════════════════════════════════════════════════════════════

/** Audit manifest recording every decision made during context assembly for a phase. */
export interface ContextManifest {
    /** Unique identifier for this manifest. */
    manifestId: string;
    /** Session this manifest belongs to. */
    sessionId: string;
    /** Task (runbook) this manifest belongs to. */
    taskId: string;
    /** Phase this manifest was assembled for. */
    phaseId: string;
    /** Workspace folder context (multi-root support). */
    workspaceFolder?: string;
    /** Phase IDs whose handoffs were considered. */
    upstreamPhaseIds: string[];
    /** Handoff IDs that were actually included. */
    includedHandoffIds: string[];
    /** Per-file inclusion decisions with mode selection rationale and token costs. */
    fileDecisions: Array<{
        workspaceFolder?: string;
        path: string;
        selectedMode: FileContextMode;
        reason: string;
        tokenCost: number;
        omitted: boolean;
        omissionReason?: string;
    }>;
    /** Per-dependency inclusion decisions. */
    dependencyDecisions: Array<{
        workspaceFolder?: string;
        path: string;
        included: boolean;
        reason: string;
        tokenCost?: number;
    }>;
    /** Aggregate token totals for the assembled context. */
    totals: {
        handoffTokens: number;
        fileTokens: number;
        dependencyTokens: number;
        totalTokens: number;
        budgetTokens: number;
    };
    /** ISO-8601 timestamp when this manifest was created. */
    createdAt: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Build Context Pack — input/output contracts for the context assembler
// ═══════════════════════════════════════════════════════════════════════════════

/** Input parameters for assembling a context pack. */
export interface BuildContextPackInput {
    /** Session ID for correlation. */
    sessionId: string;
    /** Task (runbook) ID for correlation. */
    taskId: string;
    /** Target phase ID to assemble context for. */
    phaseId: string;
    /** Workspace folder context (multi-root support). */
    workspaceFolder?: string;
    /** The raw prompt for the target phase. */
    prompt: string;
    /** Explicit file paths to include in context. */
    contextFiles: string[];
    /** Phase IDs whose handoffs should be considered. */
    upstreamPhaseIds: string[];
    /** Maximum token budget for the assembled context. */
    maxTokens: number;
    /** When true, all files receive `full` context mode regardless of heuristics. */
    requiresFullFileContext?: boolean;
}

/** Result of context pack assembly — contains the pack and its audit manifest. */
export interface BuildContextPackResult {
    /** The assembled context payload. */
    pack: ContextPack;
    /** Audit manifest documenting all inclusion decisions. */
    manifest: ContextManifest;
}
