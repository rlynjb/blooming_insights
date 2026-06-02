# Structured logs and correlation

**Industry name(s):** structured logging, log levels, correlation IDs, request context, redaction
**Type:** Industry standard · Language-agnostic

> Honest verdict: blooming insights has almost no traditional logs. Four `console.error` calls across two route files is the entire backend log surface. There's no logger module, no log levels, no correlation IDs, no redaction. The *substitute* — and it's genuinely a substitute, not a workaround — is that the AgentEvent stream gives you what correlation IDs are usually for: every event in a stream belongs to one investigation; the trace IS the correlation primitive. The gap that remains is at the route catch sites: when an exception escapes, all you get is `[agent] error: <message>` in Vercel's stdout with no request context.

---

## Zoom out, then zoom in

**Zoom out — the bigger picture.** The pillars-of-observability frame splits this layer cleanly: logs are *one* of three pillars (with metrics and traces). In a mature system, logs answer "what happened?", correlation IDs let you join logs across services for one request, and levels let you filter noise. blooming insights' answer is unusual: the trace handles almost everything logs would, leaving the log layer to do one thing only — record exceptions that escape the stream.

```
  Zoom out — where logging sits (and doesn't)

  ┌─ UI layer ──────────────────────────────────────┐
  │  no client-side logging                          │
  │  errors surface as 'error' events in the trace   │
  └─────────────────────────▲───────────────────────┘
                            │ NDJSON
  ┌─ Route handler ─────────┴───────────────────────┐  ← we are here
  │  console.error('[agent] error:', e)              │
  │    × 2 in route.ts (setup + stream catch)        │
  │  console.error('[briefing] error:', e)           │
  │    × 2 in briefing route                         │
  │  ★ that's the entire backend log surface ★       │
  └─────────────────────────▲───────────────────────┘
                            │
  ┌─ Agent loop layer ──────┴───────────────────────┐
  │  NO console calls — emits via hooks instead      │
  └─────────────────────────▲───────────────────────┘
                            │
  ┌─ MCP client layer ──────┴───────────────────────┐
  │  NO console calls — throws McpToolError instead  │
  └─────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** Structured logging = each log event is a typed object (`{ level, event, fields }`), not a freeform string. Correlation = each event carries an ID (`requestId`, `userId`, `sessionId`) so you can `grep` across services for one logical operation. blooming insights' route catch is the opposite: unstructured (a freeform string template), uncorrelated (no IDs), and unprefixed (no level). It's the textbook "we'll add a logger later" pattern — and honestly, in this codebase, it has been deferred because the trace covers the same ground for the happy path.

---

## Structure pass

**Layers.** Two: the trace layer (the strong one) and the log layer (the weak one). They serve different failure modes — the trace records *expected* agent activity; the log records *unexpected* exceptions.

**Axis: trust (what can you depend on this evidence to tell you?).** Trace events are typed: a `tool_call_end` always has a `durationMs`. You can build a UI that reads `e.durationMs` with confidence. Log calls are untyped strings: `console.error('[agent] error:', e)` — what's `e`? An `Error`? A string? An object with `.cause`? You don't know without reading the throw site. Trust flips at the seam: high-trust on the trace side, low-trust on the log side.

**Seams.** The load-bearing one is the `try/catch` boundary inside the route's `ReadableStream.start`. *Inside* the try, every problem becomes a structured event (`{type:'error', message}` on the wire + `error` in the captured snapshot). *Outside* the try (or in the *outer* try around setup), every problem becomes a string in stdout. The seam matters because it's where typed evidence flips to untyped — the moment you're crossing it, you've lost type safety on what you're recording.

A second seam, currently absent: there's no logger module to flip *between* the route catches. If there were a `lib/log.ts`, the four catch sites would call `log.error({event, error, fields})` — that would be the seam where freeform string flipped to structured payload. The gap is the *absence* of that seam.

```
  Structure pass — logs and correlation

  ┌─ 1. LAYERS ───────────────────────────────────┐
  │  trace layer (typed, primary)                  │
  │  log layer (untyped, exception-only)           │
  └────────────────────────┬───────────────────────┘
                           │  pick the axis
  ┌─ 2. AXIS ─────────────▼────────────────────────┐
  │  trust: can you depend on the evidence's       │
  │  shape, fields, and meaning?                   │
  └────────────────────────┬───────────────────────┘
                           │  trace, find flips
  ┌─ 3. SEAMS ────────────▼────────────────────────┐
  │  try↔catch (route):  typed → untyped (LOAD)    │
  │  trace↔log:          present-and-strong vs     │
  │                       present-but-bare         │
  │  (gap: no log module — no flip exists where    │
  │   it would otherwise be load-bearing)          │
  └────────────────────────┬───────────────────────┘
                           ▼
                   Block 4 — How it works
