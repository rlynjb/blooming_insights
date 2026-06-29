# request-flow

## End-to-end request flow (industry standard)

How a single click in the browser becomes a streamed sequence of insights on the screen. The whole path from `fetch` to the last `done` event, in the order it actually happens.

## Zoom out — where this pattern lives

The request flow is the *spine* of the system. Every other pattern in this folder either rides on it, hangs off it, or hardens it.

```
  Zoom out — the request flow's place in the system

  ┌─ UI ────────────────────────────────────────────────┐
  │  page.tsx → useBriefingStream → fetch + readNdjson  │
  └────────────────────────────┬────────────────────────┘
                               │  HTTP, content-type: application/x-ndjson
  ┌─ Route layer ──────────────▼────────────────────────┐
  │  /api/briefing → session → factory → ★ FLOW ★ → ... │ ← we are here
  └────────────────────────────┬────────────────────────┘
                               │
  ┌─ Adapter layer ────────────▼────────────────────────┐
  │  DataSource adapter → external server (or fixtures) │
  └─────────────────────────────────────────────────────┘
```

This file walks the spine. The other pattern files zoom into each joint: `02-auth-boundary.md` for the session/auth hop, `03-datasource-seam.md` for the port boundary, `04-aptkit-primitive-boundary.md` for what happens inside `MonitoringAgent.scan`, `06-streaming-ndjson.md` for the wire format the spine streams in.

## Structure pass

Three layers carry the request: the **client** layer (the page + hooks), the **service** layer (the Next.js route handler), the **adapter** layer (`BloomreachDataSource` or `SyntheticDataSource`). One axis worth tracing across all three: **who decides control flow?**

```
  Axis: who decides control flow?

  ┌─ client ──────────────────┐    seam: HTTP
  │  CODE decides             │   ═════╪═════►
  │  (fixed fetch + dispatch) │
  └───────────────────────────┘
       ┌─ service ────────────┐    seam: port (`DataSource`)
       │  CODE decides phases │   ═════╪═════►
       │  (bootstrap → gate   │
       │   → scan → emit)     │
       └──────────────────────┘
            ┌─ agent inside service ──┐    seam: tool call
            │  LLM decides            │   ═════╪═════►
            │  (which EQL to run next)│
            └─────────────────────────┘
                 ┌─ adapter ─────┐
                 │  CODE again   │
                 │  (cache,      │
                 │   spacing,    │
                 │   retry)      │
                 └───────────────┘
```

The control-flow answer flips three times. The first flip (client → service) is just HTTP. The second (service → agent) is the surprising one: inside one route handler, control hands off to the LLM for the duration of the scan, then takes it back to emit the wire events. The third (adapter → external) is where the rate-limit envelope sits.

The load-bearing seam is the second flip — between the route's deterministic phases and the agent's autonomous loop. Everything downstream (streaming, reliability, demo replay) is shaped by the fact that the route must keep streaming events while the agent is in charge of *what to do next*.

## How it works

### Move 1 — the mental model

Think of a one-shot subscription: the browser opens a `fetch` and reads the response as it arrives, one newline-delimited JSON event at a time. The server writes events to the same `ReadableStream` as they happen — the schema bootstrap, the coverage decisions, each tool call start, each tool call end, each insight as it's computed, then `done`. There's no polling, no WebSocket, no second connection. One HTTP request, one progressive response, terminated by a `done` event.

```
  The pattern: progressive HTTP response, NDJSON-framed

  ┌─ browser ──┐                                    ┌─ server ────┐
  │   fetch    │ ──────── GET /api/briefing ──────► │  route.ts   │
  │            │                                    │             │
  │  reader.read() ◄── chunk: {workspace:…}\n ───── │  send(...)  │
  │  reader.read() ◄── chunk: {reasoning_step}\n ── │  send(...)  │
  │  reader.read() ◄── chunk: {tool_call_start}\n ─ │  send(...)  │
  │  reader.read() ◄── chunk: {tool_call_end}\n ─── │  send(...)  │
  │       …                                         │       …     │
  │  reader.read() ◄── chunk: {insight}\n ───────── │  send(...)  │
  │  reader.read() ◄── chunk: {done}\n ──────────── │  send(...)  │
  │  reader.read() ◄── (stream closes) ──────────── │  close()    │
  └────────────┘                                    └─────────────┘
```

That picture is the whole pattern. The rest of this file walks each phase the server runs between accepting the request and closing the stream.

### Move 2 — the step-by-step walkthrough

#### the request arrives

The page opens the request:

