# Queues, streams, ordering, and backpressure

*Industry standard — queues, streams, consumer behavior, ordering, poison messages, overload.*

## Zoom out — where streaming lives

The whole repo has *one* stream surface and *no* queues. The stream is the NDJSON channel from the route handler to the browser. There's no broker, no consumer group, no replay log, no DLQ — and that's the right shape for the product.

```
  Zoom out — the one stream, and a sea of nothing else

  ┌─ L1: Browser ───────────────────────────────────────────────┐
  │  fetch() → reader.read() loop  (ONE consumer per stream)      │
  │  lib/streaming/ndjson.ts → readNdjson(body, onEvent, opts)    │
  └─────────────────────────┬───────────────────────────────────┘
                            │
                            │  hop A: HTTPS · NDJSON · `\n`-delimited
                            │  ★ THE ONLY STREAM ★
                            │
  ┌─ L2: Route ─────────────▼───────────────────────────────────┐
  │  ReadableStream.start(controller) → controller.enqueue(line)  │
  │  ONE producer per stream (the route's start callback)         │
  └─────────────────────────┬───────────────────────────────────┘
                            │
  ┌─ L3 + L4 ───────────────▼───────────────────────────────────┐
  │  no queue, no broker, no fan-out, no replay, no consumer     │
  │  group, no DLQ, no offset, no Kafka, no SQS, no Redis Streams│
  │  ★ not yet exercised — entirely absent ★                      │
  └─────────────────────────────────────────────────────────────┘
```

One writer. One reader. Same origin. No message system between them. This file walks what *is* there, then names everything that isn't.

## Zoom in — the question this file answers

> What does the stream surface guarantee, and what doesn't it?

Three answers: (1) ordering is preserved trivially because one writer + one reader + TCP; (2) backpressure is provided by `ReadableStream`'s internal queue + the browser's reader pace; (3) everything else (replay, fan-out, multi-consumer, persistence) is absent and would need a queue/broker that doesn't exist.

## Structure pass — the skeleton

### Axes — trace ordering

```
  One axis: "what determines the order events arrive in?"

  L2 producer (route)         the route calls controller.enqueue(line)
                              ONCE per event, in the order the agent
                              loop produces them; the controller queues
                              bytes synchronously into the stream

  TCP wire                    bytes are delivered in-order by TCP;
                              HTTP/1.1 over a single connection
                              preserves it

  L1 consumer (reader)        reader.read() returns chunks in arrival
                              order; the buffer split on '\n' preserves
                              line order within each chunk

  consumer dispatch           onEvent(JSON.parse(line)) runs synchronously
                              per line, in order, in the consumer's
                              event loop
```

Same answer at every layer: **in-order**. The reason is the topology (one writer, one reader) and the transport (TCP). There's no axis flip — which is itself the lesson: **ordering is a property the stream gets for free, and only stops being free when you add a second writer or a broker that fans out.**

### Seams — where ordering or backpressure *could* break

```
  Where the contract could fail — and why it doesn't today

  failure mode                     prevented by
  ─────────────                     ─────────────
  malformed line in the middle      onMalformed: silent skip (default)
                                    (lib/streaming/ndjson.ts:24-26)
                                    → ordering preserved, one event lost

  consumer slower than producer     ReadableStream backpressure: writes
                                    block when the controller's internal
                                    queue fills; the producer's await
                                    inside the start callback gates
                                    further enqueues

  consumer closes early             reader cancellation propagates to
                                    the route via req.signal.aborted;
                                    the producer breaks out of its loop
                                    (agent/route.ts:308-310)

  network partition mid-stream      partial events buffered; the reader
                                    sees an incomplete tail, flushes
                                    only if it parses (silent drop
                                    otherwise)
```

The seams are *real but bounded*. The system is one-writer/one-reader by topology, so the failure modes don't include "consumer A and consumer B got events in different orders" or "a replay re-issued event 47 with stale data."

### Layered decomposition — the same axis at two altitudes

```
  Backpressure — held constant across producer and consumer

  outer: route producer       awaits inside the start callback
                               (e.g. await schema, await classifyIntent,
                                await agent.scan); each await is a
                               natural gate on event production

  middle: ReadableStream       internal queue (default highWaterMark);
                               controller.enqueue does not block
                               in practice for the NDJSON sizes here

  inner: TCP                   socket buffer + flow control on the wire

  inner: consumer reader       reader.read() pulls one chunk at a time;
                               the loop is sequential, so JSON.parse
                               and onEvent block the next read until
                               they return
```