```

Skeleton mapped — now read the trace-as-correlation move, then the gap.

---

## How it works

**Mental model.** A structured log is `{level, event, fields, ts}` — a typed payload, not a string. A correlation ID is one field shared across every event for one logical operation, so `grep "req=abc123"` returns the whole story. blooming insights inverts this: there's no log module, but there *is* a typed event stream per investigation — so the correlation primitive isn't a string ID, it's "the stream itself." Every event in this NDJSON belongs to investigation `insightId=X`. There's no need to grep for it; you're already inside it.

```
  Pattern — correlation, two ways

  the canonical way                  the blooming insights way
  ─────────────────────              ──────────────────────────
  log.info({                         AgentEvent[]
    requestId: 'req-abc',              ↑
    userId: 'u-1',                     │ every event in this
    event: 'agent.start',              │ array belongs to one
    durationMs: 340,                   │ investigation by virtue
  })                                   │ of WHERE it lives
                                       │
  → grep requestId across              → the array IS the
    files later                          correlation envelope
```

That insight is the file's load-bearing claim. Now the gap.

### Move 2 — walk the surfaces

#### The four catch sites — what they record, what they don't

The reader anchor: you've written `try { … } catch (e) { console.error('failed:', e) }`. Same shape, four times. The four sites are: setup-time errors in `/api/agent` and `/api/briefing` (before the stream opens), and stream-time errors inside `start()` for both routes.

What happens: at setup time, the catch logs and returns a 500 JSON. At stream time, the catch logs and emits an `{type:'error', message}` event on the wire — the trace itself records that something went wrong. The stream-time error therefore exists in *two* places: the typed trace event (correlated by virtue of being in the stream) and the freeform stdout line (uncorrelated, untyped, unjoinable).

Boundary: the log is "best-effort fallback." If a user reports a crash and you ask "what's the insightId?", the trace event might tell you, but the `console.error` line in Vercel's stdout will not — the catch doesn't include the request's `insightId` in the string template. That's the missing correlation.

```
  The four catch sites — what each one captures

  site                                   form
  ─────────────────────────────────────  ────────────────────────────────
  app/api/agent/route.ts:160 (setup)    console.error('[agent] setup
                                           error:', e)
                                         → returns JSON 500
                                         → NO insightId in the log

  app/api/agent/route.ts:256 (stream)   console.error('[agent] error:', e)
                                         → emits {type:'error',message} on
                                           the wire (trace records it)
                                         → NO insightId in the log

  app/api/briefing/route.ts:166 (setup) console.error('[briefing] setup
                                           error:', e)
                                         → returns JSON 500

  app/api/briefing/route.ts:248 (stream) console.error('[briefing] error:',
                                            e)
                                         → emits error event on wire
```

#### The trace as correlation — why the log layer is thin on purpose

The reader anchor: you've used Redux DevTools and never needed a "request ID" to follow what happened — the entire action history for the session is right there. The AgentEvent stream is the same shape. Every event for one investigation lives in one array (live `collected[]` server-side, live `items[]` client-side, captured `AgentEvent[]` in the cache). There's no cross-cutting concern to correlate.

What happens: when the user reports "the diagnostic agent gave a bad answer," you don't need to grep logs — you load the investigation by ID and read the trace. The trace already contains every step, every tool call, every result. The correlation is *positional*: "this `tool_call_end` is in the same array as that `diagnosis`, so the diagnosis came from that tool's result." No IDs required.

Boundary: this works *only* for activity that goes through `send(e)`. The `console.error` lines are outside that envelope. So the failure mode "the route crashed before any event was emitted" is the one place the trace can't correlate — you fall back to "what was the last user action before the 500?" and look at the timestamp of the stdout line. The gap is small but real.

```
  The trace as correlation — pattern

  agent runs                  collected[] (correlation envelope)
  ─────────────────           ─────────────────────────────────
  thought                     [0] reasoning_step {agent:diagnostic}
  tool_call_start             [1] tool_call_start {toolName:eql}
  tool_call_end               [2] tool_call_end   {durationMs:340}
  hypothesis                  [3] reasoning_step {agent:diagnostic}
  diagnosis                   [4] diagnosis      {conclusion:…}
  done                        [5] done

  → to debug event [4]'s conclusion, you read events [0]–[3].
    Position in the array = causal correlation. No IDs.
```

#### The gap — what's missing and what it would cost

The reader anchor: you've added pino or winston to a Node project. It's a 20-line lib file plus a swap at the call sites. The cost of *not* having it: every catch site is a freeform string, every error in production is a stdout line with no fields, and you can't filter logs by level or redact PII.

What would change with a `lib/log.ts`: the four catch sites would call `log.error({event: 'agent.crash', insightId, route: '/api/agent', error: e})`. Vercel's log explorer could then filter by `event` or `insightId`. The `error` field would always be the same shape (`{name, message, stack, cause}`), not whatever JavaScript stringified `e` to. PII / token redaction could happen once in the logger, not at every call site.

What would *not* change: the trace layer is doing the heavy lifting for the happy path. Adding a logger doesn't replace the trace; it complements it at the catch sites. The current 4× `console.error` is bad ergonomics, not a structural flaw.

```
  before (today):
    console.error('[agent] error:', e)
        │
        ▼ Vercel stdout
    "[agent] error: McpToolError: tool failed — Unauthorized"
        ↑
        └─ no insightId · no level · no fields · raw stringified e

  after (proposed log module):
    log.error({
      event: 'agent.crash',
      insightId: insightId,
      route: '/api/agent',
      step: step,
      error: e,
    })
        │
        ▼ structured stdout
    {"level":"error","event":"agent.crash","insightId":"ins-7",
     "route":"/api/agent","step":"diagnose",
     "error":{"name":"McpToolError","message":"…","cause":{…}}}
        ↑
        └─ filterable · correlatable · same shape every time
```

#### Move 3 — the principle

The thing the AgentEvent stream did *exactly right* is also why the log layer is thin: it co-located the evidence with the operation. You don't need a correlation ID when the operation's events are all in the same array. The lesson generalises: before reaching for the canonical observability tools (logger, correlation ID, distributed trace), ask "what evidence is already co-located with this operation?" If the answer is "everything that matters," your log layer can be small and your trace can do the work. blooming insights got this right at the agent layer. The remaining 4× `console.error` is the seam where the design *didn't* extend the principle, and where adding a small logger would be high-value.

---

## Primary diagram

The two evidence channels at the route handler band, side by side, with their shapes and correlation properties.

```
  Logs and correlation — both channels at the route band

  ┌─ Route handler ─────────────────────────────────────────────┐
  │                                                              │
  │  channel A: the trace (typed, correlated by position)        │
  │  ──────────────────────────────────────────────────────────  │
  │    collected: AgentEvent[]                                   │
  │      ✓ typed (discriminated union)                           │
  │      ✓ correlated (one array per investigation)              │
  │      ✓ levels (kind: 'thought' | 'hypothesis' | 'conclusion')│
  │      ✓ snapshots via saveInvestigation                       │
  │      → reaches the UI live AND replays from cache            │
  │                                                              │
  │  channel B: the log (unstructured, exception-only)           │
  │  ──────────────────────────────────────────────────────────  │
  │    console.error('[agent] error:', e) × 2                    │
  │    console.error('[briefing] error:', e) × 2                 │
  │      ✗ unstructured (string interpolation)                   │
  │      ✗ uncorrelated (no insightId/requestId field)           │
  │      ✗ unleveled (no log.warn / log.info)                    │
  │      ✗ no redaction layer                                    │
  │      → reaches Vercel stdout, default retention              │
  │                                                              │
  └──────────────────────────────────────────────────────────────┘
                                │
                                ▼
                       the gap: no lib/log.ts;
                       the four sites would benefit
                       from structured replacement
```

---

## Implementation in codebase

### Use cases

Three real moments correlation matters:

- **The user says "it broke."** First move: load their `insightId` and read the trace. The `error` event in the stream tells you what message the route emitted. If there's no error event but the trace ends mid-flight, the catch fired during `controller.close()` or the function hit Vercel's `maxDuration`. The `console.error` lines in Vercel's log explorer carry the matching timestamp — that's how you join the two channels today, by timestamp.

- **A class of bugs spikes after a deploy.** This is where the gap bites. With a logger you'd query `level:error AND event:agent.crash AND route:/api/agent`. Today you `grep` Vercel's logs for `[agent] error:` and read the raw strings. You can do it; it's just slow and the result has no structure to aggregate.

- **A captured run had a tool error.** This one the trace handles cleanly: `tool_call_end` carries an `error?: string` field. Read the event, read the `error`, identify the tool. No log layer needed — the trace already has the information, correlated by position.

### Code side by side, with a line-by-line read

The two stream-time catches — the only logs that fire on a real outage path. Same shape, twice.

```
  app/api/agent/route.ts  (lines 255–260)

  } catch (e) {
    console.error('[agent] error:', e); // full stack/cause in Vercel logs   ← stdout: untyped, no fields
    send({
      type: 'error',
      message: `/api/agent · ${e instanceof Error ? e.message : String(e)}`, ← wire: typed (AgentEvent)
    });
  } finally {
    controller.close();
  }
        │
        └─ both channels fire on the same throw. The `send` is the typed
           one (lands in the trace, replays via the cache). The
           `console.error` is the untyped one (lands in stdout, joined
           by timestamp only). The asymmetry IS the gap this file names.
```

```
  app/api/briefing/route.ts  (lines 247–253)

  } catch (e) {
    console.error('[briefing] error:', e); // full stack/cause in Vercel logs
    send({
      type: 'error',
      message: `/api/briefing · ${e instanceof Error ? e.message : String(e)}`,
    });
  } finally {
    controller.close();
  }
        │
        └─ duplicated catch shape, by copy. A log module would dedupe
           this to log.error({event, route, error: e}); reading the two
           catches side by side is the strongest argument for the
           extraction.
