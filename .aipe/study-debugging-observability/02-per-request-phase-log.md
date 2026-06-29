# 02 — Per-request phase log

*Industry standard pattern: structured log (one JSON line per request) with per-phase latency breakdown, emitted from a `finally` block so it survives a thrown handler*

## Zoom out — where this concept lives

The live trace (file 01) shows the user what happened. The phase log shows the *developer* what happened, in one machine-greppable line, even when the request blew up.

```
  Zoom out — the phase log, in the stack

  ┌─ UI layer ───────────────────────────────────────────────┐
  │  no consumer here — the phase log is server-only          │
  └────────────────────────────────────────────────────────────┘
  ┌─ Service layer ───────────────────────────────────────────┐
  │  /api/briefing, /api/agent                                 │
  │  ┌─ ★ recordPhase + finally(console.log JSON) ★ ────────┐  │ ← we are here
  │  │  one JSON line per request, shared shape across both  │  │
  │  └───────────────────────────────────────────────────────┘  │
  └────────────────────────────────────────────────────────────┘
  ┌─ Vercel ──────────────────────────────────────────────────┐
  │  log retention; filter by `route` or `phases.phase`        │
  └────────────────────────────────────────────────────────────┘
```

Zoom in — the concept. Every route opens a stopwatch (`t0 = performance.now()`), pushes a `{phase, durationMs}` entry to a `phases[]` array at each completed step, and emits the entire summary as one `console.log(JSON.stringify(…))` in `finally`. The `finally` is the load-bearing part — it's what makes the budget record survive when a phase throws.

## Structure pass

Axis: **when does the signal get written?**

- The live trace writes on *every emit* — many lines per request, byte-streamed to the UI as work happens.
- The phase log writes *exactly once per request* — one line, after everything else, regardless of success or failure.
- The redacted error log (file 03) writes *on error* — zero or one lines per request.

Seam: the boundary where the answer flips is the route's `start(controller)` closure. Inside the `try`, work emits per-step signals (the live trace). Inside the `finally`, work emits one per-request signal (the phase log). The two signals exist at different granularities by design: the live trace is for streaming + product UX; the phase log is for aggregation + post-mortem.

## How it works

### Move 1 — the mental model

You know how a structured logger in a web service logs `{method, path, status, latency}` once per request, regardless of what happened inside? Same idea, except the `latency` field is decomposed into named phases so a slow request can be attributed to *which* phase ate the budget.

```
  Pattern — the phase log shape

  t0 ────────────────────────────────────────────────────► totalMs
  │                                                       │
  ├─ schema_bootstrap ──┤                                  │
                        ├─ coverage_gate ─┤                │
                                          ├─ list_tools ─┤ │
                                                          ├─ monitoring_scan ─┤
                                                                              │
                                                            finally: console.log
                                                            {route, sessionId, mode,
                                                             totalMs, phases[], aborted}
```

The trick: the log lives in `finally`, so it fires whether the route returned cleanly, threw mid-phase, was aborted by the client, or hit the Vercel 300s ceiling. Whichever path you took, you get one line per request.

### Move 2 — step by step

#### The stopwatch open

`app/api/briefing/route.ts:203-207`, `app/api/agent/route.ts:215-219`.

```ts
const t0 = performance.now();
const phases: Array<{ phase: string; durationMs: number }> = [];
const recordPhase = (phase: string, started: number) => {
  phases.push({ phase, durationMs: Math.round(performance.now() - started) });
};
```

The closure `recordPhase` is the API. Each phase opens a local timestamp (`const t_schema = performance.now()`), runs the work, then calls `recordPhase('schema_bootstrap', t_schema)`. The closure captures `phases[]` by reference, so the array grows as work progresses.

Bridge: if you've ever written `const start = Date.now(); …; console.log(Date.now() - start)`, this is the same idiom with `performance.now()` (monotonic, sub-ms) and a destination array instead of a console.log per phase.

What breaks if `recordPhase` runs *outside* the closure: each phase becomes its own `console.log` and the per-request summary fragments across many log lines. The single-line shape is what makes Vercel's filter useful — `phases.phase = "schema_bootstrap"` returns one line per request, with that phase's `durationMs` plus the surrounding context (`totalMs`, `aborted`, sibling phases). Many lines per request would require a join in the log viewer, which Vercel does not give you.

#### The per-phase timing calls

