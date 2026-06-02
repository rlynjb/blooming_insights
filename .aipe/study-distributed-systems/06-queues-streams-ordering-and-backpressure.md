# 06 — queues, streams, ordering, backpressure

**Industry name(s):** message queues · event streams · NDJSON streaming · ordering guarantees · backpressure · poison messages
**Type:** Industry standard · Language-agnostic

> **Verdict-first:** there are **no work queues** in this codebase — no Kafka, no SQS, no Redis Streams, no BullMQ, no background workers. What IS here is **one-way NDJSON event streams** from server → client (`/api/briefing`, `/api/agent`) over HTTP chunked transfer. Ordering is "emitted-order, single-producer single-consumer per stream." Backpressure is whatever the `ReadableStream` API and the browser's `fetch().body.getReader()` give you for free — the server `enqueue`s into a controller, the network buffer pushes back, the producer awaits. No poison-message handling because there are no messages to be consumed-and-retried — every stream event is observe-only. Work queues, fan-out, ordering across producers: all NOT YET EXERCISED. The streaming pattern that IS here exists for *one* reason — long-running agent runs need to look alive while they work.

---

## Zoom out, then zoom in

```
  Zoom out — where streaming lives, where queues don't

  ┌─ UI layer ───────────────────────────────────────────────┐
  │  fetch(...).body.getReader() + TextDecoder + JSON.parse   │
  │  ★ stream consumer ★                                      │ ← we are here
  └─────────────────────────┬────────────────────────────────┘
                            │ HTTP chunked transfer (NDJSON)
  ┌─ Service layer ─────────▼────────────────────────────────┐
  │  ReadableStream + controller.enqueue                      │
  │  /api/briefing  /api/agent  (both stream)                 │
  │  no work queues, no background jobs                       │
  └─────────────────────────┬────────────────────────────────┘
                            │
  ┌─ Provider layer ────────▼────────────────────────────────┐
  │  Bloomreach MCP: request/response (no streaming we use)   │
  │  Anthropic: non-streaming messages.create (the choice     │
  │             trades agent-loop-clarity for visible token-   │
  │             by-token reveal)                              │
  └──────────────────────────────────────────────────────────┘
```

**Zoom in.** The question this file answers: *how do long-running agent runs appear interactive in the browser, and what ordering/backpressure guarantees does that mechanism give you?* The answer is one well-built pattern (NDJSON over `ReadableStream`) and a stack of things deliberately not built (queues, workers, fan-out). This file walks the one and explains why the others aren't there yet.

---

## Structure pass

**Layers.** Two. Stream producer (server route handler with a `ReadableStream`) and stream consumer (browser hook reading the response body). Both are single-threaded — one producer, one consumer per stream — which is exactly why ordering and backpressure are simple.

**Axis: ordering guarantees.** Hold one question: *if events A then B are produced, what guarantees does the consumer have about their arrival order?* For NDJSON over HTTP chunked transfer, the answer is: **A always arrives before B** as long as both come over the same connection. There's only one connection per stream, so order is preserved by the transport itself. No need for sequence numbers, vector clocks, or out-of-order buffers — the stream is its own ordering.

**Seams.** Two real, one absent.

- **Seam: agent loop ↔ stream controller.** Every meaningful step in the agent calls a `send(event)` closure that wraps `controller.enqueue(...)`. The seam is intentional — separating "what the agent decides to emit" from "how the stream writes it" — and lets the same agent code work whether the route streams or batches.
- **Seam: stream controller ↔ network buffer.** The `ReadableStream` API handles backpressure automatically: if the consumer is slow, the controller's queue fills and `enqueue` returns synchronously but writes wait for buffer space. We rely on this without thinking about it.
- **Seam: producer ↔ consumer across reconnects** — *does not exist*. No reconnect protocol. If the client disconnects mid-stream, the rest is lost. File 03 walks the at-most-once-per-stream delivery semantics.

```
  Structure pass — stream layers

  ┌─ agent loop ──────────────────────────────────────────┐
  │  reasoning step / tool call / diagnosis emitted        │
  │  via a send(event) closure                             │
  └─────────────────────────┬─────────────────────────────┘
                            │  controller.enqueue
                            ▼
  ┌─ ReadableStream controller ───────────────────────────┐
  │  queues bytes; flushes when network buffer has room    │
  │  backpressure: implicit, via the underlying transport  │
  └─────────────────────────┬─────────────────────────────┘
                            │  HTTP chunked transfer
                            ▼
  ┌─ browser fetch body ──────────────────────────────────┐
  │  reader.read() pulls one chunk at a time               │
  │  splits on \n, JSON.parses each complete line          │
  └────────────────────────────────────────────────────────┘
```

