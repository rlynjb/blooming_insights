# Streaming NDJSON — one event per line, four producers, one reader kernel

**Industry name:** newline-delimited JSON / NDJSON / JSON Lines (JSONL) · Industry standard

## Zoom out, then zoom in

Every streaming surface in this app — briefing, agent investigation, query
chat, dev capture — speaks the same wire format: one JSON object per line,
terminated with `\n`. The server uses `encodeEvent()` (or the inline
equivalent in `/api/briefing`); the client uses `readNdjson()` — one
64-line kernel that all four surfaces share.

You know how `fetch().then(res => res.json())` waits for the whole body
before resolving? That's wrong for our use case: a monitoring scan can take
20-90 seconds, and the user needs to see progress (the agent's reasoning
steps, each tool call as it starts, each insight as it lands). NDJSON is
the answer: stream the body, parse one line at a time, dispatch each event
as it arrives.

```
  Zoom out — where NDJSON streaming lives

  ┌─ Server ─────────────────────────────────────────────────────────────┐
  │  /api/briefing  /api/agent  /api/mcp/capture  /api/agent?q=…          │
  │       │              │              │              │                  │
  │       └──────────────┴──────┬───────┴──────────────┘                  │
  │                             │  encodeEvent(e) = JSON.stringify(e)+'\n'│
  │                             ▼                                          │
  │                  ★ ReadableStream<Uint8Array> ★                       │
  │                  controller.enqueue(encoder.encode(...))               │
  └─────────────────────────────┬────────────────────────────────────────┘
                                │ HTTP, content-type: application/x-ndjson
  ┌─ Client ───────────────────▼─────────────────────────────────────────┐
  │  body.getReader() → TextDecoder → split('\n') → JSON.parse → dispatch │
  │  ★ lib/streaming/ndjson.ts:17-64 ★ — ONE kernel, four consumers       │ ← we are here
  │  useBriefingStream / useInvestigation / useDemoCapture /              │
  │  StreamingResponse                                                    │
  └──────────────────────────────────────────────────────────────────────┘
```

The point of this file: explain the wire format, the kernel, and the
discriminated-union event contract that makes the dispatch a switch
statement.

## Structure pass — layers, axis, seams

**Layers:** Producer code → `ReadableStream` controller → HTTP body →
network → browser `fetch` → reader loop → event handler.

**Axis (held constant): "what's on the wire at this layer?"** This is
the right axis because the whole pattern is about format negotiation —
each layer adds or removes framing.

```
  Axis: what's on the wire?

  ┌─ Producer (route handler) ──────────────────────┐
  │  AgentEvent object — typed discriminated union   │   → OBJECT
  └─────────────────────┬───────────────────────────┘
                        │ encodeEvent(e)
  ┌─ HTTP body bytes ───▼───────────────────────────┐
  │  "{\"type\":\"tool_call_start\",...}\n"          │   → BYTES with line framing
  └─────────────────────┬───────────────────────────┘
                        │ TCP/TLS
  ┌─ Browser body bytes ▼───────────────────────────┐
  │  Uint8Array chunks (may split mid-line)          │   → BYTES, no boundary guarantees
  └─────────────────────┬───────────────────────────┘
                        │ readNdjson loop
  ┌─ Consumer (hook) ───▼───────────────────────────┐
  │  AgentEvent object — same type back              │   → OBJECT (round-tripped)
  └─────────────────────────────────────────────────┘
```

**Seams (boundaries where the on-wire answer flips):**

- **Object ↔ bytes (producer side)** — `encodeEvent()` is the seam.
  After it, errors are unrecoverable in-band; before it, they're
  type-checked at compile time.
- **HTTP boundary** — the network adds no framing of its own. NDJSON's
  `\n` IS the framing. The browser may receive a single line split
  across multiple chunks; the reader has to buffer.