`app/api/briefing/route.ts:217-280`. Each phase wraps its work between a local `t_*` and a `recordPhase`:

```ts
const t_schema = performance.now();
const schema = await bootstrap(req.signal);
recordPhase('schema_bootstrap', t_schema);
…
const t_listTools = performance.now();
const raw = await dataSource.listTools({ signal: req.signal });
recordPhase('list_tools', t_listTools);
…
const t_scan = performance.now();
const anomalies = await agent.scan({ … }, runnable);
recordPhase('monitoring_scan', t_scan);
```

The phase names are stable across the two routes where they overlap (`schema_bootstrap`, `list_tools`). The non-overlapping ones (`coverage_gate` on briefing; `intent_classify` / `diagnostic_investigate` / `recommendation_propose` on agent) are route-specific.

What breaks if a phase throws BEFORE `recordPhase` is called: the throw goes to `catch`, then `finally`, then the log line. That phase doesn't appear in `phases[]` — but every completed phase before it does. So a log line that shows `phases: [{phase:'schema_bootstrap', durationMs: 4210}]` with `totalMs: 8000` and `aborted: false` tells you: schema_bootstrap took 4.2s, then something between schema_bootstrap and list_tools failed at the 8s mark. The *absence* of `list_tools` in the array is the diagnostic signal.

#### The `finally` block — the load-bearing part

`app/api/briefing/route.ts:303-326`, `app/api/agent/route.ts:317-339`.

```ts
} finally {
  try {
    await disposeDataSource();
  } catch (disposeErr) {
    console.error('[briefing] dispose error:', redactSecrets(formatError(disposeErr)));
  }
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

Five things happen here, in this order, on every path:

1. The data source dispose is attempted. Its own error is logged separately so a dispose error never swallows the route-level error.
2. The phase log line is written.
3. The stream controller is closed.

`aborted: req.signal.aborted` is the field that distinguishes "client cancelled" from "we finished" from "Vercel killed us at 300s." All three paths exit through `finally`; the field tells you which.

Bridge: this is just `try { work } catch { record error } finally { tally and close }`. The exotic part is that the function lives inside a `ReadableStream.start` closure, so the `finally` here closes *the stream* (not the request) — but the timing semantics are the same.

What breaks if the log line lives in `try` instead of `finally`: when a phase throws, you get the error log (from the `catch`) but no phase log. You lose the budget record exactly when you need it most — a thrown phase is the most diagnostic-worthy moment of the request, and the log line is silent. The 300s ceiling incident at `app/api/agent/route.ts:20-22` is the named incident this discipline came from.

#### The Anthropic usage log — a sibling signal

`lib/agents/aptkit-adapters.ts:57-61`:

```ts
console.log(JSON.stringify({
  site: this.logSite,
  sessionId: this.sessionId,
  usage: response.usage,
}));
```

Fired on every `anthropic.messages.create` completion. `site` carries the agent name + adapter (`agents/monitoring:aptkit-model`, `agents/intent:classifyIntent`). The `sessionId` joins this line to the phase log line for the same request.

This is the secondary structured signal. It tracks token usage per agent per session, which is what the developer reaches for when "why is this request 2x as expensive as I expected" comes up. The phase log says *which phase* burned the time; the usage log says *which Anthropic call inside that phase* burned the tokens.

### Move 3 — the principle

**Make the per-request summary atomic, machine-greppable, and unconditionally written.** One JSON line per request, every field at the top level (not nested), `finally`-emitted. That triple of constraints is what turns log retention into a queryable system — and what makes the line useful precisely when it's needed most (the failing request).

## Primary diagram

```
  the phase log, end to end

  request arrives
   │
   ▼
  ReadableStream.start(controller) {
    │
    │ const t0 = performance.now()
    │ const phases = []
    │ const recordPhase = (name, t) => phases.push({phase:name, durationMs:…})
    │
    ▼
    try {
      ┌────────────────────────────────────┐
      │  t_schema = perf.now()              │
      │  await bootstrap()                   │
      │  recordPhase('schema_bootstrap', t)  │
      ├────────────────────────────────────┤
      │  t_listTools = perf.now()            │
      │  await dataSource.listTools()        │
      │  recordPhase('list_tools', t)        │
      ├────────────────────────────────────┤
      │  …more phases…                       │
      └────────────────────────────────────┘
    } catch (e) {
      console.error('[briefing] error:', redactSecrets(formatError(e)))
      send({type:'error', message:…})
    } finally {
      ─── ALWAYS RUNS ───────────────────────
      await disposeDataSource()
      console.log(JSON.stringify({
        route, sessionId, mode,
        totalMs:  Math.round(perf.now() - t0),
        phases,   ← captures every COMPLETED phase
        aborted:  req.signal.aborted    ← distinguishes the exit path
      }))
      controller.close()
    }
  }
   │
   ▼
  Vercel log line: filter by route, by phases.phase, by aborted
