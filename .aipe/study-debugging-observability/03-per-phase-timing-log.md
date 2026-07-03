# 03 — Per-phase timing summary log

**One-line structured log per request, emitted in `finally`** —
Industry standard.

## Zoom out — where this concept lives

Every request to `/api/agent` or `/api/briefing` emits *one* JSON log
line at the end of the request — even when it throws. That line names
the request, the session, and the wall-clock delta for every phase.
This is the incident signal for the Vercel 300s budget, and it's the
only summary the log stream ever emits.

```
  Zoom out — the summary log in the whole system

  ┌─ Browser ────────────────────────────────────────────┐
  │  fetch('/api/agent?...')                              │
  └─────────────┬────────────────────────────────────────┘
                │  ...300s max...
  ┌─ Next route ▼────────────────────────────────────────┐
  │  try {                                                │
  │    recordPhase('schema_bootstrap', t)                 │
  │    recordPhase('list_tools', t)                       │
  │    recordPhase('diagnostic_investigate', t)           │
  │    recordPhase('recommendation_propose', t)           │
  │    send({type:'done'})                                │
  │  } catch (e) { send({type:'error', ...}) }            │
  │  finally {                                            │
  │    console.log(JSON.stringify({                       │
  │      route, sessionId, mode, totalMs, phases,         │
  │      aborted                                          │
  │    }))                             ← ★ WE ARE HERE ★  │
  │  }                                                    │
  └───────────────────────────┬──────────────────────────┘
                              │
                              ▼
                    Vercel log stream
                    (one filter reads both routes)
```

**Zoom in — what it is.** One `console.log` call, one JSON payload, one
shared shape between the two long-running routes. Emitted in the
`finally` block so the summary fires whether the request succeeded,
errored, or was cancelled mid-flight.

## Structure pass

**Layers.** Instrumentation (`recordPhase`) · aggregation (`phases[]`
array) · emission (`console.log` in `finally`) · consumption (Vercel log
filter).

**One axis held constant: failure containment.** What happens to the
summary when a phase throws?

```
  "does the summary survive a mid-request failure?"

  ┌───────────────────────────────────────┐
  │ instrumentation: recordPhase          │   → RESILIENT (called before each phase)
  └───────────────────────────────────────┘
      ┌─────────────────────────────────────┐
      │ aggregation: local `phases[]` array │   → LIVES IN CLOSURE (survives throw)
      └─────────────────────────────────────┘
          ┌────────────────────────────────┐
          │ emission: `finally` block      │   → GUARANTEED (JS spec)
          └────────────────────────────────┘

  throw at any step → summary still fires; the LAST phase in phases[]
  is the one where the throw landed's predecessor. incident signal.
```

**Seam.** The `try` / `finally` boundary in the route's
`ReadableStream.start`. The `try` runs the mechanism, the `finally`
runs the summary. Nothing else. This is the one boundary the log
emission depends on — and it's a JavaScript language guarantee.

## How it works

### Move 1 — the mental model

You know how a shell script that ends with `set -e && do_the_thing;
echo done` never gets to echo if `do_the_thing` fails? That's the
problem. The `finally` block is what turns "always emit the summary" into
a language-level guarantee. Same idea as an OTLP shutdown handler, but
scoped to one request instead of the process.

```
  The pattern — one line per request, guaranteed

     t0 = now
     phases = []

     try {
       phase 1 → recordPhase('a', t1)
       phase 2 → recordPhase('b', t2)   ← if this throws...
       phase 3 → recordPhase('c', t3)
     } catch (e) {
       send({type:'error', ...})
     } finally {
       // ...phases[] still has entries for phases that COMPLETED,
       // even if we're here because phase 2 threw.
       console.log(JSON.stringify({ route, sessionId, mode,
                                   totalMs: now - t0,
                                   phases,
                                   aborted: req.signal.aborted }))
     }

     → the log line names WHICH phase burned time before the throw.
       incident triage: read the last phases[] entry.
```

### Move 2 — the mechanism, step by step

