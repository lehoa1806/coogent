# Baseline Health Snapshot

> **Generated**: 2026-03-12T09:51 (ICT)
> **Project**: Coogent VS Code Extension (`coogent/`)

---

## 1. Jest Test Suite

**Command**: `npx jest --runInBand --detectOpenHandles --forceExit`

| Metric        | Value   |
|---------------|---------|
| **Status**    | ✅ PASS  |
| **Exit Code** | 0       |
| **Test Suites** | 88 passed, 88 total |
| **Tests**       | 1060 passed, 1060 total |
| **Snapshots**   | 0 total |
| **Duration**    | ~10.1 s |
| **Failures**    | 0 |

### Warnings

- **ts-jest hybrid module warning** (TS151002): `Using hybrid module kind (Node16/18/Next) is only supported in "isolatedModules: true"`. Emitted 4 times. Non-blocking; suppressed by setting `diagnostics.ignoreCodes` in ts-jest config.
- **3 open handles detected**: All in `handleMCPFetchResource.test.ts` — `setTimeout` in `messageRouter.ts:437` not cleared after test completion. Non-blocking due to `--forceExit`.

---

## 2. TypeScript Type Checking

**Command**: `npx tsc --noEmit`

| Metric        | Value   |
|---------------|---------|
| **Status**    | ✅ PASS  |
| **Exit Code** | 0       |
| **Errors**    | 0 |
| **Warnings**  | 0 |

No type errors detected. The project compiles cleanly with `strict: true`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, and `exactOptionalPropertyTypes` enabled.

---

## 3. ESLint

**Command**: `npx eslint src/ --max-warnings=50`

| Metric        | Value   |
|---------------|---------|
| **Status**    | ✅ PASS  |
| **Exit Code** | 0       |
| **Errors**    | 0 |
| **Warnings**  | 0 (threshold: 50) |

No lint violations. All rules (`consistent-return: error`, `no-duplicate-imports: error`, `@typescript-eslint/no-unused-vars: warn`, `@typescript-eslint/no-explicit-any: warn`) pass cleanly.

---

## Summary

| Check        | Result | Issues |
|--------------|--------|--------|
| Jest         | ✅ PASS | 3 open handles (non-blocking), ts-jest warning |
| TypeScript   | ✅ PASS | None |
| ESLint       | ✅ PASS | None |

**Overall**: The project is in healthy baseline state. All 1060 tests pass, type checking is clean, and linting passes with zero warnings against a 50-warning threshold.

### Non-Blocking Issues to Track

1. **Open handles in `handleMCPFetchResource.test.ts`** — `setTimeout` timers not cleared. Recommend adding `clearTimeout` in test teardown or using `jest.useFakeTimers()`.
2. **ts-jest TS151002 warning** — Consider adding `isolatedModules: true` to tsconfig or suppressing via `diagnostics.ignoreCodes: [151002]` in jest config.
