# Metrics, SLIs, SLOs, and alerts

**Industry name(s):** metrics, service-level indicators, service-level objectives, error budgets, alerts, RED method (Rate, Errors, Duration), USE method (Utilization, Saturation, Errors)
**Type:** Industry standard · Language-agnostic

> Honest verdict: blooming insights has a metric *primitive* — every MCP call returns `durationMs` measured wall-clock around the underlying transport — and nothing else. There's no histogram, no aggregator, no time-series store, no rollup, no SLO definition, no alerting threshold, no on-call rotation. This file teaches the canonical pillars (RED, SLI/SLO, error budgets, alerting) because they're load-bearing in any production system — and then names, file:line by file:line, exactly what is and isn't in this repo. The strength is real (`durationMs` is the right primitive); the gap is also real (none of it is aggregated). Treat this as the section that's most explicitly `not yet exercised` past the per-call number.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Metrics sit *across* every layer — every layer has signals worth counting. The canonical three pillars (logs / metrics / traces) split blooming insights cleanly: traces strong, logs weak-but-rare, metrics primitive-only. This file walks the metrics pillar.

```
  Zoom out — where metrics would sit (and don't)

  ┌─ UI ────────────────────────────────────────────┐
  │  signals: render time, hydration time, errors    │
  │  STATUS: nothing measured                        │
  └─────────────────────────▲───────────────────────┘
                            │
  ┌─ Route handler ─────────┴───────────────────────┐
  │  signals: request rate, error rate, latency      │
  │  STATUS: nothing aggregated                      │
  └─────────────────────────▲───────────────────────┘
                            │
  ┌─ Agent loop ────────────┴───────────────────────┐
  │  signals: turns/run, tool calls/run, token usage │
  │  STATUS: nothing measured                        │
  └─────────────────────────▲───────────────────────┘
                            │
  ┌─ MCP client ────────────┴───────────────────────┐  ← we are here
  │  signals: per-call durationMs, fromCache,        │
  │           retry count, error                     │
  │  STATUS: durationMs IS measured per call         │
  │          NOT aggregated anywhere                 │
  └─────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** A metric is a *number-over-time* signal. An SLI is the metric you choose to measure user-visible health by. An SLO is the target threshold on that SLI ("99% of requests under 1s"). An alert is what fires when the SLI breaches the SLO. blooming insights has one *raw signal* (`durationMs` per MCP call); it has no SLI choice, no SLO threshold, no alert pipeline. The reason this section is short is honest, not lazy.

---

## Structure pass

**Layers.** Four layers from raw signal to alert: (1) raw signal (per-event number), (2) aggregator (histogram / rollup), (3) SLO definition (what's "healthy"), (4) alerting (what fires on breach).

**Axis: cost (latency, money, ops attention).** Trace it across the layers. Raw signal: ~0 cost (a `Date.now()` subtraction). Aggregator: cheap if in-process, expensive if shipped to a TSDB. SLO definition: costs nothing in code, costs alignment time in conversation. Alerting: costs ops attention — and alert fatigue is the dominant failure mode in mature systems. Each layer has a cost shape that flips at the seam.

**Seams.** The load-bearing one — and the one blooming insights doesn't cross — is between raw signal and aggregator. `durationMs` exists per event; nothing aggregates it. The seam is *unbuilt*: there's no `lib/metrics.ts`, no `histogram.observe(d)`, no rollup. A subsequent seam, also unbuilt: aggregator → SLO. And a third: SLO → alert. The whole right side of the pipeline is the gap.

```
  Structure pass — metrics

  ┌─ 1. LAYERS ───────────────────────────────────┐
  │  raw signal · aggregator · SLO def · alerting  │
  └────────────────────────┬───────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼────────────────────────┐
  │  cost: what does each layer cost (latency,    │
  │  $, ops attention)?                            │
  └────────────────────────┬───────────────────────┘
                           │  trace, find flips
  ┌─ 3. SEAMS ────────────▼────────────────────────┐
  │  raw↔aggregator: UNBUILT (the gap starts here) │
  │  aggregator↔SLO: UNBUILT                       │
  │  SLO↔alert: UNBUILT                            │
  │  (one of these is the smallest first step;     │
  │   raw→aggregator is the load-bearing one)      │
  └────────────────────────┬───────────────────────┘
                           ▼
                   Block 4 — How it works
