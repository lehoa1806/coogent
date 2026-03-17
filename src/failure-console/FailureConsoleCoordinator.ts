// ─────────────────────────────────────────────────────────────────────────────
// src/failure-console/FailureConsoleCoordinator.ts — Orchestrates failure
// classification → suggestion → legality filtering → record assembly → persistence
// ─────────────────────────────────────────────────────────────────────────────

import type {
    FailurePacket,
    FailureConsoleRecord,
    SuggestedRecoveryAction,
} from '../types/failure-console.js';
import type { ErrorCode } from '../types/ipc.js';
import type { FailureClassifier } from './FailureClassifier.js';
import type { RecoverySuggester } from './RecoverySuggester.js';
import type { RecoveryActionRouter, ActionLegalityContext } from './RecoveryActionRouter.js';
import type { FailureConsoleRepository } from '../mcp/repositories/FailureConsoleRepository.js';
import { FailureAssembler } from './FailureAssembler.js';
import log from '../logger/log.js';

/**
 * High-level coordinator that composes the full failure-console pipeline:
 *
 *  1. Classify the packet          → {@link FailureClassifier}
 *  2. Generate suggestions         → {@link RecoverySuggester}
 *  3. Filter by action legality    → {@link RecoveryActionRouter}
 *  4. Assemble the record          → {@link FailureAssembler}
 *  5. Persist (best-effort)        → {@link FailureConsoleRepository}
 *
 * This replaces direct {@link FailureAssembler} usage in the
 * `EvaluationOrchestrator`, providing model-generated suggestions that
 * have been filtered through the legality validator.
 */
export class FailureConsoleCoordinator {
    private readonly assembler: FailureAssembler;

    constructor(
        private readonly classifier: FailureClassifier,
        private readonly suggester: RecoverySuggester,
        private readonly actionRouter: RecoveryActionRouter,
        private readonly repository?: FailureConsoleRepository,
    ) {
        // Compose with FailureAssembler internally — the assembler owns
        // evidence-building, record creation, and best-effort persistence.
        this.assembler = new FailureAssembler(this.classifier, this.repository);
    }

    /**
     * Build a complete failure record with model-generated, legality-filtered
     * recovery suggestions.
     *
     * @param packet      The transient failure data bundle collected at runtime.
     * @param legalityCtx Runtime context for evaluating action legality.
     * @param errorCode   Optional error code from the engine error path.
     * @returns A fully populated {@link FailureConsoleRecord} including
     *          filtered suggested actions.
     */
    build(
        packet: FailurePacket,
        legalityCtx: ActionLegalityContext,
        errorCode?: ErrorCode,
    ): FailureConsoleRecord {
        // 1. Classify
        const classified = this.classifier.classify(packet, errorCode);

        // 2. Generate suggestions from the classified failure context
        const rawSuggestions: SuggestedRecoveryAction[] = this.suggester.suggest({
            category: classified.category,
            severity: classified.severity,
            scope: classified.scope,
            message: classified.message,
            evidence: {}, // Evidence will be built by the assembler; we pass
            //               minimal context here since the suggester only
            //               operates on classification fields.
        });

        // 3. Filter suggestions by action legality
        const filteredSuggestions = this.actionRouter.filterSuggestions(
            rawSuggestions,
            legalityCtx,
        );

        // 4. Assemble full record (includes evidence-building + persistence)
        let record: FailureConsoleRecord;
        try {
            record = this.assembler.assemble(packet, errorCode, filteredSuggestions);
        } catch (err) {
            log.error(
                `[FailureConsoleCoordinator] Record assembly failed: ${String(err)}`,
            );
            // Fallback: assemble without suggestions to guarantee a record is returned
            record = this.assembler.assemble(packet, errorCode);
        }

        return record;
    }
}