```ts
// lib/hooks/useBriefingStream.ts:154-158
const url = `/api/briefing${search}`;       // search = ?demo=cached OR ?mode=live-…
…
const res = await fetch(url);
```

The route handler answers (`app/api/briefing/route.ts:77`). Before it commits to streaming, it inspects two things: `?demo=cached` (which short-circuits to the snapshot replay), and the `Authorization` / session cookie state (which can return a 401 with the auth URL the browser must redirect to).

```
  Layers-and-hops — request lands on the route

  ┌─ browser ────┐  hop 1: GET /api/briefing?mode=… ┌─ Next.js route ─┐
  │  fetch       │ ──────────────────────────────► │  app/api/briefing/│
  │              │  hop 4: 200 + NDJSON stream ◄── │  route.ts        │
  └──────────────┘                                  └────────┬─────────┘
                                                            │ hop 2: read cookie
                                                            │       (bi_session)
                                                            ▼
                                                   ┌─ session helper ─┐
                                                   │  getOrCreateSessionId │
                                                   └────────┬─────────┘
                                                            │ hop 3: 401 + authUrl
                                                            │       when unauthorized
                                                            ▼
                                                   (or proceed to streaming)
```

#### resolve the session, build the adapter

The route resolves the session id from the cookie (or sets a fresh one), then asks the factory for an adapter:

```ts
// app/api/briefing/route.ts:170-186
sid = await getOrCreateSessionId();
dsResult = await makeDataSource(mode, sid);
…
if (!dsResult.ok) {
  return NextResponse.json({ needsAuth: true, authUrl: dsResult.authUrl }, { status: 401 });
}
const dataSource = dsResult.dataSource;     // the port — narrowed to DataSource
const bootstrap = dsResult.bootstrap;       // closure over the adapter's bootstrap step
const disposeDataSource = dsResult.dispose; // best-effort teardown
```

`makeDataSource` is the factory (`lib/data-source/index.ts:67-100`). For `'live-bloomreach'` it defers to `connectMcp(sessionId)` which runs the OAuth dance and returns a `BloomreachDataSource`; for `'live-synthetic'` it constructs a `SyntheticDataSource` directly. The route holds only the abstract surface — it does not know which adapter it got. → see `03-datasource-seam.md`.

If the auth dance fails (no valid token, never authorized), the factory returns `{ ok: false, authUrl }` and the route sends a 401 JSON body containing the URL the browser should redirect to. The hook reads that on `res.status === 401` and navigates (`useBriefingStream.ts:162-171`). → see `02-auth-boundary.md`.

#### commit to streaming

Once the auth gate passes, the route opens a `ReadableStream` and returns it. Every `controller.enqueue(...)` from inside `start()` becomes a chunk on the wire:

```ts
// app/api/briefing/route.ts:190-200
const encoder = new TextEncoder();
const stream = new ReadableStream<Uint8Array>({
  async start(controller) {
    const send = (e: BriefingEvent) =>
      controller.enqueue(encoder.encode(JSON.stringify(e) + '\n'));
    const step = (content: string) =>
      send({ type: 'reasoning_step', step: { id: crypto.randomUUID(), agent: 'monitoring', kind: 'thought', content } });
    …
```

The `'\n'` at the end of every event is the wire framing. The reader on the other side splits on `'\n'` and `JSON.parse` each chunk. → see `06-streaming-ndjson.md`.

#### phase 1 — bootstrap the schema

The first useful work: ask the adapter to describe the workspace.

```ts
// app/api/briefing/route.ts:215-229
req.signal.throwIfAborted();
step('reading the workspace schema…');
const t_schema = performance.now();
const schema = await bootstrap(req.signal);
recordPhase('schema_bootstrap', t_schema);
send({ type: 'workspace', workspace: { … } });
```

`bootstrap(signal)` is a closure the factory baked over the adapter. For Bloomreach, it runs the loomi connect orchestrator (`list_cloud_organizations` → `list_projects` → `get_event_schema` → …) and returns a `WorkspaceSchema`. For Synthetic, it returns a fixture.

This is also the first place a `workspace` event hits the wire — the UI shows the project name and customer count in the header as soon as the schema is back.

#### phase 2 — schema-gated coverage

The 10-category checklist gates which categories actually run:

```ts
// app/api/briefing/route.ts:234-246
const capabilities = schemaCapabilities(schema);
const coverage = coverageReport(capabilities);
const runnable = runnableCategories(capabilities);
step('matching the workspace schema to the 10-category anomaly checklist…');
const coverageLines = coverageChecklistSteps(coverage);
coverage.forEach((item, i) => {
  step(coverageLines[i]);
  send({ type: 'coverage_item', item });
});
```

