# Performance audit — 8 lenses

Pass 1 of the two-pass output. Each section walks one lens against the real
repo. When a finding earns a dedicated pattern file (Pass 2), the section
cross-links rather than restating the walk.

## 1. performance-budget

There are two budgets in this codebase, one user-visible, one system-visible,
and they were chosen deliberately.

**User-visible budget — perceived latency, not wall-clock.** The investigation
flow takes ~100-115s end-to-end under live conditions (the comment at
`app/api/agent/route.ts:20-21` is explicit). The product never tries to make
that wall-clock shorter; it streams the work as NDJSON so the user sees
reasoning steps + tool calls + thinking the entire time. The budget defended is
**time-to-first-useful-signal**, not total time. → see
`05-streaming-perceived-latency.md`.

**System-visible budget — `maxDuration = 300`.** Vercel Pro's serverless
function ceiling. Two routes claim it: `app/api/briefing/route.ts:19` and
`app/api/agent/route.ts:22`. The comment at `app/api/agent/route.ts:20-21` is
candid: a live investigation runs ~100-115s under the ~1 req/s MCP spacing, so
the 60s Hobby ceiling cannot fit it. The 300s number isn't a goal; it's the
hardest deadline the runtime gives the function, and every other timing number
in the system has to compose to stay under it.

**The composition is intentional.** Routes get 300s. Per-MCP call gets 30s
(`lib/mcp/transport.ts:38`). Per-call retry waits are capped at 20s each
(`lib/mcp/connect.ts:99`, `lib/data-source/bloomreach-data-source.ts:136`).
Worst-case retry cost on one tool call: `maxRetries × retryCeilingMs = 3 × 20s
= 60s`. Three of those in series and the route is gone — so the response cache
(60s TTL, `lib/data-source/bloomreach-data-source.ts:145`) carries the load on
the repeat path.

## 2. measurement-baselines-and-profiling

**Instrumentation is in place; baselines are not committed.**

Per-phase wall-clock is captured in both routes and emitted once per request as
a structured JSON log line in `finally` (fires even on error or abort, so the
incident signal still lands). The shape is identical across routes so a single
Vercel filter reads both:

- `app/api/briefing/route.ts:317-324` — `route`, `sessionId`, `mode`, `totalMs`,
  `phases[]`, `aborted`.
- `app/api/agent/route.ts:331-338` — same shape.

Phases recorded:

- briefing: `schema_bootstrap`, `coverage_gate`, `list_tools`, `monitoring_scan`
  (`app/api/briefing/route.ts:217-281`).
- agent: `schema_bootstrap`, `list_tools`, `intent_classify`, `query_answer`,
  `diagnostic_investigate`, `recommendation_propose`
  (`app/api/agent/route.ts:232-295`).

Per-call token usage is logged inside the AptKit adapter at
`lib/agents/aptkit-adapters.ts:57-61` — a `{site, sessionId, usage}` line per
model call.

**What's missing.** No committed baselines, no aggregation, no profiler runs,
no flamegraphs. The phase logs are an excellent raw signal but nothing extracts
p50/p95 from them or alerts when a phase blows past a target. There's no
`@next/bundle-analyzer` config, no Lighthouse run.

**Concrete next step:** capture a week of live `/api/agent` logs, write the
per-phase p50/p95 numbers into `00-overview.md`, and pick the first phase whose
p95 sits above a budget you're willing to defend.

## 3. latency-throughput-and-tail-behavior

**Latency distribution — unmeasured.** The phase logs would give it; nothing
reads them yet. The route comments cite "~100-115s" for a live investigation
(`app/api/agent/route.ts:20-21`) — that's a single-figure baseline, not a
distribution.

**Throughput — bounded by the provider, not the server.** The ~1 req/s spacing
(`lib/mcp/connect.ts:97`) hard-caps the rate at which one user's investigation
makes forward progress against MCP. Two concurrent investigations against the
same user double the load on the same shared `lastCallAt` instance — but
investigations are per-request and the `BloomreachDataSource` is per-request,
so cross-user fan-in does not collide on this counter. The provider's quota is
the actual ceiling at the platform layer.

