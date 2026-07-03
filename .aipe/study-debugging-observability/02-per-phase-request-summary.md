# 02 · Per-phase request summary

*Structured request log / poor-man's tracing — **language-agnostic***

## Zoom out — where this concept lives

One JSON line per request, emitted in `finally`, carrying the total
time and a `phases[]` breakdown. It's the trace layer for the
streaming routes — you don't need OpenTelemetry to answer "where did
the 300s budget go" if you have this.

```
  Zoom out — the phase log's seat in the stack

  ┌─ UI layer ──────────────────────────────────────────────┐
  │  (not directly relevant — this log never touches UI)     │
  └──────────────────────────────────────────────────────────┘

  ┌─ Service layer ─────────────────────────────────────────┐
  │  /api/briefing/route.ts        /api/agent/route.ts       │
  │      ★ phase log emitted in `finally` ★                  │
  │      shape: {route, sessionId, mode, totalMs, phases[]}  │
  └─────────────────────────┬───────────────────────────────┘
                            │  hop: process.stdout
                            ▼
  ┌─ Log-shipping layer ────────────────────────────────────┐
  │  Vercel Functions log scraper                            │
  │  filter: `phases.phase = "schema_bootstrap"`             │
  └──────────────────────────────────────────────────────────┘
```

Zoom in — this is the trace that fires **even when the request
throws.** The `finally` block guarantees the summary lands in Vercel
logs whether the happy path finished, an exception bubbled, or the
client cancelled. Combined with the phase array's `pushed-as-we-go`
shape, the log tells you exactly which phase was in flight when the
failure landed.

## Structure pass — the skeleton

**Axis held constant: when does each phase's timing get committed?**

| Layer | Committed timing lives at |
|---|---|
| Phase code | `t_phase = performance.now()` — a stack local |
| Phase end | `recordPhase(name, t_phase)` — pushes into `phases[]` |
| Request end | `phases[]` is on the stack, but is embedded in the summary log JSON |
| Vercel logs | one JSON string, parseable, filterable |

**Seams:**

  → seam 1 — **`recordPhase` inside the try block.** Every phase
    boundary is one push into `phases[]`. If a phase throws BEFORE
    its `recordPhase` fires, that phase is absent from the array —
    which is the signal ("this phase failed to finish"). The
    presence-or-absence of a phase name is the debugging seam.
  → seam 2 — **the `finally` block.** Committing to logs is
    unconditional. The route can throw, cancel, timeout — the
    finally still fires. That's what makes the log useful under
    failure conditions.
  → seam 3 — **the shared shape across two routes.** The comment
    at `briefing/route.ts:316-319` explicitly names this: a single
    Vercel filter reads both. Same field names, same JSON keys.

## How it works

### Move 1 — the mental model

You know `console.time('x')` / `console.timeEnd('x')`. This is that,
but structured: instead of printing "x: 42ms" per phase, all phases
land in one JSON object at the end, with the total wall time and the
cancel state. One log line per request, machine-parseable, human-
readable.

```
  The pattern — a request-scoped span buffer

  ┌── request starts ──────────────────────────────────┐
  │                                                    │
  │  t0 = performance.now()                            │
  │  phases: [{phase, durationMs}, ...] = []           │
  │                                                    │
  │  ┌── phase 1 ──┐   push {'schema_bootstrap', 812}  │
  │  ┌── phase 2 ──┐   push {'coverage_gate',    142}  │
  │  ┌── phase 3 ──┐   push {'list_tools',        95}  │
  │  ┌── phase 4 ──┐   push {'monitoring_scan', 48231} │
  │                                                    │
  │  finally:                                          │
  │    console.log(JSON.stringify({                    │
  │      route, sessionId, mode,                       │
  │      totalMs: performance.now() - t0,              │
  │      phases,                                       │
  │      aborted: req.signal.aborted                   │
  │    }))                                             │
  └────────────────────────────────────────────────────┘
```

### Move 2 — the step-by-step walkthrough

**Part 1 — the phase-timing captures inside the stream.**

Every phase brackets its work with `t_phase = performance.now()` /
`recordPhase(name, t_phase)`. The helper is one line
(`agent/route.ts:217-219`):

```typescript
const t0 = performance.now();
const phases: Array<{ phase: string; durationMs: number }> = [];
const recordPhase = (phase: string, started: number) => {
  phases.push({ phase, durationMs: Math.round(performance.now() - started) });
};
```

The phases actually captured on the two routes:

  → `/api/briefing`: `schema_bootstrap` → `coverage_gate` →
    `list_tools` → `monitoring_scan`
    (`briefing/route.ts:221 · 246 · 254 · 281`)
  → `/api/agent`, investigation flow: `schema_bootstrap` →
    `list_tools` → `diagnostic_investigate` → `recommendation_propose`
    (`agent/route.ts:236 · 243 · 283 · 295`)
  → `/api/agent`, free-form query flow: `schema_bootstrap` →
    `list_tools` → `intent_classify` → `query_answer`
    (`agent/route.ts:236 · 243 · 251 · 256`)

