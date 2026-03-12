// ─────────────────────────────────────────────────────────────────────────────
// src/state/RunbookEncryptor.ts — AES-256-CBC encryption for runbook files
// ─────────────────────────────────────────────────────────────────────────────
// R4 refactor: Extracted from StateManager.ts to isolate encryption concerns.

import * as crypto from 'node:crypto';
import log from '../logger/log.js';

/** Prefix for encrypted content — allows auto-detection on read. */
const ENCRYPTED_PREFIX = 'ENC:';

/**
 * Minimal interface matching VS Code's `SecretStorage` API.
 * Decoupled from the vscode module for unit-test portability.
 */
export interface SecretStorageLike {
    get(key: string): Thenable<string | undefined>;
    store(key: string, value: string): Thenable<void>;
}

/**
 * Handles AES-256-CBC encryption and decryption of runbook and WAL files.
 *
 * Key management:
 * - If SecretStorage is provided, the key is stored/loaded from the OS keychain.
 * - If no SecretStorage is available, a random ephemeral key is generated
 *   (suitable for test environments — lost on extension restart).
 */
export class RunbookEncryptor {
    /** SecretStorage key under which the encryption key is stored. */
    private static readonly SECRET_KEY_ID = 'coogent.encryptionKey';

    /** Whether encryption is enabled. */
    private readonly enabled: boolean;

    /** VS Code SecretStorage instance (optional). */
    private readonly secretStorage: SecretStorageLike | undefined;

    /** Encryption key — loaded from SecretStorage or generated on first use. */
    private encryptionKey: Buffer | null = null;

    constructor(enabled: boolean, secretStorage?: SecretStorageLike) {
        this.enabled = enabled;
        this.secretStorage = secretStorage;
    }

    /** Whether encryption is enabled. */
    get isEnabled(): boolean {
        return this.enabled;
    }

    /**
     * Initialise the encryption key from VS Code SecretStorage.
     *
     * - If a key already exists in SecretStorage, it is loaded.
     * - If no key exists, a random 32-byte key is generated and stored.
     * - If no SecretStorage is available, falls back to in-memory random key
     *   (ephemeral — lost on extension restart, suitable for test environments).
     *
     * Must be called once before any encrypt/decrypt operations when
     * encryption is enabled. Called automatically by StateManager's
     * `loadRunbook()` and `saveRunbook()` if not yet initialized.
     */
    async init(): Promise<void> {
        if (this.encryptionKey) return;
        if (!this.enabled) return;

        if (this.secretStorage) {
            const stored = await this.secretStorage.get(RunbookEncryptor.SECRET_KEY_ID);
            if (stored) {
                this.encryptionKey = Buffer.from(stored, 'hex');
                log.info('[RunbookEncryptor] Encryption key loaded from SecretStorage.');
            } else {
                this.encryptionKey = crypto.randomBytes(32);
                await this.secretStorage.store(
                    RunbookEncryptor.SECRET_KEY_ID,
                    this.encryptionKey.toString('hex')
                );
                log.info('[RunbookEncryptor] New encryption key generated and stored in SecretStorage.');
            }
        } else {
            // No SecretStorage available — generate ephemeral key (test/CI environments)
            this.encryptionKey = crypto.randomBytes(32);
            log.warn(
                '[RunbookEncryptor] No SecretStorage available — using ephemeral encryption key. ' +
                'Encrypted data will not survive extension restarts.'
            );
        }
    }

    /**
     * Get the encryption key.
     * @throws Error if encryption is enabled but key is not initialized.
     */
    private getKey(): Buffer {
        if (this.encryptionKey) return this.encryptionKey;
        throw new Error(
            '[RunbookEncryptor] Encryption key not initialized. ' +
            'Call init() before encrypt/decrypt operations.'
        );
    }

    /**
     * Encrypt plaintext using AES-256-CBC. Returns `ENC:<iv>:<ciphertext>` (base64).
     * Only encrypts if encryption is enabled; otherwise returns plaintext.
     */
    maybeEncrypt(plaintext: string): string {
        if (!this.enabled) return plaintext;

        const key = this.getKey();
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
        const encrypted = Buffer.concat([
            cipher.update(plaintext, 'utf-8'),
            cipher.final(),
        ]);
        return `${ENCRYPTED_PREFIX}${iv.toString('base64')}:${encrypted.toString('base64')}`;
    }

    /**
     * Decrypt content if it starts with the ENC: prefix.
     * Migration-safe: plaintext content passes through unchanged.
     */
    maybeDecrypt(content: string): string {
        if (!content.startsWith(ENCRYPTED_PREFIX)) return content;

        const key = this.getKey();
        const payload = content.slice(ENCRYPTED_PREFIX.length);
        const colonIdx = payload.indexOf(':');
        if (colonIdx === -1) {
            log.warn('[RunbookEncryptor] Malformed encrypted content — missing IV separator.');
            throw new Error('Malformed encrypted content');
        }

        const iv = Buffer.from(payload.slice(0, colonIdx), 'base64');
        const ciphertext = Buffer.from(payload.slice(colonIdx + 1), 'base64');
        const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
        const decrypted = Buffer.concat([
            decipher.update(ciphertext),
            decipher.final(),
        ]);
        return decrypted.toString('utf-8');
    }
}