---

## How it works

### Move 1 — the mental model

You already know `fetch()` waits for the full body before resolving. NDJSON streaming flips that — you grab `response.body.getReader()` and pull chunks as they arrive, parsing each newline-terminated JSON object as a separate event. The server, on its end, opens a `ReadableStream`, writes events one at a time, and closes when done. Both sides treat the stream as an *event sequence*, not a single payload.

```
  The NDJSON streaming pattern — the kernel

  server                                          client
  ──────                                          ──────
  open ReadableStream                             fetch(url)
  for each event:                                  reader = body.getReader()
    controller.enqueue(JSON.stringify(e) + '\n')   loop:
  on done:                                            chunk = reader.read()
    controller.close()                                buffer += decode(chunk)
                                                     lines = buffer.split('\n')
                                                     for each complete line:
                                                       handle(JSON.parse(line))
```

Three load-bearing parts:
- **the newline delimiter** — without it, the consumer can't tell where one event ends and the next begins
- **the buffer at the consumer** — chunks don't align with newlines; you must accumulate and re-split
- **the close** — without `controller.close()` the consumer reads forever waiting for more

### Move 2 — the moving parts

#### Part 1 — the producer (server-side `ReadableStream`)

The route handler returns a `Response` whose body is a `ReadableStream<Uint8Array>`. The stream's `start(controller)` runs the agent and `enqueue`s events as they happen.

```
  Producer pattern (server)

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: AgentEvent) => {
        controller.enqueue(encoder.encode(JSON.stringify(e) + '\n'));
      };
      try {
        send({ type: 'reasoning_step', step: { ... } });
        // ... run the agent, sending events for each step
        send({ type: 'done' });
      } catch (e) {
        send({ type: 'error', message: e.message });
      } finally {
        controller.close();             ← signal end-of-stream
      }
    },
  });
  return new Response(stream, { headers: NDJSON_HEADERS });
```

The `try / catch / finally` pattern is load-bearing: it ensures `controller.close()` runs even when the agent throws, so the consumer's reader doesn't hang. Without the `finally`, an uncaught exception would close the connection abruptly (the consumer sees a network error, not a clean end).

#### Part 2 — the consumer (browser `fetch().body.getReader()`)

The client opens a fetch, gets a `ReadableStreamDefaultReader` from the response body, and pulls chunks in a loop. Chunks are byte-level; the client must split on newlines and parse each complete JSON line.

```
  Consumer pattern (client) — buffer-and-split

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;                            ← server closed; stream end
    buf += dec.decode(value, { stream: true });  ← accumulate bytes
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';                     ← last line is incomplete;
                                                    keep for next iteration
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        handle(JSON.parse(line) as AgentEvent);
      } catch { /* ignore malformed line */ }
    }
  }
  if (buf.trim()) {                             ← flush a trailing complete line
    try { handle(JSON.parse(buf)); } catch {}
  }
```

The boundary condition that gets people: `value` from `reader.read()` is **not aligned to newlines**. A single chunk might be the middle of one event, or the end of one event plus the start of another. The buffer-and-split pattern handles both cases — `lines.pop()` keeps the incomplete last line for the next iteration, joining it with whatever comes next.

#### Part 3 — backpressure (implicit, via the transport)

You don't write backpressure logic. The `ReadableStream` controller queues `enqueue`d chunks; when the underlying transport's buffer is full, further writes wait until there's room. Node's HTTP layer handles the TCP-level backpressure; the browser handles the read side. The producer never has to ask "is the consumer ready?" — if it isn't, `enqueue` blocks (via the runtime's internal mechanism), and the producer's await chain naturally yields.

```
  Backpressure — how it actually works under the hood

  producer:  controller.enqueue(bytes)
                │
                ▼
  Node HTTP:   socket.write(bytes)
                │                    ← returns false if buffer full;
                ▼                       producer "should" wait, and does
  TCP buffer:  fills up if consumer is slow
                │
                ▼
  consumer:   reader.read() pulls one chunk at a time;
              browser pulls from TCP buffer as room opens
```

In practice, NDJSON events are small (typically <1KB each) and emitted at human-readable speeds (one every few seconds at most). Backpressure never actually engages — the transport's buffer is never close to full. But the *mechanism is there for free*, which is why no explicit code manages it.

#### Part 4 — ordering (free, because single-producer single-consumer)

