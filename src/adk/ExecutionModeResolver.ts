// ─────────────────────────────────────────────────────────────────────────────
// src/adk/ExecutionModeResolver.ts — Centralized execution-mode detection
// ─────────────────────────────────────────────────────────────────────────────

import * as vscode from 'vscode';
import log from '../logger/log.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  Type Definitions
// ═══════════════════════════════════════════════════════════════════════════════

export type HostKind = 'vscode' | 'cursor' | 'antigravity' | 'unknown';

export type ExecutionMode =
  | 'vscode-native'
  | 'cursor'
  | 'antigravity'
  | 'unsupported';

export interface ModeDetectionResult {
  host: HostKind;
  mode: ExecutionMode;
  reasons: string[];
  signals: {
    hasVsCodeLmApi: boolean;
    hasCopilotModels: boolean;
    hasCursorExtension: boolean;
    hasAntigravityExtension: boolean;
    hasCursorChatCommand: boolean;
    hasAntigravityChatCommand: boolean;
    hasAntigravityAgentCommand: boolean;
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Constants
// ═══════════════════════════════════════════════════════════════════════════════

const CURSOR_EXTENSION_ID = 'anysphere.cursor-agent';
const ANTIGRAVITY_EXTENSION_ID = 'google.antigravity';

// ═══════════════════════════════════════════════════════════════════════════════
//  Helper Functions
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Determine the host environment based on detected extension signals.
 * Priority order: antigravity > cursor > vscode.
 */
function detectHost(args: {
  hasAntigravityExtension: boolean;
  hasCursorExtension: boolean;
  hasVsCodeLmApi: boolean;
}): HostKind {
  if (args.hasAntigravityExtension) return 'antigravity';
  if (args.hasCursorExtension) return 'cursor';
  if (args.hasVsCodeLmApi) return 'vscode';
  return 'unknown';
}

/**
 * Safely check whether Copilot (or other LM) models are available.
 * Returns `true` if at least one model is returned by `vscode.lm.selectChatModels`.
 */
async function safeHasCopilotModels(): Promise<boolean> {
  try {
    const models = await vscode.lm.selectChatModels({});
    return models.length > 0;
  } catch {
    log.debug('[ExecutionModeResolver] vscode.lm.selectChatModels() threw — LM API unavailable');
    return false;
  }
}

/**
 * Safely retrieve the list of available VS Code commands.
 * Returns an empty array if the command enumeration fails.
 */
async function safeGetCommands(): Promise<string[]> {
  try {
    return await vscode.commands.getCommands(true);
  } catch {
    log.debug('[ExecutionModeResolver] vscode.commands.getCommands() threw');
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Core Detection
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Detect the current execution mode by probing VS Code APIs.
 *
 * Checks for:
 *   - `vscode.lm` API availability and Copilot chat models
 *   - Cursor extension (`anysphere.cursor-agent`)
 *   - Antigravity extension (`google.antigravity`)
 *   - Available commands (`workbench.action.chat.open`,
 *     `antigravity.sendPromptToAgentPanel`)
 *
 * Returns a `ModeDetectionResult` containing the resolved host, mode,
 * human-readable reasons, and raw signal flags.
 */
export async function detectExecutionMode(): Promise<ModeDetectionResult> {
  const reasons: string[] = [];

  // ── Probe signals in parallel ──────────────────────────────────────────────

  const hasVsCodeLmApi = typeof vscode.lm?.selectChatModels === 'function';
  reasons.push(hasVsCodeLmApi
    ? 'vscode.lm API is available'
    : 'vscode.lm API is NOT available');

  const [hasCopilotModels, commands] = await Promise.all([
    hasVsCodeLmApi ? safeHasCopilotModels() : Promise.resolve(false),
    safeGetCommands(),
  ]);

  reasons.push(hasCopilotModels
    ? 'Copilot chat models detected'
    : 'No Copilot chat models found');

  const hasCursorExtension =
    vscode.extensions.getExtension(CURSOR_EXTENSION_ID) != null;
  reasons.push(hasCursorExtension
    ? `Cursor extension (${CURSOR_EXTENSION_ID}) is installed`
    : `Cursor extension (${CURSOR_EXTENSION_ID}) is NOT installed`);

  const hasAntigravityExtension =
    vscode.extensions.getExtension(ANTIGRAVITY_EXTENSION_ID) != null;
  reasons.push(hasAntigravityExtension
    ? `Antigravity extension (${ANTIGRAVITY_EXTENSION_ID}) is installed`
    : `Antigravity extension (${ANTIGRAVITY_EXTENSION_ID}) is NOT installed`);

  const commandSet = new Set(commands);

  const hasCursorChatCommand =
    commandSet.has('workbench.action.chat.open');
  reasons.push(hasCursorChatCommand
    ? 'workbench.action.chat.open command is available'
    : 'workbench.action.chat.open command is NOT available');

  const hasAntigravityChatCommand =
    commandSet.has('workbench.action.chat.open');
  // Note: same command — differentiation happens via host detection

  const hasAntigravityAgentCommand =
    commandSet.has('antigravity.sendPromptToAgentPanel');
  reasons.push(hasAntigravityAgentCommand
    ? 'antigravity.sendPromptToAgentPanel command is available'
    : 'antigravity.sendPromptToAgentPanel command is NOT available');

  // ── Build signals object ───────────────────────────────────────────────────

  const signals: ModeDetectionResult['signals'] = {
    hasVsCodeLmApi,
    hasCopilotModels,
    hasCursorExtension,
    hasAntigravityExtension,
    hasCursorChatCommand,
    hasAntigravityChatCommand,
    hasAntigravityAgentCommand,
  };

  // ── Resolve host ───────────────────────────────────────────────────────────

  const host = detectHost({
    hasAntigravityExtension,
    hasCursorExtension,
    hasVsCodeLmApi,
  });
  reasons.push(`Detected host: ${host}`);

  // ── Resolve mode based on host ─────────────────────────────────────────────

  let mode: ExecutionMode;

  switch (host) {
    case 'vscode': {
      if (hasVsCodeLmApi && hasCopilotModels) {
        mode = 'vscode-native';
        reasons.push('Mode: vscode-native (LM API + Copilot models available)');
      } else {
        mode = 'unsupported';
        reasons.push('Mode: unsupported (vscode host but missing LM API or Copilot models)');
      }
      break;
    }

    case 'cursor': {
      if (hasCursorExtension && hasCursorChatCommand) {
        mode = 'cursor';
        reasons.push('Mode: cursor (Cursor extension + chat command available)');
      } else {
        mode = 'unsupported';
        reasons.push('Mode: unsupported (cursor host but missing extension or chat command)');
      }
      break;
    }

    case 'antigravity': {
      if (hasAntigravityExtension && (hasAntigravityAgentCommand || hasAntigravityChatCommand)) {
        mode = 'antigravity';
        reasons.push('Mode: antigravity (Antigravity extension + agent/chat command available)');
      } else {
        mode = 'unsupported';
        reasons.push('Mode: unsupported (antigravity host but missing extension or commands)');
      }
      break;
    }

    default: {
      mode = 'unsupported';
      reasons.push('Mode: unsupported (unknown host)');
      break;
    }
  }

  const result: ModeDetectionResult = { host, mode, reasons, signals };

  log.info(`[ExecutionModeResolver] Detection complete: host=${host}, mode=${mode}`);
  log.debug('[ExecutionModeResolver] Signals:', JSON.stringify(signals));
  log.debug('[ExecutionModeResolver] Reasons:', reasons.join('; '));

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Singleton Cache
// ═══════════════════════════════════════════════════════════════════════════════

let cachedResult: ModeDetectionResult | null = null;

/**
 * Get the current execution mode, caching the result after the first call.
 * Subsequent calls return the cached result without re-probing.
 */
export async function getExecutionMode(): Promise<ModeDetectionResult> {
  if (cachedResult) return cachedResult;
  cachedResult = await detectExecutionMode();
  return cachedResult;
}

/**
 * Synchronous getter for callers that need the mode after it has been resolved.
 * Returns `null` if `getExecutionMode()` has not been called yet.
 */
export function getExecutionModeSync(): ModeDetectionResult | null {
  return cachedResult;
}

/**
 * Reset the cached detection result. Useful when the extension environment
 * changes (e.g., extensions installed/uninstalled) and a fresh probe is needed.
 */
export function resetExecutionModeCache(): void {
  cachedResult = null;
}
