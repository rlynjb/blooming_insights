# Overview — the performance map

Verdict first: this repo's performance shape is **provider-quota-bound, not
CPU-bound, not memory-bound, not network-bandwidth-bound**. Bloomreach's loomi
connect MCP server rate-limits per user globally at ~1 req/s and revokes tokens
after minutes. Every interesting perf number in the codebase exists to keep work
inside that provider ceiling while the route's 300s wall-clock budget is still
intact at the end.

If you remember three numbers, remember these:

```
  The four numbers that hold the system together

  ┌─ provider ceiling ─────────────────────────────────┐
  │  ~1 req/s GLOBAL per user                          │  enforced by Bloomreach
  └────────────────────────────────────────────────────┘
            │ defended by
            ▼
  ┌─ spacing gate ─────────────────────────────────────┐
  │  minIntervalMs = 1100                              │  lib/mcp/connect.ts:97
  └────────────────────────────────────────────────────┘
            │ then
            ▼
  ┌─ per-call timeout ─────────────────────────────────┐
  │  TOOL_TIMEOUT_MS = 30_000                          │  lib/mcp/transport.ts:38
  └────────────────────────────────────────────────────┘
            │ inside
            ▼
  ┌─ route budget ─────────────────────────────────────┐
  │  maxDuration = 300                                 │  app/api/{briefing,agent}/route.ts
  └────────────────────────────────────────────────────┘
```

Everything else in this guide is the story of how those four numbers compose,
where they cross-check each other, and which lens to pull when one of them moves.

## Ranked findings

In order of consequence — what would hurt most if it broke.

### 1. The spacing gate is rate-limit compliance, not backpressure

`minIntervalMs = 1100` (`lib/mcp/connect.ts:97`) is the single most load-bearing
performance number in the repo. It is **not** backpressure (no slow consumer is
being protected) — it is **rate-limit compliance** with an external provider's
global quota. Tuning it is a contract negotiation, not a flow-control decision.
Drop it below ~1000 and the next request returns a 429 with a 10s penalty window;
push it above 5000 and a 6-call investigation can't finish inside 60s. The 1.1s
value is deliberately set against the observed `"1 per 1 second"` window with a
100ms safety cushion. → `01-spacing-gate-vs-backpressure.md`

### 2. The 300s route budget is exposed, not hidden

`maxDuration = 300` (`app/api/agent/route.ts:22`, `app/api/briefing/route.ts:19`)
is the wall-clock ceiling Vercel Pro gives a serverless function. A diagnostic +
recommendation investigation runs ~100-115s end-to-end under live conditions —
that's a third of the budget, gone, in a single user click. The comment on
`connect.ts:88-93` is candid: spacing at the full 10s penalty window would cost
~60s for a 6-call investigation alone, so the design accepts the occasional 429
and pays a parsed retry wait instead of pre-paying every call. The whole rate-limit
ladder + per-call timeout exist to defend this ceiling. → `02-rate-limit-retry-ladder.md`
and `03-per-call-timeout-ceiling.md`.

### 3. The 60s response cache is the throughput multiplier you don't see

`cacheTtlMs ?? 60_000` (`lib/data-source/bloomreach-data-source.ts:145`) absorbs
repeat reads — same tool, same args, same minute — at zero MCP cost. The agent
loops re-query the workspace often enough that this is the difference between an
investigation that fits the route budget and one that doesn't. Errors are
explicitly excluded (`lib/data-source/bloomreach-data-source.ts:179-181`), so a
single bad call can't poison a minute of retries. → `04-response-cache-with-no-cache-on-error.md`

## The two perf axes that aren't load-bearing yet

### CPU & memory — not yet exercised

There are no CPU-heavy or memory-heavy code paths in this repo. The agents stream
NDJSON, the response cache is a single `Map`, the schema bootstrap parses ~5 JSON
envelopes. No hot loops, no large in-memory datasets, no GC pressure to reason
about. CPU-bound thinking becomes relevant when the repo grows a synchronous
analytics step, a large in-memory reducer, or a non-streamed JSON parse over a
multi-MB payload — none of those exist today. → `audit.md` § 4.

### Client / rendering — barely exercised

The UI is a small set of React components reading from a stream. There's no
virtualization, no code-splitting, no client-bundle measurement. `next/font` is
used with `display: 'swap'` (`app/layout.tsx:5-7`), which is the only intentional
rendering-perf choice in the client today. Performance lives on the server side.
→ `audit.md` § 7.

## Three risks named, with their evidence (or its absence)

1. **No baselines committed for the live path.** The phase log
   (`app/api/agent/route.ts:331-338`, `app/api/briefing/route.ts:317-324`) emits
   per-phase durations to Vercel — `schema_bootstrap`, `list_tools`, `monitoring_scan`,
   `diagnostic_investigate`, `recommendation_propose` — but no numbers from those
   logs are checked in. The "~100-115s" figure in the route comments is the only
   stated baseline and it isn't versioned. **Evidence: missing.** Decide a
   per-phase target, capture a week of live runs, commit the p50/p95 numbers next
   to the route.
2. **The 60s cache is unbounded.** `lib/data-source/bloomreach-data-source.ts:122`
   uses a plain `Map` with no LRU cap. Per-session OAuth scoping bounds the worst
   case (the cache lives on the per-request `BloomreachDataSource` instance), so
   it can't grow across users — but a long-lived dev process re-using the same
   instance can. **Evidence: code shape; no measurement.** Cap at N entries or
   sweep on cache writes if dev processes grow noticeably.
3. **`maxRetries = 3` × `retryCeilingMs = 20_000` = 60s worst case per call.**
   `connect.ts:99-100` sets the ceiling and the retry count, and the comment at
   `bloomreach-data-source.ts:160-162` flags the exact failure mode: a single
   tool call can burn 60s of the 300s route budget on retries. **Evidence: code
   shape; no measurement of how often this actually triggers in live runs.**
   Add a counter for retries-per-request to the phase log and revisit when you
   see one investigation eat half the budget.

## What's `not yet exercised`

- **Throughput in the multi-user sense.** No load tests; no measurement of
  concurrent-session behavior. The OAuth cookie store + per-session `Map` make
  the design correct under fan-in, but unverified.
- **GC / allocation profiling.** No `--inspect`, no heap snapshots.
- **Client bundle measurement.** No `@next/bundle-analyzer`, no Lighthouse run
  committed.
- **Tail latency / p99.** Phase logs would yield this if aggregated; nothing
  aggregates them today.