**Part A — the `recordPhase` closure.** Local to each route's
`ReadableStream.start`. Takes a phase name and its start timestamp;
appends `{ phase, durationMs }` to a local `phases` array. That's the
whole function.

Real code from `app/api/agent/route.ts:220-224`:

```ts
// Per-phase wall-clock timings — server-side `console.log` only, emitted
// once per request in the `finally` so the summary still fires when a
// phase throws (the 300s-budget incident signal). Not on the NDJSON wire.
// Shape matches /api/briefing so a single Vercel filter reads both routes.
const t0 = performance.now();
const phases: Array<{ phase: string; durationMs: number }> = [];
const recordPhase = (phase: string, started: number) => {
  phases.push({ phase, durationMs: Math.round(performance.now() - started) });
};
```

Called by each phase after it completes. The pattern is: capture `t_x`
before the phase, `recordPhase('x', t_x)` after.

Real usage from `app/api/agent/route.ts:236-300`:

```ts
stepFor(leadAgent, 'thought', 'reading the workspace schema…');
const t_schema = performance.now();
const schema = await bootstrap(req.signal);
recordPhase('schema_bootstrap', t_schema);

req.signal.throwIfAborted();
const t_listTools = performance.now();
const rawTools = await dataSource.listTools({ signal: req.signal });
// ...
recordPhase('list_tools', t_listTools);

// ... intent_classify, query_answer, diagnostic_investigate,
//     recommendation_propose all follow the same shape ...
```

**Part B — the aggregation.** `phases` is a plain array in the
`ReadableStream.start` closure. It's not shared across requests, not
persisted, not exported. It exists only for the duration of this one
request — which is exactly what you want: one summary per request, no
cross-request pollution.

The subtle payoff: if the diagnostic phase throws, `phases[]` at that
point contains entries for `schema_bootstrap` + `list_tools` + any
prior phase that completed, but *not* `diagnostic_investigate`. So the
"what phase was the request in when it threw?" answer is: **the phase
after the last entry in `phases[]`.**

```
  Reading the summary log during an incident

  Normal success:
    phases: [ schema_bootstrap: 800, list_tools: 90,
              diagnostic_investigate: 50200,
              recommendation_propose: 51100 ]
    → all four phases present. total: ~102s. green.

  Throw during recommendation:
    phases: [ schema_bootstrap: 900, list_tools: 85,
              diagnostic_investigate: 49800 ]
    → three phases. total might be ~120s from the error's own path.
    → the throw was IN recommendation_propose (the missing phase).

  300s budget hit during diagnostic_investigate:
    phases: [ schema_bootstrap: 850, list_tools: 100 ]
    aborted: true
    totalMs: 299900
    → the throw was IN diagnostic_investigate.
    → 300s minus (850 + 100) = 299s was spent inside the diag agent.
```

**Part C — the `finally` emission.** One `console.log(JSON.stringify(…))`
call in the route's `finally` block. Shape includes `route`, `sessionId`,
`mode`, `totalMs`, `phases[]`, `aborted`.

Real code from `app/api/agent/route.ts:322-345`:

```ts
} finally {
  // Tear the per-request DataSource down. Currently a no-op for the
  // Bloomreach adapter (the OAuth client outlives the request via the
  // cookie store). Best-effort — a teardown error must NOT swallow the
  // route-level error above.
  try {
    await disposeDataSource();
  } catch (disposeErr) {
    console.error('[agent] dispose error:', redactSecrets(formatError(disposeErr)));
  }
  // One summary line per request — shared shape with /api/briefing so a
  // single Vercel filter (e.g. phases.phase = "schema_bootstrap") reads
  // across both routes. Fires even on error so we can see how much of the
  // 300s budget was burned before the failure.
  console.log(JSON.stringify({
    route: '/api/agent',
    sessionId: sid,
    mode,
    totalMs: Math.round(performance.now() - t0),
    phases,
    aborted: req.signal.aborted,
  }));
  controller.close();
}
```

Two ordering guarantees baked in:

- `disposeDataSource()` runs *first* in the finally so cleanup happens
  before the summary. If cleanup throws, its error goes through the same
  redacted-formatError path but doesn't swallow the outer error.