Notice: `list_tools` and `schema_bootstrap` are in both routes with
the same names. That was deliberate — same filter reads across both.

**Part 2 — the "push before throw" invariant that makes this
diagnostic.**

Because `recordPhase` runs AFTER the phase's work returns, a phase
that THROWS never lands in the array. The absence of a phase is
therefore the signal:

```
  Phases as a "how far did we get" map

  totalMs: 42_137
  phases:
    - schema_bootstrap:      812ms  ← finished
    - coverage_gate:         142ms  ← finished
    - list_tools:             95ms  ← finished
    - monitoring_scan:  ← ABSENT — this one failed

  aborted: false

  → the failure was inside monitoring_scan, after list_tools
    committed but before the scan returned. Now you know
    which agent + which turn to look at.
```

This is why the phase log survives being useful even without
per-phase error tags — the shape itself carries the diagnosis.

**Part 3 — the `finally`-guaranteed emission.**

From `briefing/route.ts:315-324`:

```typescript
} finally {
  try { await disposeDataSource(); }
  catch (disposeErr) {
    console.error('[briefing] dispose error:',
                  redactSecrets(formatError(disposeErr)));
  }
  // One summary line per request — shared shape with /api/agent so a
  // single Vercel filter (e.g. phases.phase = "schema_bootstrap") reads
  // across both routes. Fires even on error so we can see how much of the
  // 300s budget was burned before the failure.
  console.log(JSON.stringify({
    route: '/api/briefing',
    sessionId: sid,
    mode,
    totalMs: Math.round(performance.now() - t0),
    phases,
    aborted: req.signal.aborted,
  }));
  controller.close();
}
```

Three things to notice about the `finally`:

  → **Dispose error is caught and swallowed** — not because it's
    unimportant, but because the outer error (if any) is more
    important. A dispose failure that swallows the route error would
    hide the actual bug.
  → **`aborted: req.signal.aborted`** — the client-cancel signal
    is captured. When a browser tab closes mid-scan, the log fires
    with `aborted: true` and truncated phases; you can distinguish
    "user gave up" from "server crashed."
  → **`controller.close()`** last — always. Failing to close the
    controller after emit is one of the classic streaming leaks.

**Part 4 — the shared shape as an operational contract.**

The comment at `briefing/route.ts:316-319` is the entire policy in
one paragraph:

> One summary line per request — shared shape with /api/agent so a
> single Vercel filter (e.g. phases.phase = "schema_bootstrap")
> reads across both routes.

Same field names (`route`, `sessionId`, `mode`, `totalMs`, `phases`,
`aborted`), same order, same shape. This means the Vercel log query
"show me every request that spent > 60s in `monitoring_scan`" reads
both routes with one filter. If the two routes had diverged shapes,
every operational question would be two queries.

### Move 2 — Layers-and-hops: what happens on a failing request

```
  A monitoring_scan throws mid-stream — what the phase log tells you

  t=0            request in
  ├── schema_bootstrap start   t_schema = performance.now()
  ├── ...812ms of work...
  ├── recordPhase('schema_bootstrap', t_schema)   →  push {..., 812}
  │
  ├── coverage_gate start
  ├── ...
  ├── recordPhase('coverage_gate', t_coverage)    →  push {..., 142}
  │
  ├── list_tools start
  ├── recordPhase('list_tools', t_listTools)      →  push {..., 95}
  │
  ├── monitoring_scan start                       t_scan = ...
  ├── agent.scan() → runs 12 tool calls
  ├── on tool call 8, MCP rate-limit escalates and TIMES OUT
  ├── throw → jumps to catch
  │
  ├── catch: send({type: 'error', message: ...})
  │
  ├── finally:
  │   ├── disposeDataSource()  (best-effort)
  │   └── console.log(JSON.stringify({
  │           route: '/api/briefing',
  │           sessionId: 'abc-123',
  │           mode: 'live-bloomreach',
  │           totalMs: 63_412,
  │           phases: [
  │             {phase: 'schema_bootstrap', durationMs:  812},
  │             {phase: 'coverage_gate',    durationMs:  142},
  │             {phase: 'list_tools',       durationMs:   95},
  │             // monitoring_scan MISSING — thrown before recordPhase
  │           ],
  │           aborted: false
  │         }))
  │
  └── controller.close()

  Reader of this log knows:
    · 63s total (of 300s budget)
    · 62s burned inside monitoring_scan
    · not a client cancel (aborted: false)
    · check the tool-call trace on the wire for which call broke
```

### Move 3 — the principle

**Emit tracing on the way OUT, not the way IN.** A "one summary line
per request" pattern is worth ten "start / end / step" log
messages, because it survives failures without careful cleanup
logic. The `finally` block is the seam that makes it structural:
whatever happened, this line ships. The pattern generalizes to any
long-running request handler — RPC servers, cron jobs, workers —
where per-step logging fragments across processes but per-request
logging aggregates naturally.