- **Bytes ↔ object (consumer side)** — `JSON.parse(line)` is the seam.
  After it, the handler can `switch(event.type)` with full type safety;
  before it, it's a `Uint8Array`.

## How it works

### Move 1 — the mental model

The shape: one object per line, terminated with `\n`. That's the entire
spec.

```
  Pattern — NDJSON on the wire

  {"type":"reasoning_step","step":{"id":"...","agent":"monitoring","kind":"thought","content":"reading the workspace schema…"}}
  {"type":"workspace","workspace":{"projectName":"wobbly-ukulele","totalCustomers":12450,"totalEvents":2840127}}
  {"type":"coverage_item","item":{"category":"conversion_drop","label":"conversion drop","coverage":"full"}}
  {"type":"tool_call_start","toolName":"execute_analytics_eql","agent":"monitoring"}
  {"type":"tool_call_end","toolName":"execute_analytics_eql","agent":"monitoring","durationMs":847,"result":{...}}
  {"type":"insight","insight":{"id":"...","severity":"warning","headline":"...","change":{...}}}
  {"type":"done"}
```

Each line is independent. A client can join late and miss the early
ones; the events are self-describing (each carries its `type`
discriminator). A line that fails to parse can be silently dropped
without corrupting the rest of the stream.

### Move 2 — the step-by-step walkthrough

#### Step 1 — the AgentEvent contract (the discriminated union)

The wire format is typed by a TypeScript discriminated union. The
producer and consumer both reference the same type, so a change to one
breaks the other at compile time.

```typescript
// lib/mcp/events.ts:4-12
export type AgentEvent =
  | { type: 'reasoning_step'; step: ReasoningStep }
  | { type: 'tool_call_start'; toolName: string; agent: AgentName }
  | { type: 'tool_call_end'; toolName: string; agent: AgentName; durationMs: number; result?: unknown; error?: string }
  | { type: 'insight'; insight: Insight }
  | { type: 'diagnosis'; diagnosis: Diagnosis }
  | { type: 'recommendation'; recommendation: Recommendation }
  | { type: 'done' }
  | { type: 'error'; message: string };

export function encodeEvent(e: AgentEvent): string {
  return JSON.stringify(e) + '\n';
}
```

`/api/briefing` adds two more event types not in this union
(`workspace` and `coverage_item`) because they're briefing-specific.
This is a deliberate tradeoff: keep the `AgentEvent` shared contract
narrow; let one route extend it locally for its own surface. The
client consumer (`useBriefingStream.ts:36-45`) types the extended union
as `BriefingEvent`.

```
  The shared contract vs the per-route extension

  shared AgentEvent (lib/mcp/events.ts):
    reasoning_step | tool_call_start | tool_call_end | insight |
    diagnosis | recommendation | done | error
                            │
                            └────► consumed by useInvestigation,
                                   useDemoCapture, StreamingResponse,
                                   /api/agent

  briefing-only extension (app/api/briefing/route.ts:56-60,
                           lib/hooks/useBriefingStream.ts:36-45):
    AgentEvent ∪ workspace ∪ coverage_item ∪ coverage
                            │
                            └────► consumed only by useBriefingStream
```

#### Step 2 — the producer side (writing NDJSON)

The producer pattern is `controller.enqueue(encoder.encode(...))`:

```typescript
// /api/agent — uses the named helper (app/api/agent/route.ts:183-190)
const encoder = new TextEncoder();
const stream = new ReadableStream<Uint8Array>({
  async start(controller) {
    const send = (e: AgentEvent) => {
      collected.push(e);
      controller.enqueue(encoder.encode(encodeEvent(e)));
    };
    // ... use send(...) throughout the agent run ...
  }
});
return new Response(stream, { headers: NDJSON_HEADERS });
```

`/api/briefing` inlines the encoding (because its event union has
extra types not in the shared `AgentEvent`):

```typescript
// app/api/briefing/route.ts:193-194
const send = (e: BriefingEvent) =>
  controller.enqueue(encoder.encode(JSON.stringify(e) + '\n'));
```