- `controller.close()` runs *after* the summary log so the stream stays
  open long enough for the log to flush.

**Part D — the shared shape.** The briefing route emits *the same
shape* (`app/api/briefing/route.ts:322-329`):

```ts
console.log(JSON.stringify({
  route: '/api/briefing',
  sessionId: sid,
  mode,
  totalMs: Math.round(performance.now() - t0),
  phases,
  aborted: req.signal.aborted,
}));
```

Only `route` differs. This is deliberate: **one Vercel log filter reads
both routes.** `phases.phase = "schema_bootstrap"` matches both; a p95
computed from the log stream (say via Vercel Log Drains) rolls both
routes' schema-bootstrap times together, which is the right thing —
they hit the same `bootstrap` factory.

**Part E — `aborted: req.signal.aborted`.** The bit that separates
"client cancelled" from "server timeout" from "server error."

- `aborted: true, phases: [...], last phase incomplete` — client
  cancelled OR the 300s route budget hit. Distinguish by `totalMs`:
  ~300000 means budget; less than that means client.
- `aborted: false, totalMs < 5000, phases: []` — early crash (setup
  error, missing env var, malformed config).
- `aborted: false, all phases present` — clean success.

### Move 2 variant — the load-bearing skeleton

The kernel:

```
  local phase-timing array (per request)
  + recordPhase closure
  + try { ... phases ... } finally { console.log(...) }
  + shared shape across every route that uses this
```

- **Drop `finally`** (use a plain `catch` + `console.log`) and the
  summary vanishes on client cancel or on uncaught path. Incident
  invisible.
- **Drop the shared shape** and each route becomes its own log filter.
  The Vercel query goes from one filter to N.
- **Drop `aborted`** and you can't tell cancel from budget hit — same
  totalMs, different root cause.
- **Drop `sessionId`** and you can't correlate the summary line to any
  per-turn log or receipt.

Skeleton vs hardening:

- **Skeleton:** local `phases[]` + `recordPhase` + `try/finally +
  console.log`.
- **Hardening:** `disposeDataSource()` before the log so cleanup timing
  isn't attributed to the last phase; `Math.round` on `performance.now`
  deltas for cleaner numbers; `aborted` bit for cancel vs timeout
  triage.

### Move 3 — the principle

**Guarantee your summary; the `finally` block is the one JavaScript
primitive that ensures it.** An observability signal that only fires on
the happy path is worse than none — it lulls you into thinking green
means healthy. Emit the summary unconditionally; put the diagnostic
distinguishers (`aborted`, `totalMs`, `phases[]` length) on it so one
log line separates the failure modes.

## Primary diagram

```
  Per-phase timing log — full picture

  ┌─ Request lifecycle (app/api/agent/route.ts:190-345) ────────────┐
  │                                                                  │
  │  ReadableStream.start(controller) {                              │
  │                                                                  │
  │   ┌── ONE-TIME SETUP ─────────────────────────────┐             │
  │   │  t0 = performance.now()                        │             │
  │   │  phases = []                                   │             │
  │   │  recordPhase = (name, t) =>                    │             │
  │   │     phases.push({ phase: name,                 │             │
  │   │                   durationMs: now - t })       │             │
  │   └────────────────────────────────────────────────┘             │
  │                                                                  │
  │   try {                                                          │
  │                                                                  │
  │     ┌── PER PHASE (repeat) ──────────────┐                      │
  │     │  send(reasoning_step)                │                      │
  │     │  t_x = now                           │                      │
  │     │  await phase_x_work                  │                      │
  │     │  recordPhase('phase_x', t_x)         │                      │
  │     └──────────────────────────────────────┘                      │
  │                                                                  │
  │     send({ type: 'done' })                                       │
  │                                                                  │
  │   } catch (e) {                                                  │
  │     if (aborted) return                                          │
  │     console.error('[agent] error:', redactSecrets(formatError(e)))│
  │     send({ type: 'error', message: '...' })                      │
  │   } finally {                                                    │
  │                                                                  │
  │     ┌── CLEANUP (best effort) ────────────┐                     │
  │     │  try { await disposeDataSource() }   │                     │
  │     │  catch { console.error(...) }        │                     │
  │     └──────────────────────────────────────┘                     │
  │                                                                  │
  │     ┌── ★ THE SUMMARY LOG ★ ────────────────────────────────┐   │
  │     │  console.log(JSON.stringify({                          │   │
  │     │    route: '/api/agent',        ← same as /api/briefing│   │
  │     │    sessionId: sid,             ← correlates to receipts│   │
  │     │    mode,                       ← live-mcp | live-syn..│   │
  │     │    totalMs: now - t0,                                 │   │
  │     │    phases,                     ← how far we got       │   │
  │     │    aborted: req.signal.aborted ← cancel vs error      │   │
  │     │  }))                                                  │   │
  │     └────────────────────────────────────────────────────────┘   │
  │                                                                  │
  │     controller.close()                                          │
  │   }                                                              │
  │  }                                                               │
  └──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                      Vercel log stream
                      one filter reads both routes
```

