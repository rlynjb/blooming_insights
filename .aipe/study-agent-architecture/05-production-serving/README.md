# 05 · Production serving for agents

What single-call caching, rate-limiting, and circuit-breaking become once the unit of execution is no longer one LLM call — it's a loop or a topology that issues many calls.

## Files

1. [`01-cross-turn-caching.md`](./01-cross-turn-caching.md) — cache scopes that span an agent run; this repo's 60s response cache + provider-side prefix caching
2. [`02-fan-out-backpressure.md`](./02-fan-out-backpressure.md) — concurrency caps for parallel agents (not in this repo; would be the prerequisite for adopting fan-out)
3. [`03-per-tool-circuit-breaking.md`](./03-per-tool-circuit-breaking.md) — failing fast on a dead tool so the agent reasons around it (not in this repo; the named gap)

## How this maps to the codebase

| File | In this codebase? |
|---|---|
| Cross-turn caching | **Partial.** 60s response cache per (name+args) in `BloomreachDataSource` — covers intra-run memoization. Provider-side prompt-prefix caching not currently enabled. No semantic cross-run cache. |
| Fan-out backpressure | **Not in this repo** — no fan-out today. Would be the prerequisite for adopting parallel agents. Bloomreach's ~1 req/s spacing acts as a degenerate global cap. |
| Per-tool circuit breaking | **Not in this repo** — the named gap. A flaky tool today wastes per-agent budget; a breaker would fail fast and let the agent route around it. |
