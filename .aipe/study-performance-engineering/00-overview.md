# Overview — the performance map

**Industry name(s):** performance audit · capacity audit · cost-and-latency map
**Type:** Industry standard · Language-agnostic

> blooming insights is bounded by **three measurable ceilings and one unmeasured cost line**. The ceilings: `maxDuration = 300s` per route (`app/api/agent/route.ts:20`, `app/api/briefing/route.ts:17`), `minIntervalMs = 1100` Bloomreach spacing (`lib/mcp/connect.ts:92`), and per-agent `maxToolCalls` (6/6/6/4). The unmeasured cost line: the `synthesize()` fallback in `lib/agents/diagnostic.ts:87-126` and `lib/agents/recommendation.ts:82-132` — output-token-heavy structured JSON output that fires whenever the loop fails to emit valid JSON, with no `res.usage` logging on any Anthropic call site. The load-bearing gap is the missing meter: ~5 lines of `console.log` would unblock every cost-related decision in this guide.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Performance audits go wrong when they pick one number ("p95 latency") and ignore which constraint actually moves it. For blooming insights, the constraints aren't compute or bandwidth — they're an external rate limit (Bloomreach), an external API's latency variance (Anthropic), a route-budget ceiling (Vercel), and a model-token bill (Anthropic) that nobody is currently counting. Each constraint owns a different layer; each has a different cheapest fix.

```
  Zoom out — where the performance ceilings live          ← every band, ranked by what's measurable

  ┌─ UI ─────────────────────────────────────────────┐
  │  React 19 streaming UI                            │
  │  NDJSON reader appends to state per event line    │
  │  Skeleton + ProcessStepper + StatusLog hide       │
  │   latency until events arrive                     │
  └──────────────────────┬────────────────────────────┘
                         │  HTTPS / chunked NDJSON
  ┌─ Route ────────────▼──────────────────────────────┐
  │  maxDuration = 300s  ★ HARD CEILING ★             │
  │  REPLAY_DELAY_MS = 140/180 (paced demo replay)    │
  │  ReadableStream emits one event at a time         │
  │  Cache-Control: no-cache, no-transform            │
  └──────────────────────┬────────────────────────────┘
                         │
  ┌─ Agent loop ────────▼─────────────────────────────┐
  │  maxToolCalls 6/6/6/4 (per agent)                 │
  │  truncate(tool_result) at 16_000 chars            │
  │  synthesize() = output-heavy structured JSON call │  ← ★ UNMEASURED COST CONCENTRATION
  └──────────────────────┬────────────────────────────┘
                         │
  ┌─ Provider/transport ─▼────────────────────────────┐
  │  McpClient cache (60s TTL, exact-match)           │
  │  minIntervalMs = 1100 (per-call latency floor)    │
  │  retry: parses "retry after Ns", waits up to 20s  │
  └──────────────────────┬────────────────────────────┘
                         │
  ┌─ External ──────────▼─────────────────────────────┐
  │  Bloomreach MCP: ~1 req/s/user GLOBAL rate cap    │  ★ THROUGHPUT CEILING
  │  Anthropic: per-call latency variance is visible  │
  └───────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The question this guide answers is: *what's measurably slow or expensive in blooming insights, why, and which change moves the needle without shifting the bottleneck somewhere else?* The output is in two passes (per `me.md` v1.59.2's AUDIT-STYLE GENERATORS section): a one-pass survey in `audit.md` (the 8-lens walk), then deep walks of the patterns that actually pop in this codebase (5 promoted patterns in `01-` through `05-`).

---

## Reading order

```
  audit.md                                  ← Pass 1: the 8-lens survey (start here)
                                              walks every lens, names what's there,
                                              names what's `not yet exercised` honestly

  01-300s-vercel-budget-as-hard-ceiling.md  ← Pass 2: pinned-at-ceiling budget,
                                              the failure mode, the path to lifting

  02-ttl-cache-with-no-cache-on-error.md    ← the 60s cache + the load-bearing
                                              error-bypass guard

  03-spacing-gate-as-rate-limit-compliance.md ← the 1.1s floor and why it's
                                              NOT backpressure (and what breaks
                                              if you ship parallel code thinking
                                              it is)

  04-synthesize-as-cost-concentration.md    ← the suspected dominant cost line
                                              and the 5-line meter that would
                                              confirm or refute it

  05-progressive-streaming-perceived-perf.md ← the 100s → 1-2s perceived
                                              speedup, four UX moves, the
                                              load-bearing no-transform header
