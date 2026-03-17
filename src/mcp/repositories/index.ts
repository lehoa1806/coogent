// ─────────────────────────────────────────────────────────────────────────────
// src/mcp/repositories/index.ts — Barrel export for all repositories
// ─────────────────────────────────────────────────────────────────────────────

export type { Database, Statement } from './db-types.js';
export { TaskRepository } from './TaskRepository.js';
export { PhaseRepository } from './PhaseRepository.js';
export { HandoffRepository } from './HandoffRepository.js';
export { VerdictRepository } from './VerdictRepository.js';
export { SessionRepository } from './SessionRepository.js';
export { AuditRepository } from './AuditRepository.js';
export { ContextManifestRepository } from './ContextManifestRepository.js';
export { FailureConsoleRepository, type FailureConsoleRow } from './FailureConsoleRepository.js';
