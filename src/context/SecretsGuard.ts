// ─────────────────────────────────────────────────────────────────────────────
// src/context/SecretsGuard.ts — Pre-injection secrets detection
// ─────────────────────────────────────────────────────────────────────────────
// Scans file content for common secret patterns before injecting into
// ephemeral AI workers. Non-blocking: returns findings for logging only.

export interface ScanResult {
    safe: boolean;
    findings: string[];
}

/**
 * Regex-based scanner that checks file content for common secret patterns.
 *
 * Pattern categories:
 * - API keys (AWS, OpenAI, GitHub, Slack, GitLab, Stripe)
 * - Private keys (RSA, EC, OPENSSH, PGP)
 * - Environment variable patterns (DB_PASSWORD, SECRET_KEY, etc.)
 * - High-entropy strings (Shannon entropy > 4.5 on RHS of assignments)
 */
export class SecretsGuard {
    // ── Pattern definitions ────────────────────────────────────────────────

    private static readonly API_KEY_PATTERNS: { name: string; regex: RegExp }[] = [
        { name: 'AWS Access Key', regex: /AKIA[0-9A-Z]{16}/ },
        { name: 'OpenAI API Key', regex: /sk-[A-Za-z0-9]{20,}/ },
        { name: 'GitHub PAT', regex: /ghp_[A-Za-z0-9]{36,}/ },
        { name: 'GitHub OAuth', regex: /gho_[A-Za-z0-9]{36,}/ },
        { name: 'Slack Bot Token', regex: /xoxb-[0-9]{10,13}-[0-9]{10,13}-[A-Za-z0-9]{24,}/ },
        { name: 'Slack User Token', regex: /xoxp-[0-9]{10,13}-[0-9]{10,13}-[A-Za-z0-9]{24,}/ },
        { name: 'GitLab PAT', regex: /glpat-[A-Za-z0-9\-_]{20,}/ },
        { name: 'Stripe Secret Key', regex: /sk_live_[A-Za-z0-9]{24,}/ },
        { name: 'Stripe Restricted Key', regex: /rk_live_[A-Za-z0-9]{24,}/ },
    ];

    private static readonly PRIVATE_KEY_RE =
        /-----BEGIN\s+(RSA|EC|OPENSSH|PGP|DSA)\s+PRIVATE\s+KEY-----/;

    private static readonly ENV_SECRET_KEYS = [
        'DB_PASSWORD',
        'DATABASE_PASSWORD',
        'SECRET_KEY',
        'API_SECRET',
        'AWS_SECRET_ACCESS_KEY',
        'PRIVATE_KEY',
        'JWT_SECRET',
        'ENCRYPTION_KEY',
        'AUTH_SECRET',
    ];

    /** Minimum Shannon entropy threshold to flag a value as a potential secret. */
    private static readonly ENTROPY_THRESHOLD = 4.5;

    /** Minimum length of a value to consider for entropy analysis. */
    private static readonly MIN_ENTROPY_VALUE_LENGTH = 16;

    // ── Public API ─────────────────────────────────────────────────────────

    /**
     * Scan file content for secret patterns.
     *
     * @param content  - The raw file content to scan.
     * @param filePath - Relative path (for human-readable findings).
     * @returns ScanResult with `safe: true` if clean, or findings array.
     */
    static scan(content: string, filePath: string): ScanResult {
        const findings: string[] = [];

        // 1. API key patterns
        for (const { name, regex } of SecretsGuard.API_KEY_PATTERNS) {
            if (regex.test(content)) {
                findings.push(`${name} pattern detected in ${filePath}`);
            }
        }

        // 2. Private key headers
        if (SecretsGuard.PRIVATE_KEY_RE.test(content)) {
            findings.push(`Private key header detected in ${filePath}`);
        }

        // 3. Environment variable secrets (KEY=value with non-empty value)
        for (const key of SecretsGuard.ENV_SECRET_KEYS) {
            const envRe = new RegExp(`${key}\\s*=\\s*['"]?([^'"\n\\s]+)`, 'i');
            const match = envRe.exec(content);
            if (match && match[1] && match[1].length > 0) {
                // Skip placeholder values
                const val = match[1];
                if (!SecretsGuard.isPlaceholder(val)) {
                    findings.push(`Env secret ${key}=... detected in ${filePath}`);
                }
            }
        }

        // 4. High-entropy strings in assignment-like patterns
        const assignmentRe = /(?:['"]?\w+['"]?\s*[:=]\s*)['"]([A-Za-z0-9+/=_\-]{16,})['"/]/g;
        let m: RegExpExecArray | null;
        while ((m = assignmentRe.exec(content)) !== null) {
            const value = m[1];
            if (
                value.length >= SecretsGuard.MIN_ENTROPY_VALUE_LENGTH &&
                SecretsGuard.shannonEntropy(value) > SecretsGuard.ENTROPY_THRESHOLD
            ) {
                // Don't double-report if already caught by an API key pattern
                const alreadyCaught = SecretsGuard.API_KEY_PATTERNS.some(
                    ({ regex }) => regex.test(value)
                );
                if (!alreadyCaught) {
                    findings.push(`High-entropy value detected in ${filePath}`);
                    break; // One finding is enough
                }
            }
        }

        return findings.length > 0
            ? { safe: false, findings }
            : { safe: true, findings: [] };
    }

    // ── Helpers ─────────────────────────────────────────────────────────────

    /**
     * Calculate Shannon entropy of a string.
     * Higher values indicate more randomness (likely secrets).
     */
    static shannonEntropy(str: string): number {
        if (str.length === 0) return 0;

        const freq = new Map<string, number>();
        for (const ch of str) {
            freq.set(ch, (freq.get(ch) ?? 0) + 1);
        }

        let entropy = 0;
        const len = str.length;
        for (const count of freq.values()) {
            const p = count / len;
            entropy -= p * Math.log2(p);
        }
        return entropy;
    }

    /**
     * Check if a value looks like a placeholder (e.g. "changeme", "xxx", "TODO").
     */
    private static isPlaceholder(value: string): boolean {
        const lower = value.toLowerCase();
        const placeholders = [
            'changeme', 'change_me', 'your_', 'xxx', 'todo', 'fixme',
            'replace_me', 'placeholder', 'example', 'test', 'dummy',
            'sample', '...', 'none', 'null', 'undefined', 'empty',
        ];
        return placeholders.some(p => lower.includes(p));
    }
}