Each `coverage_item` event fills one tile in the UI's coverage grid. The `runnable` array is what the agent actually scans — categories with missing dependencies are surfaced honestly, not silently skipped. → see `09-schema-gated-coverage.md`.

#### phase 3 — list tools, build the agent

```ts
// app/api/briefing/route.ts:248-257
req.signal.throwIfAborted();
const raw = await dataSource.listTools({ signal: req.signal });
const allTools: McpToolDef[] = …
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const agent = new MonitoringAgent(anthropic, dataSource, schema, allTools, sid);
```

`MonitoringAgent` is a thin wrapper around the library agent (`@aptkit/core`'s `AnomalyMonitoringAgent`); the wrapper's job is to construct the three adapter classes — model provider, tool registry, trace sink — and hand them in. → see `04-aptkit-primitive-boundary.md`.

#### phase 4 — the scan (control flow flips to the LLM)

This is the second seam from the structure pass. The route calls `agent.scan(...)` with three event hooks; from this point until the scan returns, *the LLM decides what to do next*.

```ts
// app/api/briefing/route.ts:259-281
req.signal.throwIfAborted();
step(`checking ${runnable.length} of 10 anomaly categories against this workspace…`);
const t_scan = performance.now();
const anomalies = await agent.scan({
  onToolCall: (tc) => {
    send({ type: 'tool_call_start', toolName: tc.toolName, agent: 'monitoring' });
    step(describeToolCall(tc));   // surfaces the real EQL query as the live status line
  },
  onToolResult: (tc) =>
    send({
      type: 'tool_call_end',
      toolName: tc.toolName,
      agent: 'monitoring',
      durationMs: tc.durationMs ?? 0,
      result: trunc(tc.result),
      error: tc.error,
    }),
  onText: (t) => { if (t.trim()) step(t.trim()); },
  signal: req.signal,
}, runnable);
```

Each hook turns an internal AptKit event into one or more NDJSON events on the wire. The user sees the agent's queries appear in the status panel in near real time — the "shows its work" pitch from the product context.

The `signal: req.signal` is the load-bearing detail: if the browser closes the tab, the abort signal propagates into the AptKit loop → into `dataSource.callTool({signal})` → into the Anthropic SDK call's `{signal}` option. The whole subtree cancels.

```
  Layers-and-hops — the scan, with control flipping to the LLM and back

  ┌─ route handler ────────┐   hop A: agent.scan(hooks, runnable)
  │  app/api/briefing      │ ───────────────────────────────────────►
  └────────────────────────┘                                          ┌─ AptKit loop ───┐
                                                                      │  decides which  │
                                                                      │  tool to call   │
                                                                      └────────┬────────┘
                                                                               │ hop B
                                                                               │ tool_use
                                                                               ▼
                                                                      ┌─ tool registry ─┐
                                                                      │  callTool       │
                                                                      └────────┬────────┘
                                                                               │ hop C
                                                                               ▼
                                                                      ┌─ DataSource ────┐
                                                                      │  Bloomreach OR  │
                                                                      │  Synthetic      │
                                                                      └────────┬────────┘
                                                                               │ hop D
                                                                               │ result
                                                                               ▼
                                                                      ┌─ trace sink ────┐
                                                                      │  emit event     │
                                                                      └────────┬────────┘
                                                                               │ hop E
  ┌──────────────────────────◄────────────────────────────────────────────────┘
  │  send({ type: 'tool_call_end', … })  ← back on the wire
  ▼
  (loop until the model emits its final synthesis — no more tool_use blocks)
```

The loop terminates when the model emits a turn with no tool-use blocks (the synthesis turn). The route block waits for the whole `agent.scan(...)` promise to resolve; the wire has been receiving events the whole time.

#### phase 5 — convert anomalies, persist, emit insights

```ts
// app/api/briefing/route.ts:283-288
req.signal.throwIfAborted();
const insights = anomalies.map(anomalyToInsight);
putInsights(sid, insights, anomalies);
for (const insight of listInsights(sid)) send({ type: 'insight', insight });

send({ type: 'done' });
```

`putInsights(sid, …)` writes to the session-keyed feed map (`lib/state/insights.ts`). Each insight becomes one wire event. Then `done` closes the logical stream.

#### cleanup — the finally block runs on every exit path

```ts
// app/api/briefing/route.ts:289-326 (condensed)
} catch (e) {
  if (e instanceof DOMException && e.name === 'AbortError') return;  // client cancelled
  console.error('[briefing] error:', redactSecrets(formatError(e)));
  send({ type: 'error', message: `/api/briefing · ${...}` });
} finally {
  try { await disposeDataSource(); } catch (e) { … }
  console.log(JSON.stringify({
    route: '/api/briefing',
    sessionId: sid,
    mode,
    totalMs: Math.round(performance.now() - t0),
    phases,                              // [{ phase, durationMs }, …]
    aborted: req.signal.aborted,
  }));
  controller.close();
}
```

Three things matter here:

- The cancel path (the `AbortError` branch) returns *without* emitting an error event — there's nobody listening — but it still falls through to `finally`, so the phase log fires with `aborted: true` and the partial budget consumed.
- The dispose call is best-effort. A dispose error must not swallow the route error.
- The per-request log line is the observability spine. Same shape on `/api/agent`, so one Vercel filter reads across both routes.

### Move 3 — the principle

The request flow is a *single progressive HTTP response* with a deterministic shell wrapping an autonomous core. The shell — bootstrap, gate, list tools, persist, emit — runs in fixed order, written in TypeScript. The core — the scan — runs under the LLM's control, but every event it generates is forwarded through the same `send` function as the shell's own events. The wire never knows the difference.

The transferable lesson: when an agent loop sits inside a server route, treat the route as a *streaming shell* and the loop as one of its phases. Don't try to make the route imperative-from-end-to-end (it can't predict what the agent will do); don't try to make the loop emit directly to the wire (you'll lose the route's framing and cleanup). Hooks in, NDJSON out — the route owns the boundary; the library owns the loop.

