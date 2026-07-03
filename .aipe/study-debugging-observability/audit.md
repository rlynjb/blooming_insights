# audit.md — Pass 1

The 8-lens debugging + observability audit, walked against the code
that's actually here. Each lens gets one `##` section grounded in
`file:line`. Lenses that don't apply are named `not yet exercised`
honestly. Cross-links point at Pass-2 pattern files.

The load-bearing story up front: **the observability pile is small on
purpose — one wire, one summary log, one hook, and receipts on disk.**
Every mechanism is one specific piece of evidence for one specific
question. Nothing is a generic "let's log this in case."

---

## 1. observability-map

**Three live surfaces plus two receipt classes; nothing outside them.**

The evidence map, exhaustive:

- **Live NDJSON stream** — `lib/mcp/events.ts:4-12` defines an
  8-variant discriminated union (`AgentEvent`). Produced by
  `/api/agent` (`app/api/agent/route.ts:194`) and `/api/briefing`
  (`app/api/briefing/route.ts:198`) through a shared `send()`
  closure. Consumed by the browser via `readNdjson`
  (`lib/streaming/ndjson.ts:17-64`) which then dispatches to the
  investigation hook (`lib/hooks/useInvestigation.ts:99-153`).
  → see `01-ndjson-agent-event-wire.md`
- **Per-phase summary console log** — one JSON line per request in
  the route's `finally` block: `app/api/agent/route.ts:336-343` and
  `app/api/briefing/route.ts:322-329`. Shared shape between routes so
  a single Vercel filter reads both.
  → see `03-per-phase-timing-log.md`
- **Anthropic per-call usage log** — one JSON line per model turn from
  `AnthropicModelProviderAdapter.complete()` at
  `lib/agents/aptkit-adapters.ts:97-101`. Shape:
  `{ site, sessionId, usage: response.usage }`. The `usage` field
  carries Anthropic's own `cache_creation_input_tokens` +
  `cache_read_input_tokens` — the evidence that prompt caching is
  actually landing on the wire.
- **Dev-only cache file** — `lib/state/investigations.ts:7-46` writes
  `.investigation-cache.json` in `NODE_ENV=development` only; the
  serverless FS is read-only in production. This is not intended as
  an observability surface, but it is the fastest way to grab a
  full trace of a dev run for post-hoc diagnosis.
- **Per-case receipts on disk** — `eval/receipts/<caseId>-<runId>.json`
  written by `eval/run.eval.ts:341-398`. Full case: anomaly, tool
  calls (both agents), diagnosis, recommendations, judge verdicts,
  usage + cost per phase, budget snapshot. Latest baseline runId:
  `2026-07-03T04-08-28-644Z`, ten cases.
- **Load receipt** — `eval/load-receipts/load-<runId>.json` written
  by `eval/load.eval.ts:219-220`. p50/p95/p99 for each of investigate
  / recommend / total across N investigations; per-fault-kind counts
  when fault injection is on.
- **Baseline + gate** — `eval/baseline.json` (committed) plus
  `eval/gate-<runId>.json` (per-run) drive the regression check
  (`eval/gate.eval.ts:112-148`).

What's on this map is what exists. There is no metrics endpoint, no
Prometheus scrape, no OTLP exporter, no separate `/health` route,
and no separate debug logger — the four `console.error` / `console.log`
call sites plus the four eval receipt classes are the entire pile.

## 2. reproduction-and-evidence

**Reproduction is receipt-driven; the receipt is both the input and
the verdict.**

Every eval run mints a `sharedRunId` in `beforeAll`
(`eval/run.eval.ts:168`) and every case receipt embeds it in the
filename (`<caseId>-<runId>.json`) plus the receipt body's `runId`
field. That's the reproduction handle: give someone a runId and they
can pull the whole case pile off disk, load it in `report.eval.ts`
(`eval/report.eval.ts:62-69`) and get the same p50/p95/p99 table you
saw. No re-running the agent — the evidence is the run.

For live incidents the reproduction path is:

1. Grab the `sessionId` from the browser (network tab) or the
   Vercel log filter.
2. Filter the log by that sessionId — you get every model turn
   (`aptkit-adapters.ts:97`) plus the one summary line
   (`route.ts:336`).
3. Cross-reference the `phases[]` array to know which phase burned
   time. If a phase field is missing, the throw happened *before*
   that `recordPhase` call.

Controlled experiments are what the fault-injecting DataSource is
for (`lib/data-source/fault-injecting.ts:65-`). Set
`FAULT_TIMEOUT=0.1 FAULT_RATE_LIMIT=0.05 FAULT_SEED=42
npm run eval:load` and the load run replays a deterministic
failure sequence — the receipt records `faultTotals` so you can
prove the graceful-degradation path fires the number of times you
told it to.

