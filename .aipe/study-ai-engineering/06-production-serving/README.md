# 06 — production serving

The patterns that make an LLM-powered system survive real users + real
load. For blooming insights specifically: the rate-limit + retry layer
in `BloomreachDataSource` is load-bearing (the alpha MCP server is
strict); prompt injection defenses are present implicitly via tool
allowlisting; LLM-side caching and circuit breaking are not exercised
yet.

## Files

```
01-llm-caching.md                      ← prompt cache / semantic / exact (Case B)
02-llm-cost-optimization.md            ← model routing, batching (partial)
03-prompt-injection.md                 ← attack pattern + defenses
04-rate-limiting-backpressure.md       ← LOAD-BEARING for live mode
05-retry-circuit-breaker.md            ← retry: load-bearing; circuit: Case B
```

## What's load-bearing in this section

  → **`04-rate-limiting-backpressure.md`** — Bloomreach's alpha MCP
    server enforces "1 per 10s" globally per user.
    `BloomreachDataSource.callTool` has explicit handling for this:
    parse the server-stated retry-after, sleep, retry. Without it, live
    mode doesn't work.

  → **`05-retry-circuit-breaker.md`** — the retry side is load-bearing
    (same reason); the circuit-breaker side is Case B (not implemented
    today — there's no "is the provider currently broken" gate).

## What's pattern-only (Case B)

  → **`01-llm-caching.md`** — Anthropic prompt caching is the biggest
    cost-reduction lever still on the table. The `cache_creation_input_tokens`
    and `cache_read_input_tokens` fields are already being logged
    (`lib/agents/aptkit-adapters.ts:60`) — they're just always zero
    because nothing is being cached.

  → **`03-prompt-injection.md`** — the defenses are *implicit*: tool
    allowlists narrow what a compromised prompt can do; structured JSON
    output validation rejects free-form attempts. Made explicit in the
    file.