```

Skeleton mapped. The mechanics walked below are canonical; the codebase implementation is *only* the raw signal.

---

## How it works

**Mental model.** Metrics flow through a pipeline: raw event → bucketed counter or histogram → query against the bucket → threshold check → alert. The same shape whether you're using Prometheus, Datadog, or a homegrown in-process counter. Each rung of the pipeline answers a different question.

```
  Pattern — the metrics pipeline

  per-event signal     aggregator              query              alert
  ─────────────────    ────────────────────    ─────────────────  ──────────
  durationMs           histogram (p50/p95/p99)  "what's p95 over   "p95 > 1s for
                       counter (rate per min)    the last 5min?"    5min → page"
  fromCache: bool      counter (hit rate)        "what's the        —
                                                  cache hit rate?"
  error: string|null   counter (error rate)      "what's the        "error rate >
                                                  error rate?"        1% for 5min"

  blooming insights:   ───── nothing ─────       ──── nothing ────  ──── nothing ──
   has durationMs                                                    (no alerts at all)
```

The diagram IS the gap. blooming insights builds rung 1; rungs 2–4 don't exist.

### Move 2 — walk the pillars

#### Rung 1 — raw signal (the only rung built)

The reader anchor: you've wrapped a `fetch()` with `const t0 = performance.now(); … const dt = performance.now() - t0`. Same shape. `lib/mcp/client.ts:112` captures `start = Date.now()`; line 134 computes `durationMs = Date.now() - start`. The number rides on the `CallToolResult` and then into `tool_call_end.durationMs` on the trace.

What happens: every MCP call produces one `durationMs`. Cache hits short-circuit to `durationMs: 0` (line 108). Errors don't get cached but they do get measured. The number is *true* per-call wall-clock for the live call, including the rate-limit retry waits — so a call that retries 3× for 30s ends up with `durationMs ≈ 30000`. That's deliberate; it's the latency the user actually experienced.

Boundary: the number is *only* the MCP transport call duration. Agent loop time (Anthropic round-trips) is NOT measured. So if a diagnostic run takes 60s and only 5s is in MCP, the `durationMs` sum across the trace's tool calls = 5s and the other 55s is invisible.

```
  Rung 1 — the only rung blooming insights builds

  callTool('execute_analytics_eql', {eql: '…'})
    │  start = Date.now()                        ← raw signal start
    │  await liveCall(...)                       ← may include retry waits
    │  durationMs = Date.now() - start           ← raw signal end
    ▼
  { result, durationMs: 340, fromCache: false }
                          ↑
                          └─ surfaces on tool_call_end.durationMs
                             in the trace; NEVER aggregated
```

#### Rung 2 — aggregator (the missing seam)

The reader anchor: you've used `Array.prototype.reduce` to compute an average or a max from a list of numbers. An aggregator is the same idea, but online — every new number updates the bucket. A histogram bucket counts how many observations fell into each range (`0–10ms: 12 obs`, `10–100ms: 47 obs`, etc.). From that bucket you can compute percentiles cheaply.

What it would look like in this repo: a `lib/metrics.ts` with `histogram.observe(toolName, durationMs)`. The route handler would call it on each `tool_call_end`. The bucket would live in memory (per-instance on Vercel — fine for proof-of-concept, useless for production aggregation) or be shipped to a backend.

What's actually here: nothing. No `metrics.ts`, no histogram library, no rollup. The trace shows you `durationMs` for *this run*; nothing tells you "what's the p95 over the last hour."

Boundary: on Vercel's serverless model, in-memory aggregation is per-instance and dies on cold start. So a real aggregator here needs to ship the signal to a TSDB (Prometheus remote-write, Datadog, etc.) or use Vercel's built-in `@vercel/analytics`. Neither is wired up.

```
  Rung 2 — what's missing

  desired:
    histogram.observe(toolName, durationMs)
      → in-memory bucket OR shipped to TSDB
    histogram.percentile(toolName, 0.95)
      → "p95 for execute_analytics_eql over the last hour"

  current:  ─ nothing —
    not built; no place that calls observe();
    no TSDB integration; no aggregator at all
