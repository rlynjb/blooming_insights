# 05 — Production serving for agents

Anchor: **single-agent + multi-agent (both)**

Three serving concerns that only show up once the unit of execution is an autonomous loop or a topology, not a single LLM call.

`.aipe/study-ai-engineering/` section 06 covers caching, cost, backpressure, and circuit-breaking for a *single LLM call*. This section does not re-teach those. It covers the three places where the single-call version is insufficient because the unit is now a loop or topology that issues many calls, often concurrently, often repeatedly against the same tool.

## Reading order

1. **[01-cross-turn-caching.md](./01-cross-turn-caching.md)** — prefix caching + intra-run memoization + cross-run semantic cache.
2. **[02-fan-out-backpressure.md](./02-fan-out-backpressure.md)** — concurrency cap + upward backpressure to bound a supervisor.
3. **[03-per-tool-circuit-breaking.md](./03-per-tool-circuit-breaking.md)** — per-tool breaker that feeds state back to the agent so it routes around dead tools.
