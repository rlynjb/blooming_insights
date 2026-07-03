# 00 — Overview

## The observability map

Three live surfaces, two receipt classes. That's the whole pile.

```
  Blooming's observability map — one page

  ┌─ browser ─────────────────────────────────────────────────────────┐
  │  useInvestigation → readNdjson → dispatch(AgentEvent)              │
  │                        ▲                                           │
  └────────────────────────┼───────────────────────────────────────────┘
                           │ NDJSON, one event per line
  ┌─ Next route (Node) ────┼───────────────────────────────────────────┐
  │  /api/agent            │      /api/briefing                        │
  │  /api/agent → stream ──┘  → also NDJSON, shares AgentEvent shape   │
  │        │                                                           │
  │        ├─→ send(AgentEvent)  ← LIVE WIRE (surface 1)               │
  │        ├─→ recordPhase(name, t) → phases[]                         │
  │        └─→ finally { console.log({ route, sessionId, phases }) }   │
  │                                       ▲                            │
  │                                       └─── ONE-LINE SUMMARY LOG    │
  │                                            (surface 2)             │
  │                                                                    │
  │  BloomingTraceSinkAdapter.emit(CapabilityEvent)                    │
  │        │                                                           │
  │        ├─→ hooks.onCapabilityEvent(ev)  ← RAW APTKIT TRACE hook    │
  │        └─→ hooks.onToolCall / onToolResult / onText                │
  └────────────────────────────────────────────────────────────────────┘
                           │
                           │  in dev only: mem-write + JSON file
                           ▼
                    .investigation-cache.json     ← DEV CACHE (surface 3)

  Evals fill the pile that queries are answered from:

  ┌─ eval runner (vitest) ─────────────────────────────────────────────┐
  │  run.eval.ts   → eval/receipts/<caseId>-<runId>.json  (per case)   │
  │  load.eval.ts  → eval/load-receipts/load-<runId>.json (dist stats) │
  │  baseline.eval → eval/baseline.json (committed reference)          │
  │  gate.eval.ts  → eval/gate-<runId>.json (candidate vs baseline)    │
  │  report.eval   → console table (p50/p95/p99 + tokens + cost)       │
  └────────────────────────────────────────────────────────────────────┘
```

The map is deliberately small. A monitoring stack, a metrics pipeline, a
trace collector — none of that is here yet. The signal is dense enough to
diagnose because it's *structured at the source*: every event is a typed
variant, every route emits the same summary shape, every receipt is JSON
you can grep.

## Ranked findings

Ranked by how consequential the mechanism is for actually diagnosing a
production incident today. Each links into the pattern file where it's
walked in full.

1. **The NDJSON `AgentEvent` wire is the *entire* live diagnostic
   surface.** If something goes wrong mid-investigation and the user tab
   is open, this stream is what tells you. Eight variants, one producer,
   four consumers, zero drift.
   → `01-ndjson-agent-event-wire.md`

2. **Receipts on disk are the *only* durable evidence.** The three
   in-process surfaces above (wire, phase log, dev cache) all evaporate
   when the request ends. Every retrospective — "did the p95 shift after
   Session B?" — reads receipts, not logs.
   → `02-receipts-as-evidence.md`

3. **The per-phase summary log is the incident signal for the 300s
   budget.** Every route handler emits *one line* in the `finally` block
   with `{ route, sessionId, mode, totalMs, phases, aborted }`. Fires
   even on throw. When someone reports "the investigation hung," this
   line tells you which phase burned the budget before the cancel landed.
   → `03-per-phase-timing-log.md`

4. **`onCapabilityEvent` at the AptKit seam gives you token + cost
   evidence for free.** The hook forwards every raw `CapabilityEvent`
   from the trace sink to whoever wants it — eval runner uses it to
   compute `summarizeUsage` + `estimateCost` per receipt.
   → `04-capability-trace-fanout.md`

5. **The budget tracker turns a runaway loop into a graceful NDJSON
   error.** Not just observability — a *pre-emptive* guard that costs
   nothing when the ceiling's clear and stops the bleed when it isn't.
   → `05-budget-tracker-as-guard.md`

6. **Redaction happens *before* the error text is stored.** Every
   `console.error` on the error path passes through `redactSecrets +
   formatError`, which walks the `.cause` chain and scrubs Bearer /
   OAuth tokens *before* the string ever reaches Vercel logs.
   → `06-log-redaction-and-error-chain.md`

7. **The regression gate is what makes the pile actionable.** Receipts
   without a baseline are numbers. `eval/gate.eval.ts` compares candidate
   vs `eval/baseline.json` per-dimension and fails the CI check if any
   dimension drops by more than 10pp.
   → `07-regression-gate-and-baseline.md`

## What's not yet exercised

Named honestly. If a lens finds nothing, it says so — no invented
findings to fill the template.

- **Metrics / SLIs / SLOs / alerts** — no Prometheus, no OTLP export,
  no PagerDuty, no `/metrics` endpoint, no alerting rules. The
  latency/cost numbers exist as receipts computed by an eval on-demand,
  not as continuously exported signals. When this matters: the first
  real user + a paging rotation.
- **Distributed tracing** — no OpenTelemetry, no trace IDs propagated
  across the browser → route → MCP hop. The closest thing is the
  session cookie (`bi_session`), which appears in every route's summary
  log and every receipt's `sessionId` — one correlation ID by
  convention, not by protocol.
- **Continuous log aggregation** — the `console.log` / `console.error`
  lines are picked up by Vercel's log tail if deployed there; there's
  no Datadog / Loki / ELK sink. The plan (see finding 3) is to make
  Vercel's log filter the query surface — one filter reads both routes
  because the summary shape matches.
- **Runbooks / incident post-mortems / on-call handoff** — no runbook
  directory, no incident template. The closest doc-of-the-kind is the
  eval `README.md`. When this matters: same trigger as the alerting.

## Reading order recap

`README.md` sets the frame. This file sets the map. `audit.md` walks the
8 lenses. The seven pattern files each isolate one mechanism.

The point is that the pile is small on purpose. Every mechanism does one
job; every job has a receipt or a log line or a wire event pointing at
where it broke. That's the whole design.
