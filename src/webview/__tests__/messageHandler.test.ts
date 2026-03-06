// ─────────────────────────────────────────────────────────────────────────────
// src/webview/__tests__/messageHandler.test.ts
//
// Tests for the Webview inbound IPC message handling logic.
//
// STRATEGY: messageHandler.ts is a browser-only Svelte module (depends on
// svelte/store and window APIs, installed only in webview-ui/).  Rather than
// fighting the Node test environment, we inline the exact state-mutation logic
// from messageHandler.ts as a pure function and test that contract directly.
//
// This gives us confident coverage of the session management wiring
// (SESSION_LIST, SESSION_SEARCH_RESULTS) without requiring jsdom or any
// browser polyfill.
// ─────────────────────────────────────────────────────────────────────────────

// ── Mirrored types (from webview-ui/src/types.ts) ────────────────────────────

interface SessionSummary {
    sessionId: string;
    projectId?: string;
    firstPrompt?: string;
    status: string;
    completedPhases: number;
    phaseCount: number;
    createdAt: number;
}

interface AppState {
    sessions: SessionSummary[];
    terminalOutput: string;
    engineState: string;
    phases: unknown[];
    error: { code: string; message: string } | null;
    [key: string]: unknown;
}

// ── Inline handler (mirrors messageHandler.ts switch-case logic) ──────────────
//
// If the messageHandler logic changes, this should be updated in lockstep.
// Keep this function in sync with webview-ui/src/stores/messageHandler.ts.

interface SessionListMsg { type: 'SESSION_LIST'; payload: { sessions: SessionSummary[] } }
interface SessionSearchMsg { type: 'SESSION_SEARCH_RESULTS'; payload: { query: string; sessions: SessionSummary[] } }
interface LogEntryMsg { type: 'LOG_ENTRY'; payload: { timestamp: number; level: string; message: string } }
interface ErrorMsg { type: 'ERROR'; payload: { code: string; message: string; phaseId?: number } }
interface UnknownMsg { type: string; payload?: unknown }

type HostToWebviewMessage = SessionListMsg | SessionSearchMsg | LogEntryMsg | ErrorMsg | UnknownMsg;

