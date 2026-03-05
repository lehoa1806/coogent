import { isValidWebviewMessage } from '../ipcValidator.js';

describe('isValidWebviewMessage — IPC Runtime Validation (P1-3)', () => {
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    //  Valid messages
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    it('accepts CMD_START (no payload)', () => {
        expect(isValidWebviewMessage({ type: 'CMD_START' })).toBe(true);
    });

    it('accepts CMD_PAUSE (no payload)', () => {
        expect(isValidWebviewMessage({ type: 'CMD_PAUSE' })).toBe(true);
    });

    it('accepts CMD_ABORT (no payload)', () => {
        expect(isValidWebviewMessage({ type: 'CMD_ABORT' })).toBe(true);
    });

    it('accepts CMD_REQUEST_STATE (no payload)', () => {
        expect(isValidWebviewMessage({ type: 'CMD_REQUEST_STATE' })).toBe(true);
    });

    it('accepts CMD_RETRY with valid phaseId', () => {
        expect(isValidWebviewMessage({ type: 'CMD_RETRY', payload: { phaseId: 3 } })).toBe(true);
    });

    it('accepts CMD_SKIP_PHASE with valid phaseId', () => {
        expect(isValidWebviewMessage({ type: 'CMD_SKIP_PHASE', payload: { phaseId: 1 } })).toBe(true);
    });

    it('accepts CMD_EDIT_PHASE with valid payload', () => {
        expect(isValidWebviewMessage({
            type: 'CMD_EDIT_PHASE',
            payload: { phaseId: 2, patch: { prompt: 'new prompt' } }
        })).toBe(true);
    });

    it('accepts CMD_LOAD_RUNBOOK with valid filePath', () => {
        expect(isValidWebviewMessage({
            type: 'CMD_LOAD_RUNBOOK',
            payload: { filePath: '/path/to/runbook.json' }
        })).toBe(true);
    });

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    //  Malformed messages — should all be rejected
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    it('rejects null', () => {
        expect(isValidWebviewMessage(null)).toBe(false);
    });

    it('rejects undefined', () => {
        expect(isValidWebviewMessage(undefined)).toBe(false);
    });

    it('rejects a raw string', () => {
        expect(isValidWebviewMessage('CMD_START')).toBe(false);
    });

    it('rejects a number', () => {
        expect(isValidWebviewMessage(42)).toBe(false);
    });

    it('rejects an object with no type field', () => {
        expect(isValidWebviewMessage({ payload: { phaseId: 1 } })).toBe(false);
    });

    it('rejects an unknown type', () => {
        expect(isValidWebviewMessage({ type: 'CMD_DELETE_ALL' })).toBe(false);
    });

    it('rejects CMD_RETRY with null payload', () => {
        expect(isValidWebviewMessage({ type: 'CMD_RETRY', payload: null })).toBe(false);
    });

    it('rejects CMD_RETRY with missing phaseId', () => {
        expect(isValidWebviewMessage({ type: 'CMD_RETRY', payload: {} })).toBe(false);
    });

    it('rejects CMD_RETRY with string phaseId', () => {
        expect(isValidWebviewMessage({ type: 'CMD_RETRY', payload: { phaseId: 'abc' } })).toBe(false);
    });

    it('rejects CMD_EDIT_PHASE with missing patch', () => {
        expect(isValidWebviewMessage({ type: 'CMD_EDIT_PHASE', payload: { phaseId: 1 } })).toBe(false);
    });

    it('rejects CMD_EDIT_PHASE with null patch', () => {
        expect(isValidWebviewMessage({
            type: 'CMD_EDIT_PHASE',
            payload: { phaseId: 1, patch: null }
        })).toBe(false);
    });

    it('rejects CMD_LOAD_RUNBOOK with numeric filePath', () => {
        expect(isValidWebviewMessage({ type: 'CMD_LOAD_RUNBOOK', payload: { filePath: 123 } })).toBe(false);
    });

    it('rejects CMD_LOAD_RUNBOOK with missing filePath', () => {
        expect(isValidWebviewMessage({ type: 'CMD_LOAD_RUNBOOK', payload: {} })).toBe(false);
    });

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    //  Missing message types (#69)
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    it('accepts CMD_PLAN_REQUEST with prompt', () => {
        expect(isValidWebviewMessage({
            type: 'CMD_PLAN_REQUEST',
            payload: { prompt: 'build a CLI tool' }
        })).toBe(true);
    });

    it('accepts CMD_PLAN_APPROVE (no payload)', () => {
        expect(isValidWebviewMessage({ type: 'CMD_PLAN_APPROVE' })).toBe(true);
    });

    it('accepts CMD_PLAN_REJECT with feedback', () => {
        expect(isValidWebviewMessage({
            type: 'CMD_PLAN_REJECT',
            payload: { feedback: 'needs more phases' }
        })).toBe(true);
    });

    it('accepts CMD_RESET (no payload)', () => {
        expect(isValidWebviewMessage({ type: 'CMD_RESET' })).toBe(true);
    });

    it('accepts CMD_LIST_SESSIONS (no payload)', () => {
        expect(isValidWebviewMessage({ type: 'CMD_LIST_SESSIONS' })).toBe(true);
    });

    it('accepts CMD_SEARCH_SESSIONS with query', () => {
        expect(isValidWebviewMessage({
            type: 'CMD_SEARCH_SESSIONS',
            payload: { query: 'auth' }
        })).toBe(true);
    });

    it('accepts CMD_LOAD_SESSION with sessionId', () => {
        expect(isValidWebviewMessage({
            type: 'CMD_LOAD_SESSION',
            payload: { sessionId: 'abc-123' }
        })).toBe(true);
    });

    it('accepts CMD_SET_CONVERSATION_MODE with mode', () => {
        expect(isValidWebviewMessage({
            type: 'CMD_SET_CONVERSATION_MODE',
            payload: { mode: 'isolated' }
        })).toBe(true);
    });

    it('accepts CMD_REQUEST_PLAN (no payload)', () => {
        expect(isValidWebviewMessage({ type: 'CMD_REQUEST_PLAN' })).toBe(true);
    });
});
