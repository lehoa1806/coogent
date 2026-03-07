// ─────────────────────────────────────────────────────────────────────────────
// src/evaluators/EvaluatorRegistry.ts — Strategy registry for phase evaluation
// ─────────────────────────────────────────────────────────────────────────────

import type { IEvaluator, EvaluatorType } from '../types/index.js';
import { ExitCodeEvaluatorV2 } from './ExitCodeEvaluator.js';
import { RegexEvaluator } from './RegexEvaluator.js';
import { ToolchainEvaluatorV2 } from './ToolchainEvaluator.js';
import { TestSuiteEvaluatorV2 } from './TestSuiteEvaluator.js';

/**
 * Registry of pluggable evaluators.
 * Maps EvaluatorType discriminant to concrete IEvaluator implementations.
 * Used by the Engine during the EVALUATING FSM state.
 */
export class EvaluatorRegistryV2 {
    private readonly evaluators: Map<EvaluatorType, IEvaluator>;

    constructor(workspaceRoot: string) {
        this.evaluators = new Map();
        this.evaluators.set('exit_code', new ExitCodeEvaluatorV2());
        this.evaluators.set('regex', new RegexEvaluator());
        this.evaluators.set('toolchain', new ToolchainEvaluatorV2(workspaceRoot));
        this.evaluators.set('test_suite', new TestSuiteEvaluatorV2(workspaceRoot));
    }

    /**
     * Get the evaluator for a given type.
     * Defaults to `exit_code` when type is undefined or unknown.
     */
    getEvaluator(type?: EvaluatorType): IEvaluator {
        return this.evaluators.get(type ?? 'exit_code') ?? this.evaluators.get('exit_code')!;
    }
}
