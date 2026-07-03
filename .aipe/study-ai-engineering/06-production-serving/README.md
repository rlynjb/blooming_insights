# 06 — Production serving

The cost, reliability, and security surfaces of running LLMs in production. This codebase exercises: prompt caching (live), cost optimization (Haiku for intent), prompt injection surface (structured outputs as primary defense), rate limiting (partial — inbound to MCP server, not to the app), retry (present in BloomreachDataSource; circuit breaker NOT present).

## Files

- `01-llm-caching.md` — prompt caching via Anthropic's ephemeral breakpoint. Live. Load-bearing cost move.
- `02-llm-cost-optimization.md` — Haiku for intent, Sonnet for reasoning. Budget ceiling.
- `03-prompt-injection.md` — the schema-constrained-output defense; MCP data as untrusted input.
- `04-rate-limiting-backpressure.md` — the BloomreachDataSource ~1 req/s ladder (outbound). Inbound rate limiting is Case B.
- `05-retry-circuit-breaker.md` — retry ladder present in BloomreachDataSource; circuit breaker not.

## Anchor shape

LLM application engineering. Directly exercised.

## Curriculum

Phase 5 — concepts C5.1-C5.8.
