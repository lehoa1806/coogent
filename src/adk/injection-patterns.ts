// ─────────────────────────────────────────────────────────────────────────────
// src/adk/injection-patterns.ts — Prompt injection detection patterns
// ─────────────────────────────────────────────────────────────────────────────
//
// S1-4 (SEC-3): Externalized from ADKController.ts so patterns can be
// updated without modifying controller logic.
//

/** Prompt injection phrases to detect in agent prompts. */
export const INJECTION_PATTERNS: RegExp[] = [
    /ignore\s+(all\s+)?previous\s+instructions/i,
    /ignore\s+(all\s+)?prior\s+instructions/i,
    /disregard\s+(all\s+)?previous/i,
    /^system:\s/im,
    /you\s+are\s+now\s+(?:a|an|in)\s+/i,
    /\[SYSTEM\]/i,
    /<\|im_start\|>/i,
];