Hypothesis testing lives in the golden cases themselves
(`eval/goldens/index.ts` re-exports 10 case files). Each case has a
`knownCorrect` shape and a `signalClass`
(`has-signal` / `partial-signal` / `no-signal` / `positive`); the
judge rubric scores against these on 4 dimensions per phase. The
verdict distribution *is* the hypothesis test.

## 3. structured-logs-and-correlation

**Two structured log shapes, one correlation ID by convention.**

Every log line the repo emits is `JSON.stringify`-shaped, never a
plain string. Two shapes matter:

- **Per model-turn** — `lib/agents/aptkit-adapters.ts:97-101`:
  `{ site: 'agents/<name>:aptkit-model', sessionId, usage }`.
  `usage` is Anthropic's raw usage envelope, including
  `cache_creation_input_tokens` and `cache_read_input_tokens` when
  caching is active. This is the wire-level evidence that caching
  is landing — grep for `cache_read_input_tokens` in the log stream
  and every non-first turn in an investigation should have a
  non-zero value.
- **Per-request summary** — `app/api/agent/route.ts:336-343` and
  `app/api/briefing/route.ts:322-329`:
  `{ route, sessionId, mode, totalMs, phases, aborted }`. One line
  per request, in the `finally` so it fires even on throw. The
  shape is deliberately identical between routes so a single
  Vercel filter (e.g. `phases.phase = "schema_bootstrap"`) reads
  across both.

Correlation:

- **`sessionId`** is `lib/mcp/session.ts:16-24`, minted as a
  `crypto.randomUUID()` on first request and set as an httpOnly
  cookie (`bi_session`). It appears in the per-turn log, the
  summary log, and every eval receipt (`eval/run.eval.ts:183`,
  `eval/load.eval.ts:264`). This is the one ID that ties a live
  session to its logs.
- **`runId`** correlates all receipts belonging to one eval run.
- **`caseId`** correlates a receipt back to its golden case
  definition in `eval/goldens/`.

There is no trace ID / span ID / distributed trace context — the
browser → route → MCP hop is not stitched. The `sessionId` is the
stand-in.

Redaction:

- `lib/mcp/transport.ts:66-76` (`redactSecrets`) walks a fixed set
  of `TOKEN_PATTERNS` (Bearer, `access_token`, `refresh_token`,
  `id_token`, `code_verifier`) and replaces the token value with
  `[redacted]` while preserving the surrounding JSON key.
- Called by every error-path `console.error` in the routes:
  `app/api/agent/route.ts:174`, `:317`, `:330`;
  `app/api/briefing/route.ts:179`, `:303`, `:316`; plus the four
  MCP proxy routes. This is enforced at the *log-string
  construction site*, not by a downstream sink — so a token in
  `err.cause.cause` doesn't survive the `formatError` walk
  (`transport.ts:82-97`) and reach Vercel.
  → see `06-log-redaction-and-error-chain.md`

## 4. metrics-slis-slos-and-alerts

**Not yet exercised as continuous signals; measured on-demand via
eval receipts.**

The repo has no continuously-emitted metrics: no `/metrics`
endpoint, no OTLP exporter, no StatsD, no Prometheus client, no
CloudWatch custom metrics. Nothing pages anyone; nothing
auto-alerts.

The signal that would populate an SLI *does* exist — it's just
computed on-demand from receipts:

- **Latency SLI** — computed by `eval/report.eval.ts:90-96` from
  the `durationMs` field on every receipt. Current numbers
  (runId `2026-07-03T04-08-28-644Z`): p50 diagnose 50s,
  d-judge 38s, recommend 51s, r-judge 90s, total 225s.
- **Cost SLI** — `eval/report.eval.ts:104-131` sums per-case
  `usage.costUsd` from receipts; current run total is
  $0.913 agent-side across 10 cases.
- **Quality SLI** — per-dimension pass rate over judge verdicts,
  four dimensions per phase, computed by
  `eval/baseline.eval.ts` and cached in `eval/baseline.json`.
- **Load / concurrency SLI** — populated by
  `eval/load.eval.ts:335-385` into `load-<runId>.json`; fault
  totals per kind when fault injection is on.

When continuous export becomes real, the seam is clear: every
receipt is already a proto-metric with `runId` + `caseId` as
labels; a nightly job could `curl` them into any TSDB without
touching the runner.

