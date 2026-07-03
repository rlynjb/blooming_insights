# Queues, Streams, Ordering, and Backpressure

*Industry name: server-sent events · NDJSON stream · cancellation-based backpressure · Type: Industry standard*

## Zoom out — where this concept lives

No message broker in this repo — no Kafka, no SQS, no Redis Streams. The one streaming surface is **the response stream from the Vercel function back to the browser**, framed as NDJSON events over an SSE-style keep-alive. Backpressure is one-way: the browser cancels; the server aborts. That's the whole story.

```
  Zoom out — the one streaming surface

  ┌─ Browser ──────────────────────────────────────────────┐
  │  fetch('/api/agent') → response.body reader             │
  │  cancels via AbortController on unmount / navigate     │
  └──────────────┬────────────────────▲────────────────────┘
                 │  NDJSON stream     │  req.signal
                 │  (agent events)    │  (aborts)
                 ▼                    │
  ┌─ Server ─────────────────────────┴───────────────────┐
  │  ReadableStream<Uint8Array> in route.ts               │
  │  each agent event → JSON line → controller.enqueue    │
  │                                                       │
  │  ★ THIS FILE: the stream, its ordering, its cancel ★   │
  └───────────────────────────────────────────────────────┘
```

Everything else — messages between agents, tool calls, results — happens **inside a single function invocation** as ordinary function calls. Ordering is program order. There are no queues to worry about.

## Zoom in — narrow to the concept

The streaming surface answers three questions:

1. **What framing?** — NDJSON (JSON objects delimited by `\n`), served with `Content-Type: application/x-ndjson`.
2. **What ordering?** — strict program order from the server's `send(...)` calls. No reordering.
3. **What backpressure?** — cancellation-only. The browser aborts; the server sees `req.signal.aborted` and unwinds.

Everything else — retries, throttling, dropped messages — is out of scope for this file. This is a *streaming response over one request*, not a durable queue.

## Structure pass

### Layers

- **Route** (`app/api/agent/route.ts`) — owns the `ReadableStream<Uint8Array>` and enqueues encoded events.
- **Event encoder** (`lib/mcp/events.ts`) — `encodeEvent(e)` renders a `AgentEvent` as a `\n`-terminated JSON line.
- **Client fetch** — the browser reads the body incrementally via a `Response.body.getReader()` loop.
- **Cancellation path** — `req.signal` is a `AbortSignal` that fires when the browser cancels or the connection drops.

### One axis held constant — "what happens when the reader stops reading?"

```
  Axis: backpressure at each layer

  browser        → reader.cancel() → server sees req.signal.aborted
                    OR: page unloads → connection drops → signal aborts

  route          → controller.enqueue() keeps queueing until
                    the ReadableStream is closed or errors
                    (Vercel's platform may block if buffers fill,
                     but this happens rarely at NDJSON sizes)

  agent loop     → checks req.signal.throwIfAborted() at phase
                    boundaries → clean unwind + finally block

  MCP call       → composeSignals(routeSig, timeout(30s)) →
                    in-flight fetch cancelled immediately
```

The answer flips at every layer. **Backpressure is transmitted upstream by aborting the AbortSignal, not by pausing the write side.** That's the design.

### Seams

- **Encode seam** (`lib/mcp/events.ts`): `encodeEvent(e)` returns a string; the route encodes it to bytes. The stream never sees objects.
- **Enqueue seam** (`route.ts:194`): `controller.enqueue(encoder.encode(...))`. Once a byte's in, it's committed.
- **Cancel seam** (`route.ts:231, 242, 253, ...`): every phase boundary checks `req.signal.throwIfAborted()`.

## How it works

### Move 1 — the mental model

You've written an SSE stream before: `Content-Type: text/event-stream`, server writes lines, browser reads with `EventSource`. This is close, but framed as NDJSON — one JSON object per line, delimiter is a bare `\n`. The reader isn't `EventSource`; it's a `TextDecoder` over `response.body.getReader()`.

