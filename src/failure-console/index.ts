// ─────────────────────────────────────────────────────────────────────────────
// src/failure-console/index.ts — Barrel export for the failure console module
// ─────────────────────────────────────────────────────────────────────────────

export { FailureClassifier, type ClassifiedFailure } from './FailureClassifier.js';
export { FailureAssembler } from './FailureAssembler.js';
export {
    RecoveryActionRouter,
    type ActionLegalityContext,
    type ActionLegalityResult,
} from './RecoveryActionRouter.js';
export { RecoverySuggester, type SuggestionContext } from './RecoverySuggester.js';
export { FailureConsoleCoordinator } from './FailureConsoleCoordinator.js';
