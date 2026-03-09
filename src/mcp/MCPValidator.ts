// ─────────────────────────────────────────────────────────────────────────────
// src/mcp/MCPValidator.ts — Stateless input validation for MCP tool arguments
// ─────────────────────────────────────────────────────────────────────────────
// Extracted from CoogentMCPServer.ts (Sprint 2: MCP Server Decomposition).
// All methods are static — no instance state required.

import {
    MASTER_TASK_ID_PATTERN,
    PHASE_ID_PATTERN,
} from './types.js';
import log from '../logger/log.js';
import { ERR_MCP_STRING_LENGTH_EXCEEDED } from '../logger/ErrorCodes.js';

/**
 * Stateless input validation helpers for MCP tool arguments.
 *
 * The MCP SDK does NOT validate `arguments` against the declared JSON Schema,
 * so these methods are the sole enforcement gate for runtime constraints.
 */
export class MCPValidator {
    static validateMasterTaskId(value: unknown): string {
        if (typeof value !== 'string' || !MASTER_TASK_ID_PATTERN.test(value)) {
            throw new Error(
                `Invalid masterTaskId: expected YYYYMMDD-HHMMSS-<uuid> format, got "${String(value)}".`
            );
        }
        return value;
    }

    static validatePhaseId(value: unknown): string {
        if (typeof value !== 'string' || !PHASE_ID_PATTERN.test(value)) {
            throw new Error(
                `Invalid phaseId: expected phase-<index>-<uuid> format, got "${String(value)}".`
            );
        }
        return value;
    }

    static validateString(value: unknown, fieldName: string, maxLength = 100_000): string {
        if (typeof value !== 'string') {
            throw new Error(
                `Invalid ${fieldName}: expected a string, got ${typeof value}.`
            );
        }
        if (value.length > maxLength) {
            log.warn(
                `[MCPValidator] ${ERR_MCP_STRING_LENGTH_EXCEEDED}: ${fieldName} ` +
                `(${value.length} > ${maxLength})`,
            );
            throw new Error(
                `Invalid ${fieldName}: exceeds maximum length (${maxLength}).`
            );
        }
        return value;
    }

    /**
     * D-3: Runtime enforcement for string array fields.
     * The MCP SDK does NOT validate `arguments` against the declared JSON Schema,
     * so this is the sole enforcement gate for array constraints.
     */
    static validateStringArray(
        value: unknown,
        fieldName: string,
        opts: {
            maxItemLength?: number;
            maxItems?: number;
            /** If true, each item must match the safe relative-path pattern `^[\w\-./]+$` */
            pathLike?: boolean;
        } = {}
    ): string[] {
        if (!Array.isArray(value)) {
            throw new Error(
                `Invalid ${fieldName}: expected an array, got ${typeof value}.`
            );
        }
        if (opts.maxItems !== undefined && value.length > opts.maxItems) {
            throw new Error(
                `Invalid ${fieldName}: exceeds maxItems (${opts.maxItems}).`
            );
        }
        for (const v of value) {
            if (typeof v !== 'string') {
                throw new Error(
                    `Invalid ${fieldName}: all items must be strings.`
                );
            }
            if (opts.maxItemLength !== undefined && v.length > opts.maxItemLength) {
                throw new Error(
                    `Invalid ${fieldName}: item exceeds maxLength (${opts.maxItemLength} chars).`
                );
            }
            if (opts.pathLike && !/^[\w\-./]+$/.test(v)) {
                throw new Error(
                    `Invalid ${fieldName}: item "${v.slice(0, 60)}" is not a valid relative path.`
                );
            }
        }
        return value as string[];
    }
}