One agent loop produces events; one browser tab consumes them; the HTTP connection delivers them in order. There is no concurrent producer, no multi-consumer fan-out, no possibility of reorder. The order in which `send(event)` is called is the order events appear at the consumer.

```
  Ordering — single chain, one direction

  agent step 1 → send → enqueue → write → read → handle → step 1
  agent step 2 → send → enqueue → write → read → handle → step 2
  agent step 3 → send → enqueue → write → read → handle → step 3

  no concurrency at the producer.
  no fan-out at the consumer.
  no reorder possible.
```

The boundary condition: if two requests for the same investigation ran in parallel (which the `startedRef` guard in `useInvestigation` prevents), they'd be two independent streams with no ordering relationship between them. The client would handle them as two separate event sequences.

#### Part 5 — the replay path (pre-recorded stream)

The cached/demo replay path is a *fake* streaming producer — it re-emits a pre-recorded `AgentEvent[]` array with a fixed `REPLAY_DELAY_MS` (180ms in `/api/agent`, 140ms in `/api/briefing`) between events. Same NDJSON format; same consumer code; just sourced from disk instead of an agent.

```
  Replay path — same protocol, different producer

  ┌─ cached events ─┐                     ┌─ live agent ─┐
  │ AgentEvent[]    │                     │ runAgentLoop │
  └────────┬────────┘                     └──────┬───────┘
           │                                     │
           │ for each event:                     │ for each step:
           │   enqueue                           │   enqueue
           │   sleep(REPLAY_DELAY_MS)            │   (natural delay)
           │                                     │
           └─────────────┬───────────────────────┘
                         ▼
                   same NDJSON output
                   same consumer code
```

The consumer cannot distinguish replay from live — both look like a paced stream of events. This is what makes the demo mode work without credentials.

#### Part 6 — what NOT YET EXERCISED looks like

The standard distributed-systems work-queue surface is absent.

```
  things NOT YET EXERCISED at this lens

  - work queues (SQS, RabbitMQ, Kafka, Redis Streams):
    no background jobs; everything runs inline in the request

  - fan-out / pub-sub:
    no broadcasting an event to N consumers

  - consumer groups (Kafka):
    only one consumer per stream (the browser tab that issued the fetch)

  - poison message handling (DLQ):
    no messages to be "poison" — every event is observe-only

  - ordering across producers / partitions:
    one producer per stream

  - reconnect-and-resume protocol:
    no event ID, no resumable cursor; mid-stream disconnect = lost

  what would force these:
    "schedule the briefing for 8am tomorrow" → needs a job queue
    "broadcast a new insight to N dashboards" → needs pub-sub
    "100 users hit the briefing at once" → needs work distribution
```

The right next move for the first of these is Vercel Cron Jobs + a database for the scheduled-briefing state — the platform handles the queuing for you. The right next move for fan-out is Vercel KV's pub-sub or a third-party (Pusher, Ably). None of these are wrong to be absent; they're features that haven't been built.

### Move 3 — the principle

**A stream is a queue with one producer and one consumer, where the transport is the buffer.** When you can get away with that shape (one agent doing the work, one tab watching it happen), you don't need a queue. The moment you need work to outlive the request — to be picked up by a different process, to be retried by a worker pool, to be observed by multiple consumers — you reach for an actual queue. blooming insights doesn't, and that absence is what keeps the architecture small enough to fit in your head.

---

## Primary diagram

