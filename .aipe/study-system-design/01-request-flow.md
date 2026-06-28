# Request flow — the briefing and investigation pipelines

**Industry name:** request flow / orchestrated request handler · Language-agnostic

## Zoom out, then zoom in

The two streaming routes (`/api/briefing` and `/api/agent`) carry the entire
product. Same shape: a route handler builds a DataSource, bootstraps the
workspace schema, runs one or more agents, streams NDJSON. Different bodies:
one runs the monitoring agent and emits insights; the other runs a sequential
diagnostic-then-recommendation pipeline.

You know how a typical Next.js handler looks — parse the URL, do some work,
`return NextResponse.json(...)`. This is the same shape on the outside; the
inside swaps the synchronous JSON for a `ReadableStream<Uint8Array>` that
emits one NDJSON line per event as the agent does its work.

```
  Zoom out — where the request flow lives

  ┌─ UI layer ─────────────────────────────────────────┐
  │  app/page.tsx → fetch('/api/briefing?mode=...')     │
  │  useBriefingStream, useInvestigation hooks          │
  └──────────────────────┬──────────────────────────────┘
                         │  HTTP, NDJSON response body
  ┌─ Service layer ──────▼──────────────────────────────┐
  │  app/api/briefing/route.ts ★ REQUEST FLOW ★         │ ← we are here
  │  app/api/agent/route.ts                             │
  │    parse → makeDataSource → bootstrap → run agents  │
  │    → stream NDJSON                                  │
  └──────────────────────┬──────────────────────────────┘
                         │
  ┌─ DataSource layer ───▼──────────────────────────────┐
  │  BloomreachDataSource  |  SyntheticDataSource       │
  └──────────────────────┬──────────────────────────────┘
                         │
  ┌─ Provider layer ─────▼──────────────────────────────┐
  │  Bloomreach MCP   |   in-process synthetic data     │
  └─────────────────────────────────────────────────────┘
```

The thing to remember: a route handler in this codebase isn't a function that
returns a response — it's an orchestrator that builds a streaming response
*while* it does work, and threads cancellation into every layer below.

## Structure pass — layers, axis, seams

**Layers:** UI hook → Route handler → DataSource adapter → Provider.

**Axis (held constant): "who decides what happens next?"** Trace it down the
stack and watch the answer flip at each seam.

```
  Axis: who decides control flow?

  ┌─ Browser hook (useBriefingStream) ─────────────────┐
  │  fetch() → reader loop → switch(event.type)        │   → CLIENT decides
  └────────────────────────────┬───────────────────────┘
                               │
  ┌─ Route handler ────────────▼───────────────────────┐
  │  fixed phase order: bootstrap → list → scan → done │   → CODE decides
  └────────────────────────────┬───────────────────────┘
                               │
  ┌─ Agent loop (AptKit) ──────▼───────────────────────┐
  │  message → tool_use → tool_result → message → ...  │   → LLM decides
  └────────────────────────────┬───────────────────────┘
                               │
  ┌─ DataSource / MCP transport ───────────────────────┐
  │  callTool(name, args) → fetch → JSON               │   → PROVIDER runs
  └────────────────────────────────────────────────────┘
```

The axis flips at every seam. That's why the route handler is a *pipeline*
(fixed order: schema → tools → agent → done) wrapping an *agent loop* (model
decides per turn). The pipeline guarantees consistent stage ordering; the
loop inside it gives the model freedom to choose tools. Pattern: outer
pipeline, inner loop.

**Seams (boundaries where control flips):**

- **Browser → Route handler** (HTTP) — the HTTP request hand-off. Auth is
  checked BEFORE committing to a stream so 401s can return JSON instead of
  an empty stream (`app/api/briefing/route.ts:180-182`).
- **Route handler → Agent layer** (function call) — the route owns phase
  ordering and timing; the agent owns model+tool decisions.
- **Agent layer → DataSource** (interface call) — the agent doesn't know
  which adapter is plugged in; it only knows `callTool`.
- **DataSource → Provider** (HTTP or in-process) — the adapter knows the
  wire format; the agent doesn't.

## How it works

The mechanism walks through three moves: the mental model (what shape this
is), the step-by-step body of one request, and the principle.

### Move 1 — the mental model

A route handler in this codebase looks like a streaming `fetch`-handler with
a fixed phase sequence inside it. The shape:

