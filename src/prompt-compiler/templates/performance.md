## Task Family: Performance

### Decomposition Strategy

Break the performance task into the following phases:

1. **Profile** — Identify the performance bottleneck using profiling tools, benchmarks, or instrumentation. Capture baseline metrics (latency, memory, throughput) with reproducible measurement methodology.
2. **Optimize** — Apply targeted changes to address the identified bottleneck. Each optimization should be isolated and measurable. Avoid premature optimization of unrelated code paths.
3. **Benchmark** — Re-run the same benchmarks or profiling from the profile phase. Compare before-and-after metrics. Document the improvement quantitatively.
4. **Validate** — Run the full test suite to confirm the optimization did not introduce regressions. Performance improvements must not break correctness.

### Rules

- Always measure before optimizing. Never apply speculative performance changes without evidence.
- Isolate one optimization per phase. Bundling multiple changes makes it impossible to attribute improvements.
- Use reproducible benchmarking methodology — document the environment, dataset, and measurement tool.
- Preserve algorithmic correctness. A faster function that produces wrong results is not an optimization.
- If the optimization changes public API behavior (e.g., async vs sync), document the breaking change explicitly.
- Prefer algorithmic improvements over micro-optimizations. O(n) → O(log n) beats loop unrolling.