Backpressure is **implicit at every layer** — not explicit signals, but natural single-threaded sequencing. The producer can't out-run the consumer by much, because the producer is *itself* gated by `await dataSource.callTool(…)` calls that take seconds. The consumer can't fall too far behind because TCP pushes back via window updates. **The whole pipeline is paced by the slowest link, and the slowest link is Bloomreach.**

## How it works

### Move 1 — the mental model

You've written this loop before, in the browser: `fetch(url)` → `response.body.getReader()` → `while (true) { read; decode; split('\n'); parse; handle }`. That's the entire pattern. The route handler is the mirror image.

> **NDJSON over a ReadableStream is the simplest possible streaming protocol — one writer, one reader, `\n` as the record separator. Everything fancier you've heard of (Kafka, SQS, Kinesis, Pub/Sub) exists to solve problems this codebase doesn't have: multiple consumers, replay, persistence, durability, ordering across partitions.**

```
  The kernel — one route → one browser stream

  ┌─ route start callback ───────────────────────────────────┐
  │   const send = (e) =>                                     │
  │     controller.enqueue(encoder.encode(encodeEvent(e)));   │
  │                                                          │
  │   send({ type: 'reasoning_step', ... })                   │
  │   await dataSource.callTool(...)                          │ ← natural backpressure
  │   send({ type: 'tool_call_end', ... })                    │
  │   send({ type: 'done' })                                  │
  │   controller.close()                                      │
  └──────────────────────────────────────────────────────────┘
                            │
                            │  HTTPS chunks · TCP in-order delivery
                            ▼
  ┌─ browser reader loop ────────────────────────────────────┐
  │   while (true) {                                          │
  │     const { value, done } = await reader.read();          │
  │     if (done) break;                                      │
  │     buf += decoder.decode(value, { stream: true });       │
  │     const lines = buf.split('\n');                        │
  │     buf = lines.pop() ?? '';                              │
  │     for (const line of lines) onEvent(JSON.parse(line));  │
  │   }                                                       │
  └──────────────────────────────────────────────────────────┘
```

Three primitives: a writer (`controller.enqueue`), a record separator (`\n`), a reader loop. No third party between them.

### Move 2 — walk the moving parts

#### Part 1 — the producer (one writer, in the route)

The route handler builds the stream inside the `start` callback. The pattern, abstracted from `app/api/briefing/route.ts:191-194`:

```ts
const stream = new ReadableStream<Uint8Array>({
  async start(controller) {
    const send = (e: BriefingEvent) =>
      controller.enqueue(encoder.encode(JSON.stringify(e) + '\n'));
    // … long-running async work, calling send() at each milestone …
  },
});
return new Response(stream, { headers: NDJSON_HEADERS });
```

Three load-bearing details:

1. **The terminator is `\n`.** Producer always appends, reader always splits on it. The consumer (`lib/streaming/ndjson.ts:39`) handles a non-terminated trailing chunk by holding it in `buf` until the next read or end-of-stream — but in practice every producer in this codebase terminates with `\n`, so the trailing flush is a no-op safety net.

2. **`encoder.encode` happens before enqueue.** The controller takes `Uint8Array`, not strings. Encoding inside the call site rather than in a stream-wide transform keeps the writer self-contained.

3. **The `start` callback is `async`.** Every `await` inside it (the schema bootstrap, the agent loop, the tool calls) is a natural gating point. If the consumer falls behind, the controller's internal queue backs up; new enqueues *would* eventually block (`ReadableStream` standard backpressure), but in practice the await-chain inside the producer is the dominant gate — it produces events at ~1/s peak, far slower than any consumer needs to drain.

The cancellation contract is critical (`app/api/agent/route.ts:130-138`):

```ts
async start(controller) {
  for (const e of events) {
    // Client cancelled mid-replay — break out so we don't keep enqueuing
    // bytes into an already-closed reader.
    if (req.signal.aborted) break;
    controller.enqueue(encoder.encode(encodeEvent(e)));
    await new Promise((r) => setTimeout(r, REPLAY_DELAY_MS));
  }
  controller.close();
}
```

Checking `req.signal.aborted` between enqueues is the producer's "consumer left" check. The same pattern appears in the live path (`agent/route.ts:226-298` calls `req.signal.throwIfAborted()` at coarse phase boundaries and threads `req.signal` into every async layer below).

#### Part 2 — the consumer (one reader, in the browser)

The shared kernel (`lib/streaming/ndjson.ts:18-58`):