```

#### Rung 3 — SLO definition (the conceptual gap)

The reader anchor: you've shipped a feature and someone asked "what's the SLO?" SLO = the explicit threshold on the SLI. For a typical web app: "99.9% of requests succeed in under 500ms." For an agent app: "95% of investigations complete in under 60s." For blooming insights: nothing has been written down.

What would change: an SLO doc would name (a) the SLI metric (`investigation_duration_seconds`), (b) the threshold (95th percentile < 60s), and (c) the time window (rolling 7d). The SLO doesn't have to be aspirational — it can codify the current behavior so you'd *notice* if it regressed.

What's actually here: no `docs/slos.md`, no slo config file. The implicit SLO is "it works on my machine." The route's `maxDuration = 300` (`app/api/agent/route.ts:20`) is the only quantitative time constraint anywhere — but that's a hard ceiling enforced by Vercel, not an SLO target.

Boundary: an SLO without an aggregator is performative — you can't measure breach without rung 2. So the SLO step is gated on building rung 2.

#### Rung 4 — alerting (the action gap)

The reader anchor: you've gotten a PagerDuty page. Alerting = the rule that converts an SLO breach into a notification. For blooming insights: nothing fires anywhere. No PagerDuty, no Opsgenie, no email, no Slack webhook, no rotation, no escalation.

What's actually here: silence. If the route catches throw, `console.error` logs to Vercel's stdout — *nothing* notifies a human. If the cache replays a stale snapshot for a week, no alert. If `durationMs` for MCP calls quadruples, no alert.

Boundary: solo repo, no SLA to a customer, no PagerDuty plan. Alerting is rationally deferred until there's someone to wake up. The point of naming it explicitly: when the repo grows past one user, this is the rung that goes from "rationally deferred" to "irresponsibly missing."

#### Move 3 — the principle

A metric without an aggregator is a dot on a chart that doesn't get drawn. blooming insights has the dots (every `tool_call_end.durationMs`) — what it's missing is the chart. The lesson generalises: measuring the right thing (per-call latency on the most expensive boundary, the MCP transport) is the high-leverage part; building the histogram on top of an existing measurement is mechanical. Don't be precious about the aggregator; *do* be precious about choosing the right thing to measure. The repo got the second half right and deferred the first half.

---

## Primary diagram

The full pipeline, with what's built vs not built marked explicitly.

```
  Metrics pipeline — what blooming insights builds vs not

  ┌─ Rung 1: raw signal ────────────────────────────────────────┐
  │  ★ BUILT ★                                                   │
  │  lib/mcp/client.ts:112,134                                   │
  │    start = Date.now() … durationMs = Date.now() - start      │
  │  surfaces on tool_call_end.durationMs in the trace           │
  └─────────────────────────▲───────────────────────────────────┘
                            │
  ┌─ Rung 2: aggregator ────┴───────────────────────────────────┐
  │  ─ NOT BUILT ─                                               │
  │  desired: histogram.observe(toolName, durationMs)            │
  │  blocker: no metrics module, no TSDB integration, no         │
  │           in-process accumulator that survives cold starts    │
  └─────────────────────────▲───────────────────────────────────┘
                            │
  ┌─ Rung 3: SLO definition ┴───────────────────────────────────┐
  │  ─ NOT BUILT ─                                               │
  │  desired: docs/slos.md with SLI + threshold + window         │
  │  closest existing: app/api/agent/route.ts:20 maxDuration=300 │
  │                    (a hard ceiling, not an SLO target)        │
  └─────────────────────────▲───────────────────────────────────┘
                            │
  ┌─ Rung 4: alerting ──────┴───────────────────────────────────┐
  │  ─ NOT BUILT ─                                               │
  │  desired: page/email/slack on SLO breach                     │
  │  blocker: no rotation, no SLA, no aggregator to alert on     │
  └─────────────────────────────────────────────────────────────┘

  rung 1 strong · rungs 2–4 not yet exercised