Alerting: no threshold, no notification. The regression gate
(`eval/gate.eval.ts:135`) is the closest thing — a *deploy-time*
alert that fires as a non-zero CI exit code if any judge dimension
regresses by more than 10pp against baseline.
→ see `07-regression-gate-and-baseline.md`

## 5. traces-and-request-lifecycles

**Two lifecycles, both fully instrumented; no cross-hop tracing.**

The two request lifecycles:

- **Live investigation** — `GET /api/agent?insightId=…&step=diagnose`
  or `&step=recommend`. Ten wall-clock phases named by
  `recordPhase`:
  `schema_bootstrap`, `list_tools`, `intent_classify`,
  `query_answer`, `diagnostic_investigate`,
  `recommendation_propose`. All in `app/api/agent/route.ts:222-300`.
- **Live briefing** — `GET /api/briefing`. Four phases named by
  `recordPhase`: `schema_bootstrap`, `coverage_gate`, `list_tools`,
  `monitoring_scan`. All in `app/api/briefing/route.ts:210-286`.

Each phase is a wall-clock delta stashed into a local `phases[]`
array; the summary log emits the whole array in the `finally`
block. The phase log is per-*request*, not per-tool-call — the
tool-call level lives on the NDJSON wire as
`tool_call_start` / `tool_call_end` events with `durationMs`.

Causal chain, per investigation:

```
  browser useInvestigation  (lib/hooks/useInvestigation.ts:47)
       │  fetch(/api/agent?...)
       ▼
  route.GET  (app/api/agent/route.ts:111)
       │  makeDataSource(mode, sid, override)
       ▼
  DataSource  (bloomreach or synthetic; lib/data-source/)
       │
       ▼
  DiagnosticAgent.investigate  (lib/agents/diagnostic.ts:46)
       │  wraps AptKit primitive
       ▼
  AptKit agent loop  (@aptkit/core)
       │  onCapabilityEvent for every step
       ▼
  BloomingTraceSinkAdapter.emit  (lib/agents/aptkit-adapters.ts:157)
       │  fans out to hooks
       ▼
  route.send(AgentEvent)  (app/api/agent/route.ts:192)
       ▼
  NDJSON wire  →  browser dispatch
```

The AptKit → Blooming seam is `BloomingTraceSinkAdapter`
(`lib/agents/aptkit-adapters.ts:149-184`). Every AptKit
`CapabilityEvent` fans out three ways: to `onCapabilityEvent` (raw,
for evals), to Blooming's internal per-type routing (text →
`onText`, tool → `onToolCall` / `onToolResult`), which then feeds
`send()` in the route → NDJSON on the wire. One event, three
consumers, one adapter.
→ see `04-capability-trace-fanout.md`

Cross-hop tracing: none. The browser → route hop is a plain
`fetch`; no `traceparent` header. The route → MCP hop is a plain
MCP SDK client call; no trace context propagation. The correlation
ID (`sessionId`) is set by the server on cookie mint and read on
subsequent calls, but nothing wires it into the model or MCP
request as a header.

## 6. state-snapshots-and-debugging-boundaries

**State snapshots are receipts; before/after is baseline vs
candidate.**

State inspection points:

- **Investigation cache file** — `.investigation-cache.json` in
  dev, written by `saveInvestigation`
  (`lib/state/investigations.ts:30-41`). This is a full replay-able
  event stream keyed by `insightId`; the `/api/agent` route reads
  from it first (`route.ts:127`) if `?live=1` is not set. Cache-first
  replay is *itself* a debugging tool — a bad prod investigation can
  be exported from the cache file and re-inspected offline.
- **Session's in-memory insights** — `lib/state/insights.ts` (not
  fully read here) holds per-session insights + anomalies; scoped to
  the `sessionId` cookie so concurrent sessions can't collide.
- **Demo snapshot** — `lib/state/demo-investigations.json` +
  `lib/state/demo-insights.json` are committed fallback state; the
  cache-first read at `route.ts:127` picks these up when the in-mem
  and dev-file paths miss.
- **Eval receipts** — the definitive state snapshot for post-hoc
  analysis. Each receipt contains the full anomaly, every tool
  call's args and result (truncated to 4000 chars, `route.ts:98-102`
  and `run.eval.ts:145-147`), the diagnosis, the recommendations, and
  the judge verdicts.

Debugging boundaries — where the seam supports intercept /
substitute:

- **`DataSource` port** (`lib/data-source/types.ts`, implementations
  in `bloomreach-data-source.ts`, `synthetic-data-source.ts`,
  `mcp-data-source.ts`). Swap it in the factory and the same agent
  code runs against fake data. This is what the evals do — the
  goldens run against `SyntheticDataSource` so no OAuth is needed
  and every run is deterministic.
