# Overview — the performance map

**Industry name(s):** performance audit · capacity audit · cost-and-latency map
**Type:** Industry standard · Language-agnostic

> blooming insights is bounded by **three measurable ceilings and one unmeasured cost line**: the **300s Vercel route budget** (`maxDuration = 300` in both `app/api/agent/route.ts:20` and `app/api/briefing/route.ts:17`), the **~1 req/s Bloomreach MCP rate limit** (enforced by `minIntervalMs: 1100` in `lib/mcp/connect.ts:92`, which sets the per-call latency *floor*), and the **per-agent `maxToolCalls` budget** (6, 6, 6, 4 across monitoring/diagnostic/query/recommendation). The unmeasured cost line is the `synthesize()` fallback in `lib/agents/diagnostic.ts:87` and `lib/agents/recommendation.ts:82` — a tool-less, structured-JSON output call that runs whenever the loop fails to emit valid JSON. It's the most output-token-heavy call in the system, and nothing measures it because there is no `res.usage` logging anywhere. Everything else in this guide hangs off those four facts.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Performance audits go wrong when they pick one number ("p95 latency") and ignore which constraint actually moves it. For blooming insights, the constraints aren't compute or bandwidth — they're an external rate limit (Bloomreach), an external API's latency variance (Anthropic), a route-budget ceiling (Vercel), and a model-token bill (Anthropic) that nobody is currently counting. Each constraint owns a different layer; each has a different cheapest fix.

```
  Zoom out — where the performance ceilings live          ← we are here (every band, ranked by what's measurable)

  ┌─ UI ─────────────────────────────────────────────┐
  │  React 19 streaming UI                            │
  │  NDJSON reader appends to state per line          │
  │  Skeleton + ProcessStepper hide latency           │
  └──────────────────────┬────────────────────────────┘
                         │  HTTPS / chunked NDJSON
  ┌─ Route ────────────▼──────────────────────────────┐
  │  maxDuration = 300s  ← HARD CEILING               │
  │  REPLAY_DELAY_MS = 140/180 (paced demo replay)    │
  │  ReadableStream emits one event at a time         │
  └──────────────────────┬────────────────────────────┘
                         │
  ┌─ Agent loop ────────▼─────────────────────────────┐
  │  maxToolCalls 6/6/6/4 (per agent)                 │
  │  truncate(tool_result) at 16_000 chars            │
  │  synthesize() = output-heavy structured JSON call │  ← UNMEASURED COST CONCENTRATION
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

**Zoom in — narrow to the concept.** The question this guide answers is: *what's measurably slow or expensive in blooming insights, why, and which change moves the needle without shifting the bottleneck somewhere else?* Eight files. Budget first (the contract). Measurement second (what we can see and what we can't). Then latency, CPU/memory, I/O, caching/backpressure, rendering, and a ranked red-flags audit at the end.

---

## Reading order

```
  01-performance-budget                  the contract: 300s, 1 req/s, 6 calls, 16k chars
  02-measurement-baselines-and-profiling what we measure today, what we don't, the missing meter
  03-latency-throughput-and-tail-behavior the ~100-115s investigation, the ~1.1s call floor, no batching
  04-cpu-memory-and-allocation           messages array growth, in-memory Maps, schema cache, leak boundary
  05-io-network-and-database-bottlenecks NDJSON out, HTTPS to MCP + Anthropic, no DB, FS only in dev
  06-caching-batching-and-backpressure   60s TTL cache (hit), schema cache (lifetime), rate-limit compliance ≠ backpressure
  07-rendering-client-and-mobile-performance streaming UI, skeletons, ProcessStepper, no measurements
  08-performance-red-flags-audit         ranked risks with file:line evidence
```

---

## The ranked findings (the top of file 08, surfaced here)

Three findings dominate; everything else is small by comparison.

```
  1. UNMEASURED COST CONCENTRATION
     - the synthesize() call (lib/agents/diagnostic.ts:87, lib/agents/recommendation.ts:82)
       emits a long structured-JSON output — output tokens are several × input
     - runs whenever the agent loop's parse fails (forceFinal turn missed JSON)
     - no res.usage logging anywhere → cost is invisible
     - fix: log res.usage on every Anthropic call; cache decision after data

  2. NO LOAD-TESTING / NO PROFILER INTEGRATION
     - the only per-call timing emitted is tool_call_end{durationMs} in lib/mcp/events.ts:7
     - no p50/p95/p99 latency, no throughput counters, no flame graph
     - the 300s budget is set on judgment ("~100-115s under 1 req/s") — not measurement
     - fix: durationMs per Anthropic call too; persist + summarize per investigation

  3. SPACING GATE MASQUERADING AS BACKPRESSURE
     - McpClient.liveCall waits minIntervalMs - elapsed (lib/mcp/client.ts:150)
     - this is rate-limit compliance, NOT backpressure (single-flight, no queue depth signal)
     - if the system ever fans out (parallel agents), nothing tells the producer to stop
     - fix: when fan-out arrives, add a semaphore + upward signal — see study-agent-architecture/05/02
```

---

## What we don't have, said honestly

`not yet exercised` for this codebase:

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

The pattern: blooming insights makes **bound-by-judgment** decisions (the 300s budget, the 16k truncation, the 60s TTL) — it has not yet entered the **bound-by-measurement** phase. Files 02 and 08 say which measurements would change which decision.

---

## Partition with neighbors

The performance lens touches every other guide. The partition keeps each lens crisp:

```
  THIS guide        → measurement + optimization of observed bottlenecks
  study-system-design → architecture-scale tradeoffs (file 07: the three scale ceilings)
  study-runtime-systems → execution mechanisms (event loop, async, single-process)
  study-agent-architecture/05/01 → cross-turn caching (we anchor to it, don't re-teach)
  study-agent-architecture/05/02 → fan-out backpressure (we anchor to it, don't re-teach)
  study-ai-engineering/06/02     → LLM cost optimization (we anchor to it, don't re-teach)
```

A finding belongs here when the question is *"how big? how fast? how often? how much?"* and the answer can be measured (or the measurement is honestly absent). Architectural-shape findings belong in `study-system-design`. Token-economics theory belongs in `study-ai-engineering`. Backpressure topology belongs in `study-agent-architecture`. This guide is the *applied measurement* lens.

---

## See also

- `01-performance-budget.md` — the contract that bounds the system
- `02-measurement-baselines-and-profiling.md` — what we can see, and what we can't
- `08-performance-red-flags-audit.md` — the ranked risks, with evidence
- `.aipe/study-system-design/01-system-design/07-scale-bottlenecks-and-evolution.md` — the three scale ceilings
- `.aipe/study-agent-architecture/05-production-serving/02-fan-out-backpressure.md` — why spacing isn't backpressure
- `.aipe/study-ai-engineering/06-production-serving/02-llm-cost-optimization.md` — token-economics layer
