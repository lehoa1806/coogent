// ─────────────────────────────────────────────────────────────────────────────
// src/context/SecretsGuard.ts — Pre-injection secrets detection
// ─────────────────────────────────────────────────────────────────────────────
// Scans file content for common secret patterns before injecting into
// ephemeral AI workers.
//
// Sprint 4 enhancement: Allowlist support to reduce false positives.
// S1-3 (SEC-1): Optional blocking mode via `blockOnDetection` flag.
// S1-7 (SEC-6): ReDoS-safe regex compilation for user-defined patterns.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { getCoogentDir } from '../constants/paths.js';
import log from '../logger/log.js';
import { isRegexSafe } from '../utils/regex-safety.js';

export interface ScanResult {
    safe: boolean;
    findings: string[];
}

/**
 * Allowlist configuration loaded from `.coogent/secrets-allowlist.json`.
 * - `patterns`: Compiled RegExp objects from user-defined pattern strings.
 * - `hashes`: Set of SHA-256 hex digests for known-safe values.
 */
export interface Allowlist {
    patterns: RegExp[];
    hashes: Set<string>;
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
        { name: 'JWT Token', regex: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
        { name: 'Google API Key', regex: /AIza[0-9A-Za-z\-_]{35}/ },
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

    // ── Allowlist Cache ────────────────────────────────────────────────────

    /**
     * M-10: TTL for cached allowlists (5 minutes). When the TTL expires,
     * the next `loadAllowlist()` call re-reads the config file from disk,
     * ensuring changes to `secrets-allowlist.json` are picked up without
     * requiring an extension reload.
     */
    private static readonly CACHE_TTL_MS = 5 * 60 * 1_000;

    /** Cached allowlists keyed by workspace root, with creation timestamps. */
    private static readonly allowlistCache = new Map<string, { allowlist: Allowlist; cachedAt: number }>();

    // ── Allowlist Loader ───────────────────────────────────────────────────

    /**
     * Load the allowlist from `.coogent/secrets-allowlist.json` in the workspace.
     * Returns an empty allowlist if the file doesn't exist or is malformed.
     * Results are cached per workspace root.
     */
    static async loadAllowlist(workspaceRoot: string): Promise<Allowlist> {
        const cached = SecretsGuard.allowlistCache.get(workspaceRoot);
        // M-10: Honour TTL — re-read config if cache entry has expired
        if (cached && (Date.now() - cached.cachedAt) < SecretsGuard.CACHE_TTL_MS) {
            return cached.allowlist;
        }

        const emptyAllowlist: Allowlist = { patterns: [], hashes: new Set() };
        const filePath = path.join(getCoogentDir(workspaceRoot), 'secrets-allowlist.json');

        try {
            const raw = await fs.readFile(filePath, 'utf-8');
            const parsed = JSON.parse(raw) as Record<string, unknown>;

            const patterns: RegExp[] = [];
            if (Array.isArray(parsed['allowed_patterns'])) {
                for (const p of parsed['allowed_patterns']) {
                    if (typeof p === 'string') {
                        try {
                            // S1-7 (SEC-6): Validate user-defined regex against ReDoS
                            const re = new RegExp(p);
                            if (!SecretsGuard.isRegexSafe(re, p)) {
                                log.warn(`[SecretsGuard] Skipping potentially unsafe regex pattern: ${p}`);
                                continue;
                            }
                            patterns.push(re);
                        } catch {
                            log.warn(`[SecretsGuard] Invalid allowlist pattern: ${p}`);
                        }
                    }
                }
            }

            const hashes = new Set<string>();
            if (Array.isArray(parsed['allowed_hashes'])) {
                for (const h of parsed['allowed_hashes']) {
                    if (typeof h === 'string' && /^[a-f0-9]{64}$/.test(h)) {
                        hashes.add(h);
                    }
                }
            }

            const allowlist: Allowlist = { patterns, hashes };
            SecretsGuard.allowlistCache.set(workspaceRoot, { allowlist, cachedAt: Date.now() });
            log.info(
                `[SecretsGuard] Loaded allowlist: ${patterns.length} patterns, ${hashes.size} hashes`
            );
            return allowlist;
        } catch (err: unknown) {
            const isNotFound = (err as NodeJS.ErrnoException).code === 'ENOENT';
            if (!isNotFound) {
                log.warn('[SecretsGuard] Failed to load allowlist:', (err as Error).message);
            }
            SecretsGuard.allowlistCache.set(workspaceRoot, { allowlist: emptyAllowlist, cachedAt: Date.now() });
            return emptyAllowlist;
        }
    }

    /**
     * Clear the allowlist cache. Useful for testing or when workspace config changes.
     */
    static clearAllowlistCache(): void {
        SecretsGuard.allowlistCache.clear();
    }

    // ── Public API ─────────────────────────────────────────────────────────

    /**
     * Scan file content for secret patterns.
     *
     * @param content   - The raw file content to scan.
     * @param filePath  - Relative path (for human-readable findings).
     * @param allowlist - Optional allowlist to suppress known-safe findings.
     * @returns ScanResult with `safe: true` if clean, or findings array.
     */
    static scan(content: string, filePath: string, allowlist?: Allowlist): ScanResult {
        const findings: string[] = [];

        // 1. API key patterns — SEC-1: report ALL occurrences, not just first
        for (const { name, regex } of SecretsGuard.API_KEY_PATTERNS) {
            const globalRe = new RegExp(regex.source, 'g');
            let matchCount = 0;
            let match: RegExpExecArray | null;
            while ((match = globalRe.exec(content)) !== null) {
                const matchedValue = match[0];
                if (allowlist && SecretsGuard.isAllowlisted(matchedValue, allowlist)) {
                    continue;
                }
                matchCount++;
                findings.push(
                    matchCount > 1
                        ? `${name} pattern detected in ${filePath} (occurrence ${matchCount})`
                        : `${name} pattern detected in ${filePath}`,
                );
            }
        }

        // 2. Private key headers
        if (SecretsGuard.PRIVATE_KEY_RE.test(content)) {
            findings.push(`Private key header detected in ${filePath}`);
        }

        // 3. Environment variable secrets (KEY=value with non-empty value)
        for (const key of SecretsGuard.ENV_SECRET_KEYS) {
            const envRe = new RegExp(`${key}\\s*=\\s*['"]?([^'"\\n\\s]+)`, 'i');
            const match = envRe.exec(content);
            if (match && match[1] && match[1].length > 0) {
                const val = match[1];
                if (!SecretsGuard.isPlaceholder(val)) {
                    if (allowlist && SecretsGuard.isAllowlisted(val, allowlist)) {
                        continue;
                    }
                    findings.push(`Env secret ${key}=... detected in ${filePath}`);
                }
            }
        }

        // 4. High-entropy strings in assignment-like patterns
        const assignmentRe = /(?:['"]?\w+['"]?\s*[:=]\s*)['"]([A-Za-z0-9+/=_-]{16,})['"]/g;
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
                    if (allowlist && SecretsGuard.isAllowlisted(value, allowlist)) {
                        continue;
                    }
                    findings.push(`High-entropy value detected in ${filePath}`);
                    break; // One finding is enough
                }
            }
        }

        return findings.length > 0
            ? { safe: false, findings }
            : { safe: true, findings: [] };
    }