```
  The NDJSON streaming pattern — full picture

  ┌─ /api/agent or /api/briefing ────────────────────────────────────────┐
  │                                                                       │
  │   new ReadableStream<Uint8Array>({                                    │
  │     async start(controller) {                                         │
  │       const send = (e) => controller.enqueue(                         │
  │                              encoder.encode(JSON.stringify(e)+'\n')); │
  │                                                                       │
  │       try {                                                           │
  │         send({ type: 'reasoning_step', step: {...} });                │
  │         await diagAgent.investigate(anomaly, hooks);                  │
  │             │                                                         │
  │             ├── hooks.onToolCall →    send tool_call_start            │
  │             ├── hooks.onText →        send reasoning_step             │
  │             └── hooks.onToolResult →  send tool_call_end              │
  │         send({ type: 'diagnosis', diagnosis });                       │
  │         send({ type: 'done' });                                       │
  │       } catch (e) {                                                   │
  │         send({ type: 'error', message: e.message });                  │
  │       } finally {                                                     │
  │         controller.close();   ← clean end-of-stream                   │
  │       }                                                               │
  │     }                                                                 │
  │   })                                                                  │
  │                                                                       │
  └────────────────────────────────┬─────────────────────────────────────┘
                                   │
                                   │  HTTP chunked transfer
                                   │  Content-Type: application/x-ndjson
                                   │  one JSON object per \n
                                   ▼
  ┌─ browser ────────────────────────────────────────────────────────────┐
  │                                                                       │
  │   const reader = res.body.getReader();                                │
  │   const dec = new TextDecoder();                                      │
  │   let buf = '';                                                       │
  │   for (;;) {                                                          │
  │     const { done, value } = await reader.read();                      │
  │     if (done) break;                                                  │
  │     buf += dec.decode(value, { stream: true });                       │
  │     const lines = buf.split('\n');                                    │
  │     buf = lines.pop() ?? '';      ← incomplete trailing line          │
  │     for (const line of lines) {                                       │
  │       if (!line.trim()) continue;                                     │
  │       handle(JSON.parse(line) as AgentEvent);                         │
  │     }                                                                 │
  │   }                                                                   │
  │   // flush trailing complete line, if any                             │
  │                                                                       │
  └───────────────────────────────────────────────────────────────────────┘

  ordering: emitted-order, guaranteed by single-connection chunked transfer
  backpressure: implicit, via TCP / ReadableStream's underlying transport
  delivery: at-most-once per stream (no resume on disconnect)
```

---

## Implementation in codebase

**Use cases.**
- A diagnostic agent runs for ~30 seconds against a slow EQL. Without streaming, the user would see a spinner the whole time. With NDJSON streaming, the user sees `reasoning_step → tool_call_start → tool_call_end → reasoning_step → diagnosis → done` as each step happens. The UX is "visibly working" instead of "appears frozen."
- The briefing emits coverage tiles (`coverage_item` events) one at a time, paced with checklist log lines. The UI renders each tile as its event arrives — the coverage grid fills in step with the status log. Single-stream ordering makes this pacing trivial; with separate parallel requests, the grid and log could desync.
- Demo mode replays a pre-recorded `AgentEvent[]` from disk through the same `ReadableStream` mechanism. The consumer cannot tell live from replay — both are NDJSON, both have the same event types, both are paced. The replay paces deliberately (180ms gap) to look natural.

**Code side by side.**

```
  app/api/agent/route.ts  (lines 168-264)

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const collected: AgentEvent[] = [];                ← also stored locally,
      const send = (e: AgentEvent) => {                     for the saveInvestigation
        collected.push(e);                                  call at the end
        controller.enqueue(encoder.encode(encodeEvent(e)));
      };
      // ... agent loop with hooks that call send ...
      try {
        // ... run diagnostic + recommendation agents ...
        send({ type: 'done' });
        if (step == null) saveInvestigation(insightId!, collected);
      } catch (e) {
        send({ type: 'error', message: ... });
      } finally {
        controller.close();                              ← always close,
      }                                                     even on throw
    },
  });
  return new Response(stream, { headers: NDJSON_HEADERS });
       │
       └─ this is the producer side. The `send` closure is the seam
          between agent code (which emits domain events) and stream
          code (which serializes them). Same pattern in /api/briefing.
```

```
  lib/hooks/useInvestigation.ts  (lines 184-208)

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });          ← stream: true is
                                                            critical — handles
                                                            multi-byte chars
                                                            that span chunks
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';                             ← LOAD-BEARING:
                                                            keep the trailing
                                                            incomplete line
                                                            for the next chunk
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        handle(JSON.parse(line) as AgentEvent);          ← per-line, not
      } catch { /* ignore malformed line */ }              per-chunk parsing
    }
  }
  if (buf.trim()) {
    try { handle(JSON.parse(buf) as AgentEvent); } catch {}  ← flush trailing
  }                                                            complete event
       │
       └─ this is the consumer side. The buffer-and-split is the
          load-bearing part — without it, chunks that don't align with
          newlines would either lose events or fail to parse.
```

```
  lib/mcp/events.ts  (lines 4-22)

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
  export function decodeEvent(line: string): AgentEvent {
    return JSON.parse(line) as AgentEvent;
  }
       │
       └─ the event ALGEBRA — single source of truth for what can
          flow over the stream. Both producer and consumer import the
          same type, so adding a new event type forces both to update.
          Encode/decode are deliberately minimal — JSON + newline.
```

---

## Elaborate

