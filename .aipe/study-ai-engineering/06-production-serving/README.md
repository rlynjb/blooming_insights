# 06 — Production serving

The serving side: caching, cost optimization, prompt injection defense, rate limiting/backpressure, retry/circuit breaker. This codebase exercises real production-shaped serving against Bloomreach's rate-limited alpha MCP server — the 60s response cache, the parsed-window retry ladder, and `~1.1s` proactive spacing all live inside `BloomreachDataSource`.

The big honest gap: **Anthropic prompt caching is NOT wired today.** Long system prompts pay full price on every call. The cost analysis in `01-llm-foundations/06-token-economics.md` shows that fixing this is the single biggest dollar lever in the codebase.

## Reading order

1. `01-llm-caching.md` — three cache layers; what's shipped (60s response cache) and what's not (prompt caching)
2. `02-llm-cost-optimization.md` — the cheap-classifier pattern, prompt caching, smart truncation
3. `03-prompt-injection.md` — structural defenses (tool allowlist, MCP-only side effects)
4. `04-rate-limiting-backpressure.md` — ~1.1s proactive spacing + parsed-window retry against Bloomreach
5. `05-retry-circuit-breaker.md` — retry exists, circuit breaker doesn't (yet)