```ts
export async function readNdjson<E>(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: E) => void,
  opts?: { cancelOn?: () => boolean; onMalformed?: (line, err) => void },
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      if (opts?.cancelOn?.()) {
        await reader.cancel();
        return;
      }
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        try {
          onEvent(JSON.parse(line) as E);
        } catch (err) {
          opts?.onMalformed?.(line, err);
        }
      }
    }
    // flush trailing buffer — a no-op when the producer always terminates with '\n'
    const tail = buf.trim();
    if (tail) {
      try { onEvent(JSON.parse(tail) as E); }
      catch (err) { opts?.onMalformed?.(tail, err); }
    }
  } finally {
    reader.releaseLock();
  }
}
```

Walk the parts by what breaks if removed:

```
  Reader kernel — what each part guards against

  while-loop with done check       drop it → reader leaks; promise
                                    never resolves; consumer hangs

  decoder.decode({ stream: true })  drop the stream:true flag → a
                                    multi-byte UTF-8 char split across
                                    chunks corrupts as latin-1 garbage

  buf.split('\n')                   drop it → events run together;
                                    JSON.parse fails on the whole
                                    concatenation; everything turns
                                    into "malformed line"

  buf = lines.pop() ?? ''           drop it → a partial trailing line
                                    is treated as complete; JSON.parse
                                    fails; the event is silently lost
                                    on the malformed handler

  try/catch around JSON.parse       drop it → one malformed line kills
                                    the whole stream

  cancelOn poll                     drop it → consumer cleanup (React
                                    unmount, etc.) can't abort an
                                    inflight read; the producer keeps
                                    burning route budget on nothing
```

The buffer-and-pop dance is the only non-obvious part. **Newline-delimited streaming is naturally chunked, and chunks don't align with lines.** A read might return `"...prev\nfoo\nbar\nbaz_par"` — six lines and a partial. The pop-and-keep-tail pattern preserves the partial as the start of the next decode.

#### Part 3 — backpressure (implicit at every layer)

There's no `await producer.flushed()`, no acknowledgements, no consumer-feedback loop. Backpressure happens for free because of the topology:

```
  Pacing — what gates what

  ┌─ route producer ─────────────────────────────────────┐
  │  await dataSource.callTool(…) ← 1.1s spacing per call │  ★ slowest link ★
  │  controller.enqueue(line)                              │
  │     → goes into ReadableStream internal queue          │
  └──────────────────────────┬───────────────────────────┘
                             │
  ┌─ ReadableStream queue ───▼───────────────────────────┐
  │  default highWaterMark; fills only if consumer is    │
  │  slower than producer (rare in practice — producer    │
  │  is gated by network calls, consumer is local JS)     │
  └──────────────────────────┬───────────────────────────┘
                             │
  ┌─ TCP wire ───────────────▼───────────────────────────┐
  │  flow control via window updates                      │
  └──────────────────────────┬───────────────────────────┘
                             │
  ┌─ browser reader loop ────▼───────────────────────────┐
  │  await reader.read() ← drains as fast as JS runs      │  ★ fast ★
  │  JSON.parse + onEvent: synchronous                     │
  └──────────────────────────────────────────────────────┘

  net effect: the consumer is faster than the producer by
  orders of magnitude, so no backpressure is observed in
  practice. The mechanism exists but is dormant.
```

If a future producer ever decoupled from the slow upstream — say, replaying a 10,000-event captured trace at 100x speed — backpressure would start to matter and the implicit mechanism would activate. Today the natural pacing is 1.1s+ per tool call, and a typical investigation is 6-15 calls, so the stream produces a few dozen events over ~30-60s.

#### Part 4 — error handling on the stream (what the consumer sees)

Errors are events, not exceptions on the stream. From `lib/mcp/events.ts:4-12`:

```ts
export type AgentEvent =
  | { type: 'reasoning_step'; step: ReasoningStep }
  | { type: 'tool_call_start'; toolName: string; agent: AgentName }
  | { type: 'tool_call_end'; toolName: string; agent: AgentName; durationMs: number; result?: unknown; error?: string }
  | { type: 'insight'; insight: Insight }
  | { type: 'diagnosis'; diagnosis: Diagnosis }
  | { type: 'recommendation'; recommendation: Recommendation }
  | { type: 'done' }
  | { type: 'error'; message: string };
```

The producer's try/catch around the whole `start` callback (`app/api/agent/route.ts:303-316`) translates a thrown exception into one final `{ type: 'error', message }` event before closing. The consumer's `onEvent` dispatcher sees an error like any other event. **There's no stream-level error channel** — the protocol uses application-level event types for everything, which keeps the kernel uniform.

```
  Three event categories — one shape

  data events     reasoning_step, tool_call_start, tool_call_end,
                  insight, diagnosis, recommendation

  status events   done — explicit "no more events"

  failure events  error — last event before close, carries a message

  every event is JSON, terminated by '\n', delivered in order
```