```

---

## Implementation in codebase

### Use cases

Three real moments the `durationMs` primitive gets used today (no aggregation, just per-call surfacing):

- **Showing the user how long a tool call took.** `components/investigation/ToolCallBlock.tsx` renders `durationMs` next to the tool name. It's per-call evidence: "execute_analytics_eql · 340ms." Useful for "wait, why did that take so long?" but tells you nothing about typical behavior.

- **The `/debug` page surfaces `durationMs` on each MCP call.** `app/debug/page.tsx:71–72` reads `body.durationMs` from `/api/mcp/call` and displays it under the result pane. This is the *only* place in the codebase that *acts* on `durationMs` beyond rendering it — and the action is "render it." Telling.

- **The briefing route describes a slow tool call by query text.** `app/api/briefing/route.ts:62–67` `describeToolCall` prefers the actual EQL/query text over the tool name, so the trace line reads "select count(*) from purchases where …" instead of just "execute_analytics_eql." Combined with `durationMs`, the trace tells you which *query* was slow, not just which *tool*. Practical for ad-hoc debugging; no rollup.

### Code side by side, with a line-by-line read

The one place in the codebase that *measures* the metric — `lib/mcp/client.ts`:

```
  lib/mcp/client.ts  (lines 102–146, abbreviated)

  const cacheKey = `${name}:${JSON.stringify(args)}`;
  const ttl = options.cacheTtlMs ?? 60_000;

  if (!options.skipCache) {
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return { result: cached.result as T, durationMs: 0, fromCache: true };  ← cache hit: durationMs=0
    }                                                                          ← (not "the call took 0ms",
                                                                                   "no live call happened")
  }

  const start = Date.now();                                                    ← ★ raw signal start ★
  let result = await this.liveCall(name, args);

  …  rate-limit retry loop (waits accumulate into the eventual durationMs) …

  const durationMs = Date.now() - start;                                       ← ★ raw signal end ★

  if ((result as any)?.isError === true) {
    return { result: result as T, durationMs, fromCache: false };              ← errors carry durationMs too
  }
  …
  return { result: result as T, durationMs, fromCache: false };                ← happy path: durationMs surfaces
        │
        └─ this is the entire metrics surface in the codebase.
           One Date.now() pair, surfacing one number per call.
           Everything downstream just renders or stringifies it;
           nothing accumulates it.
```

The one place that *uses* the metric for a decision (sort of) — `/debug`:

```
  app/debug/page.tsx  (lines 71–72)

  setOutput(JSON.stringify(body.result, null, 2));
  setDurationMs(typeof body.durationMs === 'number' ? body.durationMs : null);
        │
        └─ this is the only consumer that puts durationMs in component state
           for display. There is no consumer anywhere that uses durationMs
           to make a decision (skip a tool, retry differently, alert, …).
           Telling: the metric is currently informational only.
```

The hard ceiling that *acts like* an SLO but isn't one — `app/api/agent/route.ts:20`:

```
  app/api/agent/route.ts  (line 20)

  // 300s = Vercel Pro's max. A live investigation (diagnostic → recommendation)
  // runs ~100-115s under the ~1 req/s MCP limit; 60s (Hobby) cannot fit it.
  export const maxDuration = 300;                                              ← hard kill, not SLO
        │
        └─ this is enforced by Vercel: at 300s, the request is killed
           regardless of state. The comment "runs ~100-115s" is the only
           latency budget written anywhere — it's an implicit SLO that
           lives in a comment, not a measurement or threshold.
