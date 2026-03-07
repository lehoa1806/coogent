// ─────────────────────────────────────────────────────────────────────────────
// SecretsGuardAllowlist.test.ts — Tests for the allowlist feature
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { SecretsGuard } from '../SecretsGuard.js';
import type { Allowlist } from '../SecretsGuard.js';

describe('SecretsGuard — Allowlist', () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'secrets-guard-test-'));
        SecretsGuard.clearAllowlistCache();
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
        SecretsGuard.clearAllowlistCache();
    });

    // ── Allowlist Loading ─────────────────────────────────────────────────

    it('returns empty allowlist when file does not exist', async () => {
        const allowlist = await SecretsGuard.loadAllowlist(tmpDir);
        expect(allowlist.patterns).toEqual([]);
        expect(allowlist.hashes.size).toBe(0);
    });

    it('loads patterns and hashes from allowlist file', async () => {
        const coogentDir = path.join(tmpDir, '.coogent');
        await fs.mkdir(coogentDir, { recursive: true });
        await fs.writeFile(
            path.join(coogentDir, 'secrets-allowlist.json'),
            JSON.stringify({
                allowed_patterns: ['^test_', 'MY_CONST_\\d+'],
                allowed_hashes: [
                    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', // SHA-256 of ""
                ],
            })
        );

        const allowlist = await SecretsGuard.loadAllowlist(tmpDir);
        expect(allowlist.patterns).toHaveLength(2);
        expect(allowlist.hashes.size).toBe(1);
    });

    it('caches allowlist per workspace root', async () => {
        const coogentDir = path.join(tmpDir, '.coogent');
        await fs.mkdir(coogentDir, { recursive: true });
        await fs.writeFile(
            path.join(coogentDir, 'secrets-allowlist.json'),
            JSON.stringify({ allowed_patterns: ['^cached$'], allowed_hashes: [] })
        );

        const first = await SecretsGuard.loadAllowlist(tmpDir);
        const second = await SecretsGuard.loadAllowlist(tmpDir);
        expect(first).toBe(second); // Same reference = cached
    });

    it('skips invalid regex patterns gracefully', async () => {
        const coogentDir = path.join(tmpDir, '.coogent');
        await fs.mkdir(coogentDir, { recursive: true });
        await fs.writeFile(
            path.join(coogentDir, 'secrets-allowlist.json'),
            JSON.stringify({
                allowed_patterns: ['[invalid', 'valid_pattern'],
                allowed_hashes: [],
            })
        );

        const allowlist = await SecretsGuard.loadAllowlist(tmpDir);
        expect(allowlist.patterns).toHaveLength(1); // Only valid pattern
    });

    it('ignores invalid hash format', async () => {
        const coogentDir = path.join(tmpDir, '.coogent');
        await fs.mkdir(coogentDir, { recursive: true });
        await fs.writeFile(
            path.join(coogentDir, 'secrets-allowlist.json'),
            JSON.stringify({
                allowed_patterns: [],
                allowed_hashes: ['not-a-sha256', 'abcd1234'],
            })
        );

        const allowlist = await SecretsGuard.loadAllowlist(tmpDir);
        expect(allowlist.hashes.size).toBe(0);
    });

    // ── Scan with Allowlist ───────────────────────────────────────────────

    it('scan suppresses findings matching allowlist pattern', () => {
        const content = 'API_KEY = "sk-abcdefghijklmnopqrstuvwxyz1234567890"';
        const allowlist: Allowlist = {
            patterns: [/sk-abcdef/],
            hashes: new Set(),
        };

        // Without allowlist → should find OpenAI key pattern
        const resultWithout = SecretsGuard.scan(content, 'test.ts');
        expect(resultWithout.safe).toBe(false);

        // With allowlist → should be suppressed
        const resultWith = SecretsGuard.scan(content, 'test.ts', allowlist);
        expect(resultWith.safe).toBe(true);
    });

    it('scan suppresses findings matching allowlist hash', () => {
        const secretValue = 'sk-abcdefghijklmnopqrstuvwxyz1234567890';
        const hash = crypto.createHash('sha256').update(secretValue).digest('hex');
        const content = `API_KEY = "${secretValue}"`;
        const allowlist: Allowlist = {
            patterns: [],
            hashes: new Set([hash]),
        };

        const resultWith = SecretsGuard.scan(content, 'test.ts', allowlist);
        expect(resultWith.safe).toBe(true);
    });

    it('scan still reports findings not on the allowlist', () => {
        const content = 'API_KEY = "AKIAIOSFODNN7EXAMPLE1"';
        const allowlist: Allowlist = {
            patterns: [/^unrelated/],
            hashes: new Set(),
        };

        const result = SecretsGuard.scan(content, 'test.ts', allowlist);
        expect(result.safe).toBe(false);
    });
});
