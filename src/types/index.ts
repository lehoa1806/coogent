// ─────────────────────────────────────────────────────────────────────────────
// src/types/index.ts — Barrel re-export for backward compatibility (S4-1)
//
// All types have been split into domain-scoped files:
//   - phase.ts      — Runbook, Phase, branded types, ADK/context contracts
//   - engine.ts     — FSM states, events, transition table
//   - ipc.ts        — Host↔Webview IPC message contracts
//   - evaluators.ts — Evaluator, self-healing, Git sandbox types
//   - context.ts    — Context-sharing handoff/pack/manifest contracts
//   - failure-console.ts — Failure Console types and data model
//
// Existing `import { ... } from '../types/index.js'` paths continue working.
// ─────────────────────────────────────────────────────────────────────────────

export * from './phase.js';
export * from './engine.js';
export * from './ipc.js';
export * from './evaluators.js';
export * from './context.js';
export * from './failure-console.js';
