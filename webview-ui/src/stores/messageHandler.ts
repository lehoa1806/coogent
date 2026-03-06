// ─────────────────────────────────────────────────────────────────────────────
// stores/messageHandler.ts — Extension Host → Webview message router
//
// Registers a single `window.addEventListener('message', ...)` handler that
// updates the Svelte `appState` store based on inbound IPC messages.
// Replaces the inline switch/case in webview-ui/main.js.
// ─────────────────────────────────────────────────────────────────────────────

import { get } from 'svelte/store';
import { appState, appendPhaseOutput } from './vscode.js';
import type { HostToWebviewMessage, Phase } from '../types.js';

/**
 * Validates that a candidate masterTaskId matches the strict MCP format:
 * YYYYMMDD-HHMMSS-<uuid>  (e.g. 20260305-173000-a1b2c3d4-e5f6-7890-abcd-ef1234567890)
 *
 * This prevents human-readable project_id slugs (e.g. "coogent-context-management-audit")
 * from leaking into appState.masterTaskId and causing malformed coogent:// URIs.
 */
const MCP_MASTER_TASK_ID_RE =
    /^\d{8}-\d{6}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isValidMasterTaskId(id: string | undefined): id is string {
    return typeof id === 'string' && MCP_MASTER_TASK_ID_RE.test(id);
}

/** Guard: has the handler already been registered? */
let _initialized = false;

/**
 * Register the global message handler. Must be called exactly once
 * from `main.ts` during application bootstrap.
 */
export function initMessageHandler(): void {
    if (_initialized) return;
    _initialized = true;

    window.addEventListener('message', (event: MessageEvent) => {
        const msg = event.data as HostToWebviewMessage;
        if (!msg || typeof msg.type !== 'string') return;

        try {
            handleMessage(msg);
        } catch (err) {
            console.error(`[messageHandler] Error handling ${msg.type}:`, err);
        }
    });
}

/**
 * Reset the handler registration guard for test isolation.
 * QUAL-03: `_initialized` is a module-level boolean that Jest cannot reset
 * between test runs without this exported helper.
 * Call this in afterEach() or beforeEach() of test suites that call initMessageHandler().
 */