Both routes set the same headers:

```typescript
// app/api/agent/route.ts:105-108
const NDJSON_HEADERS = {
  'Content-Type': 'application/x-ndjson; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
};
```

The `no-transform` part matters: some proxies aggressively compress or
buffer streaming responses, defeating the progressive-delivery point.
`no-transform` tells them to leave the bytes alone.

#### Step 3 — the reader kernel (`readNdjson`)

This is the one piece shared across all four surfaces.

```typescript
// lib/streaming/ndjson.ts:17-64
export async function readNdjson<E>(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: E) => void,
  opts?: {
    cancelOn?: () => boolean;
    onMalformed?: (line: string, err: unknown) => void;
  },
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

Six load-bearing pieces:

  → `TextDecoder({ stream: true })` — chunks may split a multi-byte
    UTF-8 character mid-byte; `stream: true` defers the split character
    to the next chunk instead of emitting `�`
  → `let buf = ''` + `lines.pop()` — chunks may split a line mid-text;
    the last partial line stays in `buf` for the next chunk
  → `if (opts?.cancelOn?.())` — the consumer can signal "I'm gone"
    (an unmounted React effect, a navigated-away tab); `reader.cancel()`
    cleans up
  → `try { JSON.parse } catch` — a malformed line doesn't kill the
    stream; the default is silent skip, with an optional `onMalformed`
    callback for tests
  → end-of-stream flush — handles a producer that didn't terminate
    with `\n` (no current producer does this, but the contract is
    defensive)
  → `finally { reader.releaseLock() }` — the ReadableStream reader
    holds an exclusive lock on the body; releasing it lets the body be
    re-used (in practice we don't, but the contract requires it)

```
  Execution trace — chunked NDJSON arriving over network

  state                                   chunk arrived
  ─────                                   ─────────────
  buf = ""                                "{\"type\":\"tool_call_st"
  buf = "{\"type\":\"tool_call_st"        — no '\n' yet, keep buffering

  buf = "{\"type\":\"tool_call_st"        "art\",\"toolName\":\"X\"}\n{\"type\":\""
  buf = "...tool_call_start...X\"}\n{\"type\":\""
    split('\n') = [ "{...complete line...}", "{\"type\":\"" ]
    pop → buf = "{\"type\":\""
    parse "{...complete line...}" → onEvent(tool_call_start)

  buf = "{\"type\":\""                    "done\"}\n"
  buf = "{\"type\":\"done\"}\n"
    split('\n') = [ "{\"type\":\"done\"}", "" ]
    pop → buf = ""
    parse "{\"type\":\"done\"}" → onEvent(done)
```

#### Step 4 — the consumer dispatch (`switch(event.type)`)

Every consumer follows the same shape: fetch, get reader, `readNdjson`
with an event handler that does a `switch` on `event.type`. Here's the
briefing consumer (`useBriefingStream.ts:204-286`, abridged):

```typescript
const handle = (evt: BriefingEvent) => {
  switch (evt.type) {
    case 'workspace':       setWorkspace(evt.workspace); break;
    case 'coverage_item':   setCoverage((prev) => [...]); break;
    case 'tool_call_start': setQueryCount((n) => n + 1);
                            setTraceItems((prev) => [...]);
                            break;
    case 'reasoning_step':  /* push to trace + statusText */ break;
    case 'tool_call_end':   /* fill in result on last running tool item */ break;
    case 'insight':         collected.push(evt.insight); break;
    case 'done':             setInsights(collected);
                             stashInsights(collected);
                             callbacksRef.current?.onStreamComplete?.();
                             setStatus(collected.length === 0 ? 'empty' : 'loaded');
                             break;
    case 'error':            /* check reconnect policy, else setError */ break;
  }
};
await readNdjson<BriefingEvent>(res.body, handle, { cancelOn: () => cancelledRef.current });
```

TypeScript narrows the type inside each `case` arm based on the
discriminator. The compiler enforces: if you add a new `type` to the
union, every `switch` that needs to handle it gets a type error
(when using `--strict` and `noFallthroughCasesInSwitch` — which this
project does, see `tsconfig.json`). The contract is self-policing.

#### Step 5 — the four consumers, what they share

```
  Four streaming surfaces, one kernel

  surface                            consumer file                          event union
  ───────                            ─────────────                          ───────────
  feed (briefing)                    lib/hooks/useBriefingStream.ts:288    BriefingEvent (AgentEvent ∪ {workspace, coverage_item, coverage})
  investigation (step 2, 3)          lib/hooks/useInvestigation.ts:194     AgentEvent
  dev capture (drains for cache)     lib/hooks/useDemoCapture.ts:84        {type?: string, message?: string}  (only checks 'done' and 'error')
  free-form query                    components/chat/StreamingResponse.tsx AgentEvent