```
  Pattern — orchestrated streaming pipeline

       ┌─────────────────────────────────────────────┐
       │ Stage 1 — parse + auth-gate (returns JSON   │
       │           on failure, no stream committed)  │
       └──────────────────┬──────────────────────────┘
                          │
       ┌──────────────────▼──────────────────────────┐
       │  Open ReadableStream → controller           │
       └──────────────────┬──────────────────────────┘
                          │
       ┌──────────────────▼──────────────────────────┐
       │ Stage 2 — bootstrap (schema)                │   ──► emit reasoning_step
       └──────────────────┬──────────────────────────┘
                          │
       ┌──────────────────▼──────────────────────────┐
       │ Stage 3 — list_tools                        │
       └──────────────────┬──────────────────────────┘
                          │
       ┌──────────────────▼──────────────────────────┐
       │ Stage 4 — RUN AGENT (the variable stage)    │   ──► emits tool_call_*,
       │           — monitor / diagnose / recommend  │       reasoning_step, …
       └──────────────────┬──────────────────────────┘
                          │
       ┌──────────────────▼──────────────────────────┐
       │ Stage 5 — emit 'done', close controller     │
       └─────────────────────────────────────────────┘

       Wrapping every stage:
         try / catch — error events → close
         finally     — dispose, console-log summary, close
```

The shape never changes between routes; only Stage 4 differs.

### Move 2 — the step-by-step walkthrough

Walking one live briefing request from `GET /api/briefing?mode=live-bloomreach`
end-to-end.

#### Step 1 — parse + auth-gate (before any stream)

The route never commits to a stream when it can return a flat JSON error
instead. The order matters: a `401 needsAuth` response triggers the browser
to redirect to the OAuth provider (`useBriefingStream.ts:162-171`); a
started-then-failed stream can't do that cleanly because the response status
is already 200.

```typescript
// app/api/briefing/route.ts:155-188 (abridged)
if (!process.env.ANTHROPIC_API_KEY) {
  return NextResponse.json({ error: 'ANTHROPIC_API_KEY is not set' }, { status: 500 });
}
const mode: LiveMode = parseLiveMode(req.nextUrl.searchParams.get('mode'));

let sid: string;
let dsResult: Awaited<ReturnType<typeof makeDataSource>>;
try {
  sid = await getOrCreateSessionId();      // sets bi_session cookie if absent
  dsResult = await makeDataSource(mode, sid);
} catch (e) {
  // wrapped because a setup throw (missing AUTH_SECRET) shouldn't bare-500
  return NextResponse.json({ error: `... ${e.message}` }, { status: 500 });
}
if (!dsResult.ok) {
  // Bloomreach has no valid tokens → 401 + authUrl for the browser to redirect
  return NextResponse.json({ needsAuth: true, authUrl: dsResult.authUrl }, { status: 401 });
}
```

The annotation worth keeping: **auth runs before the stream opens.** This is
the only place we can speak JSON to the client. After this point, every
problem becomes an NDJSON `error` event.

#### Step 2 — open the stream, set up the emit helpers

```typescript
// app/api/briefing/route.ts:190-207 (abridged)
const encoder = new TextEncoder();
const stream = new ReadableStream<Uint8Array>({
  async start(controller) {
    const send = (e: BriefingEvent) =>
      controller.enqueue(encoder.encode(JSON.stringify(e) + '\n'));
    const step = (content: string) =>
      send({ type: 'reasoning_step',
             step: { id: crypto.randomUUID(), agent: 'monitoring',
                     kind: 'thought', content } });
    const t0 = performance.now();
    const phases: Array<{ phase: string; durationMs: number }> = [];
    // ...try/catch/finally body below...
  }
});
return new Response(stream, {
  headers: { 'content-type': 'application/x-ndjson; charset=utf-8',
             'cache-control': 'no-store, no-transform' }
});
```

`send` is the one-liner the rest of the handler uses. Every event becomes a
single JSON object + `\n`. The encoder is hoisted because allocating one per
event would be wasteful — same shape as `encodeEvent` in
`lib/mcp/events.ts:14-17` (the agent route uses the named helper; briefing
inlines because it adds `workspace` and `coverage_item` event types not in
the shared `AgentEvent` union).

