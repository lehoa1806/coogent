import * as fs from 'node:fs';
import { AgentRegistry, AgentProfileSchema } from '../AgentRegistry.js';
import log from '../../logger/log.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal valid workspace profile that passes AgentProfileSchema. */
function validWorkspaceProfile(overrides: Partial<Record<string, unknown>> = {}) {
    return {
        id: 'custom_ws_agent',
        name: 'Custom WS Agent',
        agent_type: 'CodeEditor',
        system_prompt: 'You are a workspace agent.',
        tags: ['custom'],
        handles: ['code_modification'],
        reasoning_strengths: ['symbol_level_editing'],
        skills: ['repo editing'],
        preferred_context: ['target_file'],
        requires: [],
        tolerates_ambiguity: 'low',
        risk_tolerance: 'medium',
        best_for: ['ws edits'],
        avoid_when: [],
        default_output: 'patch_with_notes',
        self_check_capabilities: [],
        ...overrides,
    };
}

describe('AgentRegistry', () => {
    let registry: AgentRegistry;

    beforeEach(() => {
        registry = AgentRegistry.loadDefault();
    });

    it('loadDefault() returns 6 profiles', () => {
        const all = registry.listAll();
        expect(all).toHaveLength(6);
    });

    it('listAll() returns all profiles', () => {
        const all = registry.listAll();
        const types = all.map((p) => p.agent_type);
        expect(types).toContain('Planner');
        expect(types).toContain('CodeEditor');
        expect(types).toContain('Reviewer');
        expect(types).toContain('TestWriter');
        expect(types).toContain('Researcher');
        expect(types).toContain('Debugger');
    });

    it('getByType("CodeEditor") returns the CodeEditor profile', () => {
        const profile = registry.getByType('CodeEditor');
        expect(profile).toBeDefined();
        expect(profile!.agent_type).toBe('CodeEditor');
        expect(profile!.handles).toContain('code_modification');
    });

    it('getByType("Unknown") returns undefined', () => {
        const profile = registry.getByType('Unknown' as any);
        expect(profile).toBeUndefined();
    });

    it('getCandidates("code_modification") returns profiles that handle it', () => {
        const candidates = registry.getCandidates('code_modification');
        expect(candidates.length).toBeGreaterThan(0);
        for (const c of candidates) {
            expect(c.handles).toContain('code_modification');
        }
        // CodeEditor should be among them
        expect(candidates.map((c) => c.agent_type)).toContain('CodeEditor');
    });

    it('getCandidates("test_creation") returns TestWriter', () => {
        const candidates = registry.getCandidates('test_creation');
        expect(candidates.map((c) => c.agent_type)).toContain('TestWriter');
    });

    it('size is 6', () => {
        expect(registry.size).toBe(6);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Workspace Profile Validation (M-3 — Zod Schema)
// ═══════════════════════════════════════════════════════════════════════════════

describe('AgentRegistry — workspace profile validation (M-3)', () => {
    let readFileSpy: jest.SpyInstance;
    let warnSpy: jest.SpyInstance;

    beforeEach(() => {
        readFileSpy = jest.spyOn(fs.promises, 'readFile');
        warnSpy = jest.spyOn(log, 'warn').mockImplementation(() => { });
    });

    afterEach(() => {
        readFileSpy.mockRestore();
        warnSpy.mockRestore();
    });

    it('loads valid workspace profiles alongside built-in profiles', async () => {
        const wsProfile = validWorkspaceProfile();
        readFileSpy.mockResolvedValue(JSON.stringify([wsProfile]));

        const reg = new AgentRegistry('/fake/workspace');
        const agents = await reg.getAgents();

        // 6 built-in + 1 valid workspace profile
        expect(agents.length).toBe(7);
        const ids = agents.map((a) => a.id);
        expect(ids).toContain('custom_ws_agent');
    });

    it('skips malformed profiles with a warning and keeps valid ones', async () => {
        const good = validWorkspaceProfile({ id: 'good_one' });
        const bad = { id: 'bad_one', name: 'Bad', agent_type: 'INVALID_TYPE' }; // missing required fields + bad enum

        readFileSpy.mockResolvedValue(JSON.stringify([good, bad]));

        const reg = new AgentRegistry('/fake/workspace');
        const agents = await reg.getAgents();

        // built-in 6 + 1 valid = 7 (bad skipped)
        const ids = agents.map((a) => a.id);
        expect(ids).toContain('good_one');
        expect(ids).not.toContain('bad_one');

        // A warning should have been logged for the invalid profile
        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining('skipping invalid profile "bad_one"'),
        );
    });

    it('falls back to built-in profiles when workspace JSON is completely invalid', async () => {
        readFileSpy.mockResolvedValue('NOT VALID JSON {{{');

        const reg = new AgentRegistry('/fake/workspace');
        const agents = await reg.getAgents();

        // Only built-in profiles should be loaded
        expect(agents).toHaveLength(6);

        // A warning should have been logged about the malformed JSON
        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining('is not valid JSON'),
        );
    });

    it('falls back to built-in profiles when workspace JSON is not an array', async () => {
        readFileSpy.mockResolvedValue(JSON.stringify({ not: 'an array' }));

        const reg = new AgentRegistry('/fake/workspace');
        const agents = await reg.getAgents();

        expect(agents).toHaveLength(6);
        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining('is not an array'),
        );
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  AgentProfileSchema unit test
// ═══════════════════════════════════════════════════════════════════════════════

describe('AgentProfileSchema', () => {
    it('validates a well-formed profile', () => {
        const result = AgentProfileSchema.safeParse(validWorkspaceProfile());
        expect(result.success).toBe(true);
    });

    it('rejects a profile missing required fields', () => {
        const result = AgentProfileSchema.safeParse({ id: 'x' });
        expect(result.success).toBe(false);
    });

    it('rejects a profile with invalid agent_type enum', () => {
        const result = AgentProfileSchema.safeParse(
            validWorkspaceProfile({ agent_type: 'NotAnAgentType' }),
        );
        expect(result.success).toBe(false);
    });
});
