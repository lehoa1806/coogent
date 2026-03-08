// ─────────────────────────────────────────────────────────────────────────────
// src/agent-selection/templates.ts — Build-time inlined worker prompt templates
// ─────────────────────────────────────────────────────────────────────────────
//
// esbuild inlines these `.md` imports as string constants via `loader: { '.md': 'text' }`.
// No filesystem access is needed at runtime.
// ─────────────────────────────────────────────────────────────────────────────

import baseWorker from './templates/base-worker.md';
import planner from './templates/Planner.md';
import codeEditor from './templates/CodeEditor.md';
import reviewer from './templates/Reviewer.md';
import testWriter from './templates/TestWriter.md';
import researcher from './templates/Researcher.md';
import debugger_ from './templates/Debugger.md';

export const BASE_WORKER = baseWorker;
export const PLANNER = planner;
export const CODE_EDITOR = codeEditor;
export const REVIEWER = reviewer;
export const TEST_WRITER = testWriter;
export const RESEARCHER = researcher;
export const DEBUGGER = debugger_;