```

What's identical: `await readNdjson(res.body, handle)` with a per-surface
handler. What differs: which event types each surface dispatches on. The
dev capture is the minimal consumer — it doesn't render anything; it just
drains the stream so the server's `saveInvestigation` runs.

### Move 3 — the principle

**Pick a wire format that's degradable.** NDJSON's defining property:
a stream half-read is still useful. A client that times out at line 47
of 60 still has 47 events worth of useful state — every `tool_call_*`
that completed, every `insight` that landed, every `reasoning_step`
that was emitted. Compare to a single JSON document: parsing fails on
incomplete input; nothing recoverable.

The same principle, generalized: when output is a sequence of
independent items, frame the items at the smallest unit that's
independently useful. For logs, it's lines (NDJSON is its sibling).
For text generation, it's tokens (SSE for streaming text completions).
For binary data, it's chunks (HTTP chunked encoding). The shape is
always: "each unit is meaningful alone, the boundary is explicit."

NDJSON beats SSE for our case because (a) we don't need named event
types beyond a JSON discriminator, (b) we don't want the EventSource
auto-reconnect (we handle reconnect at the app level via
`useReconnectPolicy`), and (c) the fetch + reader API is simpler than
EventSource for cancellation.

## Primary diagram

```
  NDJSON streaming — producer to consumer, end to end

  ┌─ Producer (Next.js route handler) ─────────────────────────────────────┐
  │                                                                          │
  │  const encoder = new TextEncoder();                                      │
  │  const stream = new ReadableStream<Uint8Array>({                         │
  │    async start(controller) {                                              │
  │      const send = (e) => controller.enqueue(                              │
  │        encoder.encode(JSON.stringify(e) + '\n'));                         │
  │                                                                            │
  │      // each agent hook becomes one send():                              │
  │      send({ type: 'reasoning_step', step: {...} });                       │
  │      send({ type: 'tool_call_start', toolName: 'X', agent: 'monitoring'});│
  │      send({ type: 'tool_call_end', toolName: 'X', durationMs: 847, ...});│
  │      send({ type: 'insight', insight: {...} });                           │
  │      send({ type: 'done' });                                              │
  │      controller.close();                                                  │
  │    }                                                                       │
  │  });                                                                       │
  │  return new Response(stream, {                                             │
  │    headers: { 'content-type': 'application/x-ndjson; charset=utf-8',     │
  │               'cache-control': 'no-cache, no-transform' }                 │
  │  });                                                                       │
  └──────────────────────────────┬─────────────────────────────────────────┘
                                 │ HTTP body
                                 ▼
                              network
                                 │
                                 ▼
  ┌─ Consumer (React hook) ────────────────────────────────────────────────┐
  │                                                                          │
  │  const res = await fetch(url);                                           │
  │  await readNdjson<AgentEvent>(res.body, (e) => {                          │
  │    switch (e.type) {                                                      │
  │      case 'reasoning_step':  setItems(p => [...p, traceFromStep(e)]); break;
  │      case 'tool_call_start': setItems(p => [...p, traceFromStart(e)]); break;
  │      case 'tool_call_end':   setItems(p => replaceRunning(p, e)); break; │
  │      case 'insight':         collected.push(e.insight); break;           │
  │      case 'done':            setComplete(true); break;                   │
  │      case 'error':           setError(e.message); break;                  │
  │    }                                                                      │
  │  }, { cancelOn: () => cancelledRef.current });                            │
  │                                                                            │
  └──────────────────────────────────────────────────────────────────────────┘

  Inside readNdjson — the buffering + dispatch loop:

  buf = ''
  while (!done):
    if cancelOn(): reader.cancel(); return
    { value, done } = await reader.read()
    buf += decoder.decode(value, { stream: true })   // handles mid-byte UTF-8
    lines = buf.split('\n')
    buf = lines.pop()                                // keep partial line
    for line in lines:
      if line.trim():
        try: onEvent(JSON.parse(line))               // dispatch
        catch: onMalformed(line, err)                // silent default
  flush trailing buf (no-op for properly-terminated producers)