```
  Layers-and-hops — opening the stream

  ┌─ Client ──────────────┐   GET /api/briefing?mode=...     ┌─ Route ─────┐
  │  fetch()              │ ────────────────────────────────► │  parse + auth│
  └───────────────────────┘                                   └──────┬───────┘
                                                                     │ ok → 200
                                                  return Response(   │
                                  ReadableStream + ndjson headers)   │
                                                                     ▼
  ┌─ Client ──────────────┐  body.getReader() (ndjson hook)  ┌─ Route ─────┐
  │  readNdjson loop      │ ◄──────────────────────────────── │  controller.│
  └───────────────────────┘  one JSON object per '\n'         │  enqueue()  │
                                                              └──────────────┘
```

#### Step 3 — bootstrap the schema (inside the stream)

The schema-fetch is the first phase that costs real time (~1-4 calls @ ~1
req/s on cold cache). Doing it INSIDE the stream means the client sees the
"reading the workspace schema…" reasoning_step immediately, instead of a
silent multi-second wait followed by a burst.

```typescript
// app/api/briefing/route.ts:215-221
req.signal.throwIfAborted();
step('reading the workspace schema…');
const t_schema = performance.now();
const schema = await bootstrap(req.signal);    // factory's bootstrap → bootstrapSchema
recordPhase('schema_bootstrap', t_schema);
send({ type: 'workspace', workspace: { ... }});
```

Cancellation lands at the top of every phase via `throwIfAborted()` — the
in-flight `await` already honours the signal because it's threaded down to
`dataSource.callTool({ signal })`; the explicit throw catches the case where
the client cancelled BETWEEN phases.

#### Step 4 — schema gate (the cheapest move in the system)

Before the monitoring agent gets called, the route computes which of the 10
anomaly categories the workspace can actually answer. Only those reach the
agent. See `09-schema-gated-coverage.md` for the deep walk.

```typescript
// app/api/briefing/route.ts:234-246 (abridged)
const capabilities = schemaCapabilities(schema);
const coverage = coverageReport(capabilities);
const runnable = runnableCategories(capabilities);
coverage.forEach((item) => { step(coverageLines[i]); send({ type: 'coverage_item', item }); });
```

#### Step 5 — run the agent (Stage 4, the variable one)

This is where the routes diverge. The monitoring route calls
`agent.scan(runnable, hooks)`; the agent route calls one of three
(`DiagnosticAgent`, `RecommendationAgent`, `QueryAgent`). The hooks are
the bridge from the agent's tool/text events to the NDJSON stream:

```typescript
// app/api/briefing/route.ts:262-281 (abridged)
const anomalies = await agent.scan({
  onToolCall:   (tc) => { send({ type: 'tool_call_start', toolName: tc.toolName, agent: 'monitoring' });
                          step(describeToolCall(tc)); },
  onToolResult: (tc) => send({ type: 'tool_call_end', toolName: tc.toolName, agent: 'monitoring',
                               durationMs: tc.durationMs ?? 0, result: trunc(tc.result),
                               error: tc.error }),
  onText:       (t)  => { if (t.trim()) step(t.trim()); },
  signal:       req.signal,
}, runnable);
```

Every tool call the agent makes becomes two NDJSON lines (`tool_call_start`
+ `tool_call_end`); every model-emitted text becomes a `reasoning_step`.

#### Step 6 — terminate the stream

```typescript
// app/api/briefing/route.ts:283-288
const insights = anomalies.map(anomalyToInsight);
putInsights(sid, insights, anomalies);
for (const insight of listInsights(sid)) send({ type: 'insight', insight });
send({ type: 'done' });
```

The agent route additionally writes the combined-run cache for replay
(`app/api/agent/route.ts:301-302`), but only when `step == null` (the
legacy combined run used by the capture). Split steps hand off via the
client's `sessionStorage` — see `08-client-stream-handoff.md`.

#### Step 7 — finally: dispose, log, close

```typescript
// app/api/briefing/route.ts:303-326 (abridged)
} catch (e) {
  if (e instanceof DOMException && e.name === 'AbortError') return;   // client cancelled
  console.error('[briefing] error:', redactSecrets(formatError(e)));
  send({ type: 'error', message: `/api/briefing · ${e.message}` });
} finally {
  try { await disposeDataSource(); } catch (e) { /* must not swallow */ }
  console.log(JSON.stringify({
    route: '/api/briefing', sessionId: sid, mode,
    totalMs: Math.round(performance.now() - t0),
    phases, aborted: req.signal.aborted,
  }));
  controller.close();
}
```

