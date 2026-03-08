import * as path from 'node:path';
import * as fs from 'node:fs';
import { PromptValidator } from '../PromptValidator.js';
import { AgentRegistry } from '../AgentRegistry.js';
import { SubtaskSpecBuilder } from '../SubtaskSpecBuilder.js';
import type { CompiledWorkerPrompt, SubtaskSpec, AssumptionPolicy, Deliverable, AgentProfile } from '../types.js';
import type { SubtaskDraft } from '../SubtaskSpecBuilder.js';

// ─── Inline compile helper (mirrors WorkerPromptCompiler logic) ───────────────
// We replicate compilation here because WorkerPromptCompiler.ts uses
// import.meta.url which is incompatible with ts-jest (CommonJS mode).

const TEMPLATES_DIR = path.resolve(__dirname, '..', 'templates');

function loadTemplate(name: string): string {
    return fs.readFileSync(path.resolve(TEMPLATES_DIR, name), 'utf-8');
}

function interpolate(template: string, values: Record<string, string>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
        if (key in values) return values[key];
        return `[MISSING: ${key}]`;
    });
}

function formatList(items: readonly string[]): string {
    if (items.length === 0) return '_None._';
    return items.map((item) => `- ${item}`).join('\n');
}

function formatDeliverable(deliverable: Deliverable): string {
    const lines: string[] = [`**Type:** ${deliverable.type}`];
    if (deliverable.must_include.length > 0) {
        lines.push(`**Must include:**\n${formatList(deliverable.must_include)}`);
    }
    return lines.join('\n');
}

function formatAssumptionPolicy(policy: AssumptionPolicy): string {
    const sections: string[] = [];
    if (policy.allowed.length > 0) sections.push(`**Allowed assumptions:**\n${formatList(policy.allowed)}`);
    if (policy.forbidden.length > 0) sections.push(`**Forbidden assumptions:**\n${formatList(policy.forbidden)}`);
    if (policy.must_confirm.length > 0) sections.push(`**Must confirm:**\n${formatList(policy.must_confirm)}`);
    if (policy.escalate_if_missing.length > 0) sections.push(`**Escalate if missing:**\n${formatList(policy.escalate_if_missing)}`);
    return sections.length > 0 ? sections.join('\n\n') : '_None._';
}

