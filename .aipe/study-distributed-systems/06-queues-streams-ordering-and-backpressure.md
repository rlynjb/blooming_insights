# Queues, streams, ordering, and backpressure

**Industry name:** newline-delimited JSON (NDJSON) over `ReadableStream`, cooperative cancellation, backpressure via standard streams API · **Type:** Industry standard pattern, applied to live agent traces

## Zoom out, then zoom in

Verdict first: no message queue, no broker, no consumer group, no poison-message handling. There is **one streaming pattern** — NDJSON over a `ReadableStream` from the Vercel route to the browser. That stream carries the agents' live reasoning, tool calls, and final results, and it's where ordering, backpressure, and cancellation get their workout.

```
  Zoom out — where the stream lives

  ┌─ UI layer ───────────────────────────────────────────────┐
  │  app/page.tsx · app/investigate/[id]/page.tsx             │
  │  useBriefingStream · useInvestigation                     │
  │  fetch().body → readNdjson() reader                       │
  └────────────────────────┬─────────────────────────────────┘
                           │ ★ HTTP NDJSON stream ★            ← we are here
                           │ application/x-ndjson
  ┌─ Service layer ────────▼─────────────────────────────────┐
  │  /api/briefing · /api/agent                               │
  │  new ReadableStream({async start(controller){…}})         │
  │  controller.enqueue(encoder.encode(JSON + '\n'))          │
  │  req.signal.aborted threaded down to upstream calls       │
  └──────────────────────────────────────────────────────────┘
```

The whole "queue/stream" chapter in this codebase is **one wire format** (NDJSON) and the contract around it (`AgentEvent` union — `lib/mcp/events.ts:4`). That's it. No Kafka, no Redis Streams, no SQS, no Pub/Sub, no SSE (we deliberately use `fetch` + a stream reader rather than `EventSource` — see the Stack note in the project context). Everything that smells like "ordering" or "backpressure" here is the Streams API doing its job.

## Structure pass

### Axis: who controls flow rate, and where?

```
  Trace "who controls flow rate" down the stack

  Agent loop          — produces events as fast as agents+tools resolve
                        (Anthropic latency-bound + ~1.1s MCP spacing)

  ReadableStream      — controller.enqueue is a sync write; backpressure
  controller          — is HANDLED BY the platform if the consumer is slow
                        (the stream's internal buffer applies)

  HTTP transport      — chunked transfer (Vercel's edge)
                        ✱ Cache-Control: no-cache, no-transform ✱

  Browser fetch       — reader.read() pulls one chunk at a time
                        if the UI doesn't await, chunks queue in the reader
                        if the tab closes, the abort propagates back

  React state         — setItems(arr => […arr, newItem]) — UI thread paces
                        the consumption
```

The interesting flips:

- **Producer-side throttle.** The agents naturally pace themselves through the MCP rate limit. So the stream is *never* hot enough to need a real backpressure mechanism.
- **Consumer-side cancellation.** The browser closing the tab is the only "slow consumer" failure we care about — handled by `req.signal.aborted`.

### Seams (load-bearing boundaries)

- `controller.enqueue` (server) ↔ `reader.read()` (client) — the Streams API contract. Drop the `\n` per event and the line-splitter on the client breaks; emit malformed JSON and the consumer falls into the error event arm.
- `req.signal.aborted` ↔ every async layer below — drop the `throwIfAborted()` calls at phase boundaries and a tab-close leaves the agent loop running until the 300s deadline.
- `Cache-Control: no-cache, no-transform` (response header) ↔ Vercel's edge — drop `no-transform` and edge gzip *could* buffer the stream into a single response, breaking the live feel. (We don't trip this in practice, but the header is there.)

### Layered decomposition: how is ordering preserved?

