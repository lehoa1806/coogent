// ─────────────────────────────────────────────────────────────────────────────
// S2-6: IPC Message Contract Tests
// Validates that all HostToWebviewMessage and WebviewToHostMessage discriminated
// unions are type-safe and that every known message type is accounted for.
// ─────────────────────────────────────────────────────────────────────────────

import type {
    HostToWebviewMessage,
    WebviewToHostMessage,
    HostToWebviewMessageType,
    WebviewToHostMessageType,
} from '../../types/index.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Host → Webview message types
// ═══════════════════════════════════════════════════════════════════════════════

/** Exhaustive list of Host → Webview message types. */
const HOST_TO_WEBVIEW_TYPES: HostToWebviewMessageType[] = [
    'STATE_SNAPSHOT',
    'PHASE_STATUS',
    'TOKEN_BUDGET',
    'ERROR',
    'LOG_ENTRY',
    'PLAN_DRAFT',
    'PLAN_STATUS',
    'SESSION_LIST',
    'SESSION_SEARCH_RESULTS',
    'CONVERSATION_MODE',
    'CONSOLIDATION_REPORT',
    'PHASE_OUTPUT',
    'PLAN_SUMMARY',
    'EXECUTION_PLAN',
    'MCP_RESOURCE_DATA',
    'SUGGESTION_DATA',
    'ATTACHMENT_SELECTED',
    'RESTORE_PROMPT',
    'workers:loaded',
];

/** Exhaustive list of Webview → Host message types. */
const WEBVIEW_TO_HOST_TYPES: WebviewToHostMessageType[] = [
    'CMD_START',
    'CMD_ABORT',
    'CMD_RETRY',
    'CMD_SKIP_PHASE',
    'CMD_PAUSE_PHASE',
    'CMD_STOP_PHASE',
    'CMD_RESTART_PHASE',
    'CMD_EDIT_PHASE',
    'CMD_LOAD_RUNBOOK',
    'CMD_RESET',
    'CMD_REQUEST_STATE',
    'CMD_PLAN_REQUEST',
    'CMD_PLAN_APPROVE',
    'CMD_PLAN_REJECT',
    'CMD_PLAN_EDIT_DRAFT',
    'CMD_PLAN_RETRY_PARSE',
    'CMD_SET_CONVERSATION_MODE',
    'CMD_REQUEST_REPORT',
    'CMD_REQUEST_PLAN',
    'CMD_REVIEW_DIFF',
    'CMD_RESUME_PENDING',
    'MCP_FETCH_RESOURCE',
    'CMD_UPLOAD_FILE',
    'CMD_UPLOAD_IMAGE',
    'workers:request',
    'CMD_LIST_SESSIONS',
    'CMD_SEARCH_SESSIONS',
    'CMD_LOAD_SESSION',
    'CMD_DELETE_SESSION',
];

// ═══════════════════════════════════════════════════════════════════════════════
//  Type-level exhaustiveness checks (compile-time validation)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Exhaustive message handler that validates all Host → Webview messages.
 * If a new message type is added to the union but not handled here,
 * TypeScript will report a compile error at the `_exhaustive` assignment.
 */
function validateHostMessage(msg: HostToWebviewMessage): string {
    switch (msg.type) {
        case 'STATE_SNAPSHOT': return msg.payload.engineState;
        case 'PHASE_STATUS': return String(msg.payload.phaseId);
        case 'TOKEN_BUDGET': return String(msg.payload.totalTokens);
        case 'ERROR': return msg.payload.code;
        case 'LOG_ENTRY': return msg.payload.message;
        case 'PLAN_DRAFT': return String(msg.payload.draft.project_id);
        case 'PLAN_STATUS': return msg.payload.status;
        case 'SESSION_LIST': return String(msg.payload.sessions.length);
        case 'SESSION_SEARCH_RESULTS': return msg.payload.query;
        case 'CONVERSATION_MODE': return msg.payload.mode;
        case 'CONSOLIDATION_REPORT': return msg.payload.report;
        case 'PHASE_OUTPUT': return msg.payload.chunk;
        case 'PLAN_SUMMARY': return msg.payload.summary;
        case 'EXECUTION_PLAN': return msg.payload.plan;
        case 'MCP_RESOURCE_DATA': return msg.payload.requestId;
        case 'SUGGESTION_DATA': return String(msg.payload.mentions.length);
        case 'ATTACHMENT_SELECTED': return String(msg.payload.paths.length);
        case 'RESTORE_PROMPT': return msg.payload.prompt;
        case 'workers:loaded': return String(msg.workers.length);
        default: {
            // Compile-time exhaustiveness check
            const _exhaustive: never = msg;
            return _exhaustive;
        }
    }
}

