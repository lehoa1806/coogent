// ─────────────────────────────────────────────────────────────────────────────
// src/mcp/SamplingProvider.ts — Sampling abstraction layer for MCP
// ─────────────────────────────────────────────────────────────────────────────
// Provides a feature-flagged sampling interface so internal workflows can
// request LLM inference via MCP Sampling without hard-coding one backend.
// Sampling must NEVER be used for deterministic control-plane logic.

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type {
    CreateMessageResult,
} from '@modelcontextprotocol/sdk/types.js';
import log from '../logger/log.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Public Interfaces
// ═══════════════════════════════════════════════════════════════════════════════

/** Request envelope for sampling operations. */
export interface SamplingRequest {
    /** The user-facing prompt to send. */
    prompt: string;
    /** Maximum tokens the model may generate. */
    maxTokens?: number;
    /** Optional system prompt to set model behaviour. */
    systemPrompt?: string;
    /**
     * Logical class of this sampling request (e.g. 'review', 'summarise').
     * Used for logging / metrics, never for routing.
     */
    requestClass: string;
}

/** Result envelope returned by a sampling operation. */
export interface SamplingResult {
    /** Generated text content. */
    content: string;
    /** Model identifier (if available). */
    model?: string;
    /** Provider name (if available). */
    provider?: string;
    /** Token usage stats (if available). */
    usage?: {
        inputTokens: number;
        outputTokens: number;
    } | undefined;
}

/** Abstract interface for any LLM sampling backend. */
export interface SamplingProvider {
    /** Returns `true` if this provider is currently able to serve requests. */
    isAvailable(): boolean;
    /** Request a sampling completion. Throws if unavailable. */
    sample(request: SamplingRequest): Promise<SamplingResult>;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  NoopSamplingProvider — returned when sampling is disabled
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * A no-op provider that always reports unavailability.
 * Callers must fall back to current (non-sampling) behaviour.
 */
export class NoopSamplingProvider implements SamplingProvider {
    isAvailable(): boolean {
        return false;
    }

    async sample(_request: SamplingRequest): Promise<SamplingResult> {
        throw new Error('Sampling not available');
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  MCPSamplingProvider — wraps the MCP Server's createMessage capability
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Concrete provider that delegates to the MCP Server's `createMessage` API.
 *
 * Availability is determined by:
 *   1. The MCP client advertising `capabilities.sampling` during handshake
 *
 * All invocations are logged with request class, model metadata (when
 * available), outcome (success / failure), and token usage.
 */
export class MCPSamplingProvider implements SamplingProvider {
    constructor(private readonly server: Server) { }

    /**
     * Check whether the connected client advertised sampling support.
     */
    isAvailable(): boolean {
        const caps = this.server.getClientCapabilities();
        return caps?.sampling != null;
    }

    /**
     * Issue a sampling request via MCP `sampling/createMessage`.
     *
     * @throws If the client has not advertised sampling capability or
     *         if the underlying `createMessage` call fails.
     */
    async sample(request: SamplingRequest): Promise<SamplingResult> {
        if (!this.isAvailable()) {
            throw new Error('Sampling not available: client does not support sampling capability');
        }

        log.info(`[SamplingProvider] Sampling request — class="${request.requestClass}", maxTokens=${request.maxTokens ?? 'default'}`);

        try {
            const result: CreateMessageResult = await this.server.createMessage({
                messages: [
                    {
                        role: 'user',
                        content: {
                            type: 'text',
                            text: request.prompt,
                        },
                    },
                ],
                maxTokens: request.maxTokens ?? 4096,
                ...(request.systemPrompt ? { systemPrompt: request.systemPrompt } : {}),
            });

            // Extract text content from the result
            const content = typeof result.content === 'object' && 'text' in result.content
                ? result.content.text
                : String(result.content);

            const model = result.model;
            const rawUsage = result._meta?.usage as SamplingResult['usage'];
            const samplingResult: SamplingResult = {
                content,
                model,
                provider: 'mcp-sampling',
                ...(rawUsage != null ? { usage: rawUsage } : {}),
            };

            log.info(
                `[SamplingProvider] Sampling success — class="${request.requestClass}", model="${model ?? 'unknown'}"` +
                (samplingResult.usage
                    ? `, inputTokens=${samplingResult.usage.inputTokens}, outputTokens=${samplingResult.usage.outputTokens}`
                    : '')
            );

            return samplingResult;
        } catch (err) {
            log.error(`[SamplingProvider] Sampling failed — class="${request.requestClass}", error="${(err as Error).message}"`);
            throw err;
        }
    }
}