#### Part 5 — replay (the synthetic-stream pattern)

The demo path replays a recorded stream from disk (`app/api/briefing/route.ts:99-152` for briefing, `agent/route.ts:128-141` for investigation). The replayer reads the JSON snapshot, enqueues each recorded event with a `REPLAY_DELAY_MS` pause between them, and emits the same `\n`-delimited NDJSON:

```ts
// agent/route.ts:128-141
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

The consumer can't tell the difference. Same protocol, same parser, same dispatcher. **This is the property that lets the demo path be reliable: the protocol is decoupled from the producer, so a tape replay and a live agent feed look identical to the browser.**

### Move 2.5 — current state vs absent shape

```
  Today (one stream, no queue)            What would force a queue
  ──────────────────────────              ─────────────────────────
  one writer, one reader,                  multiple consumers want
   same-origin, no replay                   the same events
                                            (e.g. analytics tap,
                                             admin dashboard, …)

  no persistence — stream ends             need to replay events to
   when route ends                          a consumer that arrived
                                            late (e.g. resume after
                                             disconnect)

  no fan-out                                fan-out to many users from
                                             one producer (e.g. shared
                                             briefing pushed to all
                                             subscribed sessions)

  no ordering hazard                        producers from multiple
   (single writer)                          instances need a total
                                             order
```

None of the four right-column scenarios are on the roadmap. A queue (Kafka, NATS, SQS, Redis Streams) is the right answer when any of them lights up — but adding one before then is over-engineering.

### Move 3 — the principle

> **The cheapest streaming protocol is NDJSON over HTTP — one writer, one reader, in-order delivery for free. Reach for a queue/broker only when the topology forces it (multi-consumer, replay, durability, cross-instance ordering). "We might need it later" is not topology.**

This file's content is a counterargument to the default modern reflex of "throw Kafka at every async problem." The codebase shows what you can do without one when the problem really is one-writer/one-reader.

## Primary diagram — the full stream

```
  blooming_insights — the one stream, end-to-end

  ┌─ Route start callback (producer) ─────────────────────────────┐
  │  agent emits trace/tool events                                 │
  │     │                                                          │
  │     ▼                                                          │
  │  send({ type, ... }) ──► controller.enqueue(                   │
  │                              encoder.encode(JSON + '\n')        │
  │                            )                                    │
  │     │                                                          │
  │  await dataSource.callTool(...)  ← implicit backpressure       │
  │     │                                                          │
  │     ▼                                                          │
  │  send({ type: 'done' });  controller.close();                  │
  └─────────────────────────────────┬─────────────────────────────┘
                                    │
                                    │  HTTPS / NDJSON / `\n` lines
                                    │  TCP in-order delivery
                                    ▼
  ┌─ Browser reader loop (consumer) ─────────────────────────────┐
  │  reader.read() → decode (UTF-8, streaming)                    │
  │     │                                                         │
  │     ▼                                                         │
  │  buf = lines.pop() ?? ''  (keep the partial)                  │
  │     │                                                         │
  │     ▼                                                         │
  │  for each complete line:                                      │
  │     try   { onEvent(JSON.parse(line)) }                       │
  │     catch { onMalformed(line, err)    }                       │
  │     │                                                         │
  │     ▼                                                         │
  │  cancelOn() polled between reads — if true, reader.cancel()   │
  └───────────────────────────────────────────────────────────────┘

  guarantees:
    ✓ in-order (one writer + TCP)
    ✓ at-most-once (no replay, no acks)
    ✓ implicit backpressure (consumer faster than producer)
    ✗ no replay, no persistence, no fan-out, no ack
