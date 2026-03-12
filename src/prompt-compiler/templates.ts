// ─────────────────────────────────────────────────────────────────────────────
// src/prompt-compiler/templates.ts — Build-time inlined prompt templates
// ─────────────────────────────────────────────────────────────────────────────
//
// esbuild inlines these `.md` imports as string constants via `loader: { '.md': 'text' }`.
// No filesystem access is needed at runtime.
// ─────────────────────────────────────────────────────────────────────────────

import orchestrationSkeleton from './templates/orchestration-skeleton.md';
import featureImplementation from './templates/feature-implementation.md';
import bugFix from './templates/bug-fix.md';
import refactor from './templates/refactor.md';
import migration from './templates/migration.md';
import documentationSynthesis from './templates/documentation-synthesis.md';
import repoAnalysis from './templates/repo-analysis.md';
import reviewOnly from './templates/review-only.md';
import testing from './templates/testing.md';
import ciCd from './templates/ci-cd.md';
import performance from './templates/performance.md';
import securityAudit from './templates/security-audit.md';
import dependencyManagement from './templates/dependency-management.md';
import devopsInfra from './templates/devops-infra.md';

export const ORCHESTRATION_SKELETON = orchestrationSkeleton;
export const FEATURE_IMPLEMENTATION = featureImplementation;
export const BUG_FIX = bugFix;
export const REFACTOR = refactor;
export const MIGRATION = migration;
export const DOCUMENTATION_SYNTHESIS = documentationSynthesis;
export const REPO_ANALYSIS = repoAnalysis;
export const REVIEW_ONLY = reviewOnly;
export const TESTING = testing;
export const CI_CD = ciCd;
export const PERFORMANCE = performance;
export const SECURITY_AUDIT = securityAudit;
export const DEPENDENCY_MANAGEMENT = dependencyManagement;
export const DEVOPS_INFRA = devopsInfra;