Three things to notice. **One**: the AbortError check suppresses error
events for a cancelled client (no consumer to read them) but still lets
`finally` run. **Two**: the dispose error is caught locally — a dispose
failure must not swallow the route-level error above. **Three**: the
console-log is the only observability signal — see audit lens 8 (R6).

### Move 2.5 — what's different in `/api/agent`

The pipeline shape is identical; the body differs. Three branches inside
Stage 4:

```
  /api/agent — three branches inside Stage 4

  Branch A — query (q != null, no insightId):
    classifyIntent(query) → QueryAgent.answer(query, intent) → text + done

  Branch B — diagnose (step='diagnose' or null):
    DiagnosticAgent.investigate(anomaly) → diagnosis → recommendation (if null step)

  Branch C — recommend (step='recommend'):
    parseDiagnosis(?diagnosis=...) → RecommendationAgent.propose(anomaly, diagnosis)
```

And one extra branch BEFORE Stage 1: cache-first replay
(`app/api/agent/route.ts:124-142`). When `insightId && !live`, the route
serves a precomputed investigation from `getCachedInvestigation(insightId)`
filtered by `step`, replayed with `REPLAY_DELAY_MS = 180` between events
for a readable pace. The demo path lives here.

### Move 3 — the principle

The principle is **build the pipeline, then put a loop inside it.** A pure
loop (let the model drive end-to-end) is unbounded and unpredictable —
hitting the 300s ceiling without a checkpoint is a real failure mode. A
pure pipeline (no loop at all, classic ETL) is too rigid for an agent
product where the next tool call depends on the previous result.

The fix is the hybrid you're looking at: a fixed-order pipeline at the
outer level (so phase timing is predictable and observable), with an agent
loop at the inner level (so the model can choose tools freely). The route
log line at the end of `finally` records *which phase* ate the budget when
a request blew the ceiling — an interview-grade observability story for
half a screen of structured-log JSON.

## Primary diagram

The recap visual. Everything Move 2 walked, in one frame.

```
  /api/briefing — one full request, layered

  ┌─ Browser ────────────────────────────────────────────────────────────┐
  │  fetch('/api/briefing?mode=live-bloomreach')                          │
  │  readNdjson(body, switch(event.type) → setState(...))                 │
  └──────────────────────┬───────────────────────────────────────────────┘
                         │  HTTP GET
  ┌─ Route handler ──────▼───────────────────────────────────────────────┐
  │                                                                       │
  │  STAGE 1 (sync return paths, no stream yet)                           │
  │    ANTHROPIC_API_KEY check → 500 JSON                                 │
  │    parseLiveMode + getOrCreateSessionId                               │
  │    makeDataSource(mode, sid)                                          │
  │      └─ Bloomreach not authed → 401 { needsAuth, authUrl }            │
  │                                                                       │
  │  ─── commit to stream: new ReadableStream({ start(controller) ──────  │
  │                                                                       │
  │  STAGE 2 schema_bootstrap        ──► send 'reasoning_step', 'workspace'│
  │  STAGE 3 coverage_gate           ──► send 'coverage_item' × N         │
  │  STAGE 4 list_tools                                                    │
  │  STAGE 5 monitoring_scan         ──► send 'tool_call_start/end',       │
  │                                       'reasoning_step', 'insight'     │
  │  STAGE 6 send 'done'                                                   │
  │                                                                       │
  │  catch (AbortError) → return     // client cancelled                  │
  │  catch (other)      → send 'error' { message }                        │
  │  finally:                                                              │
  │    await disposeDataSource()      // best-effort                       │
  │    console.log({ route, sid, mode, totalMs, phases, aborted })        │
  │    controller.close()                                                  │
  │                                                                       │
  └──────────────────────┬───────────────────────────────────────────────┘
                         │  one '\n'-terminated JSON object per event
                         ▼
                  back to the browser hook
```

## Elaborate

**Where this pattern comes from.** "Build a pipeline, run an agent inside"
is the working AI-engineer shape that emerged once people built enough
agent products to learn that pure-loop architectures explode and pure-ETL
architectures can't make decisions. The pipeline gives you the slots a
real engineering org needs (per-phase timing, per-phase metrics, clean
cancellation boundaries); the agent gives you the flexibility the product
needs (let the model pick the next tool).