## Elaborate

The pattern here is a slimmed-down **structured request log** — the
same shape that Google's SRE book calls "one line per request." In a
serverless environment (Vercel / Lambda) you don't own the process, so
the summary log has to be per-request; you can't rely on a background
metrics-flusher.

The `finally` guarantee comes straight from the JavaScript spec —
promises reject, `throw` propagates, `AbortError` fires, and `finally`
always runs. This is stronger than the equivalent in a Python
generator or a Go coroutine, where you need explicit `defer` /
`try/finally` and any bug in the cleanup path can swallow the outer
error.

The design decision that's easy to miss: **the summary log is
`console.log`, not `console.error`, even for the failure path.** The
`error` event on the wire is what tells the browser something went
wrong; the summary log is *always the same signal*, and its log level
is the level of a healthy signal (info). This matters because
`console.error` counts against Vercel's error-rate widget; the summary
log shouldn't.

Adjacent concepts:

- **Structured logging** (Splunk / Datadog / Loki) — the summary log is
  ready-to-ingest structured JSON, no parsing pass needed.
- **OpenTelemetry span** — the phases array is a poor-person's span
  tree, flat. The upgrade path is to emit these as real spans with a
  trace-id (red-flag R2 in the audit).
- **CI job summaries** — GitHub Actions' `$GITHUB_STEP_SUMMARY` is the
  same pattern in a different runtime.

## Interview defense

**Q: Why is the summary log in `finally` and not at the bottom of the
`try` block?**

Because the whole point is to see the summary *even when the request
fails*. Put it at the bottom of `try` and a throw skips it — you get
the error but no context on which phase was executing. `finally` is
the JavaScript language guarantee that the log fires regardless.

Anchor: the last entry in `phases[]` when the log fires names the
phase that completed before the throw; the phase that was *executing*
is the one whose `recordPhase` never fired.

**Q: Both routes emit the same shape. Why?**

So one Vercel log filter reads both. `route: '/api/agent' OR
'/api/briefing'` unions cleanly; `phases.phase = "schema_bootstrap"`
matches both routes' bootstrap phase — which is the same underlying
factory call. Uniform shape is *the* signal that lets you write filters
against unfamiliar routes.

**Q: The `aborted` bit — what problem does it solve?**

Client cancels and server timeouts both leave a partial `phases[]`
array with `totalMs` less than expected. Without `aborted`, you can't
tell them apart. With `aborted: true`, the summary answers "did
someone give up on this?" and combined with `totalMs ≈ 300000` it
answers "which one — user or server?"

**Q: Why not just use per-phase `console.log` at the end of each
phase?**

Because a phase that throws never gets its own log line — the summary
would be broken exactly when you need it. One aggregated summary,
emitted in `finally`, keeps the incident triage complete.

## See also

- `02-receipts-as-evidence.md` — the same per-phase timing information
  for eval runs, on disk instead of in logs.
- `06-log-redaction-and-error-chain.md` — the redaction that runs on
  the error path *before* the summary log fires.
- `05-budget-tracker-as-guard.md` — the guard whose breach is what
  makes the `aborted: true` + `totalMs < 300s` case appear.
