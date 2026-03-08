import { AgentRegistry } from '../AgentRegistry.js';

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