## Primary diagram

```
  Per-phase request summary — full lifecycle

  ┌──────────────────────────────────────────────────────────┐
  │ /api/briefing OR /api/agent                              │
  │                                                          │
  │  const t0 = performance.now()                            │
  │  const phases = []                                       │
  │                                                          │
  │  try {                                                   │
  │    // phase N ─────────────────────                      │
  │    const t_x = performance.now()                         │
  │    ...work...                                            │
  │    recordPhase('x', t_x)  ── phases.push({phase, dur})   │
  │                                                          │
  │    // ...more phases...                                  │
  │                                                          │
  │  } catch (e) {                                           │
  │    if (AbortError) return                                │
  │    console.error('[route] error:', redactSecrets(...))   │
  │    send({type:'error', message: ...})                    │
  │                                                          │
  │  } finally {                                             │
  │    await disposeDataSource()                             │
  │    console.log(JSON.stringify({                          │
  │      route, sessionId, mode,                             │
  │      totalMs: performance.now() - t0,                    │
  │      phases,       ← the trace                           │
  │      aborted: req.signal.aborted   ← who ended it        │
  │    }))                                                   │
  │    controller.close()                                    │
  │  }                                                       │
  │                                                          │
  └──────────────────────────────┬──────────────────────────┘
                                 │
                          process.stdout
                                 │
                                 ▼
                    Vercel log ingestion + query
                    filter: phases.phase = 'x'
```

## Elaborate

**Where this pattern comes from.** The "one structured log per unit
of work" idea is older than distributed tracing — it's the shape of
web server access logs (`nginx`, `apache`), the shape of process
audit records, the shape of Postgres's slow-query log. What
distinguishes it from OpenTelemetry is: no span IDs, no
parent/child links, no OTLP shipping. The tradeoff is you can't
correlate across services — but for a single Next.js process,
that's not the debugging question. The question is "where did
this request spend its time," and one line answers it.

**Cousins that solve the same problem differently.**

  → **OpenTelemetry spans** — richer (per-span attributes, links,
    events), but requires a collector and a UI. Overkill for a
    two-route app; correct once the stack fans out.
  → **Prometheus histograms** — good at "p95 across all requests"
    but bad at "why was THIS request slow." Complementary, not a
    replacement.
  → **`console.time`** — has the same intuition but its output is
    text, one line per phase, unstructured. Fine for local dev,
    useless in production.

**Adjacent to `03-capability-trace-receipts.md`:** the phase log is
the outer trace ("this whole request took 63s and got stuck in
monitoring_scan") and the receipt is the inner trace ("inside
monitoring_scan, here are the 8 tool calls the agent made and the
model turn tokens per turn"). Together they cover both the wall-clock
question and the semantic question.

## Interview defense

**Q1 · "How does your streaming route explain latency when a request
runs over its 300s budget?"**

**Model answer.** The route emits one structured summary log per
request from a `finally` block. Shape: `{route, sessionId, mode,
totalMs, phases[], aborted}`. Every phase pushes into the array as
it finishes; a phase that throws never lands. So the log tells you
`totalMs: 300_412` with phases showing everything up to but not
including the one that hit the budget — that's the culprit. Anchor:
`app/api/briefing/route.ts:317-323`. The shape is shared with
`/api/agent` so one Vercel filter reads both routes.

```
  interview sketch — the "how far did we get" map

  totalMs:     300_412
  phases:
    schema_bootstrap    812
    list_tools           95
    diagnostic_investigate ABSENT ← this one hit the budget
  aborted: false        ← not the client's fault
```

**Q2 · "Why put the emission in `finally` instead of after the
happy path?"**

**Model answer.** Because the interesting cases — throws, cancels,
timeouts — are exactly when I most want the trace. If I emit only
after `send({type: 'done'})`, then on the 300s-budget case I get NO
log at all — the exact case I care about disappears. `finally`
guarantees the emit even when a phase throws or the client
disconnects, which is what makes the log a real diagnostic tool
instead of a happy-path monitor.

**Q3 · "The pattern doesn't have OTel span IDs. When does that
matter?"**

**Model answer.** It matters when you fan out — multiple services,
async workers, cross-process work — because you need to correlate
"which downstream span belonged to which upstream request." Here
the whole stack is one Next.js process, so `sessionId` on every
line is enough correlation. The moment blooming grows a queue-based
worker or a second service that calls this one, I'd add
`x-request-id` in headers, stamp it on the summary log, and start
propagating it — but the phase array itself would stay the same
shape. I'd rather solve the actual problem (fan-out) than pay for
OTel infra I don't yet need.

## See also

- `01-ndjson-live-trace.md` — the "per-event" complement (the wire
  says WHAT happened; this file says HOW LONG each phase took)
- `03-capability-trace-receipts.md` — the "per-invocation" complement
  (this log is per-request; receipts are per-eval-case)