## Primary diagram

The full flow, recap visual.

```
  /api/briefing — full request flow

  ┌─ browser ─────────────────────────────────────────────────────────────┐
  │  page.tsx                                                              │
  │    useBriefingStream → fetch('/api/briefing?mode=live-bloomreach')     │
  │                                                                        │
  │   ◄── 401 + { needsAuth, authUrl }     → window.location = authUrl     │
  │   ◄── 200 + NDJSON stream              → readNdjson(body, handle, …)   │
  └──────────────────┬─────────────────────────────────────────────────────┘
                     │  HTTP
  ┌─ Next.js route ─▼─────────────────────────────────────────────────────┐
  │  app/api/briefing/route.ts (maxDuration = 300)                         │
  │                                                                        │
  │  1. session     getOrCreateSessionId()                                  │
  │  2. factory     makeDataSource(mode, sid)                               │
  │                   ├─ live-bloomreach → connectMcp → BloomreachDataSource│
  │                   └─ live-synthetic  → new SyntheticDataSource()        │
  │  3. commit      new ReadableStream({ start(controller) { … } })         │
  │  4. bootstrap   bootstrap(signal) → schema   ─ emit workspace           │
  │  5. gate        coverageReport(capabilities) ─ emit coverage_item ×10   │
  │  6. tools       dataSource.listTools(signal) → allTools                 │
  │  7. scan        new MonitoringAgent(...).scan(hooks, runnable)          │
  │                   ╱ onToolCall    → emit tool_call_start + step         │
  │                   ╲ onToolResult  → emit tool_call_end                  │
  │                     onText        → emit reasoning_step                 │
  │  8. persist     putInsights(sid, insights)                              │
  │  9. emit        emit insight × N → emit done                            │
  │ 10. finally     dispose() + log { route, sid, mode, totalMs, phases }   │
  └──────────────────┬─────────────────────────────────────────────────────┘
                     │  port: DataSource.callTool
  ┌─ adapter ───────▼─────────────────────────────────────────────────────┐
  │  BloomreachDataSource (HTTPS) OR SyntheticDataSource (in-process)      │
  └────────────────────────────────────────────────────────────────────────┘
```

## Elaborate

**Where this pattern comes from.** Progressive HTTP responses predate modern frameworks — chunked transfer encoding is a 1999 HTTP/1.1 feature. NDJSON over `fetch` is the modern equivalent of Server-Sent Events without the protocol overhead: no `Last-Event-ID` semantics, no automatic reconnect, no event-type discrimination at the transport layer. The wire format is just "JSON, one per line." The trade is that you write the framing yourself and the reconnect policy yourself (which is exactly what `useReconnectPolicy` does for the token-revocation case).

**Why not `EventSource`.** Two reasons. First, `EventSource` only supports GET — it can't carry a JSON body (the investigation route uses POST with the diagnosis payload). Second, `EventSource` reconnects automatically with `Last-Event-ID`, which is the wrong semantics here: a reconnect during a live agent scan would either duplicate work or skip events. The hand-rolled `fetch + readNdjson` model gives explicit control over reconnect, which `useReconnectPolicy` uses to do one-shot reload-after-auth-error.

