// ─────────────────────────────────────────────────────────────────────────────
// src/context/__tests__/SecretsGuard.test.ts — SecretsGuard unit tests
// ─────────────────────────────────────────────────────────────────────────────

import { SecretsGuard } from '../SecretsGuard.js';

describe('SecretsGuard', () => {
    // ── API Key Patterns ─────────────────────────────────────────────────

    it('detects AWS Access Key IDs', () => {
        const content = 'aws_access_key_id = AKIAIOSFODNN7EXAMPLE';
        const result = SecretsGuard.scan(content, 'config.ts');
        expect(result.safe).toBe(false);
        expect(result.findings).toEqual(
            expect.arrayContaining([expect.stringContaining('AWS Access Key')])
        );
    });

    it('detects OpenAI API keys', () => {
        const content = 'const key = "sk-abcdefghijklmnopqrstuvwxyz1234567890"';
        const result = SecretsGuard.scan(content, 'api.ts');
        expect(result.safe).toBe(false);
        expect(result.findings).toEqual(
            expect.arrayContaining([expect.stringContaining('OpenAI API Key')])
        );
    });

    it('detects GitHub PATs', () => {
        const content = 'GITHUB_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl';
        const result = SecretsGuard.scan(content, '.env');
        expect(result.safe).toBe(false);
        expect(result.findings).toEqual(
            expect.arrayContaining([expect.stringContaining('GitHub PAT')])
        );
    });

    it('detects Slack Bot tokens', () => {
        // Build at runtime to avoid GitHub push-protection scanning the literal
        const prefix = ['xoxb', '0000000000', '0000000000000'].join('-');
        const content = `token: "${prefix}-FAKEFAKEFAKEFAKEFAKEFAKE"`;
        const result = SecretsGuard.scan(content, 'slack.ts');
        expect(result.safe).toBe(false);
        expect(result.findings).toEqual(
            expect.arrayContaining([expect.stringContaining('Slack Bot Token')])
        );
    });

    it('detects GitLab PATs', () => {
        const content = 'GITLAB_TOKEN=glpat-xYzAbCdEfGhIjKlMnOpQr';
        const result = SecretsGuard.scan(content, '.env');
        expect(result.safe).toBe(false);
        expect(result.findings).toEqual(
            expect.arrayContaining([expect.stringContaining('GitLab PAT')])
        );
    });

    it('detects Stripe secret keys', () => {
        // Build at runtime to avoid GitHub push-protection scanning the literal
        const content = `stripe.apiKey = "${'sk' + '_live_' + '00000000000000FAKEFAKETEST'}"`;
        const result = SecretsGuard.scan(content, 'payment.ts');
        expect(result.safe).toBe(false);
        expect(result.findings).toEqual(
            expect.arrayContaining([expect.stringContaining('Stripe Secret Key')])
        );
    });

    // ── Private Key Headers ──────────────────────────────────────────────

    it('detects RSA private key headers', () => {
        const content = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCA...';
        const result = SecretsGuard.scan(content, 'id_rsa');
        expect(result.safe).toBe(false);
        expect(result.findings).toEqual(
            expect.arrayContaining([expect.stringContaining('Private key header')])
        );
    });

    it('detects EC private key headers', () => {
        const content = '-----BEGIN EC PRIVATE KEY-----\nMHQCAQEEI...';
        const result = SecretsGuard.scan(content, 'ec.pem');
        expect(result.safe).toBe(false);
        expect(result.findings).toEqual(
            expect.arrayContaining([expect.stringContaining('Private key header')])
        );
    });

    it('detects OPENSSH private key headers', () => {
        const content = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNza...';
        const result = SecretsGuard.scan(content, 'id_ed25519');
        expect(result.safe).toBe(false);
        expect(result.findings).toEqual(
            expect.arrayContaining([expect.stringContaining('Private key header')])
        );
    });

    // ── Environment Variable Secrets ─────────────────────────────────────

    it('detects DB_PASSWORD in env-like content', () => {
        const content = 'DB_PASSWORD=my_super_secret_pass';
        const result = SecretsGuard.scan(content, '.env');
        expect(result.safe).toBe(false);
        expect(result.findings).toEqual(
            expect.arrayContaining([expect.stringContaining('Env secret DB_PASSWORD')])
        );
    });

    it('detects SECRET_KEY with quotes', () => {
        const content = "SECRET_KEY='s3cr3t_pr0duction_k3y_v4lue'";
        const result = SecretsGuard.scan(content, '.env.production');
        expect(result.safe).toBe(false);
        expect(result.findings).toEqual(
            expect.arrayContaining([expect.stringContaining('SECRET_KEY')])
        );
    });

    it('ignores placeholder env values', () => {
        const content = 'DB_PASSWORD=changeme\nSECRET_KEY=your_key_here\nAPI_SECRET=placeholder';
        const result = SecretsGuard.scan(content, '.env.example');
        expect(result.safe).toBe(true);
    });

    // ── Shannon Entropy ──────────────────────────────────────────────────

    it('calculates Shannon entropy correctly', () => {
        // "aaaa" has 0 entropy (all same character)
        expect(SecretsGuard.shannonEntropy('aaaa')).toBe(0);

        // "ab" repeated has entropy of 1 (two equally frequent chars)
        expect(SecretsGuard.shannonEntropy('abab')).toBeCloseTo(1.0, 2);

        // Random-looking string should have high entropy
        const highEntropy = SecretsGuard.shannonEntropy('aB3$xZ9!qW7#mK2@pL5');
        expect(highEntropy).toBeGreaterThan(4.0);
    });

    it('returns 0 entropy for empty string', () => {
        expect(SecretsGuard.shannonEntropy('')).toBe(0);
    });

    // ── False Positive Resistance ────────────────────────────────────────

    it('passes clean TypeScript code', () => {
        const content = `
            import { readFile } from 'node:fs/promises';
            const API_KEY = process.env.API_KEY;
            export function getConfig() {
                return { port: 3000, host: 'localhost' };
            }
        `;
        const result = SecretsGuard.scan(content, 'config.ts');
        expect(result.safe).toBe(true);
    });

    it('passes code with "key" as a variable name', () => {
        const content = `const key = "user-preference-key";`;
        const result = SecretsGuard.scan(content, 'store.ts');
        expect(result.safe).toBe(true);
    });

    it('does not flag short sk- prefixes (non-OpenAI)', () => {
        const content = `const sk = "sk-short";`;
        const result = SecretsGuard.scan(content, 'short.ts');
        expect(result.safe).toBe(true);
    });

    it('does not flag public key headers', () => {
        const content = '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhki...';
        const result = SecretsGuard.scan(content, 'public.pem');
        expect(result.safe).toBe(true);
    });

    // ── Multiple findings ────────────────────────────────────────────────

    it('reports multiple findings for file with multiple secrets', () => {
        const content = [
            'AWS_SECRET_ACCESS_KEY=MyRealSecretKey123',
            'AKIAIOSFODNN7EXAMPLE',
            '-----BEGIN RSA PRIVATE KEY-----',
        ].join('\n');
        const result = SecretsGuard.scan(content, 'secrets.env');
        expect(result.safe).toBe(false);
        expect(result.findings.length).toBeGreaterThanOrEqual(3);
    });

    it('includes file path in findings', () => {
        const content = 'AKIAIOSFODNN7EXAMPLE';
        const result = SecretsGuard.scan(content, 'src/config/keys.ts');
        expect(result.safe).toBe(false);
        expect(result.findings[0]).toContain('src/config/keys.ts');
    });

    // ── JWT and Google API Key Patterns ───────────────────────────────────

    it('detects JWT tokens', () => {
        const content = 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0';
        const result = SecretsGuard.scan(content, 'auth.ts');
        expect(result.safe).toBe(false);
        expect(result.findings).toEqual(
            expect.arrayContaining([expect.stringContaining('JWT Token')])
        );
    });

    it('detects Google API keys', () => {
        const content = 'const apiKey = "AIzaSyC0X1Y2Z3a4B5c6D7E8F9G0H1I2J3K4L5M"';
        const result = SecretsGuard.scan(content, 'maps.ts');
        expect(result.safe).toBe(false);
        expect(result.findings).toEqual(
            expect.arrayContaining([expect.stringContaining('Google API Key')])
        );
    });

    // ── Redact ────────────────────────────────────────────────────────────

    it('redact() replaces JWT tokens', () => {
        const input = 'Token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0 found';
        const result = SecretsGuard.redact(input);
        expect(result).toContain('[REDACTED]');
        expect(result).not.toContain('eyJhbGci');
    });

    it('redact() replaces Google API keys', () => {
        const input = 'key=AIzaSyC0X1Y2Z3a4B5c6D7E8F9G0H1I2J3K4L5M';
        const result = SecretsGuard.redact(input);
        expect(result).toContain('[REDACTED]');
        expect(result).not.toContain('AIzaSy');
    });

    it('redact() replaces AWS keys', () => {
        const input = 'key=AKIAIOSFODNN7EXAMPLE';
        const result = SecretsGuard.redact(input);
        expect(result).toContain('[REDACTED]');
        expect(result).not.toContain('AKIA');
    });
});
