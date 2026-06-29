# 05 — Production serving for agents

Anchor: single-agent + multi-agent (both)

What changes when the unit of execution is a loop (single-agent) or a topology (multi-agent), where the same single-call problems compound across turns and concurrent agents.

This sub-section does **not** re-teach single-call serving (caching, cost, rate limiting/backpressure, retry/circuit-breaker for one model call). Those mechanics would live in `study-ai-engineering`'s production-serving sub-section when generated. What lives here is the three places where the single-call version is insufficient because the unit is now a loop or topology.

## How this maps to the repo

All three patterns are exercised. The most live is **per-tool retry** in `BloomreachDataSource` — the rate-limit retry ladder that turns "MCP returned 429" into "sleep parsed retry-after window, try again, up to 3x."

Fan-out backpressure isn't exercised in the multi-agent sense (no fan-out topology), but the proactive `minIntervalMs=200ms` spacing primitive is the same one a fan-out cap would use.

Cross-turn caching is live at two layers: provider-side prompt-prefix caching (implicit at Anthropic) and intra-run memoization (the 60s `BloomreachDataSource` cache).

## Reading order

1. `01-cross-turn-caching.md` — the layered cache story.
2. `02-fan-out-backpressure.md` — the concurrency-cap primitive (the rate-limit spacing IS this).
3. `03-per-tool-circuit-breaking.md` — the retry ladder; the failure-as-observation pattern.