```

---

## Elaborate

The canonical metric methodologies — Google's SRE Book, Brendan Gregg's USE method, Tom Wilkie's RED method — all start with the same question: *what's the smallest set of signals that tells you the system is healthy?* For a request-response service, RED is the answer: Rate (req/s), Errors (error count or %), Duration (latency percentiles). For blooming insights, the RED triple would be: investigations/min, error rate (route + agent), and p50/p95/p99 of total investigation duration. None of it is measured today.

The reason this is acceptable today: the user is the developer. The system has effectively one human watching it run. Aggregated metrics matter when nobody is watching the trace in real time — when the only signal that something is wrong is a number on a dashboard or a page from PagerDuty. When the trace IS the product (the user is staring at it as it runs), the metrics pipeline is genuinely lower priority. That tradeoff is correct *at this stage*; it stops being correct the moment the repo serves a customer base.

The smallest credible first step: write a `lib/metrics.ts` with an in-memory histogram per tool name. Call `metrics.observe(toolName, durationMs)` next to where the route calls `send({type:'tool_call_end', ...})`. Expose a `/api/metrics` route that dumps the histogram in Prometheus exposition format. That's an afternoon of work and turns rung 1 into rung 1+2. Rungs 3 and 4 follow once there's a TSDB to scrape it.

A bigger question worth naming: this repo has Anthropic API spend. Token usage per investigation is a metric the agent layer *could* measure (Anthropic's SDK returns it on every response) but currently doesn't. If you added one metric beyond `durationMs`, that's the one — cost per investigation is a business signal, not just a technical one.

---

## Interview defense

**Q1. Why is the metrics section the shortest one in this guide?**

Because the rung-1 primitive (`durationMs` per MCP call) is the entire metrics surface. There's no aggregator, no SLO, no alert. The honest answer for this stage is "we picked the right thing to measure and deferred the aggregation"; the dishonest answer would be to invent a metrics story to fill the page. The aggregation gap is acceptable today (the user is watching the trace live) and becomes irresponsible when there's no human in the loop. The smallest first move would be `lib/metrics.ts` with an in-memory histogram per tool name — an afternoon of work — turning rung 1 into rung 1+2.

```
  built     │  not built       │  rationale
  ──────────┼──────────────────┼────────────────────────────────
  rung 1    │  rungs 2, 3, 4   │  user watches the trace live;
            │                  │  no SLA; no rotation; solo repo
            │                  │  → aggregator becomes urgent at
            │                  │     customer #1
```

**Anchor:** the metric primitive IS measured (`durationMs`); the gap is everything downstream.

**Q2. What's the right SLI for an agent app?**

End-to-end investigation duration is the user-visible signal — they watch the trace render, and the time-to-`done` is the latency they feel. For blooming insights specifically: p95 of `investigation_duration_seconds` for completed investigations, with a target of `<60s` for diagnose and `<60s` for recommend. The comment in `route.ts:20` already says "runs ~100-115s" combined — so the SLO would codify what's currently working, not stretch beyond it. Token cost per investigation is the right *business* SLI (Anthropic spend is the dominant variable cost) but it would require wiring the SDK's usage object into the metric pipeline.

```
  SLI candidates                       priority
  ──────────────────────────────────   ────────
  investigation_duration_seconds (p95) high
  agent_error_rate (% errored runs)    high
  tokens_per_investigation             medium (business)
  mcp_call_latency (p95, per tool)     medium
  cache_hit_rate                       low (correctness OK)
```

**Anchor:** start from the user-visible signal. Latency-to-done is what the user feels; rate of errored runs is what stops them mid-way.

---

## Validate

1. **Reconstruct.** Without looking, draw the 4-rung metrics pipeline and mark which rung blooming insights builds and which it doesn't. Test: can you name the file:line for the rung that IS built?
2. **Explain.** Why does a cache hit return `durationMs: 0`? What would change if it returned the last live-call duration instead? Anchor: `lib/mcp/client.ts:108`.
3. **Apply to a scenario.** A user reports investigations have gotten slower this week. With today's tooling, walk the steps you'd take to confirm. Then re-walk it assuming `lib/metrics.ts` existed with a histogram per tool name.
4. **Defend the decision.** The repo has a `durationMs` primitive but no aggregator. Argue that this is the right tradeoff today. Then argue what changes the answer.

---

## See also

- `01-observability-map.md` — the MCP client layer in the map; `durationMs` is its evidence.
- `05-traces-and-request-lifecycles.md` — `durationMs` surfaces on `tool_call_end`; the trace is where it lives today.
- `08-debugging-observability-red-flags-audit.md` — where this gap is ranked against the others (high consequence, low cost-to-fix for rung 2).
- `.aipe/study-performance-engineering/` — owns the question "what to *do* with `durationMs`" once aggregation exists.