**Why not WebSocket.** Same reasons plus the deployment overhead. Vercel functions are request-response; a long-lived socket needs a different runtime. The progressive HTTP response fits the serverless model exactly: one request, one streamed response, then teardown.

**What changes if this evolves.** The two natural growth paths are (a) a second producer route emitting on the same wire (chat, free-form query) — already exercised by `/api/agent` — and (b) backpressure. Today the producer enqueues as fast as it can; if a slow reader ever became a real concern, `ReadableStream` has a built-in backpressure signal (`controller.desiredSize`) the producer could honor. Neither is needed today.

## Interview defense

**Q: Walk me through what happens between the user clicking "live" and the first insight appearing on screen.**

> The page's `useBriefingStream` hook opens `GET /api/briefing?mode=live-bloomreach`. The route resolves the session cookie, calls the factory `makeDataSource`, which runs the OAuth dance and returns a `BloomreachDataSource`. If the dance fails, the route sends 401 + the auth URL and the hook navigates. Otherwise the route opens a `ReadableStream`, bootstraps the workspace schema, gates the 10-category checklist, lists the MCP tools, builds the `MonitoringAgent`, and calls `agent.scan(hooks, runnable)`. The agent runs the loop under the LLM's control; each tool call fires `onToolCall` / `onToolResult` hooks, which the route turns into NDJSON events on the wire. As soon as the first anomaly is produced and converted to an `Insight`, an `insight` event hits the wire and the UI renders the card.

```
  the spine, one sentence per phase

  fetch → 401-gate → ReadableStream
        → bootstrap → coverage → listTools
        → MonitoringAgent.scan { onToolCall, onToolResult, onText }
        → putInsights → emit insight × N → emit done
        → finally: dispose + log
```

**Anchor:** `app/api/briefing/route.ts:170-288`.

**Q: The LLM is in control during `agent.scan`. How does the route handle that?**

> The route gives up imperative control of "what query to run next" but keeps imperative control of "what hits the wire." It passes three hooks into the agent: `onToolCall`, `onToolResult`, `onText`. The agent fires those hooks as it runs; the route translates each one into an NDJSON event. So the LLM owns the loop's *decisions* but the route owns the *framing*. The seam is the hook surface — the agent doesn't know there's an HTTP response on the other side; the route doesn't know which EQL the model will pick next.

```
  the load-bearing seam

  ┌─ route owns ─┐  hooks  ┌─ AptKit owns ─┐
  │ NDJSON wire  │ ◄────── │ the loop      │
  │ + framing    │         │ + decisions   │
  └──────────────┘         └───────────────┘
```

**Anchor:** the three hooks at `app/api/briefing/route.ts:262-280`, called from inside `agent.scan` via `BloomingTraceSinkAdapter.emit` at `lib/agents/aptkit-adapters.ts:108-130`.

**Q: What's the most load-bearing piece you'd point at if I asked "what breaks if it goes wrong?"**

> The `req.signal` thread. Cancellation has to propagate from the browser's `AbortController` (`useBriefingStream` cleanup) into `req.signal` (the route's input), into every async call the route makes — `bootstrap(req.signal)`, `dataSource.listTools({signal})`, `dataSource.callTool({signal})`, and the Anthropic SDK call's `{signal}` option. If any layer drops the signal, the route keeps burning the 300-second budget on a request the browser already abandoned. The `req.signal.throwIfAborted()` checks between phases are coarse safety nets; the per-call `{signal}` is the fine-grained one.

```
  the cancel chain

  browser AbortController
        │
        ▼
  req.signal  ── route checks .throwIfAborted() between phases
        │
        ├──► bootstrap(req.signal)
        ├──► dataSource.listTools({ signal: req.signal })
        ├──► dataSource.callTool({ signal })  ◄── per tool call
        └──► anthropic.messages.create(params, { signal })
```

**Anchor:** `app/api/briefing/route.ts:215, 248, 259, 283` plus the SDK signal at `lib/agents/aptkit-adapters.ts:52-55`.

## See also

- `02-auth-boundary.md` — the auth dance the factory defers to
- `03-datasource-seam.md` — the port the route narrows to
- `04-aptkit-primitive-boundary.md` — what happens inside `agent.scan`
- `06-streaming-ndjson.md` — the wire format this flow emits
- `07-in-memory-state-ownership.md` — where `putInsights` writes
- `08-demo-replay-as-reliability.md` — the alternate path when `?demo=cached`
- `09-schema-gated-coverage.md` — how `runnable` is decided
- `10-rate-limit-aware-mcp-client.md` — what the adapter does behind `callTool`
