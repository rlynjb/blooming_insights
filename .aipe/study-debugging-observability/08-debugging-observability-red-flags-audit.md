# Debugging & observability red-flags audit

**Industry name(s):** observability gap analysis, blind-spot audit, evidence-gap ranking
**Type:** Project-specific · ranked by consequence in this repo

> Read this file if you only have ten minutes. The other seven files walk *what's there*; this one ranks *what's missing* by consequence, names the evidence (file:line) for each verdict, and proposes the smallest first step for each gap. Verdict-first: the strongest finding is that the trace is unusually good and the metrics aggregator is the weakest link; the second strongest is that there's no structured logger and no Sentry, so a prod crash leaves a freeform stdout line as the only evidence; the third is that incident tooling past one example doesn't exist.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Red flags are gaps in the observability map (`01-observability-map.md`) ranked by *blast radius when they bite*. A gap with low blast radius (e.g. no client-side error tracking) ranks below a gap with high blast radius (e.g. no log correlation when a class of users hits the same crash). The ranking is repo-specific because the user base is the developer plus a demo audience — gaps that would be P0 in a prod customer system are P2 here.

```
  Zoom out — gaps ranked, mapped against the observability layers

  UI                  no client-side error tracker
  Route handler       no structured logger; 4× console.error
  Agent loop          ★ trace is strong here ★ — the rare bright spot
  MCP client          durationMs measured per call, never aggregated
  Provider            no upstream correlation (Anthropic / MCP request IDs)
  Cross-cutting       no Sentry, no PagerDuty, no SLOs, no runbooks
                      no backend trace sink (no OTel/Langfuse export)
```

**Zoom in — narrow to the concept.** A red-flags audit ranks risks by *consequence*, not by tidiness. "We should add Sentry" is not a P0 just because Sentry is industry-standard — it's a P0 if-and-only-if the cost of *not* having Sentry today is high. For this repo, the cost is moderate (the trace covers happy-path debugging; the gap bites on prod exceptions). So Sentry ranks high but not at the top. The metrics gap ranks higher because the primitive (`durationMs`) is already measured — the cost of the aggregator is one afternoon and the value is the difference between "watching one run" and "noticing a regression across runs."

---

## Structure pass

**Layers.** Two: gaps that have a *primitive in place* (just need wiring) vs gaps that need *new code from zero*. The first category is cheaper to fix and ranks higher per dollar spent.

**Axis: cost (effort to close the gap vs blast-radius if it bites).** Trace it: gap with primitive + low blast-radius = defer. Gap with primitive + high blast-radius = top of the list. Gap from zero + low blast-radius = defer indefinitely. Gap from zero + high blast-radius = strategic, plan for later.

**Seams.** The load-bearing one: "do we have the primitive?" If yes, the seam is between measurement and aggregation/visualization (cheap to cross). If no, the seam is between non-existence and a new module (expensive to cross). The metrics gap sits on the cheap side; the on-call rotation gap sits on the expensive side.

```
  Structure pass — red-flags audit

  ┌─ 1. LAYERS ───────────────────────────────────┐
  │  primitive-in-place gaps · zero-base gaps      │
  └────────────────────────┬───────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼────────────────────────┐
  │  cost: effort vs blast-radius                  │
  └────────────────────────┬───────────────────────┘
                           │  trace
  ┌─ 3. SEAMS ────────────▼────────────────────────┐
  │  measure↔aggregate: cheap (metrics gap)        │
  │  zero↔logger: cheap-medium (4-site swap)       │
  │  zero↔Sentry: medium (depends on logger)       │
  │  zero↔rotation: expensive (org change, not    │
  │                  code)                          │
  └────────────────────────┬───────────────────────┘
                           ▼
                   Block 4 — How it works
```

Skeleton mapped. Now the ranked list.

---

## How it works

**Mental model.** A red-flags audit is a *ranked triage list*. Each item has a verdict (P0 / P1 / P2 / P3), a single sentence describing the gap, the evidence for the verdict (file:line or absence-of-file), the consequence if it bites today, and the smallest first move. Read top-down; stop reading when items go below your remediation budget.