NDJSON over `ReadableStream` is a poor cousin of Server-Sent Events (SSE) and the much-richer WebSockets — and that's exactly why it's the right choice here. SSE would buy you auto-reconnect and a Last-Event-ID semantic; WebSockets would buy you bidirectional comms. blooming insights needs neither: the stream is one-way and the at-most-once-per-stream semantics are fine because every event is observable, not load-bearing. NDJSON over fetch wins because it has no special infrastructure requirement, works in every modern browser, and the parser is 15 lines.

The right next move IF the workload pushed harder: switch to SSE for the resume-on-disconnect semantic (server keeps a per-stream cursor, client reconnects with Last-Event-ID, server skips to the next event). The agent's `collected: AgentEvent[]` buffer at lines 171-174 is already shaped right for that — it has every event in order; resume would just be "send events past index N."

The real "queue" in this codebase is `collected` itself — an in-process array that buffers the stream for the duration of one route invocation. If the route finishes successfully, `saveInvestigation(insightId, collected)` persists it to disk (in dev) or to the in-memory Map. That's the closest thing to a durable message log we have, and it exists *for replay*, not for inter-process work passing.

---

## Interview defense

**Q: Walk me through how a long-running agent appears interactive in the browser.**

NDJSON over HTTP chunked transfer. The route opens a `ReadableStream`, the agent runs inside it, and every step (reasoning, tool call, tool result, diagnosis, recommendation, done) becomes one JSON line emitted via `controller.enqueue`. The client uses `fetch().body.getReader()` to pull chunks, splits on newline, and JSON.parses each complete line. Ordering is automatic because there's one connection and one producer; backpressure is automatic because the transport handles it. The whole pattern is maybe 30 lines on the server and 20 on the client.

```
  server                            client
  ──────                            ──────
  ReadableStream + controller        fetch().body.getReader()
  enqueue(JSON + \n)        ───►    buffer.split('\n')
                                     JSON.parse(line)
```

**Q: What's the load-bearing part people forget?**

`buf = lines.pop() ?? ''` on the client. Chunks from the reader don't align with newlines — a chunk might be the middle of one event, or the end of one plus the start of another. Pop'ing the last (possibly incomplete) line and keeping it for the next iteration is what makes the buffer-and-split work. Forget it, and you either lose events (drop the trailing fragment) or throw on JSON.parse (try to parse `{"type":"reaso`).

**Q: Why not WebSockets or SSE?**

NDJSON over fetch is one-way, which is exactly what we need — the server emits, the client reads. No bidirectional traffic. SSE would buy us auto-reconnect with Last-Event-ID, which we don't need today because mid-stream disconnect means "user closed the tab" — there's nothing to resume to. WebSockets would buy bidirectional, which we don't use. The simplest thing that works is the right call; if the workload changes (real-time collaboration, multi-user broadcast), SSE first, WebSockets only if bidirectional is needed.

---

## Validate

- **Reconstruct.** Without looking, write the consumer's buffer-and-split loop. Name the load-bearing line (`buf = lines.pop() ?? ''`).
- **Explain.** Why does the consumer `if (!line.trim()) continue` before `JSON.parse(line)`? Empty lines happen when the buffer ends on a newline (`split('\n')` gives a trailing empty element). Without the skip, `JSON.parse('')` throws.
- **Apply.** A bug report: "in production sometimes I see the stream stop mid-way and no error appears in the UI." Walk through likely causes. (Vercel `maxDuration` hitting 300s with no `finally controller.close()` — the route is killed mid-stream, the client sees a network-level end of stream, no clean `done` event. Mitigated by the existing `try/catch/finally` in both routes; would re-appear if a new route forgot the pattern.)
- **Defend.** Why no work queue? Because no work needs to outlive the request. Every agent runs inline; if it fails, the user retries. Adding a queue (BullMQ, SQS) would require background workers, separate observability, dead-letter handling — all valuable at scale, all overhead at hackathon scale. Defer until a feature needs work to survive a process death.

---

## See also

- `02-partial-failure-timeouts-and-retries.md` — the retry waits inside `McpClient` are absorbed *visibly* thanks to the streaming pattern; without the stream, the UI would freeze during a 20s retry sleep
- `03-idempotency-deduplication-and-delivery-semantics.md` — at-most-once-per-stream is part of the delivery story
- `08-sagas-outbox-and-cross-boundary-workflows.md` — the cached investigation array IS a poor-man's outbox for replay
- `.aipe/study-system-design/02-request-response-and-data-flow.md` — the architectural take on the streaming pattern
- `.aipe/study-prompt-engineering/` — the agent loop driving the events is the actual content producer
