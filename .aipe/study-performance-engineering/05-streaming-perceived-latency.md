# NDJSON streaming as a perceived-latency tool

**Industry standard / Language-agnostic**

The investigation flow takes ~100-115s of wall-clock under live conditions
and the product never tries to make that number smaller. It instead reshapes
the **perceived latency** by streaming reasoning steps, tool calls, and
results to the UI as they happen. Time-to-first-paint-of-useful-content
collapses from ~115s to ~1-3s; the wall-clock is unchanged.

This is a perceived-latency pattern, not a throughput pattern. The
distinction matters because the wrong instinct is to try to make the
wall-clock smaller — which here would either cost money (more parallel
provider calls → exceed the spacing gate's ceiling) or cost product fidelity
(skip steps to finish faster). Neither is the right trade. Streaming is.

## Zoom out — where this concept lives

Two streaming layers compose: NDJSON on the wire (the server's
`ReadableStream` writes `'\n'`-terminated JSON events as the agent runs),
and a per-event React state update on the client (the trace renders one
reasoning step or tool call at a time). The user sees the agent thinking;
the request stays open for ~100s of total work.

```
  Zoom out — where this concept lives

  ┌─ UI layer ──────────────────────────────────────────┐
  │  components/investigation/ReasoningTrace.tsx        │
  │   - renders one TraceItem per event, AS THEY ARRIVE │
  │   - lib/hooks/useInvestigation.ts dispatches events │
  │   - lib/hooks/useBriefingStream.ts dispatches events│
  └─────────────────────────┬───────────────────────────┘
                            │  fetch().body.getReader()
                            │  + TextDecoder + split('\n')
  ┌─ Wire ──────────────────▼───────────────────────────┐
  │  newline-delimited JSON over a single fetch         │
  │  Content-Type: application/x-ndjson; charset=utf-8  │
  │  Cache-Control: no-cache, no-transform              │
  └─────────────────────────┬───────────────────────────┘
                            │
  ┌─ Service layer ─────────▼───────────────────────────┐
  │  app/api/{briefing,agent}/route.ts                  │
  │   - new ReadableStream({ start(controller) {…} })   │
  │   - controller.enqueue(encodeEvent(e)) per event    │
  │   - ★ events emitted AS WORK HAPPENS ★              │
  └─────────────────────────────────────────────────────┘
```

## The structure pass

The axis to trace is **"when does the user see this piece of work?"** —
and the answer flips dramatically at the wire seam between request and
stream.

```
  axis = "when does the user see each piece of work?"

  ┌─ buffered request/response (NOT this design) ─────────┐
  │  start work → … 100s of nothing … → entire result     │
  │  perceived latency = 100s                             │
  │  user sees nothing happening → assumes broken         │
  └───────────────────────────────────────────────────────┘

  ┌─ streamed (this design) ──────────────────────────────┐
  │  start work → bootstrap done @ ~2s → user sees it     │
  │             → first tool call @ ~3s → user sees it    │
  │             → reasoning step @ ~5s → user sees it     │
  │             → … (more streaming) …                    │
  │             → final answer @ ~100s → user sees it     │
  │  perceived latency = ~2s (time to first useful event) │
  │  wall-clock = same ~100s                              │
  └───────────────────────────────────────────────────────┘

  same total work, two different products
```

The transformation isn't in the work — it's in *when the user sees the
work happening.* That's the load-bearing seam: the moment work starts
emitting events instead of waiting until completion to emit the result.

## How it works

### Move 1 — the mental model

You've used `EventSource` for server-sent events or watched a `console.log`
stream from a long-running script. Same shape — except this uses plain
`fetch()` with a `ReadableStream` body and newline-delimited JSON, not the
SSE wire format. The reason: SSE doesn't support `POST` cleanly and adds
framing rules (`event:`, `data:`, `retry:` prefixes) we don't need.
NDJSON is the simpler primitive: one JSON object per line, parsed with
`split('\n')` and `JSON.parse`.

```
  The pattern — NDJSON over a single fetch

  server:                          client:

  ReadableStream({                 fetch(url).body.getReader()
    start(controller) {              ↓
      …do work…                    TextDecoder → buf += chunk
      controller.enqueue(           ↓
        '{"type":"step",…}\n'      buf.split('\n') → lines
      )                             ↓
      …more work…                  for each line:
      controller.enqueue(            JSON.parse(line) → event
        '{"type":"tool_call_start",…}\n'  ↓
      )                            handle(event) → setState
      controller.close()           // render trace
    }
  })
```

Kernel: one fetch, a `ReadableStream` body, newline-terminated JSON, a
client-side line-buffer + parse loop. Remove the line termination → the
client can't split chunks into events. Remove the per-line `JSON.parse`
isolation → one malformed line crashes the rest of the stream.

### Move 2 — the walkthrough

#### The server-side stream

Both `/api/briefing` and `/api/agent` open a `ReadableStream` and emit events
inside its `start` function as the agents run. The send function is local
to the stream closure:

```ts
// app/api/agent/route.ts:183-195
const encoder = new TextEncoder();
const stream = new ReadableStream<Uint8Array>({
  async start(controller) {
    const collected: AgentEvent[] = [];
    const send = (e: AgentEvent) => {
      collected.push(e);
      controller.enqueue(encoder.encode(encodeEvent(e)));
    };
    const stepFor = (
      agent: AgentName,
      kind: 'thought' | 'hypothesis' | 'conclusion',
      content: string,
    ) => send({ type: 'reasoning_step', step: { id: crypto.randomUUID(), agent, kind, content } });
```

`encodeEvent` is just `JSON.stringify(e) + '\n'` (see `lib/mcp/events.ts`).
The newline terminator is the framing — every event ends with one.

Two things to notice about `send`:

1. **Each call pushes one event over the wire.** No batching, no waiting
   for "enough" events to accumulate. If you call `send` three times, three
   newline-separated JSON objects hit the response stream.
2. **`collected.push(e)` keeps a server-side copy.** Used at the end of the
   request to save the full investigation trace to the cache
   (`saveInvestigation(insightId!, collected)`) — same events, two
   consumers, no duplication.

#### Events emit as work happens, not after it

The hooks fired by the agent loops (`onText`, `onToolCall`, `onToolResult`)
each call `send` synchronously when the agent emits the corresponding
signal:

```ts
// app/api/agent/route.ts:196-210
const hooksFor = (agent: AgentName) => ({
  onText: (t: string) => {
    if (t.trim()) stepFor(agent, 'thought', t);
  },
  onToolCall: (tc: ToolCall) => send({ type: 'tool_call_start', toolName: tc.toolName, agent }),
  onToolResult: (tc: ToolCall) =>
    send({
      type: 'tool_call_end',
      toolName: tc.toolName,
      agent,
      durationMs: tc.durationMs ?? 0,
      result: trunc(tc.result),
      error: tc.error,
    }),
});
```

When the agent loop inside `DiagnosticAgent.investigate` starts a tool call,
`onToolCall` fires, `send` enqueues `tool_call_start` on the wire, and the
client immediately sees a "running" badge appear in the trace. The tool
runs for 1-30s; when it finishes, `onToolResult` fires `tool_call_end`
with the actual `durationMs` and result — the client updates the same trace
item to show the duration and expandable result.

```
  Layers-and-hops — one tool call's lifecycle on the wire

  agent       adapter         server-stream         client
  loop        callTool        controller            useInvestigation
   │
   ├─ "I want execute_analytics_eql"
   │
   ├──onToolCall(tc)──►  hookFor()
   │                       │
   │                       └──send──►  enqueue('{"type":"tool_call_start"…}\n')
   │                                                    │
   │                                                    └─── wire ───►  read → parse → setState → render "running"
   │                                                                          │
   │  (call runs, 1-30s)                                                      │  user sees the running tool
   │                                                                          │
   ├──result + durationMs                                                     │
   │                                                                          │
   ├──onToolResult(tc)─►  hookFor()
   │                       │
   │                       └──send──►  enqueue('{"type":"tool_call_end",…,"durationMs":1234,"result":{…}}\n')
   │                                                    │
   │                                                    └─── wire ───►  read → parse → setState → update to "done"
   │                                                                          │
   │  agent decides next step                                                 │  user sees duration + expandable result
   │
   ▼
```

The streaming isn't a separate "log" channel — the events ARE the work
being narrated. There's no second connection, no polling, no SSE. One
fetch, one stream, one consumer.

#### The headers that make it stream

```ts
// app/api/agent/route.ts:105-108
const NDJSON_HEADERS = {
  'Content-Type': 'application/x-ndjson; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
};
```

Two perf-relevant headers:

- **`Content-Type: application/x-ndjson`** — the application-level framing
  contract. The client distinguishes ndjson from plain JSON to decide
  whether to stream-parse (`useBriefingStream.ts:185-199`).
- **`Cache-Control: no-cache, no-transform`** — the `no-transform` is the
  load-bearing half. Without it, an intermediary (CDN, proxy, dev server's
  HMR layer) might *buffer* the response, hold it until "complete," then
  forward it all at once — destroying the streaming. `no-transform`
  instructs intermediaries to leave the body alone.

#### The client-side line buffer

The client's NDJSON parser is one small kernel reused across every
streaming consumer in the codebase. It handles partial chunks, malformed
lines, and end-of-stream cleanup.

```ts
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
    const tail = buf.trim();
    if (tail) {
      try {
        onEvent(JSON.parse(tail) as E);
      } catch (err) {
        opts?.onMalformed?.(tail, err);
      }
    }
  } finally {
    reader.releaseLock();
  }
}
```

The kernel:

- **`buf`** holds the partial line carry-over between chunks. TCP/HTTP
  chunks don't respect message boundaries; you'll often get half an event,
  then the rest in the next chunk.
- **`buf.split('\n')` + `buf = lines.pop() ?? ''`** — split, take everything
  but the last piece as complete lines, save the last piece (possibly empty,
  possibly half a line) for the next chunk to complete.
- **Per-line `try/catch` around `JSON.parse`** — malformed lines log via
  `onMalformed` but don't crash the loop. Critical for streaming
  resilience: one corrupted line doesn't kill the whole reader.
- **`{ stream: true }` on `TextDecoder.decode`** — tells the decoder to
  hold UTF-8 multi-byte characters that straddle a chunk boundary. Without
  it, an emoji split across two chunks would render as garbage.
- **`reader.releaseLock()` in `finally`** — the `ReadableStream` reader
  pattern requires release; the `finally` ensures it happens even on a
  thrown handler.

**What breaks if you drop the `buf` carry-over.** Every event spanning a
chunk boundary becomes two malformed half-events, then a malformed final
half-event, repeating. Visible as the trace getting blank-then-corrupt
under any non-trivial network conditions.

#### React state updates as events arrive

`useInvestigation.ts` and `useBriefingStream.ts` both pass `handle` to
`readNdjson`. The handler switches on event type and updates React state
per event:

```ts
// lib/hooks/useInvestigation.ts:98-152 (extract)
const handle = (e: AgentEvent) => {
  switch (e.type) {
    case 'reasoning_step': {
      const it: TraceItem = {
        kind: 'step',
        id: e.step.id,
        agent: e.step.agent,
        stepKind: e.step.kind as 'thought' | 'hypothesis' | 'conclusion',
        content: e.step.content,
        ts: Date.now(),
      };
      cItems.push(it);
      setItems((p) => [...p, it]);
      break;
    }
    case 'tool_call_start': {
      const it: TraceItem = { kind: 'tool', id: crypto.randomUUID(), toolName: e.toolName, status: 'running', ts: Date.now() };
      cItems.push(it);
      setItems((p) => [...p, it]);
      break;
    }
    // ...
  }
};
```

Each event becomes a `setItems((p) => [...p, it])` — React re-renders the
trace, the new line appears with a `bi-fade-up` animation, the user sees
progress. **No virtualization** — the trace stays small enough (tens of
items per investigation) that the cost is negligible.

#### Demo replay re-paces the snapshot

When the route serves a cached snapshot in demo mode, it deliberately
re-introduces delays between events so the reveal feels live instead of
all-at-once:

```ts
// app/api/agent/route.ts:131-137
async start(controller) {
  for (const e of events) {
    if (req.signal.aborted) break;
    controller.enqueue(encoder.encode(encodeEvent(e)));
    await new Promise((r) => setTimeout(r, REPLAY_DELAY_MS));
  }
  controller.close();
},
```

`REPLAY_DELAY_MS = 180` for the agent route, `140` for the briefing route.
This is a **product** decision, not a performance one — the snapshot could
emit all events in microseconds, but the UX of "everything appears at
once" doesn't tell the same story as "the agent is reasoning through it."
The re-pacing makes the demo look like a live run. Same perceived-latency
principle, applied in reverse: artificially *slow down* a too-fast path to
keep the narrative.

#### Cancellation that respects StrictMode

There's a subtle perf-adjacent quirk in `useInvestigation.ts:44-49`: the
hook explicitly does NOT cancel the in-flight fetch on cleanup. React
StrictMode (dev) mounts → cleans up → re-mounts; cancelling on the first
cleanup, with the started-guard blocking the re-mount, would abort the
stream and leave the trace empty. The started-guard prevents the
double-fetch; the in-flight run completes normally.

This isn't a perf optimization in the throughput sense — it's a
correctness fix for the streaming model under StrictMode. Worth noting
because it's a common foot-gun: "cleanup cancels fetch" sounds right and
silently breaks the stream.

### Move 3 — the principle

The principle: **wall-clock and perceived latency are independent variables,
and you should optimize them with different tools.** Wall-clock comes down
when you reduce work or parallelize it; perceived latency comes down when
you put pieces of progress in front of the user as they happen.

A useful test: **for any long-running operation, ask "what could the user
see at the 10% mark that would tell them progress is real?"** If you can
emit something at every meaningful step — a tool name, a reasoning thought,
a partial result — you can sometimes leave the wall-clock alone and just
ship streaming. The shape of the streamed events IS the new product, not a
side channel.

The corollary: **don't fight the wall-clock with parallelism when the
wall-clock is provider-bound.** This codebase deliberately doesn't `Promise.all`
the schema-bootstrap calls (`lib/mcp/schema.ts:194-198`) even though they're
independent — because the spacing gate would queue them at 1.1s apart
anyway, and parallel issuance just risks exceeding the provider's quota.
Streaming each step's progress is the lever that exists; parallelism isn't.

## Primary diagram

```
  NDJSON streaming — full picture

  ┌─ /api/agent or /api/briefing ──────────────────────────────┐
  │                                                            │
  │  new ReadableStream({                                      │
  │    async start(controller) {                               │
  │      const send = (e) => {                                 │
  │        collected.push(e);                                  │
  │        controller.enqueue(encoder.encode(                   │
  │          JSON.stringify(e) + '\n'                          │
  │        ));                                                 │
  │      };                                                    │
  │                                                            │
  │      send('reading the workspace schema…')                 │
  │      schema = await bootstrap(req.signal)        ── 1-3s ──│  emitted
  │      send('coverage gate: 8 of 10 categories runnable')    │  as work
  │                                                            │  happens
  │      for each agent step:                                  │
  │        send(tool_call_start)            ── 0.1s ──         │  …
  │        result = await dataSource.callTool(…)  ── 1-30s ──  │  …
  │        send(tool_call_end + result)     ── 0.1s ──         │  …
  │        send(reasoning_step + thought)                      │  …
  │                                                            │
  │      send(diagnosis)  /  send(recommendation)              │
  │      send('done')                                          │
  │      saveInvestigation(insightId, collected)               │
  │    }                                                       │
  │  })                                                        │
  │                                                            │
  │  Content-Type: application/x-ndjson; charset=utf-8         │
  │  Cache-Control: no-cache, no-transform                     │
  └────────────────────────────────────────┬───────────────────┘
                                           │
                                  TCP / HTTP chunks
                                  (boundaries don't respect events)
                                           │
  ┌─ client (useInvestigation / useBriefingStream) ───────────┐
  │                                                            │
  │  fetch(url).body.getReader()                               │
  │       │                                                    │
  │       ▼                                                    │
  │  readNdjson(body, handle):                                 │
  │    decoder = new TextDecoder()                             │
  │    buf = ''                                                │
  │    while (read):                                           │
  │      buf += decoder.decode(chunk, { stream: true })        │
  │      lines = buf.split('\n')                               │
  │      buf = lines.pop() ?? ''       ← partial-line carry    │
  │      for line in lines:                                    │
  │        try: handle(JSON.parse(line))                       │
  │        catch: onMalformed(line) ← one bad line ≠ crash     │
  │                                                            │
  │  handle(event):                                            │
  │    switch event.type:                                      │
  │      'reasoning_step' → setItems([...p, asStep(event)])    │
  │      'tool_call_start' → setItems([...p, asTool(event)])   │
  │      'tool_call_end'   → setItems(updateRunningTool)       │
  │      …                                                     │
  │                                                            │
  │  React re-renders trace per event                          │
  │  user sees progress at ~1-3s, total wait ~100s             │
  └────────────────────────────────────────────────────────────┘
```

## Elaborate

**Why NDJSON and not Server-Sent Events.** SSE adds framing rules
(`event:`, `data:`, `retry:` line prefixes) and is read by `EventSource`,
which doesn't support `POST` cleanly and gives less control over headers
and errors. NDJSON is the simplest possible streaming format: one JSON
object per line, parsed with `split('\n')`. The application-level type
(`Content-Type: application/x-ndjson`) is the contract; the client picks
between stream-parse and plain-JSON parse based on it
(`useBriefingStream.ts:185-199`).

**Why not WebSockets.** WebSockets are bidirectional and stateful — neither
of which this product needs. Server → client only, request-scoped lifetime,
no reconnect-and-resume semantics. `fetch` + `ReadableStream` is the
minimal primitive that fits.

**The `collected[]` server copy is one of those nice double-uses.** The
events stream live to the client and accumulate server-side. When the
investigation completes (`send({ type: 'done' })`), the server saves the
full `collected[]` array to `saveInvestigation` so the next demo replay
gets the exact same events. No second observability layer needed.

**Phase logs are different.** The per-phase wall-clock numbers
(`app/api/agent/route.ts:215-218` and the `finally` log at `:331-338`)
are emitted to `console.log` only — they're for ops, not the user. The
streaming layer is for the user; the phase log is for you. Two different
audiences, two different channels. Don't mix them.

**The 4000-char truncation matters here.** `app/api/agent/route.ts:97-101`
caps tool results at 4000 characters in the streamed event. Without it,
a chatty tool (large EQL result, full segment dump) could push a single
NDJSON line into multi-megabyte territory — fine on the server, expensive
to JSON-stringify, parse, and render on the client. Truncation at the
event boundary preserves the streaming model.

## Interview defense

**Q: How do you handle a request that takes a long time?**

I separate wall-clock from perceived latency. The investigation flow is
genuinely 100-115 seconds of work — most of it is provider round-trips at
about 1 req/s, which we don't control. So instead of fighting the
wall-clock, we stream the work as it happens: the route opens a
`ReadableStream` and emits NDJSON events for every reasoning step, tool
call start, tool call end with duration, and partial result. The client
reads the stream with `fetch().body.getReader()` plus a line-buffered
parser that handles chunk boundaries and malformed lines without
crashing.

Result: time-to-first-paint of useful content drops to ~1-3 seconds (the
schema bootstrap), and the user watches the agent reason through the
problem for the rest of the time. Same wall-clock, completely different
product.

The kernel that matters: `Content-Type: application/x-ndjson`,
`Cache-Control: no-transform` to stop intermediaries from buffering,
one JSON object per `\n`, partial-line carry on the client. Drop any
one and the stream stops streaming.

```
  Sketch — one tool call's wire shape

  server emits:                                client renders:
  '{"type":"tool_call_start","toolName":"X"}\n' → trace row appears "running"
  // (1-30s of tool work)
  '{"type":"tool_call_end","durationMs":1234}\n' → row updates to "done · 1234ms"
```

Anchor: `app/api/agent/route.ts:183-340` for the stream, `lib/streaming/ndjson.ts`
for the client parser kernel, `lib/hooks/useInvestigation.ts:98-152` for the
React handler.

**Q: What's the load-bearing part most people forget?**

The `no-transform` cache-control header. People focus on `no-cache` (which
matters for browser cache) and forget that intermediaries — proxies, dev
servers, CDNs — will happily buffer your response into a single chunk if
nothing tells them not to. `no-transform` is the line that says "leave
the body alone." Without it, your beautifully streamed events get
delivered as one giant blob at the end, looking identical to a buffered
response on the wire. The bug is invisible until you ship behind a CDN
that buffers.

The other underrated piece is the partial-line carry in the client
parser (`buf = lines.pop()`). TCP chunks don't respect message
boundaries — half an event in one chunk, the rest in the next. Without
the carry, every chunk boundary becomes two malformed half-events.

**Q: Why not WebSockets or SSE?**

SSE adds framing rules I don't need and is read by `EventSource`, which
doesn't `POST` cleanly. WebSockets are bidirectional and stateful — this
product needs neither. `fetch` + `ReadableStream` + NDJSON is the
minimum primitive that fits: server → client only, request-scoped,
inspectable with `curl --no-buffer`.

## See also

- `01-spacing-gate-vs-backpressure.md` — explains why the wall-clock is
  provider-bound: 1.1s minimum between tool calls × ~10 calls per
  investigation = the irreducible floor that streaming makes tolerable.
- `00-overview.md` — the budget map: 300s route ceiling, 100-115s typical,
  and why we don't try to make the wall-clock smaller.
- `../study-system-design/` — the broader streaming-vs-batched architecture
  decision and how it shapes the demo/live split.
- `../study-runtime-systems/` — `ReadableStream`, `TextDecoder`, the event
  loop's interaction with `controller.enqueue` backpressure.
- `../study-debugging-observability/` — the `phases[]` summary log is a
  parallel observability channel; this file covers the user-facing channel.