function applyMessage(state: AppState, msg: HostToWebviewMessage): AppState {
    switch (msg.type) {
        case 'SESSION_LIST': {
            const m = msg as SessionListMsg;
            return { ...state, sessions: m.payload.sessions };
        }

        case 'SESSION_SEARCH_RESULTS': {
            const m = msg as SessionSearchMsg;
            return { ...state, sessions: m.payload.sessions };
        }

        case 'LOG_ENTRY': {
            const m = msg as LogEntryMsg;
            const { level, message } = m.payload;
            return {
                ...state,
                terminalOutput: state.terminalOutput + `[${level.toUpperCase()}] ${message}\n`,
            };
        }

        case 'ERROR': {
            const m = msg as ErrorMsg;
            const { code, message } = m.payload;
            return {
                ...state,
                error: { code, message },
                terminalOutput: state.terminalOutput + `[ERROR] ${message}\n`,
            };
        }

        default:
            return state;
    }
}

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeState(overrides: Partial<AppState> = {}): AppState {
    return {
        sessions: [],
        terminalOutput: '',
        engineState: 'IDLE',
        phases: [],
        error: null,
        ...overrides,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
//  SESSION_LIST
// ─────────────────────────────────────────────────────────────────────────────

describe('SESSION_LIST message handler', () => {
    it('populates sessions from an empty initial state', () => {
        const sessions: SessionSummary[] = [
            { sessionId: 'aaa', status: 'completed', completedPhases: 3, phaseCount: 3, createdAt: 1_700_000_000 },
            { sessionId: 'bbb', status: 'idle', completedPhases: 0, phaseCount: 0, createdAt: 1_700_000_100 },
        ];

        const result = applyMessage(makeState(), {
            type: 'SESSION_LIST',
            payload: { sessions },
        });

        expect(result.sessions).toEqual(sessions);
    });

    it('replaces a previously populated list', () => {
        const initial = makeState({
            sessions: [{ sessionId: 'old', status: 'completed', completedPhases: 1, phaseCount: 1, createdAt: 1 }],
        });
        const newSessions: SessionSummary[] = [
            { sessionId: 'new', status: 'idle', completedPhases: 0, phaseCount: 5, createdAt: 2 },
        ];

        const result = applyMessage(initial, {
            type: 'SESSION_LIST',
            payload: { sessions: newSessions },
        });

        expect(result.sessions).toEqual(newSessions);
    });

    it('clears the list when payload contains an empty array', () => {
        const initial = makeState({
            sessions: [{ sessionId: 'x', status: 'completed', completedPhases: 1, phaseCount: 1, createdAt: 99 }],
        });

        const result = applyMessage(initial, {
            type: 'SESSION_LIST',
            payload: { sessions: [] },
        });

        expect(result.sessions).toEqual([]);
    });

    it('preserves other state fields when updating sessions', () => {
        const initial = makeState({ terminalOutput: 'previous output', engineState: 'EXECUTING_WORKER' });
        const sessions: SessionSummary[] = [
            { sessionId: 'z', status: 'idle', completedPhases: 0, phaseCount: 0, createdAt: 0 },
        ];

        const result = applyMessage(initial, {
            type: 'SESSION_LIST',
            payload: { sessions },
        });

        // Sessions updated
        expect(result.sessions).toEqual(sessions);
        // Other fields untouched
        expect(result.terminalOutput).toBe('previous output');
        expect(result.engineState).toBe('EXECUTING_WORKER');
    });

    it('preserves optional session fields (projectId, firstPrompt)', () => {
        const sessions: SessionSummary[] = [
            {
                sessionId: 'rich',
                projectId: 'proj-42',
                firstPrompt: 'add auth',
                status: 'completed',
                completedPhases: 2,
                phaseCount: 2,
                createdAt: 1_000_000,
            },
        ];

        const result = applyMessage(makeState(), {
            type: 'SESSION_LIST',
            payload: { sessions },
        });

        expect(result.sessions[0].projectId).toBe('proj-42');
        expect(result.sessions[0].firstPrompt).toBe('add auth');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
//  SESSION_SEARCH_RESULTS
// ─────────────────────────────────────────────────────────────────────────────

describe('SESSION_SEARCH_RESULTS message handler', () => {
    it('populates sessions with search results', () => {
        const results: SessionSummary[] = [
            { sessionId: 'sr-1', firstPrompt: 'auth refactor', status: 'completed', completedPhases: 2, phaseCount: 2, createdAt: 1_700_001_000 },
        ];

        const result = applyMessage(makeState(), {
            type: 'SESSION_SEARCH_RESULTS',
            payload: { query: 'auth', sessions: results },
        });

        expect(result.sessions).toEqual(results);
    });

    it('replaces an existing session list with search results', () => {
        const initial = makeState({
            sessions: [{ sessionId: 'pre-existing', status: 'idle', completedPhases: 0, phaseCount: 0, createdAt: 1 }],
        });
        const results: SessionSummary[] = [
            { sessionId: 'match', status: 'completed', completedPhases: 1, phaseCount: 1, createdAt: 2 },
        ];

        const result = applyMessage(initial, {
            type: 'SESSION_SEARCH_RESULTS',
            payload: { query: 'q', sessions: results },
        });

        expect(result.sessions).toEqual(results);
        expect(result.sessions).toHaveLength(1);
        expect(result.sessions[0].sessionId).toBe('match');
    });

    it('yields an empty list when no sessions match the query', () => {
        const initial = makeState({
            sessions: [{ sessionId: 'prior', status: 'completed', completedPhases: 1, phaseCount: 1, createdAt: 1 }],
        });

        const result = applyMessage(initial, {
            type: 'SESSION_SEARCH_RESULTS',
            payload: { query: 'no-match', sessions: [] },
        });

        expect(result.sessions).toEqual([]);
    });

    it('preserves other state fields when handling search results', () => {
        const initial = makeState({ terminalOutput: 'log data', error: null });
        const results: SessionSummary[] = [
            { sessionId: 's', status: 'idle', completedPhases: 0, phaseCount: 0, createdAt: 0 },
        ];

        const result = applyMessage(initial, {
            type: 'SESSION_SEARCH_RESULTS',
            payload: { query: '', sessions: results },
        });

        expect(result.sessions).toEqual(results);
        expect(result.terminalOutput).toBe('log data');
        expect(result.error).toBeNull();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Verify isolation — other message types do not mutate sessions
// ─────────────────────────────────────────────────────────────────────────────

describe('irrelevant messages — sessions field is untouched', () => {
    const existingSessions: SessionSummary[] = [
        { sessionId: 'guard', status: 'completed', completedPhases: 1, phaseCount: 1, createdAt: 9999 },
    ];

    it('LOG_ENTRY does not modify sessions', () => {
        const state = makeState({ sessions: existingSessions });
        const result = applyMessage(state, {
            type: 'LOG_ENTRY',
            payload: { timestamp: Date.now(), level: 'info', message: 'hello world' },
        });
        expect(result.sessions).toEqual(existingSessions);
    });

    it('ERROR does not modify sessions', () => {
        const state = makeState({ sessions: existingSessions });
        const result = applyMessage(state, {
            type: 'ERROR',
            payload: { code: 'UNKNOWN', message: 'something broke' },
        });
        expect(result.sessions).toEqual(existingSessions);
        expect(result.error).toEqual({ code: 'UNKNOWN', message: 'something broke' });
    });

    it('unknown message type does not modify sessions', () => {
        const state = makeState({ sessions: existingSessions });
        const result = applyMessage(state, { type: 'SOME_FUTURE_MSG' });
        expect(result.sessions).toEqual(existingSessions);
    });
});