```

The trace's `error` event variant — the typed counterpart, defined once:

```
  lib/mcp/events.ts  (line 12)

  | { type: 'error'; message: string };                                       ← the typed error channel
        │
        └─ this is what the routes' `send({type:'error', ...})` lands as.
           Replayed from cache identically; rendered in the UI's
           ReasoningTrace identically. Same shape, every time. The
           contrast with the freeform console.error string is the lesson.
```

The McpClient's typed error throw — what produces the `e` that the catches receive:

```
  lib/mcp/client.ts  (lines 159–162)

  } catch (err) {
    this.lastCallAt = Date.now();
    // Tag transport-level failures (e.g. a 401) with the tool name so the UI
    // can show which call failed, not just a generic message.
    throw new McpToolError(name, errorDetail(err), { cause: err });
  }
        │
        └─ the tool name is on the error. So when the route's
           console.error fires, the message inside has the tool name —
           but only inside the stringified message, not as a structured
           field. That's the lossy step a logger would fix.
```

---

## Elaborate

The "trace as correlation envelope" pattern blooming insights uses is the same shape as request-scoped context in Go (`context.Context`) or async_hooks in Node (`AsyncLocalStorage`) — both let you stash request-scoped data so every log call inside the request can grab it without explicit threading. The difference: blooming insights doesn't need a context primitive because the events *are* the context. They live in one array, the array is one investigation, done.

What a real logger would buy beyond this: log levels (filter `level:error` vs `level:info` in Vercel's UI), redaction (a single place to strip `Authorization` headers from logged objects), and rate limiting (don't let a hot error path flood stdout). The first one matters for ops; the second matters for security; the third matters for cost. In a single-user pre-production app, none of them is urgent yet. Naming them explicitly is the point.

The closest comparable: Express + pino is the canonical Node combo. Pino is ~3 lines to set up, takes structured fields, and serializes to NDJSON (the same format the trace uses). The migration path is small — drop `lib/log.ts`, swap the 4 catches, done. The reason not to do it today is the same reason not to add OpenTelemetry: nothing is currently broken in a way only the structured log would catch.

---

## Interview defense

**Q1. The repo has 4× `console.error`. Is that an oversight?**

It's a *deliberate gap*, not an oversight. The trace handles the happy path: every event is typed, correlated by position in the stream, and replayable. The four catches handle the exception path *only*. Until exceptions are common enough to need aggregation or the field shape needs to be filterable, freeform strings are honest about what they are. The structural choice — co-locating evidence with the operation via the AgentEvent stream — means the log layer doesn't have to do much. The cost of *not* upgrading: when you do hit a class of outages, you `grep` strings instead of querying fields.

```
  trace handles:    expected agent activity (every event typed)
  log handles:      unexpected exceptions (4× console.error)
                                        │
                                        └─ acceptable today; first to upgrade
                                           when exception volume grows