```

## Elaborate

The references that matter for this material:

- **WHATWG Streams (ReadableStream).** The browser/Node primitive used on both sides. The internal queue + highWaterMark is the spec mechanism for backpressure; we lean on the defaults.
- **NDJSON (newline-delimited JSON).** Not a formal standard but a widely-adopted convention. The contract is one JSON document per line, `\n` as the terminator. Worth knowing: Server-Sent Events (SSE) is the alternative that adds reconnection + last-event-id; we chose NDJSON because we don't need the SSE features and NDJSON parses with `JSON.parse` per line rather than SSE's `event:` / `data:` framing.
- **Kafka log-as-the-database** (Jay Kreps, "The Log: What every software engineer should know about real-time data's unifying abstraction"). The mental model for why queues exist: replay, multiple consumers, decoupled producer/consumer lifecycles. The article is the best long-read on the *why* if you want to know what's *not* in this codebase.
- **Backpressure in React Streams / TC39 async iterators.** Adjacent reading — the same pull-based backpressure mechanism shows up in Node's async iterators (`for await of stream`).

The interesting comparison is **NDJSON vs SSE.** Both are one-writer/one-reader over HTTP. NDJSON wins when the consumer needs `fetch` for headers/auth/POST bodies (`EventSource` is GET-only and can't set arbitrary headers — there's a workaround with `withCredentials`, but it's clumsy). SSE wins when the consumer needs automatic reconnection + last-event-id replay. We picked NDJSON because we use POST-style request shapes via `fetch` (for the `req.signal` and the URL params), and because reconnection here means "re-run the briefing," not "replay from offset 47."

## Interview defense

### "Walk me through your streaming protocol."

The route handler builds a `ReadableStream` whose `start` callback runs the agent loop and calls `controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'))` once per event. The browser opens it with `fetch(...).body.getReader()`, reads chunks, splits on `\n`, parses each line as JSON, and dispatches. The protocol is NDJSON — one event per line. Ordering is preserved because there's one producer per stream and TCP delivers in-order. There's no replay, no acks, no broker — at-most-once delivery, which is fine because the result of every briefing/investigation is cacheable in-memory (`saveInvestigation`, `putInsights`) and re-runnable. If the consumer disconnects mid-stream, the producer notices via `req.signal.aborted` and breaks out of its loop.

```
  Anchor:
    producer:  app/api/agent/route.ts:185-189 (send/controller.enqueue)
    consumer:  lib/streaming/ndjson.ts:18-58 (readNdjson kernel)
    abort:     app/api/agent/route.ts:308-310 (DOMException AbortError suppression)
```

### "What's your backpressure strategy?"

Implicit. The producer is gated by `await dataSource.callTool(…)` which has a 1.1s spacing floor and ~1-5s typical latency, so it emits events at ~1/s peak. The browser consumer is local JavaScript reading from a TCP stream, drains chunks at memory bandwidth, and dispatches `onEvent(JSON.parse(line))` synchronously. The consumer is always faster than the producer by orders of magnitude, so the `ReadableStream` internal queue (default `highWaterMark`) never fills. The mechanism for explicit backpressure exists in the spec — `controller.desiredSize`, the queue would back up and pause writes — but it's dormant here because the pacing is naturally producer-limited.

The case where I'd add explicit backpressure is if we ever replayed a captured stream at high speed (e.g. dumping 10,000 historical events for analytics ingestion). Today the demo replay is 140-180ms per event by design, so even that path is pacing-limited.

### "Why NDJSON instead of Server-Sent Events?"

Three reasons. (1) NDJSON parses with `JSON.parse(line)` per line — clean and trivial. SSE has `event:` / `data:` framing that needs its own parser even though the payload is also JSON. (2) `fetch` lets us set arbitrary headers, follow cookies the way the rest of the app does, and read `req.signal` for cancel — `EventSource` is more constrained. (3) SSE's headline feature is automatic reconnect with `Last-Event-Id`, which isn't useful here: reconnection in our system means "re-run the briefing" (server-side fresh state), not "replay from offset 47." The reconnect-on-401 path in `app/page.tsx` is bespoke for the OAuth-token-rotation case, not a generic replay. NDJSON has a smaller spec surface for our use case.

```
  Anchor:
    contract:  lib/mcp/events.ts:4-22 (AgentEvent + encodeEvent/decodeEvent)
    headers:   app/api/agent/route.ts:105-108 (NDJSON_HEADERS constant)
```

### "What happens to one malformed event in the stream?"

The reader's per-line `try { JSON.parse } catch { onMalformed }` (`lib/streaming/ndjson.ts:45-49`) isolates the failure to that one line. The default `onMalformed` is silent — the malformed line is dropped, the read loop continues. **Ordering is preserved for surviving events.** This is a deliberate at-most-once choice: better to lose one event than to abort the whole stream. The trade-off: if the producer is buggy and starts emitting malformed lines systematically, the consumer silently drops them all — there's no telemetry for malformed-rate today. That's a real observability gap; it's flagged in file 09.

## See also

- `02-partial-failure-timeouts-and-retries.md` — what produces the events the stream carries.
- `03-idempotency-deduplication-and-delivery-semantics.md` — at-most-once delivery and why it's safe here.
- `07-clocks-coordination-and-leadership.md` — why event ordering inside the stream is trivial (one writer).
- `09-distributed-systems-red-flags-audit.md` — malformed-rate telemetry gap, SSE-vs-NDJSON re-evaluation.
- `.aipe/study-debugging-observability/` — the per-phase console.log that records what the stream did.