- **`FaultInjectingDataSource`** (`lib/data-source/fault-injecting.ts`)
  wraps *any* DataSource and forces the four failure modes
  (`timeout`, `rate_limit`, `server_error`, `malformed_json`) at
  configurable per-kind rates. Seeded PRNG makes runs
  reproducible. This is the controlled-experiment surface — force
  a fault, observe the retry ladder, observe the graceful
  degradation, count the faults in the receipt.
- **`onCapabilityEvent`** on `AgentHooks` — captures every raw
  AptKit event without touching agent internals. This is what
  makes token + cost math possible offline: the receipt captures
  every event, the report replays the events through
  `summarizeUsage` + `estimateCost`.

Before/after: the receipt shape + `runId` lets you compare any two
runs. `eval/gate.eval.ts:112-148` does exactly this at the
per-dimension pass-rate level; a person can do it at the per-case
receipt level with `diff <(jq . baseline-01-…) <(jq . candidate-01-…)`.

## 7. incident-analysis-and-prevention

**The 300s budget breach is the one modeled incident; guarded by
the budget tracker + traced by the phase log.**

The named production incident this repo has actually been designed
around is the 300s Vercel Pro route budget:

- **Signal** — the summary log fires in the `finally` block, so a
  route that hit the 300s cap still emits its `phases[]`. The last
  entry in `phases[]` names the phase that burned the budget.
  `aborted: req.signal.aborted` disambiguates client cancel from
  server timeout.
- **Guard** — `BudgetTracker` (`lib/agents/budget.ts:41-77`) is
  created per investigation and shared across
  `DiagnosticAgent` + `RecommendationAgent`. Every model turn calls
  `AnthropicModelProviderAdapter.complete()`
  (`aptkit-adapters.ts:59-66`) which checks `budget.exceeded()`
  BEFORE dispatching. On breach it throws `BudgetExceededError`;
  the route catches it (implicit — falls through the generic error
  path at `route.ts:308-321`) and emits a graceful NDJSON `error`
  event.
- **Cost-side prevention** — Phase-3 prompt caching in
  `aptkit-adapters.ts:85-89`: the system prompt is wrapped in an
  `ephemeral` cache breakpoint on every `complete()` call. First
  call is `cache_creation` (~1.25× normal), every subsequent call
  within 5 min is `cache_read` (~0.1×). For a ~10-turn diagnostic
  run this is a ~80% reduction on the system-prompt input token
  cost. Landing verified via the per-turn log's
  `cache_read_input_tokens` field.
- **Retry-side prevention** — the MCP transport's per-call
  `AbortSignal.timeout(30_000)` (`lib/mcp/transport.ts:38`) bounds
  any single tool call to 30s. Composed with the client's
  `req.signal` via `composeSignals`
  (`transport.ts:173-189`) so whichever fires first cancels the
  call. This prevents one stuck MCP call from monopolizing the
  route's 300s.

The fault-injection surface (see lens 6) is the regression guard
for the retry-and-degrade paths. The regression gate is the
quality regression guard.

Runbooks / post-mortems: not yet exercised. There is no
`RUNBOOK.md`, no `POSTMORTEMS/` directory, no incident template.
The eval receipt structure is what a post-mortem *would* attach
if there were one — full case reproduction on disk.

## 8. debugging-observability-red-flags-audit

The ranked blind spots, worst first. Each is real — no invented
finding to fill the section.

### R1. `console` is the only sink

Rank: highest, because it's the ceiling on how much observability
scales without work. Every log line ends up in either the browser
devtools or Vercel's log stream. Grep works fine for one incident;
it doesn't work for "did the p95 shift over the last 100 requests"
without pulling everything into a spreadsheet.

- Evidence: every log call site in the repo is `console.log` or
  `console.error`. Grep across `lib/` and `app/`:
  `lib/agents/aptkit-adapters.ts:97`, `app/api/agent/route.ts:336`,
  `app/api/briefing/route.ts:322` — plus the six error-path
  `console.error`s wrapped in `redactSecrets(formatError(…))`.
