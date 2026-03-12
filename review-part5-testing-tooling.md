# Review Part 5 — Testing Infrastructure, Tooling & Supporting Modules

**Reviewer**: Senior TypeScript Engineer — Deep Code Review  
**Scope**: Testing config, build tooling, ESLint, developer experience, and remaining modules (evaluators, git, logger, consolidation, prompt-compiler, utils)  
**Date**: 2026-03-12

---

## Table of Contents

1. [Testing & Verification](#1-testing--verification)
2. [Configuration, Tooling & Build Health](#2-configuration-tooling--build-health)
3. [Developer Experience](#3-developer-experience)
4. [Module Reviews](#4-module-reviews)
   - [Evaluators](#41-evaluators)
   - [Git](#42-git)
   - [Logger](#43-logger)
   - [Consolidation](#44-consolidation)
   - [Prompt-Compiler](#45-prompt-compiler)
   - [Utils](#46-utils)
5. [Cross-Cutting Concerns](#5-cross-cutting-concerns)
6. [Summary & Priority Matrix](#6-summary--priority-matrix)

---

## 1. Testing & Verification

### T-1: Coverage Thresholds May Be Artificially Met by Low-Value Test Mass

**Severity**: Medium  
**File**: `jest.config.js` (lines 22-28)

**Issue**: The coverage thresholds (70% lines, 60% branches, 65% functions, 70% statements) are applied *globally* across all `src/**/*.ts` files. This means high coverage in heavily-tested utility/pure modules can mask near-zero coverage in critical, hard-to-test areas (e.g., `engine/`, `adk/`, `mcp/`). There is no per-module or per-directory threshold enforcement.

**Root Cause**: Jest's `coverageThreshold.global` aggregates all files into a single bucket. Critical modules that interact with VS Code APIs, child processes, or SQLite are inherently harder to test and likely drag down branch coverage while easy pure-function modules inflate line coverage.

**Remediation**:
```js
coverageThreshold: {
    global: { lines: 70, branches: 60, functions: 65, statements: 70 },
    './src/evaluators/': { branches: 80 },
    './src/prompt-compiler/': { branches: 75 },
    './src/engine/': { branches: 50 },
}
```
Add per-directory thresholds for critical paths. Start conservative (match current actual coverage) and ratchet up.

**Tradeoffs**: More granular thresholds require ongoing maintenance when new modules are added.  
**Tests**: Run `jest --coverage` and compare per-directory reports against new thresholds.

---

### T-2: `jest.globalSetup.js` Copies WASM Binary but Doesn't Clean Up

**Severity**: Low  
**File**: `jest.globalSetup.js` (lines 14-18)

**Issue**: The global setup copies `sql-wasm.wasm` into `src/mcp/` to satisfy `ArtifactDB` at test time, but there is no corresponding `globalTeardown` to remove it. This binary (≈1 MB) will accumulate as a tracked or untracked file inside `src/`.

**Root Cause**: The setup was designed as a one-shot idempotent copy (`if (!fs.existsSync(dest))`), but this sidesteps the question of cleanup.

**Remediation**: Add a `jest.globalTeardown.js` that removes the copied WASM file if it was created by setup. Alternatively, copy it to a temp directory and configure `ArtifactDB` to look there during tests.

**Tradeoffs**: Teardown adds complexity; the `.gitignore` should already exclude `*.wasm` from `src/`.  
**Tests**: Verify that `src/mcp/sql-wasm.wasm` does not exist after test suite completes.

---

### T-3: `--runInBand --detectOpenHandles --forceExit` Signals Test Isolation Issues

**Severity**: High  
**File**: `package.json` (line 344)

**Issue**: The test script uses `--runInBand` (serial execution), `--detectOpenHandles`, and `--forceExit`. This trifecta is a strong signal of resource leak or improper teardown in tests. `--forceExit` masks tests that leave open handles (DB connections, timers, streams). `--runInBand` is needed because tests likely have shared state or race conditions when run in parallel.

**Root Cause**: Modules like `ArtifactDB` (SQLite), `LogStream` (file streams), and `MCPServer` (TCP) open long-lived resources. Tests likely don't consistently call `dispose()` or `close()`.

**Remediation**:
1. Audit all test files for missing `afterAll`/`afterEach` cleanup calls.
2. Remove `--forceExit` and fix the actual leaks.
3. Once leaks are fixed, remove `--runInBand` to speed up tests via parallelism.
4. Keep `--detectOpenHandles` temporarily for diagnostics.

**Tradeoffs**: Fixing leaks is time-consuming but essential for CI reliability.  
**Tests**: Run `jest --detectOpenHandles` without `--forceExit` and address every reported handle.

---

### T-4: No Integration Test Coverage for Evaluator + Engine Flow

**Severity**: Medium  
**Files**: `src/evaluators/__tests__/EvaluatorV2.test.ts`

**Issue**: The evaluators are tested in isolation (unit tests), but there is no integration test that exercises the full `Engine → EvaluatorRegistry → Evaluator → SelfHealingController` flow. The `ToolchainEvaluator` and `TestSuiteEvaluator` execute real `execFile` calls. In tests, these would either need to be mocked or run against a fixture project.

**Root Cause**: The evaluator subsystem was designed with pluggable strategies but the integration seam between Engine and evaluators is not tested.

**Remediation**: Create an integration test that:
1. Sets up a minimal mock workspace with a `package.json` and a trivial test script.
2. Runs the `Engine` through a phase with `test_suite` evaluator.
3. Verifies the evaluation result feeds back into the self-healing loop.

**Tradeoffs**: Integration tests are slower and require filesystem fixtures.  
**Tests**: The new integration test itself validates the flow.

---

### T-5: `jest.mdTransform.js` Uses `module.exports` — Inconsistent with ESM Declarations

**Severity**: Low  
**File**: `jest.mdTransform.js` (line 9)

**Issue**: The transform outputs `module.exports = ...` (CommonJS), which is correct for Jest's CJS environment. However, the `declarations.d.ts` declares `.md` modules with `export default` (ESM). The mismatch means that the import syntax in source differs from how Jest resolves it. This currently works because `ts-jest` bridges the gap, but it's fragile.

**Root Cause**: esbuild handles `.md` as `text` loader (producing `default` exports), while Jest needs a custom CJS transform.

**Remediation**: Ensure the mdTransform consistently produces the same shape. Consider:
```js
code: `module.exports = { default: ${JSON.stringify(sourceText)} };`
```
This ensures `import content from './template.md'` works correctly via `ts-jest`'s ESM interop.

**Tradeoffs**: Requires testing that all `.md` imports still work after the change.  
**Tests**: Run existing tests that import `.md` files (e.g., `TemplateLoader.test.ts`).

---

### T-6: Missing Test Coverage for GitManager

**Severity**: Medium  
**File**: `src/git/__tests__/GitManager.test.ts`

**Issue**: `GitManager` uses dynamic `import()` for `child_process` and `util` inside the `gitExec` method (lines 221-223). This makes it difficult to mock cleanly in tests. Each call re-imports the modules, defeating `jest.mock()` at the module level.

**Root Cause**: The dynamic imports were likely added to avoid top-level side effects, but they create testing friction.

**Remediation**: Move the `execFile`/`promisify` imports to the top of the file (static imports) and use `jest.mock('node:child_process')` in tests. The dynamic import pattern provides no measurable benefit since `child_process` is a Node.js built-in.

**Tradeoffs**: Static imports are loaded eagerly but Node built-ins are negligible in cost.  
**Tests**: Ensure `GitManager.test.ts` can mock `execFile` and test all code paths (success, failure, rollback).

---

### T-7: `pretest` Runs Full Lint — CI May Double-Lint

**Severity**: Low  
**File**: `package.json` (line 341)

**Issue**: `pretest` calls `npm run lint`, which runs both `tsc --noEmit` AND `eslint`. The `ci` script then runs `npm run lint && npm test`. This means during CI, lint runs twice: once from `ci`'s explicit `lint` call, and again from `pretest` inside `npm test`.

**Root Cause**: NPM lifecycle hooks (`pretest`) are implicit and easy to forget when composing CI scripts.

**Remediation**: Either:
- Option A: Remove `pretest` and rely on the explicit `ci` script to orchestrate.
- Option B: Add a `--no-lint` flag to `test` and use `"test:bare": "jest ..."`.

**Tradeoffs**: Option A is simpler but developers running `npm test` locally won't get automatic linting.  
**Tests**: Verify CI script timing before/after the change.

---

## 2. Configuration, Tooling & Build Health

### C-1: esbuild Target `node18` vs tsconfig Target `ES2022` — Potential Mismatch

**Severity**: Medium  
**Files**: `esbuild.js` (line 40), `tsconfig.json` (line 3)

**Issue**: esbuild targets `node18` while tsconfig targets `ES2022`. Node 18 supports ES2022 features, but there's a subtle divergence: tsconfig's `module: "Node16"` emits `.js` imports with Node16 module resolution semantics, while esbuild bundles everything as CJS (`format: 'cjs'`). This is internally consistent but creates a gap: TypeScript typechecking sees Node16 ESM semantics while the bundle is CJS.

**Root Cause**: Historical evolution — TypeScript added `Node16` resolution to support ESM in Node, but VS Code extensions must be CJS bundles.

**Remediation**: Document this intentional discrepancy in a comment in `esbuild.js`. Consider adding `"node18"` to tsconfig's `lib` if Node 18-specific APIs are needed (currently only `ES2022` is listed).

**Tradeoffs**: Purely documentation; no runtime behavior change.  
**Tests**: Run `tsc --noEmit` to verify type checking passes.

---

### C-2: ESLint `--max-warnings=50` Is a Soft Cap That May Silently Degrade

**Severity**: Medium  
**Files**: `package.json` (lines 329, 340)

**Issue**: Both `lint-staged` and the `lint` script use `--max-warnings=50`. This means up to 50 warnings are silently swallowed. If the warning count drifts upward, the team won't notice until it crosses 50 and breaks the build. There's no ratchet mechanism to prevent warning inflation.

**Root Cause**: The cap was set conservatively to allow existing code to pass while new rules are introduced.

**Remediation**: Track warning count in CI:
1. Run `eslint --format json` and parse the warning count.
2. Fail CI if warnings exceed the current baseline.
3. Ratchet downward in a separate PR when warnings are fixed.

Alternatively, immediately reduce `--max-warnings` to the current actual count.

**Tradeoffs**: More aggressive caps require fixing existing warnings first.  
**Tests**: `npm run lint` should pass with the reduced cap.

---

### C-3: `*.js` and `*.cjs` Are Ignored by ESLint — Config Files Go Unchecked

**Severity**: Low  
**File**: `.eslintrc.cjs` (lines 29-30)

**Issue**: The `ignorePatterns` include `*.js` and `*.cjs`, which means the JavaScript config files (`esbuild.js`, `jest.config.js`, `jest.globalSetup.js`, `jest.mdTransform.js`) are never linted. These files contain I/O operations, path joins, and file copies that could benefit from linting.

**Root Cause**: The ESLint config is TypeScript-focused; JS files are second-class citizens.

**Remediation**: Add a separate ESLint override for JS config files with a basic ruleset (no TypeScript parser):
```js
overrides: [
    {
        files: ['*.js', '*.cjs'],
        parser: 'espree',
        env: { node: true },
        rules: { 'no-unused-vars': 'warn' },
    },
]
```

**Tradeoffs**: Additional ESLint config complexity; marginal benefit for small config files.  
**Tests**: `npm run lint` should now also check JS files.

---

### C-4: `.vscodeignore` Excludes All `.d.ts` Files — May Strip Needed Declarations

**Severity**: Low  
**File**: `.vscodeignore` (line 48)

**Issue**: The pattern `**/*.d.ts` excludes all declaration files from the VSIX package. Since the extension is bundled by esbuild (which inlines everything into `out/extension.js`), this is correct. However, if any runtime code dynamically loads or references `.d.ts` files (e.g., for TypeScript language service integration), they would be missing.

**Root Cause**: The `.vscodeignore` was written assuming full bundling with no runtime TypeScript.

**Remediation**: Verify no runtime code path references `.d.ts` files. If safe, add a comment explaining the exclusion:
```
# ── Build artifacts ── (safe: esbuild bundles all TS into extension.js)
**/*.d.ts
```

**Tradeoffs**: None if confirmed safe.  
**Tests**: Package the VSIX and verify the extension activates correctly.

---

### C-5: `exactOptionalPropertyTypes` in tsconfig May Cause Issues with Third-Party Types

**Severity**: Medium  
**File**: `tsconfig.json` (line 23)

**Issue**: `exactOptionalPropertyTypes: true` enforces that optional properties can only be assigned `undefined` explicitly (not omitted). This is a strict and relatively uncommon setting that can cause friction with third-party library types that don't account for it. For example, `{ foo?: string }` means `foo` can only be `string | undefined`, not omitted entirely.

**Root Cause**: This flag was likely enabled as part of a strictness push.

**Remediation**: Keep the flag but document it in the contributing guide. If frequent type errors arise from third-party interfaces, consider disabling it or using targeted `@ts-expect-error` comments.

**Tradeoffs**: Strictness catches real bugs (accidental `undefined` assignment) but increases friction.  
**Tests**: `tsc --noEmit` confirms compatibility.

---

### C-6: No `engines.node` Field in `package.json`

**Severity**: Low  
**File**: `package.json`

**Issue**: The `package.json` specifies `engines.vscode >= 1.85.0` but doesn't specify a Node.js engine version. The esbuild config targets `node18`, and `.nvmrc` contains a Node version, but `package.json` itself doesn't enforce it. This can lead to CI or contributor environments using incompatible Node versions.

**Root Cause**: Missing field — likely an oversight.

**Remediation**: Add `"engines": { "node": ">=18.0.0" }` to `package.json`.

**Tradeoffs**: None.  
**Tests**: `npm install` on Node 16 should fail with an engine incompatibility warning.

---

## 3. Developer Experience

### DX-1: Folder Structure Inconsistency — `__tests__` vs Co-located Tests

**Severity**: Low

**Issue**: All test files follow the `__tests__/` convention (tests in a sibling `__tests__` directory), which is consistent throughout the project. However, the `jest.config.js` `testMatch` pattern (`**/__tests__/**/*.test.ts`) requires tests to be inside `__tests__` directories. If a developer creates a co-located `*.test.ts` file outside `__tests__`, it won't be discovered.

**Root Cause**: The `testMatch` pattern is restrictive by design.

**Remediation**: Document the convention in `CONTRIBUTING.md`. Optionally, add a CI check that verifies no `.test.ts` files exist outside `__tests__/` directories.

**Tradeoffs**: None.  
**Tests**: `find src -name '*.test.ts' -not -path '*__tests__*'` should return empty.

---

### DX-2: `npm run compile` Is Bundling — Not Type-Checking

**Severity**: Low  
**File**: `package.json` (line 335)

**Issue**: The `compile` script runs `node esbuild.js`, which bundles but doesn't type-check. Type-checking only happens during `npm run lint` (via `tsc --noEmit`). A developer running `npm run compile` might assume their code is type-safe, but esbuild doesn't do type checking.

**Root Cause**: esbuild is a bundler, not a type checker. This is by design but the naming is misleading.

**Remediation**: Either:
- Rename `compile` to `bundle` for clarity.
- Or add `"compile": "tsc --noEmit && node esbuild.js"` to include type-checking.

**Tradeoffs**: Adding `tsc` to `compile` slows it down but ensures type safety.  
**Tests**: `npm run compile` should succeed after the change.

---

### DX-3: No Watch Mode for Tests

**Severity**: Low  
**File**: `package.json`

**Issue**: There's `npm run watch` for esbuild but no `test:watch` script for Jest watch mode. Developers iterating on tests must manually re-run `npm test`.

**Root Cause**: Missing convenience script.

**Remediation**: Add `"test:watch": "jest --watch --runInBand"` to scripts.

**Tradeoffs**: None.  
**Tests**: `npm run test:watch` should enter interactive watch mode.

---

## 4. Module Reviews

### 4.1 Evaluators

#### E-1: `ExitCodeEvaluator` — Misleading `retryPrompt` on Empty stderr

**Severity**: Low  
**File**: `src/evaluators/ExitCodeEvaluator.ts` (line 43)

**Issue**: The expression `stderr.slice(-4096) ? { retryPrompt: ... } : {}` will produce a `retryPrompt` of an empty string when `stderr` is empty (since `"".slice(-4096)` returns `""`). However, `""` is falsy, so this actually works correctly. But the logic is confusing — a reader might expect the truthy check to fail on empty string, and it does, but only by accident.

**Root Cause**: The conditional spread relies on JavaScript's falsy evaluation of empty strings.

**Remediation**: Make the intent explicit:
```ts
...(stderr.length > 0 ? { retryPrompt: stderr.slice(-4096) } : {}),
```

**Tradeoffs**: Purely readability; no behavior change.  
**Tests**: Existing `EvaluatorV2.test.ts` should cover this.

---

#### E-2: `RegexEvaluator` — User-Controlled Regex Without ReDoS Protection

**Severity**: High  
**File**: `src/evaluators/RegexEvaluator.ts` (lines 34, 68)

**Issue**: The regex pattern comes directly from `phase.success_criteria` (user/runbook-controlled input) and is compiled with `new RegExp(pattern)`. Malicious or poorly constructed patterns can cause catastrophic backtracking (ReDoS), freezing the evaluator thread.

**Root Cause**: No input validation or timeout on regex evaluation.

**Remediation**:
1. Add a regex complexity check (e.g., reject patterns with nested quantifiers like `(a+)+`).
2. Or run the regex in a Worker thread with a timeout.
3. At minimum, wrap the `exec()` call in a `setTimeout`/`Promise.race` pattern:
```ts
const result = await Promise.race([
    new Promise<RegExpExecArray | null>(resolve => resolve(regex.exec(combined))),
    new Promise<null>((_, reject) => setTimeout(() => reject(new Error('Regex timeout')), 5000)),
]);
```

**Tradeoffs**: Timeout adds async complexity; complexity checking may reject legitimate patterns.  
**Tests**: Add a test with a known ReDoS pattern to verify protection.

---

#### E-3: `ToolchainEvaluator` — `npx --no-install` Flag Injection Is Fragile

**Severity**: Medium  
**File**: `src/evaluators/ToolchainEvaluator.ts` (lines 83-85)

**Issue**: When `binary === 'npx'`, the code uses `args.unshift('--no-install')` to prevent arbitrary package downloads. However, `args` is derived from `parts.slice(1)` which was split from the user-provided command. The `args` array is a local copy, but `unshift` mutates it in-place, which is correct. The real issue is that this check only applies to `ToolchainEvaluator` — the `TestSuiteEvaluator` does NOT have this protection.

**Root Cause**: Security hardening was applied to `ToolchainEvaluator` but not mirrored to `TestSuiteEvaluator`, even though both share the same `TOOLCHAIN_WHITELIST`.

**Remediation**: Extract the `npx --no-install` enforcement into a shared function in `constants.ts` and apply it in both evaluators:
```ts
export function sanitizeArgs(binary: string, args: string[]): string[] {
    if (binary === 'npx' && !args.includes('--no-install')) {
        return ['--no-install', ...args];
    }
    return args;
}
```

**Tradeoffs**: Minimal; shared logic reduces duplication.  
**Tests**: Add test cases for `npx` commands in both evaluators verifying `--no-install` is present.

---

#### E-4: `TestSuiteEvaluator` — `FAIL ` Pattern May False-Positive

**Severity**: Medium  
**File**: `src/evaluators/TestSuiteEvaluator.ts` (lines 19-26)

**Issue**: The `FAILURE_PATTERNS` include `/FAIL\s/` which matches "FAIL " (with a trailing space). This can false-positive on output containing "FAILOVER", "FAILED TO" or similar strings that aren't actual test failures. The pattern `/FAILED\s/` has the same issue.

**Root Cause**: The patterns are intentionally loose to catch multiple frameworks, but this trades precision for recall.

**Remediation**: 
- Use word-boundary anchors: `/\bFAIL\b/`
- Or anchor to line start: `/^FAIL\s/m`
- Or only trigger failure pattern check when exit code is 0 (the code already does this — line 100 — but the comment says "even if exit code is 0", which is the correct behavior).

**Tradeoffs**: More restrictive patterns may miss some framework outputs.  
**Tests**: Add test cases with "FAILOVER" and "FAIL " in output to verify correct behavior.

---

#### E-5: `EvaluatorRegistry` — No Extensibility for Custom Evaluators

**Severity**: Low  
**File**: `src/evaluators/EvaluatorRegistry.ts` (lines 19-24)

**Issue**: The registry hardcodes all evaluator instances in the constructor. There's no `register()` method to add custom evaluators at runtime, which limits extensibility.

**Root Cause**: The evaluator set was designed as a closed set. The `EvaluatorType` union type in `types/index.ts` is also likely a closed union.

**Remediation**: Add a `register(type: string, evaluator: IEvaluator)` method. This prepares for future community evaluators or plugin evaluators.

**Tradeoffs**: Additional API surface; needs validation to prevent overwriting built-in evaluators.  
**Tests**: Test that custom evaluators can be registered and retrieved.

---

### 4.2 Git

#### G-1: `GitManager.gitExec` Re-imports `child_process` on Every Call

**Severity**: Medium  
**File**: `src/git/GitManager.ts` (lines 221-223)

**Issue**: Both `gitExec` and `resolveGitRoot` use dynamic `import()` for `node:child_process` and `node:util` on every invocation. This is wasteful and creates testing friction (cannot use `jest.mock()` at the module level).

**Root Cause**: Dynamic imports were likely added to match an ESM pattern, but the extension bundles as CJS via esbuild. Static imports work fine.

**Remediation**: Move to top-level static imports:
```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
```

**Tradeoffs**: None — Node built-ins are zero-cost to import statically.  
**Tests**: `GitManager.test.ts` should mock `node:child_process` at the module level.

---

#### G-2: `GitManager.rollback` Runs `git clean -fd` — Potential Data Loss

**Severity**: High  
**File**: `src/git/GitManager.ts` (lines 67-88)

**Issue**: `rollback()` runs `git reset --hard HEAD` followed by `git clean -fd`, which deletes ALL untracked files. The dry-run at line 72-74 logs what will be cleaned but doesn't ask for user confirmation. If a developer has untracked files (e.g., local configs, notes, WIP files), they will be permanently deleted.

**Root Cause**: The method was designed for automated cleanup in CI-like scenarios, but it's also callable from the VS Code extension UI.

**Remediation**:
1. Remove `-fd` from the default `rollback()` and only do `git reset --hard HEAD`.
2. Add a separate `rollbackWithClean()` method that includes the `git clean` step.
3. OR add a confirmation flow in the calling code (Engine/SelfHealingController) that presents the dry-run output to the user before proceeding.

**Tradeoffs**: Without `git clean`, new files created by the AI worker during a failed phase will remain.  
**Tests**: Verify that `rollback()` without `git clean` resets tracked changes but preserves untracked files.

---

#### G-3: `GitSandboxManager` — Duplicated Git Extension API Acquisition

**Severity**: Medium  
**File**: `src/git/GitSandboxManager.ts` (lines 111-140, 149-176)

**Issue**: `getGitAPI()` and `getAllRepositories()` both independently acquire the Git extension, check `isActive`, and call `getAPI(1)`. This is duplicated logic (~20 lines) that should be factored out.

**Root Cause**: The two methods serve different consumers (single-repo vs multi-repo) but share identical bootstrap logic.

**Remediation**: Extract the shared logic:
```ts
private getApi(): GitAPI {
    const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!gitExtension) throw new Error('...');
    if (!gitExtension.isActive) throw new Error('...');
    return gitExtension.exports.getAPI(1);
}
```
Then `getGitAPI()` calls `getApi()` + `findBestRepository()`, and `getAllRepositories()` calls `getApi()` + validates `repositories.length`.

**Tradeoffs**: Small refactor; reduces ~15 lines of duplication.  
**Tests**: Existing tests should pass unchanged.

---

#### G-4: `GitSandboxManager` — Branch Name Sanitization Is Duplicated

**Severity**: Medium  
**File**: `src/git/GitSandboxManager.ts` (lines 290-296, 491-496)

**Issue**: The branch name sanitization logic (slug → lowercase, strip special chars, collapse hyphens) is duplicated between `createSandboxBranch` and `createSandboxBranchAll`. This is a DRY violation.

**Root Cause**: Copy-paste from single-repo to multi-repo implementation.

**Remediation**: Extract into a private method:
```ts
private sanitizeBranchName(options: SandboxOptions): string {
    const prefix = options.branchPrefix ?? '';
    const slug = options.taskSlug
        .replace(/\s+/g, '-')
        .replace(/[^a-zA-Z0-9\-/]/g, '')
        .replace(/-{2,}/g, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase();
    return `${prefix}${slug}`;
}
```

**Tradeoffs**: None.  
**Tests**: Add a test for the extracted sanitization method with edge cases (empty slug, special chars, consecutive hyphens).

---

### 4.3 Logger

#### L-1: `LogStream` — Synchronous File Operations in Constructor

**Severity**: Medium  
**File**: `src/logger/LogStream.ts` (lines 89-106)

**Issue**: The constructor calls `fs.mkdirSync`, `fs.statSync` (via `rotate()`), and `fs.createWriteStream` — all synchronous file I/O. This blocks the extension's activation path. If the workspace root is on a slow network mount, activation could hang.

**Root Cause**: The logger was designed to be available synchronously from `activate()`, requiring sync I/O.

**Remediation**: Consider a two-phase init:
1. Constructor stores config but doesn't touch the filesystem.
2. A lazy `ensureStream()` method creates the stream on first write.

```ts
private ensureStream(): boolean {
    if (this.stream) return true;
    // ... sync I/O here, but only on first write
}
```

**Tradeoffs**: Adds complexity; first log write becomes slightly slower. But activation is no longer blocked by I/O.  
**Tests**: Verify that `new LogStream(...)` completes without file I/O and that the first `log.info()` creates the file.

---

#### L-2: `log.ts` Proxy Silently Drops Messages Before `initLog()`

**Severity**: Low  
**File**: `src/logger/log.ts` (lines 37-50)

**Issue**: The `log` proxy object uses optional chaining (`_instance?.info(...)`) which silently drops all log calls before `initLog()` is called. This means early startup errors or diagnostics during extension activation are lost.

**Root Cause**: The proxy was designed to be safe to call at any time, prioritizing no-crash over no-data-loss.

**Remediation**: Buffer early messages in an array and flush them once `initLog()` is called:
```ts
const earlyBuffer: Array<{ level: string; args: unknown[] }> = [];

export function initLog(workspaceRoot: string, options?: LogStreamOptions): LogStream {
    _instance = new LogStream(workspaceRoot, options);
    for (const { level, args } of earlyBuffer) {
        (_instance as any)[level]?.(...args);
    }
    earlyBuffer.length = 0;
    return _instance;
}
```

**Tradeoffs**: Memory usage for buffered messages; needs a cap to prevent unbounded growth.  
**Tests**: Log messages before `initLog()`, then initialize and verify they appear in the log file.

---

#### L-3: `TelemetryLogger` — Unbounded Phase Log File Growth

**Severity**: Medium  
**File**: `src/logger/TelemetryLogger.ts` (lines 159-176)

**Issue**: `logPhaseOutput` appends every stdout/stderr chunk to a per-phase JSONL file without any size limit. A phase that produces megabytes of output (e.g., npm install, large test suite) will create an equally large log file. The `data.chunk` field stores the full `sanitizedChunk`, not just the truncated 200-char message.

**Root Cause**: The telemetry logger was designed for completeness over efficiency.

**Remediation**: Cap the total file size per phase (e.g., 5 MB) and stop appending once the cap is reached:
```ts
private phaseSizes = new Map<number, number>();

private async appendPhaseEntry(phaseId: number, entry: LogEntry): Promise<void> {
    const currentSize = this.phaseSizes.get(phaseId) ?? 0;
    if (currentSize > 5 * 1024 * 1024) return; // skip
    const line = JSON.stringify(entry) + '\n';
    this.phaseSizes.set(phaseId, currentSize + line.length);
    await this.appendEntry(`phase-${phaseId}.jsonl`, entry);
}
```

**Tradeoffs**: Truncated logs lose late-phase output. Consider logging a "truncated" marker.  
**Tests**: Write a test that appends > 5 MB of output and verifies the file doesn't exceed the cap.

---

#### L-4: `ErrorCodes.ts` — Dual Error Systems (Enum + String Constants)

**Severity**: Medium  
**File**: `src/logger/ErrorCodes.ts` (lines 14-116)

**Issue**: The file defines two parallel error systems:
1. `ErrorCode` enum (lines 14-80) — for structured error codes.
2. String constants (lines 87-104) — `BoundaryErrorCode` type for JSONL logs.

These two systems overlap conceptually but aren't unified. The `ErrorCode` enum values are strings but aren't used in the `BoundaryErrorCode` union, and vice versa. Code using error codes must choose which system to use.

**Root Cause**: The boundary error codes were added later (P2.2) as a separate concern from the original `ErrorCode` enum.

**Remediation**: Merge into a single system. Either:
- Extend the `ErrorCode` enum to include boundary codes.
- Or convert everything to string constants with a single union type.

**Tradeoffs**: Large refactor if many callsites depend on the enum's runtime behavior.  
**Tests**: Verify all error code references compile after unification.

---

#### L-5: `TelemetryLogger.logBoundaryEvent` Hardcodes Level to `'warn'`

**Severity**: Low  
**File**: `src/logger/TelemetryLogger.ts` (line 289)

**Issue**: The `logBoundaryEvent` method always uses `level: 'warn'` regardless of the error code. Some boundary events are diagnostic (e.g., `ERR_STORAGE_SOURCE_SELECTION`) and should be `'info'`, while others (e.g., `ERR_MCP_PATH_TRAVERSAL_BLOCKED`) should be `'error'`.

**Root Cause**: The level was set to a safe default during initial implementation.

**Remediation**: Derive the level from the error code prefix or add a severity parameter:
```ts
async logBoundaryEvent(
    code: BoundaryErrorCode,
    context: Record<string, unknown>,
    severity?: LogEntry['level'],
): Promise<void> {
    const level = severity ?? (code.includes('FAILED') || code.includes('BLOCKED') ? 'error' : 'warn');
    // ...
}
```

**Tradeoffs**: Changes the method signature; callers need updating.  
**Tests**: Verify that `ERR_MCP_PATH_TRAVERSAL_BLOCKED` logs as `'error'`.

---

### 4.4 Consolidation

#### CO-1: `ConsolidationAgent.saveReport` — Fire-and-Forget File Write

**Severity**: Medium  
**File**: `src/consolidation/ConsolidationAgent.ts` (lines 281-283)

**Issue**: The debug clone write at lines 281-283 uses a fire-and-forget promise chain (`fs.mkdir(...).then(...).catch(...)`). This means:
1. The `saveReport` method returns before the debug file is written.
2. If the extension deactivates before the write completes, the file may be corrupted or missing.
3. The error is caught and logged but the caller has no way to know the write failed.

**Root Cause**: The write was intentionally non-blocking to avoid slowing down report submission.

**Remediation**: Use `await` for the write but with a timeout so it doesn't block indefinitely:
```ts
try {
    await Promise.race([
        this.writeDebugClone(debugDir, markdown),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
    ]);
} catch (err) {
    log.warn('[ConsolidationAgent] Debug clone failed (non-fatal):', err);
}
```

**Tradeoffs**: Slightly slower `saveReport` completion.  
**Tests**: Mock `fs.mkdir` to be slow and verify the timeout works.

---

#### CO-2: `ConsolidationAgent.generateReport` — Phase Status Counting Logic Is Error-Prone

**Severity**: Medium  
**File**: `src/consolidation/ConsolidationAgent.ts` (lines 96-112)

**Issue**: When a handoff is found, the code counts phases by status (`completed`, `failed`, other → skipped). But when no handoff is found (lines 103-112), the phase is always counted as `skippedPhases++` regardless of its actual status. A phase with `status: 'completed'` but no handoff file would be counted as skipped, which is incorrect.

**Root Cause**: The absence of a handoff is used as a heuristic for "not executed", but `phase.status` is authoritative.

**Remediation**: Always use `phase.status` for counting, regardless of handoff availability:
```ts
if (phase.status === 'completed') successfulPhases++;
else if (phase.status === 'failed') failedPhases++;
else skippedPhases++;
```

**Tradeoffs**: None.  
**Tests**: Test with a phase that has `status: 'completed'` but no handoff — verify it counts as successful.

---

#### CO-3: `ConsolidationAgent.loadHandoffFromMCP` — Brittle Phase ID Parsing

**Severity**: Medium  
**File**: `src/consolidation/ConsolidationAgent.ts` (line 319)

**Issue**: The numeric phase ID is extracted with `parseInt(mcpPhaseId.replace(/^phase-/, '').split('-')[0], 10)`. This assumes the format `phase-NNN-<uuid>` and breaks silently (returning `NaN` → fallback 0) if the format changes. For example, `phase-alpha-uuid` would produce `NaN`.

**Root Cause**: Fragile string parsing instead of using a structured ID format.

**Remediation**: 
1. Add a named regex with validation:
```ts
const match = mcpPhaseId.match(/^phase-(\d+)/);
const numericId = match ? parseInt(match[1], 10) : 0;
```
2. Log a warning when parsing fails so the issue is visible.

**Tradeoffs**: None.  
**Tests**: Test with malformed phase IDs.

---

### 4.5 Prompt-Compiler

#### PC-1: `PlannerPromptCompiler` — Creates New Instances of Sub-Components on Every `compile()` Call

**Severity**: Medium  
**File**: `src/prompt-compiler/PlannerPromptCompiler.ts` (lines 103-124)

**Issue**: Every call to `compile()` creates new instances of `RequirementNormalizer`, `TaskClassifier`, `TemplateLoader`, and `PolicyEngine`. These are stateless objects, so creating them is wasteful. The `RepoFingerprint` is cached (line 81), but the rest aren't.

**Root Cause**: The pipeline was designed for clarity (each step creates its own component) rather than performance.

**Remediation**: Cache all stateless components as instance fields:
```ts
private readonly normalizer = new RequirementNormalizer();
private readonly classifier = new TaskClassifier();
private readonly templateLoader = new TemplateLoader();
private readonly policyEngine = new PolicyEngine();
```

**Tradeoffs**: Marginal memory increase (trivial — these are small objects).  
**Tests**: Existing tests should pass unchanged.

---

#### PC-2: `PlannerPromptCompiler.hashFingerprint` — djb2 Hash Has High Collision Rate

**Severity**: Low  
**File**: `src/prompt-compiler/PlannerPromptCompiler.ts` (lines 343-350)

**Issue**: The `hashFingerprint` method uses a simple djb2 hash that produces a 32-bit hash (8 hex chars). For fingerprint comparisons, this has a non-trivial collision probability, especially if used for cache invalidation.

**Root Cause**: A simple hash was chosen over importing a crypto library to keep the module lightweight.

**Remediation**: Use a FNV-1a hash (same speed, better distribution) or use Node's built-in `createHash('md5')` since it's available:
```ts
import { createHash } from 'node:crypto';
return createHash('md5').update(JSON.stringify(fingerprint)).digest('hex').slice(0, 16);
```

**Tradeoffs**: `crypto` module import adds ~0 overhead (Node built-in). MD5 is not security-sensitive here.  
**Tests**: Verify different fingerprints produce different hashes.

---

#### PC-3: `RequirementNormalizer` — `KNOWN_INPUT_RE` Global Regex Has Shared State

**Severity**: Medium  
**File**: `src/prompt-compiler/RequirementNormalizer.ts` (lines 60, 216)

**Issue**: `KNOWN_INPUT_RE` is a module-level `RegExp` with the `/g` flag. The `extractKnownInputs` method resets `lastIndex` at line 216, which is correct. However, if any other code in the module or in tests calls `KNOWN_INPUT_RE.test()` or `.exec()` without resetting, it would fail on every other call due to shared state.

**Root Cause**: Module-level regex with `/g` flag is a well-known JavaScript anti-pattern because the regex object retains stateful `lastIndex`.

**Remediation**: Create the regex inside the method:
```ts
private extractKnownInputs(text: string): string[] {
    const re = /`([^`]+)`|"([^"]+)"/g;
    // ...
}
```

**Tradeoffs**: Creates a new regex per call, but this is negligible.  
**Tests**: Call `extractKnownInputs` twice in a row with different inputs and verify correct results.

---

#### PC-4: `TaskClassifier` — `review_only` Family Can Never Win Due to Priority Order

**Severity**: Medium  
**File**: `src/prompt-compiler/TaskClassifier.ts` (lines 37-39)

**Issue**: The `review_only` family has keywords `['review', 'code review', 'check', 'inspect']`. The keyword `'review'` also appears implicitly in `repo_analysis`'s `'review codebase'`. More critically, `'check'` is extremely common in prompts (e.g., "check the database connection", "check this file"), meaning `review_only` would score high on many non-review prompts.

However, since `review_only` is last in the priority order, it can only win if no higher-priority family scores at all, AND `review_only` scores > 0. In practice, `feature_implementation` keywords (`'add'`, `'create'`, `'build'`) are so common that `review_only` almost never wins.

**Root Cause**: The classification system uses simple keyword counting with a fixed priority order.

**Remediation**: 
1. Add more discriminative keywords to `review_only` (e.g., `'peer review'`, `'review my code'`, `'review this PR'`).
2. Remove the overly generic `'check'` keyword.
3. Consider giving `review_only` a bonus multiplier to counteract the priority disadvantage.

**Tradeoffs**: Any change to classification affects downstream template selection.  
**Tests**: Add tests with prompts like "review this PR" and verify `review_only` is selected.

---

#### PC-5: `RepoFingerprinter.profileSubproject` — Mutates Shared State

**Severity**: High  
**File**: `src/prompt-compiler/RepoFingerprinter.ts` (lines 297-329)

**Issue**: `profileSubproject` temporarily overwrites `this.effectiveRoot` (line 306), creates a new `TechStackDetector` (line 307), and then restores the original value (line 317). This is not thread-safe — if `fingerprint()` is called concurrently (e.g., in a multi-command scenario), the temporary state mutation could cause one call to read another call's effective root.

**Root Cause**: The method was designed assuming serial execution, which is true in the current code. But the pattern is fragile and violates encapsulation.

**Remediation**: Don't mutate `this.effectiveRoot`. Instead, pass the child URI explicitly to a standalone `TechStackDetector`:
```ts
private async profileSubproject(childUri: vscode.Uri, name: string): Promise<SubprojectProfile> {
    const scopedReader: FileReader = {
        readFileQuietly: async (relativePath) => {
            /* read from childUri */
        },
        fileExists: async (relativePath) => { /* ... */ },
        hasFileMatching: async (pattern) => { /* ... */ },
    };
    const detector = new TechStackDetector(scopedReader);
    // ...
}
```

**Tradeoffs**: More code but eliminates shared mutable state.  
**Tests**: Call `fingerprint()` concurrently and verify correct results for each subproject.

---

#### PC-6: `PolicyEngine` — No Extension Points for Custom Policies

**Severity**: Low  
**File**: `src/prompt-compiler/PolicyEngine.ts` (lines 200-206)

**Issue**: The `PolicyEngine` constructor creates built-in policies with no way to register custom policies. The `policies` field is `readonly` but it's an array, so elements could technically be pushed to it externally (TypeScript wouldn't prevent `engine.policies.push(...)` since `readonly` on the field doesn't make the array immutable).

**Root Cause**: The engine was designed as a closed system with only built-in policies.

**Remediation**: Add a `register(policy: PolicyModule)` method and make the array properly immutable:
```ts
private readonly _policies: PolicyModule[];
get policies(): readonly PolicyModule[] { return this._policies; }

register(policy: PolicyModule): void {
    this._policies.push(policy);
}
```

**Tradeoffs**: Additional API surface.  
**Tests**: Test that custom policies are evaluated in order after built-ins.

---

### 4.6 Utils

#### U-1: `WorkspaceHelper.resolveFileAcrossRoots` — Uses `fs.existsSync` (Blocking I/O)

**Severity**: Low  
**File**: `src/utils/WorkspaceHelper.ts` (line 100)

**Issue**: `resolveFileAcrossRoots` uses `fs.existsSync` for each root, which is synchronous I/O. For multi-root workspaces with network mounts, this could block the extension host.

**Root Cause**: The function was designed to be synchronous for simplicity and determinism.

**Remediation**: Provide an async variant:
```ts
export async function resolveFileAcrossRootsAsync(
    relativePath: string,
    roots: string[],
): Promise<FileResolutionResult> {
    const checks = await Promise.all(
        roots.map(async root => ({
            root,
            exists: await fs.promises.access(path.join(root, relativePath)).then(() => true, () => false),
        })),
    );
    // ...
}
```

**Tradeoffs**: Async version requires callers to be async; keep the sync version for unit tests.  
**Tests**: Both sync and async variants should produce the same results.

---

#### U-2: `planMarkdown.ts` — Timestamp Is Non-Deterministic

**Severity**: Low  
**File**: `src/utils/planMarkdown.ts` (line 55)

**Issue**: `new Date().toISOString()` is called inside `buildImplementationPlanMarkdown`, making the output non-deterministic. Tests would need to mock `Date` or use snapshot testing with a timestamp matcher.

**Root Cause**: Convenience over testability.

**Remediation**: Accept an optional `generatedAt` parameter:
```ts
export function buildImplementationPlanMarkdown(draft: { ... }, options?: { generatedAt?: string }): string {
    const ts = options?.generatedAt ?? new Date().toISOString();
    // ...
}
```

**Tradeoffs**: API change; existing callers unaffected (optional param).  
**Tests**: Pass a fixed timestamp in tests and assert exact output.

---

#### U-3: `planMarkdown.ts` — Prompt Truncation at 80 Chars May Cut Mid-Word

**Severity**: Low  
**File**: `src/utils/planMarkdown.ts` (line 49)

**Issue**: `phase.prompt.slice(0, 80)` truncates at exactly 80 characters, which may cut in the middle of a word or markdown syntax.

**Root Cause**: Simple truncation without word-boundary awareness.

**Remediation**: Truncate at the last space before 80 chars and append `…`:
```ts
const truncated = prompt.length > 80 
    ? prompt.slice(0, prompt.lastIndexOf(' ', 80)) + '…' 
    : prompt;
```

**Tradeoffs**: Minor complexity; edge case if no space exists in first 80 chars.  
**Tests**: Test with a long prompt and verify clean truncation.

---

## 5. Cross-Cutting Concerns

### XC-1: Evaluators and Git Modules Both Shell Out — Inconsistent Approach

**Severity**: Medium

**Issue**: `GitManager` uses `execFile` directly (via dynamic import), while the evaluators (`ToolchainEvaluator`, `TestSuiteEvaluator`) also use `execFile` but import it statically and share constants (`TOOLCHAIN_WHITELIST`). `GitSandboxManager` uses zero shell commands (VS Code Git API only). These three approaches to the same problem (running external processes) are inconsistent.

**Remediation**: Create a shared `ShellRunner` utility that:
1. Wraps `execFile` with consistent timeout, maxBuffer, and error handling.
2. Enforces the whitelist for untrusted inputs.
3. Logs all command executions via `TelemetryLogger`.

**Tradeoffs**: Large refactor touching multiple modules.  
**Tests**: Integration tests verifying `ShellRunner` with various binaries.

---

### XC-2: No Input Validation at Module Boundaries

**Severity**: High

**Issue**: Across all reviewed modules, function parameters are not validated at entry points:
- `EvaluatorRegistry.getEvaluator(type)` silently defaults to `exit_code` on unknown types.
- `GitManager.rollbackToCommit(commitHash)` accepts any string without regex validation.
- `TelemetryLogger.initRun(runId)` creates directories from unvalidated strings.
- `ConsolidationAgent.generateReport()` casts `phase.id as number` without validation.

**Root Cause**: The codebase relies on TypeScript types for correctness, but runtime inputs (from JSON, user input, or MCP) may not match compile-time types.

**Remediation**: Add Zod or manual validation at module boundaries:
```ts
// Example for rollbackToCommit
const GIT_HASH_RE = /^[a-f0-9]{4,40}$/i;
if (!GIT_HASH_RE.test(commitHash)) {
    return { success: false, message: `Invalid commit hash: ${commitHash}` };
}
```

**Tradeoffs**: Validation adds code and complexity. Use Zod for consistency (already a dependency).  
**Tests**: Test each boundary with invalid inputs.

---

## 6. Summary & Priority Matrix

| ID | Severity | Module | Issue | Effort |
|----|----------|--------|-------|--------|
| E-2 | **Critical** | Evaluators | ReDoS in RegexEvaluator | Medium |
| G-2 | **High** | Git | `git clean -fd` potential data loss | Low |
| PC-5 | **High** | Prompt-Compiler | Shared mutable state in RepoFingerprinter | Medium |
| XC-2 | **High** | Cross-Cutting | No input validation at module boundaries | High |
| T-3 | **High** | Testing | `--forceExit` masks resource leaks | High |
| E-3 | **Medium** | Evaluators | `npx --no-install` not in TestSuiteEvaluator | Low |
| E-4 | **Medium** | Evaluators | False-positive failure patterns | Low |
| G-1 | **Medium** | Git | Dynamic import per gitExec call | Low |
| G-3 | **Medium** | Git | Duplicated Git API acquisition | Low |
| G-4 | **Medium** | Git | Duplicated branch name sanitization | Low |
| L-1 | **Medium** | Logger | Sync I/O in LogStream constructor | Medium |
| L-3 | **Medium** | Logger | Unbounded phase log file growth | Low |
| L-4 | **Medium** | Logger | Dual error code systems | Medium |
| CO-1 | **Medium** | Consolidation | Fire-and-forget file write | Low |
| CO-2 | **Medium** | Consolidation | Phase status counting logic | Low |
| CO-3 | **Medium** | Consolidation | Brittle phase ID parsing | Low |
| PC-1 | **Medium** | Prompt-Compiler | Re-creates stateless components per call | Low |
| PC-3 | **Medium** | Prompt-Compiler | Module-level regex with shared state | Low |
| PC-4 | **Medium** | Prompt-Compiler | review_only can never win classification | Low |
| C-1 | **Medium** | Config | esbuild/tsconfig target mismatch docs | Low |
| C-2 | **Medium** | Config | ESLint warning cap drift | Low |
| C-5 | **Medium** | Config | exactOptionalPropertyTypes friction | Low |
| T-1 | **Medium** | Testing | Global coverage thresholds mask gaps | Low |
| T-4 | **Medium** | Testing | No evaluator→engine integration tests | Medium |
| T-6 | **Medium** | Testing | GitManager dynamic imports block mocking | Low |
| XC-1 | **Medium** | Cross-Cutting | Inconsistent shell-out approaches | High |
| T-2 | **Low** | Testing | WASM copy without cleanup | Low |
| T-5 | **Low** | Testing | mdTransform CJS/ESM inconsistency | Low |
| T-7 | **Low** | Testing | pretest double-lints in CI | Low |
| C-3 | **Low** | Config | JS config files unlinted | Low |
| C-4 | **Low** | Config | .vscodeignore excludes all .d.ts | Low |
| C-6 | **Low** | Config | Missing engines.node field | Low |
| DX-1 | **Low** | DX | testMatch restricts to __tests__ | Low |
| DX-2 | **Low** | DX | compile ≠ type-check confusion | Low |
| DX-3 | **Low** | DX | No test:watch script | Low |
| E-1 | **Low** | Evaluators | Misleading retryPrompt conditional | Low |
| E-5 | **Low** | Evaluators | No custom evaluator extensibility | Medium |
| L-2 | **Low** | Logger | Silent message drops before initLog | Low |
| L-5 | **Low** | Logger | Hardcoded warn level in boundary events | Low |
| PC-2 | **Low** | Prompt-Compiler | djb2 hash collision rate | Low |
| PC-6 | **Low** | Prompt-Compiler | No custom policy extension point | Low |
| U-1 | **Low** | Utils | Sync fs.existsSync in resolveFile | Low |
| U-2 | **Low** | Utils | Non-deterministic timestamp | Low |
| U-3 | **Low** | Utils | Prompt truncation mid-word | Low |

### Recommended Priority Order

1. **E-2** (ReDoS): Security vulnerability. Fix first.
2. **G-2** (git clean data loss): User data loss risk.
3. **PC-5** (Shared mutable state): Correctness bug under concurrency.
4. **T-3** (forceExit): Technical debt that masks real issues.
5. **XC-2** (Input validation): Defense-in-depth for all module boundaries.
6. **E-3 + E-4** (Evaluator security/correctness): Quick wins.
7. **G-1 + G-3 + G-4** (Git cleanup): Quick refactors.
8. **CO-2 + CO-3** (Consolidation correctness): Quick fixes.
9. **PC-1 + PC-3 + PC-4** (Prompt-compiler cleanup): Quick wins.
10. Everything else as time allows.

---

```json
{
  "decisions": [
    "Reviewed all 30 files covering testing infrastructure, tooling configuration, and 6 module groups",
    "Identified 42 issues across testing (7), configuration (6), developer experience (3), evaluators (5), git (4), logger (5), consolidation (3), prompt-compiler (6), utils (3), and cross-cutting concerns (2)",
    "Classified severity as: 1 critical, 4 high, 20 medium, 17 low",
    "Prioritized ReDoS vulnerability (E-2) as the most urgent fix",
    "Identified git clean data loss (G-2) and shared mutable state (PC-5) as high-severity correctness issues",
    "Noted that --forceExit in test scripts masks resource leaks that should be fixed before increasing test parallelism",
    "Noted the file `PromptCompiler.ts` referenced in context doesn't exist — actual file is `PlannerPromptCompiler.ts`"
  ],
  "modified_files": [
    "review-part5-testing-tooling.md"
  ],
  "unresolved_issues": [
    "Could not read MCP resource (coogent-mcp-bridge server not available) — implementation plan context was not used",
    "Test coverage actual percentages were not measured — would require running `jest --coverage` to validate thresholds",
    "Some test files for reviewed modules (e.g., EvaluatorV2.test.ts, GitManager.test.ts) were identified but not fully read for detailed test quality assessment",
    "The webview-ui testing (Vitest) was not reviewed as it was out of scope"
  ],
  "next_steps_context": "This is the final Phase 5 review. Combined with phases 1-4, the full review covers: architecture & dead code (part 1), engine & orchestration (part 2), MCP & storage (part 3), ADK & context & planner & state & session (part 4), and testing & tooling & supporting modules (part 5). Key cross-phase themes are: ReDoS vulnerability in RegexEvaluator, multiple resource leak issues masking test reliability, inconsistent shell-out patterns, missing boundary validation across all modules, and dual error code systems that should be unified. The recommended refactoring priority starts with security fixes (ReDoS, git clean), then correctness (shared state, phase counting), then test infrastructure (fixing forceExit), then code health (deduplication, validation)."
}
```