**Tail behavior — bounded by `TOOL_TIMEOUT_MS` and the retry ceiling.** A hung
MCP call is bounded at 30s (`lib/mcp/transport.ts:38`). A rate-limited call is
bounded at `3 × 20s = 60s` worst case (`lib/data-source/bloomreach-data-source.ts:159-174`).
Together, no single MCP call can eat more than ~90s of the 300s route budget
even in a worst-case timeout-followed-by-three-retries scenario. The tail is
explicitly engineered, not accidental. → `03-per-call-timeout-ceiling.md`.

**Contention — minimal.** No queues, no shared mutable state across requests,
no locks. The OAuth cookie store has its own request-scoped read/flush
discipline (`lib/mcp/auth.ts:38-50`) that sidesteps Next's request-vs-response
cookie split.

## 4. cpu-memory-and-allocation

`not yet exercised` — and that's the honest finding. There are no hot CPU
loops in this repo. The agents stream NDJSON, the response cache is a single
`Map`, the schema bootstrap parses ~5 JSON envelopes. No reducers over large
in-memory datasets, no synchronous transforms over megabytes of payload, no
worker threads, no SIMD, no parallel CPU work to coordinate. There's no GC
pressure to reason about because there's no allocation pattern interesting
enough to GC over.

The closest thing to a memory concern: the 60s response cache
(`lib/data-source/bloomreach-data-source.ts:122`) is unbounded — no LRU cap,
no sweep. Per-request `BloomreachDataSource` instances scope it correctly for
production (one per request, dies with the request), but a long-lived dev
process re-using the same instance can grow it. Cap at N entries or
sweep-on-write if dev memory becomes noticeable.

When this lens becomes relevant: if the repo grows a synchronous reducer (e.g.
collapsing the streamed events into a saved investigation server-side under
high fan-in), a non-streamed JSON parse over a multi-MB payload, or a worker
pool — then come back here.

## 5. io-network-and-database-bottlenecks

**No database.** The data model lives in `lib/state/` as in-memory `Map`s
scoped to the session, with optional file persistence in dev (`.investigation-cache.json`,
`.auth-cache.json`). Production state lives in the encrypted-cookie OAuth store
and in `BloomreachDataSource`'s 60s response cache. There is no SQL, no NoSQL,
no query plan to read.

**The network IS the bottleneck.** Every interesting piece of latency in this
repo is a round-trip to either Anthropic (the model call) or Bloomreach (the
MCP tool call). Two sub-bottlenecks worth naming separately:

- **The Bloomreach side, rate-limited.** ~1 req/s globally per user. The
  spacing gate (`minIntervalMs = 1100`, `lib/mcp/connect.ts:97`) ensures we
  honor that ceiling proactively; the retry ladder
  (`lib/data-source/bloomreach-data-source.ts:159-174`) recovers when we hit it
  anyway. → `01-spacing-gate-vs-backpressure.md` and `02-rate-limit-retry-ladder.md`.
- **The Anthropic side, unmetered here but token-priced.** `lib/agents/aptkit-adapters.ts:57-61`
  logs `usage` per call (input + output tokens) — the only place model cost
  surfaces. No batching of model calls; each agent step is a fresh
  `messages.create`. There's no `prompt_caching` wired up.

**Filesystem.** Two writes: `.auth-cache.json` and `.investigation-cache.json`
(`lib/state/investigations.ts:32-39`) — both dev-only, gated by
`PERSIST = process.env.NODE_ENV === 'development'`. The committed demo files
(`lib/state/demo-insights.json`, `lib/state/demo-investigations.json`) are
read-only at runtime and served directly from disk by `app/api/briefing/route.ts:86-153`
and `app/api/agent/route.ts:124-142`. No streaming for these — they're small
enough that `readFileSync` is fine and the replay throttle (140ms / 180ms per
event) intentionally re-paces them.

## 6. caching-batching-and-backpressure

This is the rich lens. Five mechanisms compose here.

**Caching (3 layers).**

1. **60s response cache** on every MCP tool result, keyed by `name + JSON.stringify(args)`
   (`lib/data-source/bloomreach-data-source.ts:144-152`). Errors are excluded
   (`bloomreach-data-source.ts:179-181`) so a single 429 / timeout doesn't poison
   the next minute. → `04-response-cache-with-no-cache-on-error.md`.