    /**
     * S1-3 (SEC-1): Scan with blocking mode.
     * Same as `scan()` but throws `SecretsBlockedError` if secrets are
     * detected and `blockOnDetection` is true.
     */
    static scanWithBlocking(
        content: string,
        filePath: string,
        blockOnDetection: boolean,
        allowlist?: Allowlist,
    ): ScanResult {
        const result = SecretsGuard.scan(content, filePath, allowlist);
        if (!result.safe && blockOnDetection) {
            throw new SecretsBlockedError(
                `Secrets detected in ${filePath}: ${result.findings.join('; ')}`,
                result.findings,
            );
        }
        return result;
    }

    /**
     * Redact detected secret patterns in content, replacing matches with
     * `[REDACTED]`. Used on worker output streams before broadcasting
     * to the UI and persisting to telemetry logs.
     *
     * Coverage:
     * - API key patterns (AWS, OpenAI, GitHub, Slack, GitLab, Stripe, JWT, Google)
     * - Private key headers (RSA, EC, OPENSSH, PGP, DSA)
     * - Environment variable secrets (DB_PASSWORD, SECRET_KEY, etc.)
     * - High-entropy strings in assignment patterns (Shannon entropy > 4.5)
     *
     * @param content - The raw content (stdout/stderr) to redact.
     * @returns Content with detected secrets replaced by `[REDACTED]` or
     *          `[REDACTED-HIGH-ENTROPY]`.
     */
    static redact(content: string): string {
        let result = content;

        // 1. API key patterns
        for (const { regex } of SecretsGuard.API_KEY_PATTERNS) {
            result = result.replace(new RegExp(regex.source, 'g'), '[REDACTED]');
        }

        // 2. Private key headers
        result = result.replace(
            new RegExp(SecretsGuard.PRIVATE_KEY_RE.source, 'g'),
            '[REDACTED]'
        );

        // 3. Environment variable secrets — replace the value portion only
        for (const key of SecretsGuard.ENV_SECRET_KEYS) {
            const envRe = new RegExp(
                `(${key}\\s*=\\s*['"]?)([^'"\\n\\s]+)`,
                'gi',
            );
            result = result.replace(envRe, (_match, prefix: string, value: string) => {
                if (SecretsGuard.isPlaceholder(value)) return `${prefix}${value}`;
                return `${prefix}[REDACTED]`;
            });
        }

        // 4. High-entropy strings in assignment-like patterns
        const assignmentRe = /(?:['"]?\w+['"]?\s*[:=]\s*)['"]([A-Za-z0-9+/=_-]{16,})['"]/g;
        result = result.replace(assignmentRe, (fullMatch, value: string) => {
            if (
                value.length >= SecretsGuard.MIN_ENTROPY_VALUE_LENGTH &&
                SecretsGuard.shannonEntropy(value) > SecretsGuard.ENTROPY_THRESHOLD
            ) {
                // Don't double-redact values already caught by API key patterns
                const alreadyCaught = SecretsGuard.API_KEY_PATTERNS.some(
                    ({ regex }) => regex.test(value),
                );
                if (!alreadyCaught) {
                    return fullMatch.replace(value, '[REDACTED-HIGH-ENTROPY]');
                }
            }
            return fullMatch;
        });

        return result;
    }

    // ── Helpers ─────────────────────────────────────────────────────────────

    /**
     * Check if a value is allowlisted by either pattern match or hash.
     */
    private static isAllowlisted(value: string, allowlist: Allowlist): boolean {
        // Check pattern matches
        for (const pattern of allowlist.patterns) {
            if (pattern.test(value)) return true;
        }

        // Check hash matches
        const hash = crypto
            .createHash('sha256')
            .update(value)
            .digest('hex');
        return allowlist.hashes.has(hash);
    }

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

    /**
     * S1-7 (SEC-6): Test if a regex pattern is safe from ReDoS.
     * SEC-2: Delegates to shared `isRegexSafe` utility with stricter
     * structural analysis + timing guard.
     */
    private static isRegexSafe(re: RegExp, source: string): boolean {
        return isRegexSafe(re, source);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  S1-3 (SEC-1): SecretsBlockedError
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Thrown when secrets are detected and blocking mode is enabled.
 * Contains the list of findings for UI display.
 */
export class SecretsBlockedError extends Error {
    constructor(
        message: string,
        public readonly findings: string[],
    ) {
        super(message);
        this.name = 'SecretsBlockedError';
    }
}
