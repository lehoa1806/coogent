// ─────────────────────────────────────────────────────────────────────────────
// StateManagerEncryption.test.ts — Tests for AES-256-CBC encryption
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { StateManager, type SecretStorageLike } from '../StateManager.js';
import { RUNBOOK_FILENAME, type Runbook, type EngineState } from '../../types/index.js';

const ENCRYPTED_PREFIX = 'ENC:';

function makeRunbook(overrides?: Partial<Runbook>): Runbook {
    return {
        project_id: 'test-project',
        status: 'running',
        current_phase: 0,
        phases: [
            {
                id: 0,
                status: 'pending',
                prompt: 'Build the thing',
                context_files: ['src/main.ts'],
                success_criteria: 'Tests pass',
            },
        ],
        ...overrides,
    } as Runbook;
}

/** In-memory mock of VS Code SecretStorage. */
function createMockSecretStorage(): SecretStorageLike & { _store: Map<string, string> } {
    const _store = new Map<string, string>();
    return {
        _store,
        get(key: string) { return Promise.resolve(_store.get(key)); },
        store(key: string, value: string) { _store.set(key, value); return Promise.resolve(); },
    };
}

describe('StateManager — Encryption', () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'statemgr-enc-test-'));
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('saves and loads runbook with encryption enabled (SecretStorage)', async () => {
        const secrets = createMockSecretStorage();
        const mgr = new StateManager(tmpDir, true, secrets);
        const runbook = makeRunbook();

        await mgr.saveRunbook(runbook, 'EXECUTING' as EngineState);

        // Verify on-disk content is encrypted
        const raw = await fs.readFile(path.join(tmpDir, RUNBOOK_FILENAME), 'utf-8');
        expect(raw.startsWith(ENCRYPTED_PREFIX)).toBe(true);

        // Verify load decrypts correctly
        const loaded = await mgr.loadRunbook();
        expect(loaded).not.toBeNull();
        expect(loaded!.project_id).toBe('test-project');
        expect(loaded!.phases).toHaveLength(1);
    });

    it('saves plaintext when encryption is disabled (default)', async () => {
        const mgr = new StateManager(tmpDir, false);
        const runbook = makeRunbook();

        await mgr.saveRunbook(runbook, 'EXECUTING' as EngineState);

        const raw = await fs.readFile(path.join(tmpDir, RUNBOOK_FILENAME), 'utf-8');
        expect(raw.startsWith(ENCRYPTED_PREFIX)).toBe(false);
        const parsed = JSON.parse(raw);
        expect(parsed.project_id).toBe('test-project');
    });

    it('reads plaintext files when encryption is enabled (migration-safe)', async () => {
        // Write plaintext with encryption OFF
        const mgrPlain = new StateManager(tmpDir, false);
        await mgrPlain.saveRunbook(makeRunbook(), 'EXECUTING' as EngineState);

        // Read with encryption ON — should transparently handle plaintext
        const secrets = createMockSecretStorage();
        const mgrEnc = new StateManager(tmpDir, true, secrets);
        const loaded = await mgrEnc.loadRunbook();
        expect(loaded).not.toBeNull();
        expect(loaded!.project_id).toBe('test-project');
    });

    it('encrypt/decrypt roundtrip preserves data integrity', async () => {
        const secrets = createMockSecretStorage();
        const mgr = new StateManager(tmpDir, true, secrets);
        const runbook = makeRunbook({
            summary: 'Test with emoji 🎉 and unicode: café résumé',
        });

        await mgr.saveRunbook(runbook, 'EXECUTING' as EngineState);
        const loaded = await mgr.loadRunbook();

        expect(loaded!.summary).toBe('Test with emoji 🎉 and unicode: café résumé');
    });

    it('generates key on first use and reuses from SecretStorage on next instantiation', async () => {
        const secrets = createMockSecretStorage();

        // First instance — should generate and store key
        const mgr1 = new StateManager(tmpDir, true, secrets);
        await mgr1.saveRunbook(makeRunbook(), 'EXECUTING' as EngineState);

        // Verify key was stored
        expect(secrets._store.has('coogent.encryptionKey')).toBe(true);
        const storedKey = secrets._store.get('coogent.encryptionKey')!;
        expect(storedKey).toHaveLength(64); // 32 bytes = 64 hex chars

        // Second instance with same SecretStorage — should load existing key
        const mgr2 = new StateManager(tmpDir, true, secrets);
        const loaded = await mgr2.loadRunbook();
        expect(loaded).not.toBeNull();
        expect(loaded!.project_id).toBe('test-project');
    });

    it('falls back to ephemeral key when no SecretStorage provided', async () => {
        // No SecretStorage — should still work with ephemeral key
        const mgr = new StateManager(tmpDir, true);
        const runbook = makeRunbook();

        await mgr.saveRunbook(runbook, 'EXECUTING' as EngineState);

        const raw = await fs.readFile(path.join(tmpDir, RUNBOOK_FILENAME), 'utf-8');
        expect(raw.startsWith(ENCRYPTED_PREFIX)).toBe(true);

        // Same instance can decrypt
        const loaded = await mgr.loadRunbook();
        expect(loaded).not.toBeNull();
        expect(loaded!.project_id).toBe('test-project');
    });

    it('different SecretStorage instances produce different keys', async () => {
        const dir1 = await fs.mkdtemp(path.join(os.tmpdir(), 'enc-key-test-1-'));
        const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'enc-key-test-2-'));

        try {
            const secrets1 = createMockSecretStorage();
            const secrets2 = createMockSecretStorage();

            const mgr1 = new StateManager(dir1, true, secrets1);
            const mgr2 = new StateManager(dir2, true, secrets2);

            await mgr1.saveRunbook(makeRunbook(), 'EXECUTING' as EngineState);
            await mgr2.saveRunbook(makeRunbook(), 'EXECUTING' as EngineState);

            // Different random keys means different ciphertext
            const raw1 = await fs.readFile(path.join(dir1, RUNBOOK_FILENAME), 'utf-8');
            const raw2 = await fs.readFile(path.join(dir2, RUNBOOK_FILENAME), 'utf-8');
            expect(raw1).not.toEqual(raw2);
        } finally {
            await fs.rm(dir1, { recursive: true, force: true });
            await fs.rm(dir2, { recursive: true, force: true });
        }
    });
});
