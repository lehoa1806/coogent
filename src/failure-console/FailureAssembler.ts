// ─────────────────────────────────────────────────────────────────────────────
// src/failure-console/FailureAssembler.ts — Orchestrates failure record creation
// ─────────────────────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import type {
    FailurePacket,
    FailureEvidence,
    FailureConsoleRecord,
    SuggestedRecoveryAction,
} from '../types/failure-console.js';
import type { ErrorCode } from '../types/ipc.js';
import type { FailureConsoleRepository } from '../mcp/repositories/FailureConsoleRepository.js';
import type { FailureClassifier } from './FailureClassifier.js';
import log from '../logger/log.js';

/**
 * Assembles a classified {@link FailureConsoleRecord} from a runtime
 * {@link FailurePacket} and optionally persists it to the database.
 *
 * Orchestration flow:
 *  1. Classify the packet via {@link FailureClassifier}
 *  2. Build {@link FailureEvidence} from packet fields
 *  3. Create a full {@link FailureConsoleRecord} with a unique ID
 *  4. Persist (best-effort) if a {@link FailureConsoleRepository} is available
 *  5. Return the record
 */
export class FailureAssembler {
    constructor(
        private readonly classifier: FailureClassifier,
        private readonly repository?: FailureConsoleRepository,
    ) {}

    /**
     * Assemble a complete {@link FailureConsoleRecord} from the given packet.
     *
     * @param packet           The transient failure data bundle collected at runtime.
     * @param errorCode        Optional error code from the engine error path.
     * @param suggestedActions  Optional pre-computed recovery suggestions (e.g. from
     *                          {@link FailureConsoleCoordinator}). Defaults to `[]`.
     * @returns A fully populated, immutable failure record.
     */
    assemble(
        packet: FailurePacket,
        errorCode?: ErrorCode,
        suggestedActions?: readonly SuggestedRecoveryAction[],
    ): FailureConsoleRecord {
        // 1. Classify
        const classified = this.classifier.classify(packet, errorCode);

        // 2. Build evidence from packet fields
        const evidence = this.buildEvidence(packet);

        // 3. Create the full record
        const now = Date.now();
        const record: FailureConsoleRecord = {
            id: randomUUID(),
            runId: packet.runId,
            sessionId: packet.sessionId,
            ...(packet.phaseId !== undefined ? { phaseId: packet.phaseId } : {}),
            ...(packet.workerId !== undefined ? { workerId: packet.workerId } : {}),
            severity: classified.severity,
            scope: classified.scope,
            category: classified.category,
            ...(classified.rootEventId !== undefined ? { rootEventId: classified.rootEventId } : {}),
            contributingEventIds: packet.timeline.map((e) => e.eventId),
            message: classified.message,
            evidence,
            suggestedActions: suggestedActions ? [...suggestedActions] : [],
            createdAt: now,
            updatedAt: now,
        };

        // 4. Persist (best-effort)
        if (this.repository) {
            try {
                this.repository.upsert({
                    id: record.id,
                    masterTaskId: record.runId,
                    sessionId: record.sessionId,
                    ...(record.phaseId !== undefined ? { phaseId: record.phaseId } : {}),
                    ...(record.workerId !== undefined ? { workerId: record.workerId } : {}),
                    severity: record.severity,
                    scope: record.scope,
                    category: record.category,
                    ...(record.rootEventId !== undefined ? { rootEventId: record.rootEventId } : {}),
                    contributingEventIds: [...record.contributingEventIds],
                    message: record.message,
                    evidenceJson: JSON.stringify(record.evidence),
                    suggestedActionsJson: JSON.stringify(record.suggestedActions),
                    createdAt: record.createdAt,
                    updatedAt: record.updatedAt,
                });
            } catch (err) {
                log.error(
                    `[FailureAssembler] Failed to persist failure record ${record.id}: ${String(err)}`,
                );
            }
        }

        // 5. Return the record
        return record;
    }

    // ─── Private helpers ─────────────────────────────────────────────────

    /**
     * Build a {@link FailureEvidence} snapshot from the packet's runtime data.
     *
     * Field mapping:
     *  - `latestWorkerOutput` ← `packet.latestOutput`
     *  - `latestErrorText`    ← `packet.latestError`
     *  - `contextBudget`      ← `packet.contextBudget` (maps `used` → `estimatedUsed`)
     *  - `toolActions`        ← `packet.toolActions`
     *  - `successCriteria`    ← `packet.successCriteria`
     */
    private buildEvidence(packet: FailurePacket): FailureEvidence {
        const evidence: FailureEvidence = {
            ...(packet.latestOutput !== undefined ? { latestWorkerOutput: packet.latestOutput } : {}),
            ...(packet.latestError !== undefined ? { latestErrorText: packet.latestError } : {}),
            ...(packet.contextBudget !== undefined
                ? {
                      contextBudget: {
                          tokenLimit: packet.contextBudget.tokenLimit,
                          estimatedUsed: packet.contextBudget.used,
                          remaining: packet.contextBudget.remaining,
                      },
                  }
                : {}),
            ...(packet.toolActions !== undefined
                ? { toolActions: [...packet.toolActions] }
                : {}),
            ...(packet.successCriteria !== undefined
                ? { successCriteria: [...packet.successCriteria] }
                : {}),
        };
        return evidence;
    }
}