```
  The pattern — one-writer streaming with cancel-driven backpressure

  server                                       browser
    │                                             │
    │ ── phase X starts                           │
    │ send({type:'reasoning_step', …})            │
    │──────── JSON line + \n ─────────────────►   │
    │                                             │ decode + parse
    │                                             │ dispatch to UI
    │                                             │
    │ send({type:'tool_call_start', …})           │
    │──────── JSON line + \n ─────────────────►   │
    │                                             │ … user clicks "cancel"
    │                                             │ controller.abort()
    │                                             │ ── fetch aborts
    │ req.signal.aborted = true                   │
    │                                             │
    │ next req.signal.throwIfAborted() → throws   │
    │ finally: record phase, close stream         │
```

The kernel: **enqueue-per-event, cancel-signal-per-phase, no shared queue**. If you strip the cancel-signal you get an SSE that keeps burning function time even after the user leaves. If you strip the phase-boundary check you get a graceless unwind — the model keeps calling Anthropic in the background.

### Move 2 — the walkthrough

#### The NDJSON framing — one line per event

`lib/mcp/events.ts` exports `encodeEvent(e)`. The route uses it verbatim:

```ts
// app/api/agent/route.ts:192
const send = (e: AgentEvent) => {
  collected.push(e);
  controller.enqueue(encoder.encode(encodeEvent(e)));
};
```

The `collected.push(e)` is the interesting sidecar: after the stream finishes, `saveInvestigation(insightId, collected)` writes the full event log to the in-memory cache (`route.ts:307`). That's how replay works — the same events that streamed to the browser are the ones a later request replays.

```
  Framing — one JSON object per newline

  {"type":"reasoning_step","step":{…}}\n
  {"type":"tool_call_start","toolName":"list_projects",…}\n
  {"type":"tool_call_end","toolName":"list_projects",…}\n
  {"type":"reasoning_step","step":{…}}\n
  {"type":"diagnosis","diagnosis":{…}}\n
  {"type":"recommendation","recommendation":{…}}\n
  {"type":"done"}\n
```

**Content-Type**: `application/x-ndjson; charset=utf-8` (`route.ts:107`). No SSE `data:` prefix, no `event:` marker — just newline-delimited JSON. That's why the browser can't use `EventSource`; it needs a manual reader loop.

#### The ordering — program order, no reordering

Every `send(e)` call is synchronous with respect to the enqueue. The route runs `send` in the natural order of the agent loop:

```
  Ordering — strict program order from ONE writer

  route.ts flow:
    1. send(reasoning_step: 'reading the workspace schema…')
    2. schema = await bootstrap(req.signal)
    3. send(reasoning_step: 'interpreting your question…')
    4. classifyIntent(...)
    5. QueryAgent.answer(...) → hooks fire send(...) per turn
       - each tool_call_start → send(...)
       - each tool_call_end → send(...)
       - each text step → send(...)
    6. send(recommendation: r) (one per rec)
    7. send({type:'done'})
```

There's only **one writer per stream**. No concurrent enqueue, no interleaving. Ordering is the program's execution order. That's the whole guarantee — simple because the concurrency budget is one.

**Failure mode this avoids**: parallel agents writing to the same stream would need explicit sequencing. This repo runs agents sequentially inside one request, so the question doesn't arise.

#### Cancellation — the one backpressure signal

`req.signal` (an `AbortSignal` from `NextRequest`) is the single backpressure channel. Two ways it fires:

1. **Explicit browser cancel** — user clicks a cancel button (currently: navigating away, page unload).
2. **Connection drop** — browser tab closes, network drops, Vercel's edge detects the disconnect.

Both surface as `req.signal.aborted === true`. Every phase boundary checks it:

```ts
// app/api/agent/route.ts:231, 242, 253, 271, 279, 292, ...
req.signal.throwIfAborted();
```

If the signal has fired, `throwIfAborted()` throws an `AbortError`, which unwinds the stream's `start(controller)` async function, hits the outer `catch`, records the phase, and closes cleanly.