```
  Pattern — the ranked triage

  rank  gap                                    cost     blast radius
  ────  ─────────────────────────────────────  ───────  ─────────────────
  P0    metrics aggregator (rung 2 of the      low      high
        pipeline)                                       (regressions invisible)
  P0    structured logger (lib/log.ts)         low      high
                                                         (prod crashes opaque)
  P1    Sentry / error tracker                 medium   medium
                                                         (depends on P0)
  P1    upstream request-ID correlation        low      medium
        (Anthropic / MCP)
  P2    cache snapshot provenance              low      medium
        envelope                                        (regression analysis)
  P2    parallel-span pairing (spanId)         low      low (latent)
  P3    on-call rotation, runbooks, SLO defs   high     low (no SLA today)
  P3    backend trace sink (OTel/Langfuse)     high     low (UI has trace)
```

The diagram is the audit. The walks below give the evidence and the move for each.

### Move 2 — walk each red flag

#### P0 — no metrics aggregator (rung 2 of the pipeline)

The reader anchor: you've used Chrome's performance tab — per-event timing is shown, but you can also compute averages across events. blooming insights builds the per-event side (`durationMs` on every `tool_call_end`) and not the aggregate side. There's nothing that computes p95 of `execute_analytics_eql` over time, nothing that counts errors per route per hour, nothing that tells you "the average investigation got 20% slower this week."

Evidence: `lib/mcp/client.ts:112,134` measures `durationMs`. No `lib/metrics.ts`. No `@vercel/analytics`, no Prometheus client, no rollup module anywhere. The only place that consumes `durationMs` for display is `app/debug/page.tsx:71–72` (one tool call at a time).

Consequence if it bites: a class of regressions becomes invisible. You can't notice "the diagnostic agent has been 30% slower since last Tuesday" without an aggregator. You'd notice the individual slow run in the trace; you wouldn't notice the trend.

Smallest first move: `lib/metrics.ts` with an in-memory histogram per `toolName` and per `route`. Wire `metrics.observe(toolName, durationMs)` next to `send({type:'tool_call_end', …})` in both routes. Expose `/api/metrics` returning Prometheus exposition format. ~2 hours of work; turns rung 1 into rung 1+2.

```
  built     │  not built                       │  smallest first move
  ──────────┼──────────────────────────────────┼─────────────────────
  rung 1    │  rung 2 (aggregator)              │  lib/metrics.ts
            │  rung 3 (SLO defs)                │  + observe() at the 2
            │  rung 4 (alerting)                │    send sites
            │                                   │  (~2 hours)
```

#### P0 — no structured logger (lib/log.ts)

The reader anchor: you've added pino or winston to a Node project. Same gap here. The four `console.error` calls in the route catches give you a freeform string in Vercel's stdout — no level, no fields, no correlation, no redaction.

Evidence: 4× `console.error` total: `app/api/agent/route.ts:160,256`; `app/api/briefing/route.ts:166,248`. No `lib/log.ts`, no logger import anywhere in `lib/`.

Consequence if it bites: when a class of users hits the same crash, you `grep` strings in Vercel's log explorer instead of filtering by `level:error AND event:agent.crash AND route:/api/agent`. The aggregation is manual and slow. Also: no redaction layer means if an `AUTH_SECRET`-bearing object ever ends up in a thrown error's payload, it surfaces in stdout in cleartext.

Smallest first move: a ~30-line `lib/log.ts` exposing `log.error({event, ...fields}, err)`, serializing to NDJSON, with a redaction list. Swap the 4 catches. No new dependency required — `JSON.stringify` is enough. ~30 minutes of work.

```
  before:  console.error('[agent] error:', e)
  after:   log.error({ event: 'agent.crash', insightId, route, err: e })
                                              ↑           ↑       ↑
                                              correlation route   typed error
```

#### P1 — no Sentry / error tracker

The reader anchor: you've added `@sentry/nextjs` to a Next app. 5 lines of setup plus `Sentry.captureException` at each catch.

Evidence: no `@sentry/*` package in `package.json`. No `sentry.client.config.ts`, no `sentry.server.config.ts`. No error-tracking dependency of any kind. The 4 `console.error` lines are the entire prod error-detection surface.

