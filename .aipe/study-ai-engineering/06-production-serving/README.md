# 06 · Production serving

The production-hardening layer. Every concept in this sub-section is live in this codebase.

- [01-llm-caching.md](01-llm-caching.md) — prompt caching, live and measured (`cache_read_input_tokens = 3168`).
- [02-llm-cost-optimization.md](02-llm-cost-optimization.md) — Haiku classifier + Sonnet agents + budget ceiling.
- [03-prompt-injection.md](03-prompt-injection.md) — tool-schema constraint + secret redaction at the transport boundary.
- [04-rate-limiting-backpressure.md](04-rate-limiting-backpressure.md) — the ~1 req/s Bloomreach gate and how the DataSource paces around it.
- [05-retry-circuit-breaker.md](05-retry-circuit-breaker.md) — retry ladder for rate limits; circuit-breaker as the not-yet-added hardening.

## The load-bearing files in this sub-section

- `lib/agents/aptkit-adapters.ts:75-98` — the cache_control breakpoint.
- `lib/agents/pricing.ts` — the pricing helper feeding cost math.
- `lib/agents/budget.ts` — the pre-dispatch budget ceiling.
- `lib/mcp/transport.ts` — 30s per-call timeout, secret redaction.
- `lib/data-source/bloomreach-data-source.ts` — the retry ladder + ~1 req/s spacing gate.