```
  Cancellation flow

  browser: reader.cancel() or unload
       │
       ▼
  fetch(): AbortController fires
       │
       ▼
  server: req.signal.aborted = true
       │
  ┌────┴────────────────────────────────┐
  │                                     │
  ▼                                     ▼
  route.ts phase boundary               MCP call in flight
  throwIfAborted() throws               composeSignals fires abort
  → route unwinds cleanly               → SDK cancels HTTP request
  → controller.close()                  → route sees AbortError
                                        → same unwind path
```

The composed signal propagation is what makes this fast. Without `composeSignals(req.signal, timeout(30s))` in the transport, an in-flight MCP call would keep running until the 30 s timeout even though the browser has already left. With it, the fetch aborts within tens of milliseconds of the cancel.

#### The finally block — clean shutdown with phase telemetry

Even on cancel, the route logs phase durations. `route.ts` structure (paraphrasing):

```ts
try {
  // ... phase 1: bootstrap
  req.signal.throwIfAborted();
  const t_schema = performance.now();
  const schema = await bootstrap(req.signal);
  recordPhase('schema_bootstrap', t_schema);

  // ... phase 2: list tools
  // ... phase 3: agent loops
} catch (e) {
  // client cancelled → AbortError → log and unwind
} finally {
  // record total phases, always emit summary to console
  console.log(JSON.stringify({ site: 'agents/route', phases, ... }));
}
```

The `finally` is what makes this observable under cancellation — you still see how far the investigation got before the user bailed. That's the debugging story for streams that die mid-flight.

#### Replay — same encoder, no live agent

The demo path (`route.ts:126`) replays a cached event list at 180 ms per line:

```ts
// app/api/agent/route.ts:104, 130
const REPLAY_DELAY_MS = 180;
// ...
const stream = new ReadableStream<Uint8Array>({
  async start(controller) {
    for (const e of events) {
      if (req.signal.aborted) break;
      controller.enqueue(encoder.encode(encodeEvent(e)));
      await new Promise((r) => setTimeout(r, REPLAY_DELAY_MS));
    }
    controller.close();
  },
});
```

The **cancel loop is the same**: `if (req.signal.aborted) break`. Same NDJSON framing, same event types, same client reader. Only the source differs — a stored array instead of a live agent. That interchangeability is the payoff of framing events as data.

### Move 3 — the principle

**Cancellation-based backpressure is the right shape for one-shot streams.** Traditional backpressure (a slow reader pauses a producer) matters for durable streams where lost data is unacceptable. For a one-shot investigation stream, the right question is: "is anyone still listening?" If yes, keep streaming; if no, tear down. That's what `req.signal` + `throwIfAborted()` at phase boundaries + `composeSignals` in the transport achieve. The producer never blocks — it just checks whether anyone cares.

## Primary diagram

The whole streaming picture, one frame:

```
  The streaming surface, one frame

  ┌─ Browser ──────────────────────────────────────────────┐
  │  const res = await fetch('/api/agent?…')                │
  │  const reader = res.body.getReader()                    │
  │  const decoder = new TextDecoder()                      │
  │                                                         │
  │  while (true) {                                         │
  │    const {done, value} = await reader.read()            │
  │    if (done) break                                      │
  │    // decode bytes, split on \n, parse each JSON line   │
  │    for (const line of lines) dispatch(JSON.parse(line)) │
  │  }                                                      │
  │                                                         │
  │  cancel: controller.abort() → reader errors             │
  └─────────────────────┬───────────▲──────────────────────┘
                        │           │
                   NDJSON body    req.signal
                        │           │
  ┌─────────────────────▼───────────┴──────────────────────┐
  │  app/api/agent/route.ts (Vercel function)              │
  │                                                         │
  │  const stream = new ReadableStream({                    │
  │    async start(controller) {                            │
  │      const send = (e) => controller.enqueue(            │
  │        encoder.encode(encodeEvent(e))                   │
  │      )                                                  │
  │                                                         │
  │      try {                                              │
  │        req.signal.throwIfAborted() // phase boundary    │
  │        ...bootstrap...                                  │
  │        req.signal.throwIfAborted()                      │
  │        ...listTools...                                  │
  │        req.signal.throwIfAborted()                      │
  │        ...diagnostic.investigate(hooks)                 │
  │           hooks fire send(...) per event                │
  │        req.signal.throwIfAborted()                      │
  │        ...recommend.propose(hooks)                      │
  │        send({type:'done'})                              │
  │      } catch (e) {                                      │
  │        if (isAbort) unwind cleanly                      │
  │      } finally {                                        │
  │        record phase durations                           │
  │        controller.close()                               │
  │      }                                                  │
  │    }                                                    │
  │  })                                                     │
  │                                                         │
  │  return new Response(stream, {                          │
  │    headers: {                                           │
  │      'Content-Type': 'application/x-ndjson; charset=utf8│
  │      'Cache-Control': 'no-cache, no-transform',         │
  │    }                                                    │
  │  })                                                     │
  └─────────────────────────────────────────────────────────┘
```

