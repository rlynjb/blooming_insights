# 06 — Production serving

The operational layer: what it takes to run an LLM application under real cost, real rate limits, and real failure. This sub-section covers how blooming insights caches, controls cost, defends against malicious input, throttles a rate-limited upstream, and recovers from transient failure — and, just as honestly, where those defenses stop.

Two of these are **Case A** (a real implementation to extend) and two are **Case B** (honest gaps — the buildable hardening targets). One is mixed.

```
            ┌─────────────────────────────────────────────────────────┐
            │  PRODUCTION-SERVING LAYER                                │
            │                                                         │
   cost ──► │  caching ──┐                                            │
            │  cost opt ─┤── what it costs to run                     │
            │            │                                            │
   safety ─►│  prompt injection ── what malicious input can do        │
            │            │                                            │
   load ──► │  rate limiting ──┐                                      │
            │  retry/breaker ──┤── what happens under load & failure  │
            └─────────────────────────────────────────────────────────┘
```

---

## Files in this sub-section

### `01-llm-caching.md` — Case A (partial)
The three cache layers. **Built:** the 60s exact-match `Map` over MCP tool results (`lib/mcp/client.ts`, keyed `name:JSON.stringify(args)`, no-cache-on-error) and the coarse whole-investigation replay cache (`lib/state/investigations.ts`). **Absent:** Anthropic prompt caching (`cache_control`) on the static system prefix, and a semantic cache. Exercise: add `cache_control` to the static prefix — the highest-ROI cost change.

### `02-llm-cost-optimization.md` — Case A (partial)
Where the money goes and which lever moves it. **Built:** edge model routing (cheap haiku classifier vs sonnet agents), hard `maxToolCalls` budgets (6/6/4/6), 16k truncation, and caching. **Absent:** prompt caching, a cost dashboard, and a cheap-first-then-escalate cascade *within* agents (all sonnet). Output tokens dominate — the `synthesize()` call is the big line item. Exercise: a per-run cost meter from `res.usage`.

### `03-prompt-injection.md` — Case B (honest security finding)
The `?q=` input is only `.trim()`'d (`app/api/agent/route.ts` L54) then passed verbatim as `userPrompt: query` (`lib/agents/query.ts` L35) — no sanitization. Honestly bounded: the app is read-only (MCP tools cannot write) and artifacts are validated structured output, so the blast radius is data exfiltration via crafted answers, not destructive action. Exercise: an input guard on `?q=` plus documenting the read-only / structured-output defense.

### `04-rate-limiting-backpressure.md` — Case A (partial)
**Built:** fixed-interval inter-call spacing — `liveCall` enforces `minIntervalMs` (`lib/mcp/client.ts` L69–L77), set to 1100 ms in `connectMcp` (`lib/mcp/connect.ts` L58) for Bloomreach's ~1 req/s/user limit. **Absent:** a real request queue, backpressure, and load-shedding under burst — it is serial spacing for one user, not a multi-tenant queue. Exercise: a concurrency-bounded queue with backpressure when N users share the limit.

### `05-retry-circuit-breaker.md` — Case A (partial) + Case B
**Built:** bounded rate-limit retry with EXPONENTIAL backoff — `while (isRateLimited && retries < maxRetries)` (`lib/mcp/client.ts` L122–L132), `maxRetries = 3`, base `retryDelayMs = 10_000`, capped at `retryCeilingMs = 20_000`, preferring a parsed Retry-After window + a 500ms buffer — honestly missing only jitter. **Absent:** jitter, and a circuit breaker. Exercise: add jitter and a breaker that fails fast during a provider outage.

---

## Case A vs Case B at a glance

```
  concept                     status        the gap to build
  ──────────────────────────  ───────────   ──────────────────────────────
  01 caching                  Case A        prompt caching (cache_control)
  02 cost optimization        Case A        cost meter + in-agent cascade
  03 prompt injection         Case B        input guard on ?q=
  04 rate limiting            Case A        queue + backpressure
  05 retry / circuit breaker  Case A + B    jitter + breaker
```

**Caching, rate limiting, and retry are Case A** — real, working implementations in `lib/mcp/client.ts` and `lib/mcp/connect.ts` that the exercises extend and harden. **Prompt injection and the circuit breaker are the Case-B hardening gaps** — prompt injection is an honest, bounded security finding, and the circuit breaker is the missing companion to the existing retry.

---

## Reading order

Each file is self-contained, but they pair naturally:
- **Cost pair:** `01-llm-caching` → `02-llm-cost-optimization` (caching is a cost lever; read them together).
- **Load pair:** `04-rate-limiting-backpressure` → `05-retry-circuit-breaker` (both live in `McpClient`; spacing, retry, and the breaker are one funnel).
- **Standalone:** `03-prompt-injection` (the security finding; read whenever the threat model comes up).

All five anchor to the same two files — `lib/mcp/client.ts` and `lib/mcp/connect.ts` — which together form the single choke-point where caching, spacing, and retry meet.

---
