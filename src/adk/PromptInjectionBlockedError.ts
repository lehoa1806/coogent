// ─────────────────────────────────────────────────────────────────────────────
// src/adk/PromptInjectionBlockedError.ts — Error thrown when prompt injection
// is detected and blocking mode is enabled.
// ─────────────────────────────────────────────────────────────────────────────
// Mirrors the SecretsBlockedError pattern from context/SecretsGuard.ts.

/**
 * Thrown when prompt injection patterns are detected in a phase prompt
 * and the `blockOnPromptInjection` setting is enabled.
 *
 * Contains the list of matched pattern sources for diagnostics and UI display.
 */
export class PromptInjectionBlockedError extends Error {
    constructor(
        message: string,
        public readonly matchedPatterns: string[],
    ) {
        super(message);
        this.name = 'PromptInjectionBlockedError';
    }
}