## Elaborate

**NDJSON vs SSE**: SSE (Server-Sent Events) has `EventSource` in browsers — automatic reconnect, `data:` framing, `event:` types. NDJSON has none of that — you roll the reader yourself. Why NDJSON here? Because the reader needs full control: this repo's stream is per-investigation (no reconnect makes sense; if you disconnected mid-way, you'd start a new investigation), and the event types are richer than SSE's flat `event:` scheme. NDJSON stays a JSON object per line, which is directly typed as `AgentEvent`.

**No message broker** — this repo doesn't have queues (Kafka, SQS, Redis Streams), and the reason is the request-scoped model. Everything happens inside one HTTP request's lifetime; there's no work to hand off to background workers, no eventual-processing story. When the product grows a background job (scheduled monitoring, batch briefing generation), that's when a queue becomes the right shape — and the vocabulary this file names (ordering, delivery semantics, dedup keys, backpressure via consumer lag) becomes load-bearing.

**Compare to the load harness's semaphore**: `eval/load.eval.ts:171` runs N investigations at concurrency K using a shift-from-shared-array semaphore. That's the closest thing to a work queue in the repo — but it's process-local, not durable, and it exists only during a test run. See the header of `eval/load.eval.ts` for the design.

## Interview defense

**Q: "How does your response stream work?"**

A: NDJSON over a `ReadableStream<Uint8Array>`. Each `AgentEvent` (reasoning step, tool call start/end, diagnosis, recommendation, done) is JSON-encoded, newline-delimited, and enqueued into the stream controller. The browser reads it with `response.body.getReader()` + `TextDecoder`, splits on `\n`, and dispatches each line as a typed event.

```
   server sends:                       browser reads:
   {reasoning_step: ...}\n             → dispatch(reasoning_step)
   {tool_call_start: ...}\n            → dispatch(tool_call_start)
   {tool_call_end: ...}\n              → dispatch(tool_call_end)
   {done}\n                            → close reader
```

**Q: "How do you handle a client that leaves mid-stream?"**

A: `req.signal` fires. Every phase boundary calls `throwIfAborted()`, which throws an `AbortError` that unwinds the async `start(controller)` function. The `finally` block still records phase durations to the log. Composed signals in the transport (`composeSignals(req.signal, AbortSignal.timeout(30_000))`) cancel any in-flight MCP call within milliseconds of the browser disconnect — so we don't burn function time on a call whose result no one will read.

**Anchor**: `app/api/agent/route.ts:231` and `lib/mcp/transport.ts:131`.

**Q: "Do you have queues or backpressure?"**

A: No queue. Backpressure is one-way, cancellation-based. There's one writer per stream (the route handler) and one reader (the browser), and the ordering is strict program order. If the reader stops reading, the writer sees the AbortSignal fire and tears down. No separate broker, no dead-letter queue, no dedup table — the stream lives and dies within one HTTP request.

**Load-bearing gotcha**: the stream is per-request. Any state that needs to survive the request lives elsewhere — in-memory (per instance, lost on cold start), in the demo JSON (deploy-time only), in the cookie (browser-durable, crypto-shared). See file 04 for the consistency story.

## See also

- `02-partial-failure-timeouts-and-retries.md` — where `composeSignals` connects cancellation to the MCP call.
- `01-distributed-system-map.md` — the stream is one of the two arrows in the map.
- `04-consistency-models-and-staleness.md` — what state survives past the stream ending.