**The deeper principle.** A streaming response is just a special case of
the request-handler pattern with one extra rule: **once the body starts,
the status code is fixed.** Everything error-shaped after that point has
to ride the body. That's why the auth-gate runs before
`new ReadableStream`, and why `AbortError` is swallowed in the catch:
the cancelled client can't read the 'error' event either way.

**Where it breaks.**

- **Sequential bootstrap blows the budget on cold start.** Schema
  bootstrap does 4 sequential MCP calls (`lib/mcp/schema.ts:195-198`); a
  cold cache + a rate-limit retry can eat 30s+. The module-level cache
  hides this on warm instances.
- **The error-as-NDJSON-line contract can confuse pre-AbortSignal
  clients.** A client that doesn't read the body after a cancel won't
  see the `'error'` event — which is fine because there's nothing to
  show, but it does mean errors that happen DURING a stream are
  invisible in any log aggregator that only reads response status codes.
- **The phase timings are a one-line JSON dump.** No traces, no spans,
  no parent-child correlation across routes. Fine for now; the line at
  the end of `finally` is a deliberate starting point (see audit R6).

**What to explore next.**

- `06-streaming-ndjson.md` — the wire contract this pipeline produces
- `07-multi-agent-orchestration.md` — Stage 4's three-branch body
- `03-datasource-seam.md` — the swappable provider behind `makeDataSource`
- `02-oauth-boundary.md` — why Stage 1 is non-negotiable

## Interview defense

#### Q: "Why is your route handler a pipeline AROUND an agent loop instead of just letting the agent drive end-to-end?"

A pure loop is unbounded — the agent can decide to keep calling tools
until it hits the model's max_tokens or our 300s `maxDuration`. We need
predictable phase timing for two reasons: cancellation boundaries (so
`throwIfAborted()` lands somewhere meaningful) and observability (so the
log line at end-of-`finally` tells me which phase ate the budget when a
request blows up).

```
  outer pipeline (CODE decides phases)
      └── inner loop (LLM decides tools within one phase)
```

**Surface:** the answer is "control flow flips at the agent boundary."
**Probe:** if asked to defend further — name the phase-log
(`app/api/briefing/route.ts:317-322`) and the `throwIfAborted()` calls at
every phase boundary as the concrete payoff.

#### Q: "What's the load-bearing part of this pipeline — what breaks if you remove it?"

The `try / catch / finally` is the kernel. Specifically: the `finally`
running even on `AbortError`. Remove that and the per-phase timings
disappear on every cancelled request — and on Vercel, a 300s-budget blow
is exactly the cancel case (client gave up, route still running). The
phase log is how we know where it died.

Other load-bearing parts (in order):

  → `req.signal.throwIfAborted()` between phases — cancellation must land
    at a clean boundary, not mid-stream
  → the auth-gate BEFORE `new ReadableStream` — the only place we can
    return JSON status codes
  → the per-phase `recordPhase(name, started)` — what makes the log
    actionable

Optional hardening (not load-bearing):

  → `redactSecrets` on the error log — important for security, but the
    pipeline runs without it
  → `trunc(tc.result)` to cap event size — quality-of-life

#### Q: "What changes at 10x users?"

The Bloomreach alpha rate-limits per user globally, so 10x concurrent
users doesn't change the per-user budget — but it does multiply the
warm-instance memory footprint (each session is a Map entry in
`lib/state/insights.ts`). Vercel auto-scales serverless instances, so
the binding constraint stays per-user. At 100x I'd worry about the
schema cache being per-instance — 100 warm instances each pay the
4-call bootstrap on first request. A shared cache (Vercel KV) is the
move.

## See also

- `00-overview.md` — the whole-system map
- `06-streaming-ndjson.md` — the NDJSON contract this pipeline produces
- `07-multi-agent-orchestration.md` — the variable Stage 4 body
- `05-caching-and-rate-limiting.md` — what makes Stage 2's bootstrap survivable
- `02-oauth-boundary.md` — why Stage 1's auth-gate exists
- `study-runtime-systems` — the async / AbortSignal / event-loop mechanics
- `study-networking` — HTTP, NDJSON-on-the-wire, connection lifecycle
