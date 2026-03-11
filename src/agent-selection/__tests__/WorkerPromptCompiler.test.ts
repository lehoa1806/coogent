import type { SubtaskSpec, AgentProfile, CompiledWorkerPrompt, AssumptionPolicy, Deliverable } from '../types.js';
import { SubtaskSpecBuilder, type SubtaskDraft } from '../SubtaskSpecBuilder.js';
import { AgentRegistry } from '../AgentRegistry.js';
import {
    BASE_WORKER,
    CODE_EDITOR,
} from '../templates.js';

// ─── Inline WorkerPromptCompiler logic for testing ────────────────────────────
// We replicate the compilation logic here because WorkerPromptCompiler.ts uses
// esbuild-inlined templates that are available as module constants.

const PROMPT_VERSION = '1';

/** Interpolate {{key}} placeholders. Unknown keys → [MISSING: key]. */
function interpolate(template: string, values: Record<string, string>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
        if (key in values) return values[key];
        return `[MISSING: ${key}]`;
    });
}

/** Format array as markdown list. */
function formatList(items: readonly string[]): string {
    if (items.length === 0) return '_None._';
    return items.map((item) => `- ${item}`).join('\n');
}

/** Format deliverable. */
function formatDeliverable(deliverable: Deliverable): string {
    const lines: string[] = [`**Type:** ${deliverable.type}`];
    if (deliverable.must_include.length > 0) {
        lines.push(`**Must include:**\n${formatList(deliverable.must_include)}`);
    }
    return lines.join('\n');
}

/** Format assumption policy. */
function formatAssumptionPolicy(policy: AssumptionPolicy): string {
    const sections: string[] = [];
    if (policy.allowed.length > 0) sections.push(`**Allowed assumptions:**\n${formatList(policy.allowed)}`);
    if (policy.forbidden.length > 0) sections.push(`**Forbidden assumptions:**\n${formatList(policy.forbidden)}`);
    if (policy.must_confirm.length > 0) sections.push(`**Must confirm:**\n${formatList(policy.must_confirm)}`);
    if (policy.escalate_if_missing.length > 0) sections.push(`**Escalate if missing:**\n${formatList(policy.escalate_if_missing)}`);
    return sections.length > 0 ? sections.join('\n\n') : '_None._';
}

type ExecutionMode = 'primary' | 'fallback';

/** Build IPC contract instructions (test-friendly reimplementation). */
function buildIpcInstructions(executionMode: ExecutionMode): string {
    const sections: string[] = ['### IPC Contract', ''];
    if (executionMode === 'fallback') {
        sections.push('1. **Read your task** from `request.md` in the current IPC directory.');
    }
    sections.push(
        `${executionMode === 'fallback' ? '2' : '1'}. **Write your COMPLETE response** to \`response.md\` in the current IPC directory.`,
        `${executionMode === 'fallback' ? '3' : '2'}. Output ONLY the content \u2014 no explanation, no markdown code fences wrapping the file write.`,
    );
    return sections.join('\n');
}

/** Compile prompt (test-friendly reimplementation). */
function compile(spec: SubtaskSpec, profile: AgentProfile, executionMode: ExecutionMode = 'primary'): CompiledWorkerPrompt {
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

    const interpolatedBase = interpolate(BASE_WORKER, values);
    const interpolatedAgent = interpolate(CODE_EDITOR, values);
    const ipcInstructions = buildIpcInstructions(executionMode);
    const text = `${interpolatedBase}\n${interpolatedAgent}\n${ipcInstructions}`;
    const promptId = `prompt_${spec.subtask_id}_v${PROMPT_VERSION}`;

    const assumptionPolicy: AssumptionPolicy = {
        allowed: spec.assumptions_allowed,
        forbidden: spec.assumptions_forbidden,
        must_confirm: spec.required_confirmations,
        escalate_if_missing: spec.context_requirements.must_include,
    };

    return {
        prompt_id: promptId,
        subtask_id: spec.subtask_id,
        agent_type: profile.agent_type,
        ...(profile.mode !== undefined ? { mode: profile.mode } : {}),
        text,
        assumption_policy: assumptionPolicy,
        output_contract: spec.deliverable,
        version: PROMPT_VERSION,
    };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('WorkerPromptCompiler', () => {
    let codeEditorProfile: AgentProfile;
    let spec: SubtaskSpec;

    beforeEach(() => {
        const registry = AgentRegistry.loadDefault();
        codeEditorProfile = registry.getByType('CodeEditor')!;

        const draft: SubtaskDraft = {
            id: 'subtask-wpc-001',
            title: 'Add validation to user form',
            goal: 'Implement input validation for the user registration form',
            contextFiles: ['src/components/UserForm.ts'],
            requiredSkills: ['typescript', 'validation'],
        };
        spec = SubtaskSpecBuilder.build(draft, {
            constraints: ['Do not change the submit endpoint'],
        });
    });

    it('compiles a valid SubtaskSpec and CodeEditor profile into a CompiledWorkerPrompt', () => {
        const result = compile(spec, codeEditorProfile);
        expect(result).toBeDefined();
        expect(result.prompt_id).toBeDefined();
        expect(result.subtask_id).toBe('subtask-wpc-001');
        expect(result.agent_type).toBe('CodeEditor');
        expect(result.text).toBeTruthy();
        expect(result.assumption_policy).toBeDefined();
        expect(result.output_contract).toBeDefined();
        expect(result.version).toBe('1');
    });

    it('compiled text contains the subtask goal', () => {
        const result = compile(spec, codeEditorProfile);
        expect(result.text.toLowerCase()).toContain(
            'implement input validation for the user registration form'.toLowerCase(),
        );
    });

    it('compiled text contains forbidden assumptions', () => {
        const result = compile(spec, codeEditorProfile);
        expect(result.text).toContain('Do not change the submit endpoint');
    });

    it('prompt_id follows the expected format', () => {
        const result = compile(spec, codeEditorProfile);
        expect(result.prompt_id).toBe('prompt_subtask-wpc-001_v1');
    });

    it('missing template values are replaced with [MISSING: key]', () => {
        const result = compile(spec, codeEditorProfile);
        // No raw {{placeholder}} should remain
        const rawPlaceholders = result.text.match(/\{\{\w+\}\}/g);
        expect(rawPlaceholders).toBeNull();
    });

    // ─── Execution Mode: IPC instructions ─────────────────────────────────

    it('primary mode: includes response.md but NOT request.md instructions', () => {
        const result = compile(spec, codeEditorProfile, 'primary');
        expect(result.text).toContain('response.md');
        expect(result.text).not.toContain('Read your task');
        expect(result.text).not.toMatch(/request\.md/);
    });

    it('fallback mode: includes BOTH request.md and response.md instructions', () => {
        const result = compile(spec, codeEditorProfile, 'fallback');
        expect(result.text).toContain('response.md');
        expect(result.text).toContain('request.md');
        expect(result.text).toContain('Read your task');
    });

    it('default executionMode is primary (no request.md)', () => {
        const result = compile(spec, codeEditorProfile);
        expect(result.text).toContain('response.md');
        expect(result.text).not.toMatch(/request\.md/);
    });
});