/**
 * Exhaustive message handler that validates all Webview → Host messages.
 */
function validateWebviewMessage(msg: WebviewToHostMessage): string {
    switch (msg.type) {
        case 'CMD_START': return 'start';
        case 'CMD_ABORT': return 'abort';
        case 'CMD_RETRY': return String(msg.payload.phaseId);
        case 'CMD_SKIP_PHASE': return String(msg.payload.phaseId);
        case 'CMD_PAUSE_PHASE': return String(msg.payload.phaseId);
        case 'CMD_STOP_PHASE': return String(msg.payload.phaseId);
        case 'CMD_RESTART_PHASE': return String(msg.payload.phaseId);
        case 'CMD_EDIT_PHASE': return String(msg.payload.phaseId);
        case 'CMD_LOAD_RUNBOOK': return msg.payload?.filePath ?? 'browse';
        case 'CMD_RESET': return 'reset';
        case 'CMD_REQUEST_STATE': return 'request-state';
        case 'CMD_PLAN_REQUEST': return msg.payload.prompt;
        case 'CMD_PLAN_APPROVE': return 'approve';
        case 'CMD_PLAN_REJECT': return msg.payload.feedback;
        case 'CMD_PLAN_EDIT_DRAFT': return msg.payload.draft.project_id;
        case 'CMD_PLAN_RETRY_PARSE': return 'retry-parse';
        case 'CMD_SET_CONVERSATION_MODE': return msg.payload.mode;
        case 'CMD_REQUEST_REPORT': return 'report';
        case 'CMD_REQUEST_PLAN': return 'plan';
        case 'CMD_REVIEW_DIFF': return String(msg.payload.phaseId);
        case 'CMD_RESUME_PENDING': return 'resume';
        case 'MCP_FETCH_RESOURCE': return msg.payload.uri;
        case 'CMD_UPLOAD_FILE': return 'file';
        case 'CMD_UPLOAD_IMAGE': return 'image';
        case 'workers:request': return 'workers';
        case 'CMD_LIST_SESSIONS': return 'list';
        case 'CMD_SEARCH_SESSIONS': return msg.payload.query;
        case 'CMD_LOAD_SESSION': return msg.payload.sessionId;
        case 'CMD_DELETE_SESSION': return msg.payload.sessionId;
        default: {
            const _exhaustive: never = msg;
            return _exhaustive;
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Runtime Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('IPC Message Contract Tests', () => {
    describe('Host → Webview message types', () => {
        it('should have at least 17 known message types', () => {
            expect(HOST_TO_WEBVIEW_TYPES.length).toBeGreaterThanOrEqual(17);
        });

        it('should contain no duplicate types', () => {
            const unique = new Set(HOST_TO_WEBVIEW_TYPES);
            expect(unique.size).toBe(HOST_TO_WEBVIEW_TYPES.length);
        });

        it('should include all core message types', () => {
            const expected = [
                'STATE_SNAPSHOT', 'PHASE_STATUS', 'TOKEN_BUDGET', 'ERROR',
                'LOG_ENTRY', 'PLAN_DRAFT', 'PLAN_STATUS', 'PHASE_OUTPUT',
            ];
            for (const type of expected) {
                expect(HOST_TO_WEBVIEW_TYPES).toContain(type);
            }
        });

        it('should include session-related types', () => {
            expect(HOST_TO_WEBVIEW_TYPES).toContain('SESSION_LIST');
            expect(HOST_TO_WEBVIEW_TYPES).toContain('SESSION_SEARCH_RESULTS');
        });

        it('should include planning types', () => {
            expect(HOST_TO_WEBVIEW_TYPES).toContain('PLAN_DRAFT');
            expect(HOST_TO_WEBVIEW_TYPES).toContain('PLAN_STATUS');
            expect(HOST_TO_WEBVIEW_TYPES).toContain('PLAN_SUMMARY');
            expect(HOST_TO_WEBVIEW_TYPES).toContain('EXECUTION_PLAN');
        });

        it('should include RESTORE_PROMPT type', () => {
            expect(HOST_TO_WEBVIEW_TYPES).toContain('RESTORE_PROMPT');
        });
    });

    describe('Webview → Host message types', () => {
        it('should have at least 25 known message types', () => {
            expect(WEBVIEW_TO_HOST_TYPES.length).toBeGreaterThanOrEqual(25);
        });

        it('should contain no duplicate types', () => {
            const unique = new Set(WEBVIEW_TO_HOST_TYPES);
            expect(unique.size).toBe(WEBVIEW_TO_HOST_TYPES.length);
        });

        it('should include all command types', () => {
            const expected = [
                'CMD_START', 'CMD_ABORT', 'CMD_RETRY', 'CMD_SKIP_PHASE',
                'CMD_RESET', 'CMD_REQUEST_STATE', 'CMD_PLAN_REQUEST',
                'CMD_PLAN_APPROVE', 'CMD_PLAN_REJECT',
            ];
            for (const type of expected) {
                expect(WEBVIEW_TO_HOST_TYPES).toContain(type);
            }
        });

        it('should include session management types', () => {
            expect(WEBVIEW_TO_HOST_TYPES).toContain('CMD_LIST_SESSIONS');
            expect(WEBVIEW_TO_HOST_TYPES).toContain('CMD_SEARCH_SESSIONS');
            expect(WEBVIEW_TO_HOST_TYPES).toContain('CMD_LOAD_SESSION');
            expect(WEBVIEW_TO_HOST_TYPES).toContain('CMD_DELETE_SESSION');
        });

        it('should include MCP fetch resource type', () => {
            expect(WEBVIEW_TO_HOST_TYPES).toContain('MCP_FETCH_RESOURCE');
        });
    });

    describe('Type-level exhaustiveness', () => {
        it('validateHostMessage handles STATE_SNAPSHOT correctly', () => {
            const msg: HostToWebviewMessage = {
                type: 'STATE_SNAPSHOT',
                payload: {
                    runbook: {
                        project_id: 'test',
                        status: 'idle',
                        current_phase: 0,
                        phases: [],
                    },
                    engineState: 'IDLE' as any,
                },
            };
            expect(validateHostMessage(msg)).toBe('IDLE');
        });

        it('validateHostMessage handles ERROR correctly', () => {
            const msg: HostToWebviewMessage = {
                type: 'ERROR',
                payload: {
                    code: 'PARSE_ERROR',
                    message: 'Test error',
                },
            };
            expect(validateHostMessage(msg)).toBe('PARSE_ERROR');
        });

        it('validateWebviewMessage handles CMD_START correctly', () => {
            const msg: WebviewToHostMessage = { type: 'CMD_START' };
            expect(validateWebviewMessage(msg)).toBe('start');
        });

        it('validateWebviewMessage handles CMD_PLAN_REQUEST correctly', () => {
            const msg: WebviewToHostMessage = {
                type: 'CMD_PLAN_REQUEST',
                payload: { prompt: 'Build a backend' },
            };
            expect(validateWebviewMessage(msg)).toBe('Build a backend');
        });

        it('validateHostMessage handles RESTORE_PROMPT correctly', () => {
            const msg: HostToWebviewMessage = {
                type: 'RESTORE_PROMPT',
                payload: { prompt: 'build auth module' },
            };
            expect(validateHostMessage(msg)).toBe('build auth module');
        });
    });
});