```

**Anchor:** the correlation primitive is the array, not an ID. Once you see that, the thin log layer makes sense.

**Q2. What's the smallest change that would meaningfully improve the log surface?**

A 30-line `lib/log.ts` that exposes `log.error({event, ...fields}, err)`, serializes to NDJSON, and replaces the 4 catch sites. The diff would be: add the module, replace 4 lines. The win: structured search in Vercel's log explorer, redaction in one place, and consistent error shape. No new dependency required — `JSON.stringify({level, event, ts, ...fields})` is fine. The cost: ~half an hour. The risk: zero — the catches already exist, they just stringify badly today.

```
  diff size: 1 new file (~30 lines) + 4 single-line edits
  win:       filterable logs in Vercel, redaction one place, typed errors
  risk:      zero — no behavior change, only the log shape
```

**Anchor:** name the file path and the count of edited lines. Concreteness signals you've actually looked at the catches, not just theorized.

---

## Validate

1. **Reconstruct.** Without looking, list the four catch sites by file and what each one does on top of the `console.error`. (Hint: two return JSON, two send an `error` event.)
2. **Explain.** Why is "the array IS the correlation envelope" a substitute for a correlation ID? What category of bug breaks that substitution?
3. **Apply to a scenario.** A class of users hits the same crash. With today's logs, walk the steps you'd take to confirm it's the same crash for all of them. Then re-walk it assuming a structured logger existed.
4. **Defend the decision.** Argue for keeping `console.error` for one more quarter. Argue against. Name the leading indicator that flips the decision.

---

## See also

- `01-observability-map.md` — the bigger picture: the log layer is one row in a map where the trace row is much stronger.
- `05-traces-and-request-lifecycles.md` — the trace as the primary observability surface, including the typed `error` event variant.
- `07-incident-analysis-and-prevention.md` — the flake-fix incident; the `console.error` lines played no role in finding it, because the failure was test-time, not runtime.
- `08-debugging-observability-red-flags-audit.md` — where this gap is ranked against the others.