export function resetForTesting(): void {
    _initialized = false;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Message Dispatcher
// ═══════════════════════════════════════════════════════════════════════════════

function handleMessage(msg: HostToWebviewMessage): void {
    switch (msg.type) {
        // ── Full state snapshot from Extension Host ──────────────────────
        case 'STATE_SNAPSHOT': {
            const { runbook, engineState, masterTaskId } = msg.payload;
            appState.update((s) => ({
                ...s,
                engineState,
                projectId: runbook.project_id,
                // Only update masterTaskId when the incoming value passes the strict
                // YYYYMMDD-HHMMSS-uuid format check. Human-readable project_id slugs
                // (e.g. "coogent-context-management-audit") must NOT be used here,
                // as they would produce malformed coogent:// URIs in PhaseDetails.svelte.
                masterTaskId: isValidMasterTaskId(masterTaskId) ? masterTaskId : s.masterTaskId,
                // Merge phases: preserve runtime fields (mcpPhaseId) that the
                // Extension Host doesn't include in the runbook snapshot.
                phases: (runbook.phases as Phase[]).map((incoming) => {
                    const existing = s.phases.find((p) => p.id === incoming.id);
                    return existing
                        ? { ...incoming, mcpPhaseId: existing.mcpPhaseId ?? (incoming as Phase).mcpPhaseId }
                        : (incoming as Phase);
                }),
                masterSummary: runbook.summary || s.masterSummary,
            }));
            break;
        }

        // ── Individual phase status change ───────────────────────────────
        case 'PHASE_STATUS': {
            const { phaseId, status, durationMs } = msg.payload;
            const now = Date.now();
            appState.update((s) => {
                const phaseStartTimes = { ...s.phaseStartTimes };
                const phaseElapsedMs = { ...s.phaseElapsedMs };

                if (status === 'running' && !phaseStartTimes[phaseId]) {
                    // Record start time when phase begins
                    phaseStartTimes[phaseId] = now;
                } else if (status === 'completed' || status === 'failed') {
                    // Freeze elapsed time when phase ends
                    const startMs = phaseStartTimes[phaseId];
                    if (startMs) {
                        phaseElapsedMs[phaseId] = durationMs ?? (now - startMs);
                    }
                }

                return {
                    ...s,
                    phases: s.phases.map((p) =>
                        p.id === phaseId ? { ...p, status } : p,
                    ),
                    phaseStartTimes,
                    phaseElapsedMs,
                };
            });
            break;
        }


        // ── Token budget per phase ───────────────────────────────────────
        case 'TOKEN_BUDGET': {
            const { phaseId, totalTokens, limit, breakdown } = msg.payload;
            if (phaseId != null) {
                appState.update((s) => ({
                    ...s,
                    phaseTokenBudgets: {
                        ...s.phaseTokenBudgets,
                        [phaseId]: {
                            totalTokens,
                            limit,
                            fileCount: breakdown.length,
                        },
                    },
                }));
            }
            break;
        }

        // ── Error from Extension Host ────────────────────────────────────
        case 'ERROR': {
            const { code, message } = msg.payload;
            appState.update((s) => ({
                ...s,
                error: { code, message },
                terminalOutput: s.terminalOutput + `[ERROR] ${message}\n`,
            }));
            break;
        }

        // ── Log entry → terminal output ──────────────────────────────────
        case 'LOG_ENTRY': {
            const { level, message } = msg.payload;
            // ERR-01: [LAST_PROMPT] sentinel restores the user's prompt into the
            // chat input after a cancelled Git pre-flight check. The sentinel is
            // stripped before displaying in the terminal so it's invisible to the user.
            const LAST_PROMPT_PREFIX = '[LAST_PROMPT] ';
            if (message.startsWith(LAST_PROMPT_PREFIX)) {
                const restoredPrompt = message.slice(LAST_PROMPT_PREFIX.length);
                appState.update((s) => ({ ...s, lastPrompt: restoredPrompt }));
                break;
            }
            appState.update((s) => ({
                ...s,
                terminalOutput:
                    s.terminalOutput + `[${level.toUpperCase()}] ${message}\n`,
            }));
            break;
        }


        // ── Plan draft for review ────────────────────────────────────────
        case 'PLAN_DRAFT': {
            const { draft, fileTree } = msg.payload;
            appState.update((s) => ({
                ...s,
                planDraft: draft,
                planFileTree: fileTree,
                planSlideIndex: 0,
            }));
            break;
        }

        // ── Plan status update ───────────────────────────────────────────
        case 'PLAN_STATUS': {
            const { status, message } = msg.payload;
            appState.update((s) => ({
                ...s,
                planStatus: { status, message },
            }));
            if (msg.payload.status === 'error') {
                appState.update((s) => ({
                    ...s,
                    terminalOutput:
                        s.terminalOutput +
                        `[PLAN ERROR] ${msg.payload.message || 'Planning failed'}\n`,
                }));
            }
            break;
        }


        // ── Consolidation report ─────────────────────────────────────────
        case 'CONSOLIDATION_REPORT': {
            appState.update((s) => ({
                ...s,
                consolidationReport: msg.payload.report,
            }));
            break;
        }

        // ── Implementation plan ──────────────────────────────────────────
        case 'IMPLEMENTATION_PLAN': {
            appState.update((s) => ({
                ...s,
                implementationPlan: msg.payload.plan,
            }));
            break;
        }

        // ── Conversation mode sync ───────────────────────────────────────
        case 'CONVERSATION_MODE': {
            appState.update((s) => ({
                ...s,
                conversationMode: msg.payload.mode,
            }));
            break;
        }

        // ── Plan summary (master task description) ───────────────────────
        case 'PLAN_SUMMARY': {
            appState.update((s) => ({
                ...s,
                masterSummary: msg.payload.summary,
            }));
            break;
        }

        // ── Per-phase output (same as WORKER_OUTPUT but routed) ──────────
        case 'PHASE_OUTPUT': {
            appendPhaseOutput(msg.payload.phaseId, msg.payload.chunk);
            break;
        }

        // ── MCP resource data response ────────────────────────────────────
        case 'MCP_RESOURCE_DATA': {
            // Intentional no-op: each createMCPResource() call in mcpStore.ts
            // registers its own window.addEventListener('message', ...) listener
            // that guards by requestId (payload.requestId === pendingRequestId).
            // Routing the message here instead would create a second consumer
            // and may cause double-resolution if mcpStore.ts is ever extended
            // to support caching. The requestId correlation is the sole dispatch
            // mechanism — see webview-ui/src/stores/mcpStore.ts:
            //   createMCPResource() → line ~94.
            break;
        }



        // ── Suggestion data from Extension Host ─────────────────────────
        case 'SUGGESTION_DATA': {
            appState.update((s) => ({
                ...s,
                mentionItems: msg.payload.mentions as { label: string; description: string; insert: string }[],
                workflowItems: msg.payload.workflows as { label: string; description: string; insert: string }[],
            }));
            break;
        }

        // ── Session list (response to CMD_LIST_SESSIONS) ─────────────────
        case 'SESSION_LIST': {
            appState.update((s) => ({
                ...s,
                sessions: msg.payload.sessions,
            }));
            break;
        }

        // ── Session search results (response to CMD_SEARCH_SESSIONS) ──────
        case 'SESSION_SEARCH_RESULTS': {
            appState.update((s) => ({
                ...s,
                sessions: msg.payload.sessions,
            }));
            break;
        }

        // ── Attachment selected (file picker result) ─────────────────────
        case 'ATTACHMENT_SELECTED': {
            // No-op in store — ChatInput handles this via its own listener
            break;
        }

        default: {
            // Unknown message types are silently ignored for forward compatibility.
            console.warn('[messageHandler] Unknown message type:', (msg as { type: string }).type);
            break;
        }
    }
}