2. **Schema cache** for the bootstrap (4 tool calls becoming 1 `WorkspaceSchema`
   object) — `lib/mcp/schema.ts:138`, `let cached: WorkspaceSchema | null`. This
   is a module-level single-slot cache, never invalidated except by the test-only
   `_resetSchemaCache` (`lib/mcp/schema.ts:211`). For the live Bloomreach path
   it's a meaningful speedup on subsequent runs; for the per-request DataSource
   factory model it survives across requests *in the same warm Node process*
   only, which on serverless means "sometimes."
3. **Committed demo snapshot** (`lib/state/demo-*.json`) — served by route
   short-circuits (`app/api/briefing/route.ts:86`, `app/api/agent/route.ts:125`)
   before any auth or stream setup. This is the **presentation-reliability**
   cache: zero MCP cost, zero model cost, deterministic. The replay throttle
   (`REPLAY_DELAY_MS = 140` in briefing, `180` in agent) deliberately re-paces
   the snapshot so it doesn't all-at-once on screen.

**Batching.** Effectively none. The schema bootstrap is `await`-chained 4 times
sequentially (`lib/mcp/schema.ts:195-198`) — the comment notes it could be
parallelized except for the ~1 req/s ceiling, which would just queue them at
the spacing gate anyway. Model calls aren't batched. No `Promise.all` opportunities
get reached for inside the agent loops; they wouldn't help under the same gate.

**Throttling / spacing gate.** `minIntervalMs = 1100` in `lib/mcp/connect.ts:97`,
enforced inside `liveCall` at `lib/data-source/bloomreach-data-source.ts:191-194`.
This is rate-limit *compliance*, not backpressure. The teaching distinction lives
in `01-spacing-gate-vs-backpressure.md` — keep that file's framing close at hand.

**Backpressure — not yet exercised in the producer-consumer sense.** No queue, no
bounded buffer, no consumer-driven pull mechanism. The closest thing is the
NDJSON stream's natural pull semantics (the browser reader's `read()` paces the
producer's `enqueue` under Node's stream backpressure), but the code doesn't
manage it explicitly. If you ever add a producer that emits faster than the
consumer can drain, that's when backpressure becomes a real lens here.

**Overload control — partial.** Per-call timeout (30s) and bounded retries
(3 × 20s) cap any single operation, but there's no circuit breaker, no
rejection mode, no degraded-response path beyond "stream the error event and
let the UI render it." For an alpha-quality provider that's adequate; for
production scale it's the obvious next step.

## 7. rendering-client-and-mobile-performance

**Client side is small and unmeasured.** The UI is a small set of React
components reading from a stream. No virtualization, no code-splitting, no
client bundle measurement committed. `next/font` is used with `display: 'swap'`
(`app/layout.tsx:5-7`) — three font families, the only intentional rendering-perf
choice the layout exercises.

**Streaming as a rendering-perf tool.** The single most impactful client-side
perf choice is the decision to render NDJSON events as they arrive
(`lib/hooks/useBriefingStream.ts:204-285`, `lib/hooks/useInvestigation.ts:98-152`).
The UI never waits for "the answer" — it shows the reasoning steps, tool calls,
and per-tool durations as they stream. Time-to-first-paint of useful content is
on the order of the schema bootstrap (~1-3s), not the total investigation
(~100-115s).

**No `useMemo` / `useCallback` inside components.** Only the two policy hooks
(`useReconnectPolicy.ts`, `useDemoCapture.ts`) use `useCallback`. The streaming
hooks deliberately don't memoize event handlers — each event is a state update
that re-renders the trace list, which is fine for the volume (tens of items per
investigation, not thousands). When the trace list grows past a few hundred
items, that's when virtualization becomes the next lens.

**The 4000-char tool-result truncation** (`app/api/agent/route.ts:97-101`,
`app/api/briefing/route.ts:71-75`) prevents a single chatty tool from bloating
the NDJSON stream past what the client can comfortably render — applied at the
event boundary, not at the storage boundary.

