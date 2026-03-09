// ─────────────────────────────────────────────────────────────────────────────
// src/mcp/__tests__/SamplingProvider.test.ts — Unit tests for sampling layer
// ─────────────────────────────────────────────────────────────────────────────

import {
    NoopSamplingProvider,
    MCPSamplingProvider,
    type SamplingRequest,
} from '../SamplingProvider.js';
import log from '../../logger/log.js';

// ── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../../logger/log.js', () => ({
    __esModule: true,
    default: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    },
}));

function createMockServer(opts: {
    hasSampling?: boolean;
    createMessageResult?: unknown;
    createMessageError?: Error;
} = {}) {
    return {
        getClientCapabilities: jest.fn().mockReturnValue(
            opts.hasSampling ? { sampling: {} } : {}
        ),
        createMessage: jest.fn().mockImplementation(async () => {
            if (opts.createMessageError) {
                throw opts.createMessageError;
            }
            return opts.createMessageResult ?? {
                content: { type: 'text', text: 'Generated response' },
                model: 'test-model-3',
                role: 'assistant',
                _meta: {
                    usage: { inputTokens: 100, outputTokens: 42 },
                },
            };
        }),
    } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const sampleRequest: SamplingRequest = {
    prompt: 'Summarise this diff',
    maxTokens: 1024,
    systemPrompt: 'You are a code reviewer.',
    requestClass: 'review',
};

// ═══════════════════════════════════════════════════════════════════════════════
//  NoopSamplingProvider
// ═══════════════════════════════════════════════════════════════════════════════

describe('NoopSamplingProvider', () => {
    const provider = new NoopSamplingProvider();

    it('isAvailable() returns false', () => {
        expect(provider.isAvailable()).toBe(false);
    });

    it('sample() throws "Sampling not available"', async () => {
        await expect(provider.sample(sampleRequest))
            .rejects.toThrow('Sampling not available');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  MCPSamplingProvider
// ═══════════════════════════════════════════════════════════════════════════════

describe('MCPSamplingProvider', () => {
    // ── Availability ─────────────────────────────────────────────────────

    describe('isAvailable()', () => {
        it('returns true when client advertises sampling capability', () => {
            const server = createMockServer({ hasSampling: true });
            const provider = new MCPSamplingProvider(server);
            expect(provider.isAvailable()).toBe(true);
        });

        it('returns false when client does not advertise sampling', () => {
            const server = createMockServer({ hasSampling: false });
            const provider = new MCPSamplingProvider(server);
            expect(provider.isAvailable()).toBe(false);
        });

        it('returns false when getClientCapabilities() returns undefined', () => {
            const server = createMockServer();
            server.getClientCapabilities.mockReturnValue(undefined);
            const provider = new MCPSamplingProvider(server);
            expect(provider.isAvailable()).toBe(false);
        });
    });

    // ── Sampling ─────────────────────────────────────────────────────────

    describe('sample()', () => {
        it('returns a SamplingResult on success', async () => {
            const server = createMockServer({ hasSampling: true });
            const provider = new MCPSamplingProvider(server);

            const result = await provider.sample(sampleRequest);

            expect(result.content).toBe('Generated response');
            expect(result.model).toBe('test-model-3');
            expect(result.provider).toBe('mcp-sampling');
            expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 42 });
        });

        it('passes prompt and maxTokens to server.createMessage', async () => {
            const server = createMockServer({ hasSampling: true });
            const provider = new MCPSamplingProvider(server);

            await provider.sample(sampleRequest);

            expect(server.createMessage).toHaveBeenCalledWith(
                expect.objectContaining({
                    messages: [
                        {
                            role: 'user',
                            content: { type: 'text', text: 'Summarise this diff' },
                        },
                    ],
                    maxTokens: 1024,
                    systemPrompt: 'You are a code reviewer.',
                })
            );
        });

        it('defaults maxTokens to 4096 when not specified', async () => {
            const server = createMockServer({ hasSampling: true });
            const provider = new MCPSamplingProvider(server);

            await provider.sample({ prompt: 'Hello', requestClass: 'test' });

            expect(server.createMessage).toHaveBeenCalledWith(
                expect.objectContaining({ maxTokens: 4096 })
            );
        });

        it('throws when sampling is unavailable', async () => {
            const server = createMockServer({ hasSampling: false });
            const provider = new MCPSamplingProvider(server);

            await expect(provider.sample(sampleRequest))
                .rejects.toThrow('Sampling not available: client does not support sampling capability');
        });

        it('propagates server.createMessage errors', async () => {
            const server = createMockServer({
                hasSampling: true,
                createMessageError: new Error('Connection lost'),
            });
            const provider = new MCPSamplingProvider(server);

            await expect(provider.sample(sampleRequest))
                .rejects.toThrow('Connection lost');
        });

        it('logs request class and outcome on success', async () => {
            const server = createMockServer({ hasSampling: true });
            const provider = new MCPSamplingProvider(server);

            await provider.sample(sampleRequest);

            expect(log.info).toHaveBeenCalledWith(
                expect.stringContaining('class="review"')
            );
            expect(log.info).toHaveBeenCalledWith(
                expect.stringContaining('Sampling success')
            );
        });

        it('logs error on failure', async () => {
            const server = createMockServer({
                hasSampling: true,
                createMessageError: new Error('Timeout'),
            });
            const provider = new MCPSamplingProvider(server);

            await expect(provider.sample(sampleRequest)).rejects.toThrow();

            expect(log.error).toHaveBeenCalledWith(
                expect.stringContaining('Sampling failed')
            );
        });
    });
});