```
  "How is ordering preserved?" — held constant

  ┌─ Agent loop ─────────────────────────────────────────────┐
  │  one event per send(), in calling order                   │   → SEQUENTIAL by construction
  └────────────────────────┬─────────────────────────────────┘
                           │
  ┌─ ReadableStream controller ──────────────────────────────┐
  │  enqueue is synchronous → emits in call order             │   → FIFO
  └────────────────────────┬─────────────────────────────────┘
                           │
  ┌─ HTTP chunked encoding ──────────────────────────────────┐
  │  TCP preserves byte order; one NDJSON line per "event"    │   → byte-ordered
  └────────────────────────┬─────────────────────────────────┘
                           │
  ┌─ Client reader ──────────────────────────────────────────┐
  │  read() returns chunks in send order; split on \n         │   → line-ordered
  └────────────────────────┬─────────────────────────────────┘
                           │
  ┌─ React state ────────────────────────────────────────────┐
  │  setItems(arr => […arr, newItem]) appends in receive ord  │   → reducer-ordered
  └──────────────────────────────────────────────────────────┘
```

Same answer at every layer — *sequential, in arrival order, no reordering*. That makes the whole pattern feel boring, which is the point. We get ordering for free because there's only one producer and one consumer per stream.

## How it works

### Move 1 — the mental model

You know how a generator function yields values one at a time and the consumer pulls them with `for await`? Same shape, but the producer is a Vercel route handler and the consumer is a `fetch` in the browser. The wire format is dead simple: one JSON object per line, separated by `\n`, served with `Content-Type: application/x-ndjson`. The client reads chunks, splits on `\n`, parses each line as one `AgentEvent`, and handles it.

```
  NDJSON streaming kernel — the picture

  server                                client
  ──────                                ──────
                                        const res = await fetch('/api/agent');
                                        const reader = res.body.getReader();
  ReadableStream({
    async start(controller) {
      send(e1) ───enqueue('{e1}\n')──►    read() → '{e1}\n'
                                          → split('\n') → [{e1}]
      send(e2) ───enqueue('{e2}\n')──►    read() → '{e2}\n'
                                          → setItems(…)
      …
      send(done) ──enqueue('{done}')─►    read() → done event
      controller.close()           ───►   read() → {done:true}
    }
  })
```

Two rules make it work: **one JSON object per line** (the consumer's split point) and **one `await` between events** (so the producer doesn't fill the buffer faster than the consumer drains). In practice the agents take 100ms+ between sends (anthropic + MCP latency), so this is automatic.

### Move 2 — walk the parts

#### Part: the wire format (a tagged-union over NDJSON)

The contract is `AgentEvent` from `lib/mcp/events.ts:4`:

```ts
export type AgentEvent =
  | { type: 'reasoning_step'; step: ReasoningStep }
  | { type: 'tool_call_start'; toolName: string; agent: AgentName }
  | { type: 'tool_call_end'; toolName: string; agent: AgentName;
      durationMs: number; result?: unknown; error?: string }
  | { type: 'insight'; insight: Insight }
  | { type: 'diagnosis'; diagnosis: Diagnosis }
  | { type: 'recommendation'; recommendation: Recommendation }
  | { type: 'done' }
  | { type: 'error'; message: string };

export function encodeEvent(e: AgentEvent): string {
  return JSON.stringify(e) + '\n';
}
```

Two production rules baked in:

- **`type` is the discriminator.** Clients switch on it; new event types are backward-compatible (older clients ignore unknown `type`s).
- **`done` and `error` are terminal.** The server promises one of them is the LAST event on the stream.

The project-context file calls this contract out as "must not change" — both producers (routes) and consumers (UI hooks + demo snapshots) depend on the exact field names. That's the load-bearing constraint.

#### Part: the producer (route handler)

The pattern, in real code from `/api/briefing` (`app/api/briefing/route.ts:191`):

```ts
const stream = new ReadableStream<Uint8Array>({
  async start(controller) {
    const send = (e: BriefingEvent) =>
      controller.enqueue(encoder.encode(JSON.stringify(e) + '\n'));
    // …
    try {
      req.signal.throwIfAborted();                       // phase boundary 1
      step('reading the workspace schema…');             // → reasoning_step event
      const schema = await bootstrap(req.signal);
      req.signal.throwIfAborted();                       // phase boundary 2
      // … runs agents, each fires send(...) inside hooks
      send({ type: 'done' });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;   // client cancelled
      send({ type: 'error', message: `/api/briefing · ${e.message}` });
    } finally {
      // dispose + summary log
      controller.close();                                // end the stream
    }
  },
});

return new Response(stream, {
  headers: {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store, no-transform',
  },
});
```