Consequence if it bites: when prod crashes, the only detection signal is "the user reports it" or "the developer happens to be reading Vercel logs." There's no deduplication (you can't tell if 50 users hit the same crash or 1 user hit it 50 times). No release tagging (you can't tell which deploy introduced it).

Smallest first move: gated on the logger gap. Add Sentry *after* `lib/log.ts` exists, so the breadcrumbs carry structured tags. The diff: install `@sentry/nextjs`, run the setup wizard, add `Sentry.captureException(e, {tags: fields})` at each catch site. Order matters — installing Sentry first would carry opaque strings as the only context.

#### P1 — no upstream request-ID correlation

The reader anchor: you've called Stripe and noticed every response has an `Request-Id` header; if something goes wrong, you can include that ID in a support ticket and Stripe can find the request on their side. blooming insights doesn't do this for either upstream (Anthropic or Bloomreach MCP).

Evidence: `lib/mcp/client.ts` doesn't read any request-ID-like header from MCP responses. `lib/agents/base.ts` doesn't capture Anthropic's request ID from the SDK response (Anthropic's SDK does expose it on the response object — it's just not extracted). The trace's `tool_call_end` doesn't carry an upstream ID.

Consequence if it bites: when an Anthropic or MCP call fails in a way that needs vendor support, you can't reference a specific request. Cost is mild today (low call volume, escalation is rare); cost rises with scale.

Smallest first move: extend `tool_call_end` with `upstreamRequestId?: string`. Read the value from the SDK / MCP response and pass it through. Two-line edit per agent + one new field on the event union.

#### P2 — cache snapshot lacks provenance envelope

The reader anchor: you've captured a request in Chrome's network HAR and noticed it includes timestamps, headers, and the loading page's URL — context around the request, not just the request itself. The snapshot here captures `AgentEvent[]` and nothing else: no timestamp, no model version, no prompt hash, no schema version.

Evidence: `lib/state/investigations.ts:30–41` writes `events: AgentEvent[]` directly. No envelope. The committed seed (`lib/state/demo-investigations.json`) is a `{insightId: events[]}` map — same shape.

Consequence if it bites: you can't tell *when* a snapshot was captured, *which model* produced it, or *which prompt version* the agent was running. So regression analysis ("did our prompt change degrade this case?") requires checking out the old code and re-running — you can't diff snapshots across model/prompt versions because the metadata isn't there.

Smallest first move: extend the snapshot shape to `{capturedAt, modelVersion, promptHash?, events: AgentEvent[]}`. Update both write paths and the read paths. The model version is already a constant in `lib/agents/base.ts:9` (`AGENT_MODEL = 'claude-sonnet-4-6'`) — easy to capture. Prompt hash requires hashing the prompt strings at startup. ~1 hour, plus a re-capture of the seed.

#### P2 — parallel-span pairing is positional, not by ID (latent)

The reader anchor: you've used promise.all() and watched things race. The trace's span-pairing (`replaceRunningTool` in `useInvestigation`) finds the matching `tool_call_start` by scanning backward for the most recent `'running'` tool with the same `toolName`. This works because today's agent loop runs tools sequentially.

Evidence: `lib/hooks/useInvestigation.ts:86–95` is the matching logic. `lib/agents/base.ts:128–168` runs tools sequentially in `runAgentLoop`'s for-loop.

Consequence if it bites: latent. If `runAgentLoop` ever dispatches tools in parallel, two `tool_call_start` events with the same `toolName` would race, and the matching logic would attach `durationMs` to the wrong span.

Smallest first move: add `id: string` to `tool_call_start`, echo it on `tool_call_end`, match on ID. One field on the event union, one ID generation per tool dispatch, one match update in the UI. ~30 minutes; prevents the latent break before it activates.

#### P3 — no on-call rotation, runbooks, SLO defs

The reader anchor: you've been on call at a company with PagerDuty. None of this exists here. No `docs/runbooks/`, no `docs/slos.md`, no rotation, no SLA.

Evidence: file absence. No SLO-bearing files in the repo. The only quantitative time constraint is `maxDuration = 300` (`app/api/agent/route.ts:20`) — a Vercel ceiling, not an SLO.

Consequence if it bites: solo repo, no customer SLA, no third-party reliability commitments. Cost is genuinely low today. Cost climbs the moment the repo serves a real customer base.

Smallest first move: deferred — *correctly*. Adding rotation/SLOs/runbooks before there's an SLA to back them is performative. The leading indicator is "first customer signs an SLA"; before that, this gap is rationally open.

#### P3 — no backend trace sink (OTel / Langfuse / Datadog export)

The reader anchor: you've sent OpenTelemetry traces to Jaeger. This codebase has the trace; it doesn't export it.

Evidence: `package.json` has no `@opentelemetry/*`, no `langfuse`, no `dd-trace`, no `@vercel/otel`. (`@opentelemetry/api` is transitively in `node_modules` via Next.js, but the repo doesn't use it.) The trace lives in the UI + the cache; no backend has it.

Consequence if it bites: no cross-investigation queries possible. You can't ask "show me all investigations in the last week where the diagnostic agent hit `maxTurns`." The trace per investigation is rich; aggregating across is impossible.

Smallest first move: deferred. The UI consumes the trace as a stream and the cache replays it for the demo — there's no current consumer that would *query* across traces. Without a query consumer, the export is performative. The leading indicator is "we want to do regression analysis across captured runs" — at that point, the snapshot envelope (P2) is the prerequisite, and OTel export is the next step.

#### Move 3 — the principle

A red-flags audit is high-value only if it *ranks honestly by consequence in this repo* — not by what's industry-standard, not by what would impress a code reviewer. The strongest version of this audit names the gaps that are *cheap to close and high-blast-radius* at the top (P0: metrics aggregator, structured logger) and the gaps that are *expensive and low-blast-radius today* at the bottom (P3: rotation, OTel export). The lesson generalises: when you do a gap audit, the consequence column is what makes it useful — without it, every gap looks equally urgent, and nothing gets done.

---

## Primary diagram

The full audit as a ranked grid, with primitives-in-place vs zero-base marked.

```
  Red-flags audit — ranked

                                                cost      blast      primitive
  rank  gap                                     to fix    radius     exists?
  ────  ──────────────────────────────────────  ─────     ──────     ──────────
  P0    no metrics aggregator                   low       high       yes (durationMs)
  P0    no structured logger                    low       high       no (4× console.error)
  P1    no Sentry / error tracker               medium    medium     no (depends on P0)
  P1    no upstream request-ID correlation      low       medium     yes (response objects)
  P2    no snapshot provenance envelope         low       medium     yes (events[] exists)
  P2    parallel-span pairing positional        low       low/latent yes (toolName + running)
  P3    no on-call rotation/runbooks/SLOs       high      low        no (no SLA today)
  P3    no backend trace sink (OTel/Langfuse)   high      low        yes (AgentEvent stream)

  read top-down · stop at your remediation budget · each row's "smallest first move" lives in this file's Move 2
```

---

## Implementation in codebase

### Use cases

Three real moments this audit gets consulted:

- **Triaging an outage.** Skim the P0 row — is the gap that bit you today on this list? If so, you have a remediation move written down. If not, the audit needs a new row.

- **Sprint planning.** The audit is the prioritized backlog of observability work. P0s are "this sprint." P1s are "next sprint." P2s are "good first issue." P3s are "after the first customer."

- **Onboarding the second developer.** This file is the one-stop tour of what's missing. Combined with `01-observability-map.md` (what's there), the two files together give a complete map.

### Code side by side, with a line-by-line read

The primitive that proves P0 metrics is "primitive in place, aggregator missing":

```
  lib/mcp/client.ts  (lines 112, 134)

  const start = Date.now();                                                    ← rung 1: measured
  ...
  const durationMs = Date.now() - start;                                       ← rung 1: surfaced
  ...
  return { result, durationMs, fromCache: false };
        │
        └─ the primitive IS measured. The gap is one observe() call away.
           A 30-line lib/metrics.ts wires the existing primitive to a
           histogram. That's what makes this a P0 with low cost.
```

The four log call sites that prove P0 structured-logger is "zero-base but small":

```
  app/api/agent/route.ts  (lines 160, 256)
  app/api/briefing/route.ts  (lines 166, 248)

  // all 4 sites have the same shape:
  } catch (e) {
    console.error('[agent] error:', e);                                        ← unstructured string
    send({ type: 'error', message: `…` });
  }
        │
        └─ 4 sites, identical shape. A logger module + 4 single-line
           edits closes the gap. ~30 minutes. The Sentry P1 is gated
           on this — without structured fields, Sentry inherits the
           same lossy strings.
```

The positional pair that proves P2 parallel-span is "latent, easy to harden":

```
  lib/hooks/useInvestigation.ts  (lines 86–95)

  const replaceRunningTool = (arr, e) => {
    for (let i = arr.length - 1; i >= 0; i--) {
      const it = arr[i];
      if (it.kind === 'tool' && it.toolName === e.toolName                    ← positional match
          && it.status === 'running') {                                         ← (works because sequential)
        arr[i] = { ...it, status: 'done', durationMs: e.durationMs, ... };
        break;
      }
    }
    return arr;
  };
        │
        └─ the match logic is scan-backwards-for-most-recent-running.
           Add { id: string } to tool_call_start/end and match on ID.
           One field, latent break prevented.
```

---

## Elaborate

The "primitive in place vs zero-base" split this audit uses is a heuristic worth keeping: when a gap's primitive is already measured, the cost of closing the gap collapses to wiring. When the primitive doesn't exist, you're writing code from zero, often in a domain (logging, alerting, on-call) that requires conventions and tooling beyond the code itself. The P0 row is dominated by "primitive in place" items because those are highest leverage per dollar.

The audit deliberately doesn't recommend adding everything industry-standard at once. The P3 row (rotation, runbooks, OTel) is *correctly deferred* because the consumer doesn't exist yet. Adding OTel without a backend that queries the traces is performative; adding rotation without an SLA is theatre. The discipline of naming what's *correctly* deferred is half the value of the audit — without it, the list reads like a "you need everything" lecture, which is wrong for this repo at this stage.

The leading indicators that flip P3 → P1: "we have a customer with an SLA" (rotation), "we want regression analysis across snapshots" (OTel + provenance envelope), "we hit our first prod outage that took >1 hour to root-cause" (runbooks + Sentry). Each is concrete and measurable. The audit should be re-read at each of those triggers and re-ranked.

---

## Interview defense

**Q1. What's the single highest-leverage thing this repo should add tomorrow?**

`lib/metrics.ts` with an in-memory histogram per `toolName`, wired into both routes' `tool_call_end` send sites. The primitive (`durationMs`) is already measured at `lib/mcp/client.ts:134`; the cost to add the aggregator is ~2 hours; the unlock is the difference between "watching one run" and "noticing a regression across runs." Bonus: expose `/api/metrics` in Prometheus exposition format and you're one Grafana scrape away from a real dashboard. The reason this beats Sentry as the first move: Sentry needs structured fields to be useful, and the structured fields don't exist yet — so the logger module would have to come first anyway. The metrics aggregator has zero dependencies.

```
  rank-1 move: lib/metrics.ts + 2 observe() wires
  cost:        ~2 hours
  unlock:      regressions become visible across runs
  blocks:      nothing (the primitive already exists)
```

**Anchor:** "the primitive is already measured; the gap is one observe() call away."

**Q2. What's the most surprising gap in this codebase's observability?**

That there's no `lib/log.ts`. Every catch block goes straight to `console.error` with a freeform string. The repo has *typed* events for happy paths (`AgentEvent` is rigorous), but the exception path falls all the way back to untyped strings — and the exception path is where you're most likely to need structure (error class, route, insightId, upstream IDs). It's a 30-minute add that closes a high-blast-radius gap. The reason it hasn't been added: the trace handles the happy path so well that the exception path felt like a corner case. That intuition is correct *today*; it stops being correct the moment exceptions stop being rare.

```
  asymmetry: happy path typed (AgentEvent), exception path freeform (console.error)
  cost to fix: 30 minutes (lib/log.ts + 4 swaps)
  value: prod-crash debugging stops being string-grep
```

**Anchor:** name the asymmetry — typed happy path, untyped exception path. Identifying the asymmetry is the credibility signal.

---

## Validate

1. **Reconstruct.** Without looking, list the four P0/P1 gaps and rank them by "cost to fix."
2. **Explain.** Why does the audit rank "no metrics aggregator" higher than "no Sentry"? What primitive makes the metrics aggregator cheaper to add?
3. **Apply to a scenario.** A team is given one week to make this repo production-ready for a first customer with a 99.5% uptime SLA. Walk the gaps you'd close, in order, and justify each by P-rank.
4. **Defend the decision.** Argue for adding OTel + Sentry + on-call rotation all at once "to get to industry standard." Argue against. Name what each adds and what each gold-plates.

---

## See also

- `00-overview.md` — the per-section verdict, summarised.
- `01-observability-map.md` — what *is* there, layer by layer (this file is the inverse — what's *not* there).
- `04-metrics-slis-slos-and-alerts.md` — the metrics gap in full.
- `03-structured-logs-and-correlation.md` — the logger gap in full.
- `07-incident-analysis-and-prevention.md` — the one example that exists, and the tooling gaps past it.