```

## Elaborate

**Where this pattern comes from.** NDJSON / JSON Lines emerged from the
logging world (~2010-2014): tools like Elasticsearch's bulk API, Splunk's
HTTP event collector, and the `jq` ecosystem all needed a streamable
JSON format that wasn't a single giant array. The format is so simple
it doesn't even have a formal specification — `jsonlines.org` is a
single page that says "one JSON value per line, separated by `\n`."

**The deeper principle.** Frame at the boundary of independent
meaning. Single-JSON requires the whole document to be parsed
atomically; NDJSON makes each line independently parseable.

The class of streaming wire formats:

  → SSE (Server-Sent Events) — `event:`/`data:` prefixed lines,
    auto-reconnect via EventSource, used for tokens/notifications
  → NDJSON / JSONL — one JSON value per line, used for logs, agent
    traces, bulk operations
  → HTTP chunked encoding — bytes as the unit, used for raw streaming
    (file downloads, audio/video)
  → WebSocket frames — bidirectional, used for true duplex
    (chat, multiplayer, collaborative editing)

We pick NDJSON because the request is one-way (server → client) and the
events are structured. SSE would work too; the tiebreaker is the
fetch+reader API being simpler than EventSource for our cancellation
story.

**Where it breaks.**

- **Proxies that buffer.** Some CDN configurations buffer responses
  until they're complete, defeating the progressive-delivery point.
  We mitigate with `cache-control: no-transform` and `content-type:
  application/x-ndjson` (which most CDNs treat as "don't transform"),
  but a misconfigured proxy could still break it.
- **JSON.stringify cost on the producer.** Each event is stringified
  on the hot path. For a 60-line briefing this is fine; for a 60,000-
  line scan it'd matter. Today's volumes are tiny.
- **The producer can run out of memory on `collected.push(e)`.** The
  `/api/agent` route keeps every event in a `collected` array
  (`app/api/agent/route.ts:186`) so it can be cached for replay. A
  long investigation with many tool calls grows this without bound.
  The 300s ceiling caps total accumulation, but a hostile prompt
  could fill memory.
- **Each line must be valid JSON.** A bug that emits a non-JSON line
  is silently swallowed by `onMalformed`. Default behavior is silent,
  which is friendly to clients but unfriendly to producers — a
  bug-in-the-encoder might never surface. The `onMalformed` callback
  is the test-time hook.

**What to explore next.**

- `01-request-flow.md` — the route handler that drives this stream
- `08-client-stream-handoff.md` — how the stream survives a tab close
  (it doesn't — but the result hand-off does)
- `study-networking` — HTTP chunked encoding, SSE vs NDJSON vs WebSocket
- `study-runtime-systems` — ReadableStream, TextDecoder, async iteration

## Interview defense

#### Q: "Why NDJSON instead of SSE for streaming the agent's reasoning?"

Three reasons, in order. **One**: the data is structured. Each event is
a typed discriminated union; JSON-per-line is the most natural fit. SSE
treats data as opaque text and you'd JSON.parse inside the `message`
handler anyway. **Two**: we own the reconnect story. The Bloomreach
alpha revokes tokens after minutes and we want a single one-shot
reset+reload on auth errors — EventSource's auto-reconnect would fight
that. **Three**: fetch + ReadableStream + a tiny `readNdjson` kernel is
simpler than EventSource for cancellation; we already use AbortSignal
everywhere, so reusing it for the stream consumer means one cancellation
model instead of two.

```
  SSE                      NDJSON (what we pick)
  ───                      ─────────────────────
  EventSource API          fetch + ReadableStream
  auto-reconnect built-in  app owns reconnect
  named event types        types via JSON discriminator
  text framing             line framing
  no Authorization headers can carry any headers via fetch