```

## Elaborate

Where this pattern comes from: structured logging is older than this codebase by decades. Bunyan, pino, zap, glog — every production logger emits one JSON line per record with stable field names. The `finally`-emitted summary is the specific shape that comes from request-tracing libraries (OpenTelemetry's `finally` on the span, the AWS X-Ray model, the Go context-cancellation pattern). The novelty here is *only* that this repo writes it by hand instead of via a library — at this scale that's the right call; the library buys you propagation across services and this repo doesn't have those yet.

Adjacent concepts: the per-Anthropic-call usage log (sibling structured signal). The redacted error log (file 03) is what makes it safe to put the structured log into shared retention. The replay snapshot (file 05) doesn't carry phase log data — the live trace and the replay trace look identical because replay deliberately fakes nothing about the server's actual work.

What to read next: the `aborted` field comes from `req.signal.aborted`, which is set by the `AbortSignal` composition in `lib/mcp/transport.ts:173-189` (the route signal + the per-call 30s timeout signal). When both are wired in, `aborted: true` could mean either — the phase log doesn't currently distinguish them. Adding a `abortReason` field would be the natural growth.

## Interview defense

**Q: Why `finally` instead of after the work completes? You'd still log on success.**

```
  try-only log               finally-only log
  ─────────────              ────────────────
  try {                       try {
    work()                      work()    ← throws
    log()    ← misses           …
  } catch (e) {                } catch (e) {
    handle(e)                   handle(e)
  }                            } finally {
                                 log()    ← still fires
                                }
```

The pattern *exists because* of the failure case. A successful request can be measured in many ways; a failed request often can't. The phase log is most diagnostic when something blew up — the partial `phases[]` array tells you *where* the work got to. Putting the log in `try` means you have no record of any request that fails — exactly the opposite of what you want. Anchor: `app/api/briefing/route.ts:303-326`.

**Q: What does an entry look like for a request that hit the 300s Vercel ceiling?**

```json
{
  "route": "/api/agent",
  "sessionId": "abc-...",
  "mode": "live-bloomreach",
  "totalMs": 300012,
  "phases": [
    {"phase": "schema_bootstrap", "durationMs": 4210},
    {"phase": "list_tools", "durationMs": 380},
    {"phase": "diagnostic_investigate", "durationMs": 295380}
  ],
  "aborted": true
}
```

Reading it: schema and listTools combined to 4.6s, then `diagnostic_investigate` ate the rest until the platform killed the function. The `recommendation_propose` phase is absent — never started. The `aborted: true` confirms the exit path was a cancellation (the Vercel timeout triggers an AbortSignal on the request). The next question is "why did the diagnostic agent run for nearly 5 minutes" — that's the live trace's job (file 01), where each `tool_call_end.durationMs` shows which MCP call ate the time.

**Q: Why isn't every per-tool-call duration in the phase log too?**

Two reasons. First, per-tool-call durations already live in the live trace — `tool_call_end.durationMs` on every `AgentEvent.tool_call_end`. Putting them in two places risks drift. Second, a single `monitoring_scan` phase can fire dozens of MCP calls; expanding each into a top-level `phases[]` entry would inflate the log line beyond practical size and lose the "one line per request" property. The two surfaces (live trace per-call, phase log per-phase) are at different granularities by design. Anchor: `app/api/briefing/route.ts:265-275` (the per-call timing flows into `tool_call_end`).

## See also

- `01-ndjson-reasoning-trace.md` — the per-event signal; this file's per-request sibling.
- `03-redaction-at-the-error-edge.md` — what makes it safe to ship the phase log to log retention without leaking tokens.
- `04-server-error-body-capture.md` — when an error reaches the `catch` block, the body capture is what populates the message that the error log carries.
- `study-performance-engineering` — the actual budget analysis (e.g. p95 of `monitoring_scan`, the 60s → 300s incident) leans on this signal.