```

The audit is the one-pass survey. The pattern files are the deep walks on the patterns that *actually pop* in this codebase — pinned-at-the-ceiling budget, the cache mechanics, the spacing-gate-vs-backpressure distinction, the unmeasured cost line, and the perceived-perf strategy. Together they cover what's load-bearing without padding.

---

## The ranked findings (the top of audit.md, surfaced here)

Three findings dominate; everything else is small by comparison.

```
  1. NO res.usage LOGGING ANYWHERE
     - the four Anthropic call sites (lib/agents/base.ts:102,
       diagnostic.ts:97, recommendation.ts:96, intent.ts:18)
       all RECEIVE res.usage and NONE READ IT
     - fix: ~5 lines of console.log (the cheapest fix in the codebase)
     - unblocks: cost budgets, R1 measurement, soft budgets in file 01

  2. COST CONCENTRATION on synthesize()
     - the synthesize() call (lib/agents/diagnostic.ts:87-126,
       lib/agents/recommendation.ts:82-132) emits long structured-JSON
       output — output tokens are several × input
     - runs whenever the agent loop's parse fails (forceFinal turn missed JSON)
     - SUSPECTED dominant cost line, NOT CONFIRMED (requires #1 to land)
     - see 04-synthesize-as-cost-concentration.md

  3. 300s ROUTE BUDGET AT CEILING, ZERO HEADROOM
     - app/api/agent/route.ts:20, briefing/route.ts:17
     - pinned at Vercel Pro's max; ~100-115s typical leaves ~185s headroom
     - bad-day retry storms (~280s) scrape the ceiling
     - beyond 300s: Vercel kills mid-stream, user sees no diagnosis
     - see 01-300s-vercel-budget-as-hard-ceiling.md
```

---

## What we don't have, said honestly

`not yet exercised` for this codebase (kept honest in `audit.md`):

```
  → Formal SLOs (no p99 latency target, no error-rate budget)
  → Load testing (no k6, no autocannon, no synthetic baseline)
  → Profiler integration (no clinic, no 0x, no Chrome DevTools profiling)
  → Batching (single-request shape; no batched MCP calls or batched Anthropic calls)
  → Bundle-size measurement (no @next/bundle-analyzer config)
  → Web Vitals (no LCP/INP/CLS measurement, no Vercel Speed Insights)
  → APM (no Datadog/Sentry/New Relic; only `console.error` for failures)
  → Cost telemetry (no res.usage logging anywhere)
  → Backpressure (single-flight serial calls; no queue, no semaphore)
```

The pattern: blooming insights makes **bound-by-judgment** decisions (the 300s budget, the 16k truncation, the 60s TTL) — it has not yet entered the **bound-by-measurement** phase. The audit's `measurement-baselines-and-profiling` lens names which measurements would change which decisions.

---

## Partition with neighbors

The performance lens touches every other guide. The partition keeps each lens crisp:

```
  THIS guide        → measurement + optimization of observed bottlenecks
  study-system-design → architecture-scale tradeoffs (the second ceiling at 100x users)
  study-runtime-systems → execution mechanisms (event loop, async, single-process)
  study-agent-architecture/05/01 → cross-turn caching (we anchor to it, don't re-teach)
  study-agent-architecture/05/02 → fan-out backpressure (we anchor to it, don't re-teach)
  study-ai-engineering/06/02     → LLM cost optimization (we anchor to it, don't re-teach)
```

A finding belongs here when the question is *"how big? how fast? how often? how much?"* and the answer can be measured (or the measurement is honestly absent). Architectural-shape findings belong in `study-system-design`. Token-economics theory belongs in `study-ai-engineering`. Backpressure topology belongs in `study-agent-architecture`. This guide is the *applied measurement* lens.

---

## See also

- `README.md` — reading order with cross-links
- `audit.md` — Pass 1: the 8-lens audit (the one-pass survey)
- `01-300s-vercel-budget-as-hard-ceiling.md` — Pass 2: the route-budget contract
- `02-ttl-cache-with-no-cache-on-error.md` — Pass 2: the cache mechanics
- `03-spacing-gate-as-rate-limit-compliance.md` — Pass 2: compliance vs backpressure
- `04-synthesize-as-cost-concentration.md` — Pass 2: the unmeasured cost line
- `05-progressive-streaming-perceived-perf.md` — Pass 2: the UX strategy
- `.aipe/study-system-design/audit.md#scale-bottlenecks-and-evolution` — the three scale ceilings
- `.aipe/study-agent-architecture/05-production-serving/02-fan-out-backpressure.md` — why spacing isn't backpressure
- `.aipe/study-ai-engineering/06-production-serving/02-llm-cost-optimization.md` — the token-economics layer