```

**Surface:** "structured data + we own reconnect + simpler cancellation."
**Probe:** if pressed — name `useReconnectPolicy.ts:33-123` as the
proof we want app-level reconnect, not EventSource's auto-retry.

#### Q: "What's the load-bearing part of this — what breaks if you remove it?"

The `let buf = '' + lines.pop()` pattern in the reader kernel
(`lib/streaming/ndjson.ts:30, 41`). It's the kernel: chunks from the
network can split a line mid-text, so the reader has to keep the
trailing partial line as `buf` and prepend it to the next chunk
before splitting again.

```
  load-bearing skeleton — line reassembly across chunks

  buf = ''
  for each chunk arriving:
    buf += decoder.decode(chunk, { stream: true })
    lines = buf.split('\n')
    buf = lines.pop()                          ← LOAD-BEARING: keep partial line
    for each complete line: onEvent(JSON.parse(line))

  at end-of-stream:
    if buf.trim(): try JSON.parse(buf) one more time
```

Drop the `pop()` and you'd attempt to JSON.parse a half-line on every
chunk boundary. The reader would emit `onMalformed` constantly and
miss real events.

Other load-bearing parts:

  → `TextDecoder({ stream: true })` — multi-byte UTF-8 character
    handling across chunks
  → `try { JSON.parse } catch` around dispatch — one malformed line
    must not kill the stream
  → `if (opts?.cancelOn?.())` polling — without it, an unmounted
    React component holds the reader forever
  → `reader.releaseLock()` in `finally` — required by the
    ReadableStream contract

Optional hardening:

  → end-of-stream flush of trailing `buf` — defensive against
    producers that don't terminate with `\n` (none of ours do this)
  → `onMalformed` callback — testing hook; default is silent skip

#### Q: "What changes if you need bi-directional streaming (chat-like)?"

NDJSON wouldn't work — it's one-way (server → client only). The right
move is WebSockets, but you'd give up the simple HTTP semantics (auth
header on the connect, retry on 401, graceful degradation through
CDNs). A pragmatic middle: keep the NDJSON server-push, add a separate
POST endpoint for client-to-server messages that returns its own
NDJSON stream for the response. That's effectively what the chat
surface does today — `QueryBox` POSTs (well, GETs with a `q` param),
the response is one NDJSON stream of agent events ending in `done`.

True bi-directional (server can ask the client mid-stream for more
context) would need WebSockets or a long-polling pattern. We don't have
that use case today; the agent has all the context it needs at request
time.

## See also

- `00-overview.md` — where this sits in the whole system
- `01-request-flow.md` — the route handler that drives the stream
- `08-client-stream-handoff.md` — what happens across the request boundary
- `04-aptkit-primitive-boundary.md` — how the trace adapter produces these
  events
- `study-networking` — SSE vs NDJSON vs WebSocket on the wire
- `study-runtime-systems` — ReadableStream + TextDecoder mechanics