Three details worth marking:

- **`throwIfAborted` at every phase boundary.** Lines 215, 248, 259, 283. The signal also flows into `bootstrap`, `dataSource.listTools`, `agent.scan`, all the way down to `BloomreachDataSource.callTool` and the SDK's transport timeout.
- **`AbortError` is swallowed silently.** No `error` event sent when the client cancelled — there's no consumer. The `finally` still runs so the phase summary still logs.
- **`controller.close()` lives in `finally`.** The stream always closes. A leaked stream would hold the route open until the 300s ceiling kicked in.

#### Part: the consumer (`readNdjson`)

The client uses `fetch` + a stream reader, not `EventSource`. The reason is in the project context — `EventSource` doesn't carry custom headers, can't POST, and reconnects automatically on error (which we don't want; we want our own `useReconnectPolicy` to handle that).

```
  Layers-and-hops — one event end-to-end

  ┌─ /api/agent ───────┐  hop 1: chunk = '{type:"tool_call_start",…}\n'
  │ controller.enqueue │ ─────────────────────────────────────►  ┌─ fetch reader ──────────┐
  │ (sync write)       │                                          │ readNdjson generator    │
  └────────────────────┘                                          │ split on '\n'           │
                                                                   │ JSON.parse each line    │
                                                                   └──────────┬──────────────┘
                                                                              │ for await (e of …)
                                                                              ▼
                                                                   ┌─ hook switch(e.type) ──┐
                                                                   │ 'tool_call_start' →    │
                                                                   │  setItems(arr => […])  │
                                                                   └────────────────────────┘
```

#### Part: backpressure (the part you get for free)

The Streams API's contract: `controller.enqueue` is synchronous, but the *underlying source* has an internal queue. When that queue fills, the implementation **applies pressure** — in practice for HTTP streams, this means the TCP write buffer fills, the OS write blocks, and your `enqueue` calls eventually pause behind a microtask.

In our system, this never actually fires because:

1. The agents produce events at ~100ms intervals minimum (anthropic latency).
2. The UI consumes them on every animation frame.
3. The chunks are tiny (a JSON object, hundreds of bytes).

So "backpressure" is theoretical here — but the pattern is correct: a slow consumer would cause the producer to slow down via the standard mechanism, not via a custom signal. That's the right design point.

#### Part: ordering (also free)

Single producer, single consumer, one TCP connection. There's no "out of order" failure mode unless the producer races itself (sends from two async tasks without awaiting). The producer is a single `async start` function — even though it `await`s internally, every `send(e)` lands in calling order.

There's one place this could break in principle — the **demo replay** path interleaves coverage_item events with reasoning_step events from a forEach loop (`app/api/briefing/route.ts:114`):

```ts
const lines = coverageChecklistSteps(coverage);
for (let i = 0; i < coverage.length; i++) {
  controller.enqueue(encoder.encode(JSON.stringify(stepEvt(lines[i])) + '\n'));
  controller.enqueue(encoder.encode(JSON.stringify({ type: 'coverage_item', item: coverage[i] }) + '\n'));
  await new Promise((r) => setTimeout(r, REPLAY_DELAY_MS));
}
```

Two `enqueue` calls in lockstep, then a `setTimeout(140)` to pace the reveal. Both writes are synchronous, so the order is guaranteed; the `await` is purely for UX pacing.

#### Part: cancellation (the load-bearing one)

The `req.signal` flows down through every layer. The chain:

```
  Layers-and-hops — abort propagation

  ┌─ Browser ──────────┐  tab close / unmount cleanup → fetch().signal.abort()
  │ fetch + cleanup    │ ────────────────────────────────────────►  ┌─ Vercel runtime ─┐
  │                    │                                            │ req.signal       │
  │                    │                                            │ .aborted = true  │
  └────────────────────┘                                            └────────┬─────────┘
                                                                             │
                                                                  ┌──────────┴───────────┐
                                                                  │ checked at each      │
                                                                  │ phase boundary in    │
                                                                  │ route.ts             │
                                                                  └──────────┬───────────┘
                                                                             │ threaded down
                                                                             ▼
                                                                  ┌──────────────────────┐
                                                                  │ bootstrap(signal)    │
                                                                  │  → callTool(…,{sig}) │
                                                                  │     → SdkTransport   │
                                                                  │       composeSignals │
                                                                  │       (routeSig,     │
                                                                  │        timeout(30s)) │
                                                                  │       first-wins     │
                                                                  └──────────────────────┘
```

`useInvestigation` has a deliberate exception (`lib/hooks/useInvestigation.ts:34` and following — the comment block calls it out):

> we deliberately do NOT cancel the fetch on effect cleanup. React StrictMode (dev) mounts → cleans up → re-mounts; cancelling on the first cleanup, with the started-guard blocking the re-mount, aborted the stream and left the logs empty.

So in production, cancellation is the contract; in dev StrictMode, the guard pattern is what prevents the double-fetch instead of cancel-on-cleanup. This is the kind of detail that breaks a naive "always cancel on unmount" rule.

### Move 3 — the principle

**A stream is a queue with one consumer.** Get the contract right (terminal event, ordered, line-delimited) and the rest of the chapter (ordering, backpressure, cancellation) is handled by the platform. The trap is reaching for queue infrastructure (Kafka, SQS, Redis Streams) when a `ReadableStream` over HTTP with a single consumer is the actual shape. If you ever do need to fan a single producer out to N consumers, *then* a real queue earns its place — until then, you're paying coordination overhead for nothing.

## Primary diagram

```
  Full picture — the only streaming pattern in this codebase

  ┌─ Browser ─────────────────────────────────────────────────────────┐
  │  useBriefingStream / useInvestigation                              │
  │  const res = await fetch('/api/briefing?demo=cached');             │
  │  const reader = res.body.getReader();                              │
  │  for await (const event of readNdjson(reader)) {                   │
  │    switch (event.type) {                                           │
  │      case 'workspace': setWorkspace(...);                          │
  │      case 'coverage_item': setCoverage(arr => [...]);              │
  │      case 'reasoning_step': setItems(arr => [...]);                │
  │      case 'tool_call_start': setItems(arr => [...]);               │
  │      case 'tool_call_end': replaceRunningTool(arr, e);             │
  │      case 'insight': setInsights(arr => [...]);                    │
  │      case 'done': setComplete(true);                               │
  │      case 'error': useReconnectPolicy.handle(e.message);           │
  │    }                                                               │
  │  }                                                                 │
  │  on unmount: started-guard prevents double-fetch                   │
  │              (NOT abort-on-cleanup — would break StrictMode)       │
  └────────────────────────────┬──────────────────────────────────────┘
                               │ HTTPS application/x-ndjson
                               │ Cache-Control: no-cache, no-transform
                               │ TCP backpressure if consumer slow
                               │ fetch.signal.abort() if tab closed
  ┌─ /api/briefing or /api/agent ─────────────────────────────────────┐
  │  new ReadableStream({                                              │
  │    async start(controller) {                                       │
  │      try {                                                         │
  │        req.signal.throwIfAborted();   // phase 1                   │
  │        send(reasoning_step "reading schema…");                     │
  │        const schema = await bootstrap(req.signal);                 │
  │        req.signal.throwIfAborted();   // phase 2                   │
  │        // for each agent.scan / agent.investigate, hooks fire:    │
  │        //   onText  → send(reasoning_step)                         │
  │        //   onToolCall → send(tool_call_start)                     │
  │        //   onToolResult → send(tool_call_end)                     │
  │        for (insight of insights) send({type:'insight', insight});  │
  │        send({type:'done'});                                        │
  │      } catch (e) {                                                 │
  │        if (e.name === 'AbortError') return;   // silent            │
  │        send({type:'error', message: e.message});                   │
  │      } finally {                                                   │
  │        dispose();                                                  │
  │        controller.close();                                         │
  │        log({route, totalMs, phases, aborted: req.signal.aborted}); │
  │      }                                                             │
  │    }                                                               │
  │  });                                                               │
  └───────────────────────────────────────────────────────────────────┘
```

## Elaborate

NDJSON is one of three sane choices for "live events over HTTP":

- **NDJSON over fetch** (this codebase): one JSON object per line, parse on `\n`. Works with `fetch`, supports POST, supports custom headers, no auto-reconnect. We chose this for the reasons listed.
- **Server-Sent Events (`EventSource`)**: `text/event-stream`, `data: …\n\n` framing, auto-reconnect. Limited to GET, no custom headers in the browser API. The auto-reconnect is *seductive* but here it'd fight `useReconnectPolicy`.
- **WebSockets**: bidirectional, full-duplex, framed protocol. Overkill when the server is the only producer.

The closest industry analog to our pattern is **gRPC server streaming** — one request, many response messages, ordered, with deadline propagation. We don't use gRPC (web compatibility, runtime overhead) but the contract is the same shape.

What to read next: the WHATWG Streams Standard for the ReadableStream contract; the SSE spec (HTML5 living standard) for the alternative we passed on; Kafka's "exactly-once semantics" blog for the world where real queues earn their keep.

## Interview defense

**Q: "Why NDJSON over WebSockets or SSE?"**

> "Three reasons. NDJSON over `fetch` supports POST and custom headers — `EventSource` is GET-only and can't carry auth headers in the browser. WebSockets are bidirectional and our server is the only producer, so the duplex is overkill. And `EventSource`'s automatic reconnect would fight `useReconnectPolicy` — we want our own one-shot reconnect with the session-storage flag, not the browser's open-ended retry loop. NDJSON with our own contract: `{type, …}` per line, `\n`-delimited, terminal `done` or `error`. The wire format is one line of code on each side."

Diagram:

```
  server                              client
  ──────                              ──────
  enqueue('{e1}\n')  ──HTTP chunk──►  read() → split('\n') → JSON.parse → handler
  enqueue('{e2}\n')  ──────────────►  …
  enqueue('{done}')  ──close()────►  loop ends
```

**Q: "How is ordering guaranteed?"**

> "One producer, one consumer, one TCP connection. `controller.enqueue` is synchronous, so the producer never races itself; TCP preserves byte order; the client splits chunks on `\n`. There's no failure mode where events arrive out of order unless someone calls `send` from two async tasks without `await`ing between them. That's a code-review thing, not a protocol thing."

**Q: "What about backpressure?"**

> "I get it for free from the Streams API. If the consumer reads slowly, the underlying source's queue fills, the TCP write buffer fills, the OS write blocks, and my `enqueue` calls eventually pause behind a microtask. In practice it never fires here because the agents produce events at 100ms+ intervals (Anthropic latency + the ~1.1s MCP spacing) and the UI consumes them on every animation frame. But the pattern is correct — a slow consumer would slow the producer down via the platform mechanism, not via a custom signal."

**Q: "What's the load-bearing detail?"**

> "Cancellation propagation. `req.signal.throwIfAborted()` is called at every phase boundary in the route — schema bootstrap, listTools, agent loop, each MCP call. The signal threads all the way down to `SdkTransport.callTool` where it's composed with a per-call 30s timeout via `AbortSignal.any`, first-signal-to-fire wins. The client closing the tab cancels the upstream Bloomreach call in flight; without that, a tab-close leaves the agent loop running until the 300s ceiling. The one place we don't cancel — `useInvestigation`'s cleanup — is deliberate and the comment block explains why: React StrictMode in dev would otherwise abort the only good fetch."

**Q: "What's NOT here that I should know about?"**

> "No message queue, no consumer group, no poison-message handling, no dead-letter queue. One stream, one consumer. If we ever need to fan out — say, monitoring runs in the background and pushes anomalies to multiple subscribers — that's the day a real queue earns its place. Today it'd be ceremony."

## See also

- `02-partial-failure-timeouts-and-retries.md` — the abort signal propagation that lives at the bottom of this stream.
- `04-consistency-models-and-staleness.md` — `insight.timestamp` is the snapshot disclosure on every streamed event.
- `09-distributed-systems-red-flags-audit.md` — the "no cancel on cleanup" exception is documented there.
- `../study-runtime-systems/` — the event loop and Streams API plumbing this pattern sits on top of.
- `../study-networking/` — HTTP chunked transfer + the no-transform header story.
