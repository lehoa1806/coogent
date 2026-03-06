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
                masterTaskId: masterTaskId || runbook.project_id || s.masterTaskId,
                phases: [...(runbook.phases as Phase[])],
                masterSummary: runbook.summary || s.masterSummary,
            }));
            break;
        }

        // ── Individual phase status change ───────────────────────────────
        case 'PHASE_STATUS': {
            const { phaseId, status } = msg.payload;
            appState.update((s) => ({
                ...s,
                phases: s.phases.map((p) =>
                    p.id === phaseId ? { ...p, status } : p,
                ),
            }));
            break;
        }

        // ── Worker stdout/stderr chunk ───────────────────────────────────
        case 'WORKER_OUTPUT': {
            const { phaseId, chunk, stream } = msg.payload;
            if (phaseId != null) {
                appendPhaseOutput(phaseId, chunk);
            }
            // Also append to global terminal output
            const prefix = stream === 'stderr' ? '[stderr] ' : '';
            appState.update((s) => ({
                ...s,
                terminalOutput: s.terminalOutput + prefix + chunk,
            }));
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

        // ── Session list (history drawer) ────────────────────────────────
        case 'SESSION_LIST':
        case 'SESSION_SEARCH_RESULTS': {
            appState.update((s) => ({
                ...s,
                sessions: [...msg.payload.sessions],
            }));
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

        // ── MCP resource data response (handled by mcpStore listeners) ───
        case 'MCP_RESOURCE_DATA': {
            // No-op here — individual createMCPResource() stores handle
            // their own responses via window.addEventListener('message').
            break;
        }

        default: {
            // Unknown message types are silently ignored for forward compatibility.
            console.warn('[messageHandler] Unknown message type:', (msg as { type: string }).type);
            break;
        }
    }
}