function compilePrompt(spec: SubtaskSpec, profile: AgentProfile): CompiledWorkerPrompt {
    const values: Record<string, string> = {
        agent_type: profile.agent_type,
        mode: profile.mode ?? '',
        title: spec.title,
        goal: spec.goal,
        subtask_id: spec.subtask_id,
        task_type: spec.task_type,
        reasoning_type: spec.reasoning_type.join(', '),
        required_skills: spec.required_skills.join(', '),
        required_inputs: formatList(spec.required_inputs),
        dependency_inputs: formatList(spec.dependency_inputs),
        assumptions_allowed: formatList(spec.assumptions_allowed),
        assumptions_forbidden: formatList(spec.assumptions_forbidden),
        required_confirmations: formatList(spec.required_confirmations),
        risk_level: spec.risk_level,
        failure_cost: spec.failure_cost,
        deliverable: formatDeliverable(spec.deliverable),
        verification_needed: formatList(spec.verification_needed),
        fallback_strategy: spec.fallback_strategy,
        assumption_policy: formatAssumptionPolicy({
            allowed: spec.assumptions_allowed,
            forbidden: spec.assumptions_forbidden,
            must_confirm: spec.required_confirmations,
            escalate_if_missing: spec.context_requirements.must_include,
        }),
        context_package: '',
    };

    const baseTemplate = loadTemplate('base-worker.md');
    const agentTemplate = loadTemplate(`${profile.agent_type}.md`);
    const text = `${interpolate(baseTemplate, values)}\n${interpolate(agentTemplate, values)}`;
    const promptId = `prompt_${spec.subtask_id}_v1`;

    return {
        prompt_id: promptId,
        subtask_id: spec.subtask_id,
        agent_type: profile.agent_type,
        ...(profile.mode !== undefined ? { mode: profile.mode } : {}),
        text,
        assumption_policy: {
            allowed: spec.assumptions_allowed,
            forbidden: spec.assumptions_forbidden,
            must_confirm: spec.required_confirmations,
            escalate_if_missing: spec.context_requirements.must_include,
        },
        output_contract: spec.deliverable,
        version: '1',
    };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('PromptValidator', () => {
    let validator: PromptValidator;
    let registry: AgentRegistry;

    beforeEach(() => {
        validator = new PromptValidator();
        registry = AgentRegistry.loadDefault();
    });

    /** Build a well-formed prompt+spec pair for testing. */
    function buildWellFormedPair(): { prompt: CompiledWorkerPrompt; spec: SubtaskSpec } {
        const draft: SubtaskDraft = {
            id: 'val-001',
            title: 'Add feature',
            goal: 'Implement the new feature',
            contextFiles: ['src/feature.ts'],
            requiredSkills: ['typescript'],
        };
        const spec = SubtaskSpecBuilder.build(draft, {
            constraints: ['Do not break existing tests'],
            knownInputs: ['src/feature.ts'],
        });
        const profile = registry.getByType('CodeEditor')!;
        const prompt = compilePrompt(spec, profile);
        return { prompt, spec };
    }

    it('a well-formed prompt passes validation', () => {
        const { prompt, spec } = buildWellFormedPair();
        const result = validator.validate(prompt, spec);
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
    });

    it('missing goal produces an error', () => {
        const { prompt, spec } = buildWellFormedPair();
        const brokenPrompt: CompiledWorkerPrompt = {
            ...prompt,
            text: prompt.text.replace(/Implement the new feature/gi, ''),
        };
        const result = validator.validate(brokenPrompt, spec);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.field === 'goal')).toBe(true);
    });

    it('missing forbidden assumptions produces an error', () => {
        const { prompt, spec } = buildWellFormedPair();
        const brokenPrompt: CompiledWorkerPrompt = {
            ...prompt,
            text: prompt.text
                .replace(/[Ff]orbidden assumptions?/gi, '')
                .replace(/assumptions_forbidden/gi, ''),
        };
        const result = validator.validate(brokenPrompt, spec);
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.field === 'assumptions_forbidden')).toBe(true);
    });

    it('empty required_inputs for code_modification produces an error', () => {
        const draft: SubtaskDraft = {
            id: 'val-002',
            title: 'Add feature',
            goal: 'Implement something',
        };
        const spec = SubtaskSpecBuilder.build(draft);
        expect(spec.task_type).toBe('code_modification');
        expect(spec.required_inputs).toHaveLength(0);

        const profile = registry.getByType('CodeEditor')!;
        const prompt = compilePrompt(spec, profile);
        const result = validator.validate(prompt, spec);
        expect(result.errors.some((e) => e.field === 'required_inputs')).toBe(true);
    });

    it('medium-risk with few verification targets produces a warning', () => {
        const draft: SubtaskDraft = {
            id: 'val-003',
            title: 'Add feature',
            goal: 'Implement something',
            contextFiles: ['src/feature.ts'],
        };
        const spec: SubtaskSpec = {
            ...SubtaskSpecBuilder.build(draft, { knownInputs: ['src/feature.ts'] }),
            risk_level: 'medium',
            verification_needed: [],
        };
        const profile = registry.getByType('CodeEditor')!;
        const prompt = compilePrompt(spec, profile);
        const result = validator.validate(prompt, spec);
        expect(result.warnings.some((w) => w.field === 'verification_needed')).toBe(true);
    });

    it('valid prompt has valid: true and empty errors', () => {
        const { prompt, spec } = buildWellFormedPair();
        const result = validator.validate(prompt, spec);
        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
        expect(result.prompt_id).toBe(prompt.prompt_id);
    });
});