**`reactStrictMode` is on** (Next default). One specific perf-relevant
consequence: `lib/hooks/useInvestigation.ts:44-49` carries a `startedRef` guard
plus an explicit decision NOT to cancel the in-flight fetch on cleanup —
because StrictMode's mount-cleanup-remount would otherwise abort the live
stream and leave the trace empty. That's a debugging-observability story
more than a perf story, but it lives on the perf seam.

## 8. performance-red-flags-audit

Risks ranked by consequence × probability × difficulty-of-recovery. Each one
names the evidence for the verdict, or names the absent measurement.

### Red flag 1 — no committed baselines for the live path

**Evidence: missing.** The phase logs (`app/api/briefing/route.ts:317-324`,
`app/api/agent/route.ts:331-338`) emit per-phase durations, but nothing aggregates
them and no numbers are committed. The "~100-115s" figure in the route comments
is the only stated baseline.

**Why it's a red flag.** You can't notice the system getting slower if you've
never written down how fast it is now. The first time a phase shifts upward
under load, you have no anchor.

**The move.** Capture a week of live `/api/agent` runs from Vercel, compute
p50/p95 per phase, commit the table next to the route. Then pick the first phase
whose p95 sits above a target you'd defend, and write that target down.

### Red flag 2 — worst-case retry budget can eat the route

**Evidence: code shape; behavior unmeasured.** `maxRetries = 3` ×
`retryCeilingMs = 20_000` = 60s per tool call worst case
(`lib/mcp/connect.ts:99-100`, `lib/data-source/bloomreach-data-source.ts:159-174`).
The comment at `bloomreach-data-source.ts:160-162` flags this exactly: against
the 60s route budget (note: the comment says 60s but the actual budget is 300s —
the comment is conservative or pre-dates the bump), a single call can cost 60s
on retries. Two such calls in series and a third of the route is gone.

**Why it's a red flag.** A degraded provider window (alpha server having a bad
minute) doesn't fail loudly — it eats budget silently across multiple investigation
runs until you wonder why the UI feels heavy.

**The move.** Add a `retries` counter to the phase log entry per request. When
you see a request with `retries: 3+` and `totalMs > 200000`, you'll know the
ladder is actively saving the request OR eating it, and which.

### Red flag 3 — unbounded response cache `Map`

**Evidence: code shape.** `lib/data-source/bloomreach-data-source.ts:122` —
plain `Map`, no LRU, no max-size, no sweep. The per-request scoping bounds
production reasonably (the `BloomreachDataSource` instance dies with the request),
but the schema cache (`lib/mcp/schema.ts:138`) is module-level and can outlive
many requests in a warm dev process or warm Vercel instance.

**Why it's not yet acute.** Bloomreach tool results are small (tens of KB at
most after the `unwrap`), and the 60s TTL means the cache window is short.
Worst-case memory growth is bounded by `(unique_calls_per_60s) × (per_call_KB)`,
which is small.

**The move.** When you add a tool that returns megabytes (a large catalog dump,
a wide segment), cap the cache at N entries and add a sweep-on-write. Until then,
leave it.

### Red flag 4 — no `prompt_caching` on the Anthropic side

**Evidence: code shape.** `lib/agents/aptkit-adapters.ts:42-71` constructs each
`messages.create` fresh. The system prompts (`lib/agents/prompts/*.md`) are
non-trivial in size and re-sent every step.

**Why it's a red flag.** Token cost on the Anthropic side is the second-largest
provider expense after wall-clock time. `prompt_caching` (5x cost reduction on
the cached prefix) would land directly on the agent loop's hot path.

**The move.** When you next touch `aptkit-adapters.ts`, add
`cache_control: { type: 'ephemeral' }` on the system prompt block. Validate the
cache hit rate via the `usage.cache_read_input_tokens` field that comes back in
`response.usage`.

### Red flags `not yet exercised`

- Bundle-size red flags — no client bundle measurement committed.
- Memory red flags — no heap snapshots, no GC tuning.
- Connection-pool red flags — no DB, no Postgres pool, no Redis client.
- Tail latency red flags — would surface from aggregated phase logs; nothing
  aggregates them today.