- Consequence: metrics-shaped questions ("what fraction of
  briefings hit the 30s MCP timeout in the last hour?") don't have
  an answer without ad-hoc log-parsing.
- Move: the fix isn't a logger library; the fix is an aggregation
  seam. A `logStructured(shape)` shim that today wraps
  `console.log` but tomorrow can also `fetch` to an OTLP HTTP
  endpoint. Cheap now, cheaper before there's a second sink.

### R2. No trace-ID propagation across hops

Rank: high, because the only correlation ID today is `sessionId`,
which is *per-user*, not *per-request*. A user with two open tabs
firing two briefings gets two log streams tagged the same way.

- Evidence: no `traceparent` / `traceId` in any header threading
  in `app/api/*/route.ts`; no request-scoped context passed into
  the agent classes.
- Consequence: interleaved logs from two concurrent requests
  can't be untangled without timestamps + heuristics.
- Move: mint a `requestId = crypto.randomUUID()` at the top of
  each route, thread it into every `console.log` payload, and
  into the `send()` closure so it also lands on the NDJSON wire.
  One field, ~5 lines per route, fully additive.

### R3. Client-side error visibility is a black hole

Rank: high. The browser side of the observability map is
`readNdjson` → dispatch. If the ndjson parser or the dispatch
handler throws, the error stays in the browser console. Nothing
reports it back.

- Evidence: `lib/hooks/useInvestigation.ts:206-208` catches the
  outer async error and calls `setError`, but there's no browser
  → server "please log this" round-trip. The `readNdjson`
  malformed-line handler
  (`lib/streaming/ndjson.ts:47-49`) defaults to silent skip.
- Consequence: a subtle producer bug (e.g. an `unknown` result
  that doesn't round-trip through JSON cleanly) surfaces as
  "the trace item stopped updating" with no server-side signal.
- Move: pass `onMalformed` to `readNdjson` and post the failing
  line to a `POST /api/log-malformed` route. Also fire a
  `window.addEventListener('error'|'unhandledrejection', …)` in
  the app shell that pings the same route.

### R4. Prompt-caching evidence lives only in logs

Rank: medium. The `cache_read_input_tokens` on the per-turn log
is the sole live evidence that caching is landing. The receipts
capture `inputTokens` + `outputTokens` but *not* the cache split
(comment at `aptkit-adapters.ts:103-106` explicitly names this —
aptkit's `model_usage` event doesn't expose the cache fields).

- Evidence: `budget.ts:29-34` (`BudgetSnapshot`) has no cache
  tokens; `report.eval.ts` prints totals but not cache hit rate;
  receipt shape at `run.eval.ts:341-395` has no cache field.
- Consequence: cache regressions are invisible in receipts.
  Someone edits a system prompt and blows the cache; the token
  totals go up but no dimension in the baseline says
  "cache hit rate dropped."
- Move: capture `response.usage.cache_read_input_tokens` +
  `cache_creation_input_tokens` in the adapter's usage log
  (already emitted) but *also* pipe them into a
  `CacheStatsCollector` alongside the `BudgetTracker`, snapshot
  it into the receipt, and add a `cache_hit_rate` line to the
  report.

### R5. No `/health` or `/ready` endpoint

Rank: medium-low. No probe route means Vercel and any external
uptime monitor can only measure end-to-end briefing latency as a
proxy for health. If MCP auth is broken but briefings still 200
via the cached demo path, health is silently green.

- Evidence: `find app/api -name route.ts` — no `health/` or
  `ready/`.
- Consequence: outages that only affect the *fresh* path stay
  invisible until someone tries to run a fresh investigation.
- Move: `GET /api/health` returns `{ ok, checks: { mcp: 'ok' |
  'auth-required' | 'timeout', anthropic: 'ok' | 'no-key' } }`
  after non-destructive probes. Sub-second budget.

### R6. Dev cache file has no rotation

Rank: low. `.investigation-cache.json` grows unbounded per
insightId key. Not a runtime problem (dev only) but eventually a
grep-slowdown / disk problem.

- Evidence: `lib/state/investigations.ts:32-37` always
  `readJson` → merge → `writeFileSync`. No TTL, no eviction.
- Consequence: a dev machine that runs a lot of investigations
  ends up with a fat cache file. Then git tries to include it
  (`.gitignore` catches it; verified) but the cache read gets
  slow.
- Move: cap at N most-recent insightIds, or add a
  `npm run cache:clear` script.

### R7. Log volume per investigation is high, unbounded

Rank: low. Every model turn emits a JSON line
(`aptkit-adapters.ts:97`); a diagnostic run is ~10 turns, a full
investigation (diagnose + recommend) is ~20. At load N=20 that's
~400 lines per load run. Fine today; a problem at real
concurrency.

- Evidence: no sampling in the per-turn log; no log-level flag
  gating it.
- Consequence: at 100 concurrent investigations the log stream is
  ~2000 lines/min just from the model-usage logs.
- Move: a debug-flag gate (`process.env.LOG_MODEL_USAGE`) or
  head-sampling (1-in-N per session).
