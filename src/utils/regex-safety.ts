// ─────────────────────────────────────────────────────────────────────────────
// src/utils/regex-safety.ts — Shared ReDoS safety check
// ─────────────────────────────────────────────────────────────────────────────
// Extracted from SecretsGuard (SEC-2) so both SecretsGuard and RegexEvaluator
// can reject user-controlled regex patterns that are vulnerable to
// Regular Expression Denial of Service (ReDoS).
//
// Uses structural pattern analysis as the primary defense and a strict
// timing guard as a secondary fallback.

/**
 * Test if a regex pattern is safe from ReDoS attacks.
 *
 * Two-layer defense:
 * 1. **Structural analysis:** Rejects patterns with nested quantifiers
 *    (e.g., `(a+)+`, `(a|b+)+`, `(x*)*`) which are the root cause of
 *    exponential backtracking.
 * 2. **Timing guard:** Runs the regex against a 100-char adversarial string
 *    with a strict 10ms wall-clock limit.
 *
 * @param re     The compiled RegExp object.
 * @param source The original pattern source string.
 * @returns `true` if the pattern is deemed safe, `false` if it should be rejected.
 */
export function isRegexSafe(re: RegExp, source: string): boolean {
    // ── Layer 1: Structural analysis — reject nested quantifiers ─────────
    const dangerousPatterns = [
        // (x+)+ or (x*)* — quantified group containing a quantifier
        /\([^)]*[+*][^)]*\)[+*]/,
        // (a|b+)+ — alternation group with quantified branch, then quantified
        /\([^)]*\|[^)]*[+*][^)]*\)[+*]/,
        // Nested quantifiers without explicit grouping
        /([+*])\??[^)]*\1/,
    ];

    for (const dp of dangerousPatterns) {
        if (dp.test(source)) {
            return false;
        }
    }

    // ── Layer 2: Timing guard — catch edge cases structural analysis misses
    const testStr = 'a'.repeat(100) + '!';
    const start = performance.now();
    try {
        re.test(testStr);
    } catch {
        return false;
    }
    return performance.now() - start < 10;
}
