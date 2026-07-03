# 00 · Overview — perf-shape of this repo

The whole system in one frame, with the perf mechanisms marked.

```
  Zoom out — where perf is decided

  ┌─ UI (Next.js RSC + client hooks) ──────────────────────────┐
  │  investigate page → useInvestigation → readNdjson           │
  │      · header override: persistedConfigHeader()            │
  │      · one AbortController per mount (React StrictMode-safe)│
  └────────────────────────────────┬───────────────────────────┘
                                   │  HTTPS · NDJSON stream
  ┌─ Serverless route (Vercel node runtime) ─────────────────────┐
  │  /api/agent · maxDuration = 300s  ← ROUTE BUDGET             │
  │      · phase timings recorded per request                    │
  │      · BudgetTracker (~$2/investigation) checks BEFORE       │
  │        every Anthropic call                                  │
  │      · prompt cache: system prompt wrapped ephemeral         │
  └────────────────────┬──────────────────────┬──────────────────┘
                       │                      │
                       │ model turns          │ tool calls
                       ▼                      ▼
              ┌─ Anthropic API ──┐   ┌─ DataSource (port) ────────┐
              │ Sonnet 4.6       │   │  Bloomreach adapter        │
              │ · cache_creation │   │   · 60s response cache     │
              │   1.25× input    │   │   · ~1.1s spacing gate     │
              │ · cache_read     │   │   · retry ladder (10s/20s) │
              │   0.1× input     │   │   · 30s per-call timeout   │
              └──────────────────┘   └────────────────────────────┘
                                        │
                                        ▼ live-synthetic swap
                                     ┌─ SyntheticDataSource ──────┐
                                     │  in-process fake, 0ms     │
                                     │  used by load eval        │
                                     └────────────────────────────┘
```

## Ranked findings

The load-bearing perf mechanisms, ordered by consequence.

  1. **Route budget composition** (`app/api/agent/route.ts:23`
     `maxDuration = 300`) — the outer bound. Every mechanism below
     exists to fit within it. See `01-route-budget-and-timeout-composition.md`.

  2. **Spacing gate vs retry ladder** (`lib/mcp/connect.ts:121`
     `minIntervalMs: 1100`; `bloomreach-data-source.ts:163-174`
     retry loop) — the load-bearing distinction of the whole repo:
     the spacing gate is a *scheduler* (proactive `sleep`), the retry
     ladder is *backpressure* (reactive on 429). Confusing them is
     the perf trap. See `02-spacing-gate-and-retry-ladder.md`.

  3. **Prompt caching** (`lib/agents/aptkit-adapters.ts:85-89`
     `cache_control: { type: 'ephemeral' }`) — validated live in
     receipts: `cache_read_input_tokens 3168` on the second turn.
     Roughly 80% off system-prompt cost across a ~10-turn ReAct loop.
     See `03-prompt-caching-ephemeral-breakpoint.md`.

  4. **Response cache TTL** (`lib/data-source/bloomreach-data-source.ts:145`
     `ttl = options.cacheTtlMs ?? 60_000`) — per-`(name, args)` map,
     absorbs repeats within a single investigation. Not shared across
     Vercel instances. See `04-response-cache-ttl.md`.

  5. **Budget ceiling** (`lib/agents/budget.ts` + adapter check at
     `aptkit-adapters.ts:64-66`) — throws BEFORE dispatch, not after.
     A runaway loop cannot burn additional cost past the ceiling.
     See `05-budget-ceiling-check-before-dispatch.md`.

  6. **Load harness with semaphore concurrency** (`eval/load.eval.ts:170-211`
     fixed-K worker pool) — bounded parallel workers pull from a
     shared queue. Smoke: `N=2, K=1` → 208s wall clock, $0.156.
     See `06-load-harness-semaphore-concurrency.md`.

  7. **Fault-injecting decorator** (`lib/data-source/fault-injecting.ts`)
     — wraps the DataSource so a fraction of calls fail in known ways
     without touching the agent. Run: `FAULT_TIMEOUT=0.2
     FAULT_MALFORMED_JSON=0.2 N=3` → 9 faults, 0 failures.
     See `07-fault-injecting-decorator.md`.

## Real numbers — baseline runId 2026-07-03T04-08-28-644Z, 10 cases

Per-phase p50 wall-clock latency:

```
  phase                     p50
  ─────────────────         ─────
  diagnostic_investigate    ~50s
  diagnosisJudge            ~38s
  recommendation_propose    ~51s
  recommendationJudge       ~90s
  total (per case)          ~225s
```

Per-case cost avg ~$0.09 agent-side. Full run: $0.913 agent + ~$0.40
judge ≈ ~$1.30 total for 10 cases. One rec-judge outlier: case 09
at 675s. That's the tail — a p50 of ~90s and a max of 675s is the
distribution to name in interviews, not just the p50.

Load smoke (`LOAD_N=2 LOAD_CONCURRENCY=1`, no faults): 208s wall
clock, ~104s per investigation, $0.156. Load with faults
(`FAULT_TIMEOUT=0.2 FAULT_MALFORMED_JSON=0.2 N=3`): 9 injected
faults, 0 investigation failures.

## `not yet exercised`

Honestly named so `audit.md` doesn't manufacture findings:

  → **No client-side bundle profiling.** The client is a Next.js RSC
    surface with modest interactivity (feed, investigate). No Lighthouse
    baseline, no bundle-size budget, no Core Web Vitals capture.
  → **No CPU or memory profiling.** No flamegraphs, no heap snapshots,
    no allocation tracking. The hot path is I/O-bound (network to
    Anthropic + MCP), not CPU-bound, which is why it hasn't come up.
  → **No production observability.** Phase timings go to
    `console.log` for Vercel to pick up; there is no APM, no metrics
    pipeline, no SLO dashboard. See `audit.md` §2.
  → **No horizontal-scale load test.** The load harness runs one
    process, semaphore-bounded. There's no multi-region fanout, no
    coordinated load, no queue-depth measurement across replicas.
    See `audit.md` §3.
  → **No cross-instance cache.** The 60s response cache is a
    per-process `Map`. Vercel serverless memory is not shared, so on
    a cold start the cache is empty by construction. Named honestly
    rather than pretending it's a distributed cache.

## Cross-links

  → `study-runtime-systems` — the execution model (event loop,
    `AbortSignal` composition, `setTimeout` as backpressure). This
    guide MEASURES the resulting latency; runtime-systems EXPLAINS
    why an async gap is spent the way it is.
  → `study-system-design` — the architectural tradeoffs. Why the
    ~1.1s gate exists at all (Bloomreach's per-user global rate
    limit); why the load harness runs offline (avoid burning the
    ~1 req/s live budget); why per-instance caches are correct-enough
    for portfolio traffic.
