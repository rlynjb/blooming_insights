# 01 · NDJSON live trace

*Event stream / newline-delimited JSON wire-format — **industry standard***

## Zoom out — where this concept lives

The NDJSON trace is the observable surface between server and browser.
Every event the agent produces — "I'm thinking about X," "I called
tool Y and got Z," "here's the diagnosis" — is one JSON object on
one line, streamed as it happens.

```
  Zoom out — the NDJSON trace's seat in the stack

  ┌─ UI layer ──────────────────────────────────────────────┐
  │  StatusLog / ReasoningTrace / ToolCallBlock              │
  │  render TraceItem[] from a ReadableStream               │
  └─────────────────────────┬───────────────────────────────┘
                            │  hop: fetch() body
                            │  content-type: application/x-ndjson
  ┌─ Streaming boundary ────▼───────────────────────────────┐
  │  ★ AgentEvent NDJSON ★  ← we are here                   │
  │  the wire; one event per line; encodeEvent / readNdjson │
  └─────────────────────────┬───────────────────────────────┘
                            │  producer writes events into
                            │  a ReadableStream inside a route
  ┌─ Service layer ─────────▼───────────────────────────────┐
  │  /api/briefing/route.ts, /api/agent/route.ts             │
  │  MonitoringAgent / DiagnosticAgent / RecommendationAgent│
  └─────────────────────────┬───────────────────────────────┘
                            │
  ┌─ Provider layer ────────▼───────────────────────────────┐
  │  Anthropic SDK · MCP transport · aptkit trace sink       │
  └──────────────────────────────────────────────────────────┘
```

Zoom in — this is what the product ships. The pitch is "an analyst
that shows its work"; the NDJSON trace *is* the work. Break the wire
format and the UI has nothing to render.

## Structure pass — the skeleton

**Axis held constant: who owns each event's payload?**

| Layer | Who decides | What the layer sees |
|---|---|---|
| aptkit trace sink | aptkit internals | `CapabilityEvent` (11 variants incl. `model_usage`) |
| Blooming adapter | route handler | `AgentEvent` (8 variants) + `BriefingEvent` extras |
| Wire | producer | one JSON object per line, terminated `\n` |
| UI reader | consumer | reduced into `TraceItem[]` shape |

**Seams — where the axis flips:**

  → seam 1 — **the trace sink** (`aptkit-adapters.ts:139`) flips
    `CapabilityEvent` → `AgentEvent`. Payload shape changes, per-event
    routing decisions live here.
  → seam 2 — **the wire** (`events.ts:17`). Producer type is
    `AgentEvent`; reader sees `unknown` and validates by
    `type` discriminator. The braces of the type union are on
    the SERVER side; the browser gets bytes.
  → seam 3 — **the UI reduction** (`hooks/useBriefingStream.ts:250-
    290`) flips `AgentEvent` → `TraceItem` — a *display* shape
    with timestamps and a status field the wire doesn't carry.

**Layers, one dimension held:** who terminates an event's lifetime?
At aptkit → whoever consumes `CapabilityEvent`. At the wire → the
producer `enqueue()`s and moves on. At the UI → the reducer keeps
the event in state until the component unmounts. Each layer owns
its own event lifetime; no layer waits on another to acknowledge.

## How it works

### Move 1 — the mental model

You've used `fetch().then(r => r.json())` a thousand times. This is
the streaming cousin: `fetch().then(r => r.body.getReader())`, then
read chunks, split on `\n`, `JSON.parse` each line. Every line is a
complete event, and the reader can start rendering as soon as the
first line arrives — no waiting for the whole response.

The pattern is **line-delimited event stream** — the same shape as
Server-Sent Events, minus SSE's `event:` / `data:` framing. NDJSON
picks one convention (`\n` between JSON documents) and calls it a
day.

```
  The pattern — the wire is a stream of complete lines

  server                                            browser

  emit({type:'reasoning_step',...}) ──┐
  emit({type:'tool_call_start',...})  │
  emit({type:'tool_call_end',...})    ├──► ReadableStream (network)
  emit({type:'insight',...})          │
  emit({type:'done'})                 ┘
                                                    │
                                                    ▼
                                       readNdjson(body, onEvent)
                                          │
                                          ├─► split on '\n'
                                          ├─► JSON.parse each line
                                          └─► onEvent(evt)
                                                    │
                                                    ▼
                                              TraceItem[] state
                                              → renders live
```

### Move 2 — the step-by-step walkthrough

The mechanism has four moving parts, in order along the stream.

**Part 1 — the type union that shapes every event.**

`AgentEvent` (`lib/mcp/events.ts:5-14`) is a
discriminated union with 8 variants. The discriminator is `type`, and
every variant carries exactly the fields it needs — no optional
kitchen-sink object.

```typescript
// lib/mcp/events.ts:5-14
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
```

Why it matters: **the type union is the wire contract.** Adding a
new event variant is a two-side change (producer emits + consumer
switches). Removing a variant breaks the UI reducer's exhaustiveness
check. This is the "AgentEvent NDJSON contract" line in AGENTS.md
under "what must not change."

The briefing route extends the union locally (`briefing/route.ts:55-59`)
with `workspace`, `coverage_item`, `coverage` — kept LOCAL to that
route so the shared contract doesn't grow. That local extension is
one of the cleanest observability-hygiene moves in the repo: don't
pollute the wire everyone reads.

**Part 2 — encoding: `JSON.stringify(evt) + '\n'`.**

The encoder is one line. It's at `lib/mcp/events.ts:17`:

```typescript
export function encodeEvent(e: AgentEvent): string {
  return JSON.stringify(e) + '\n';
}
```

**What breaks if the `+ '\n'` is missed:** the reader's `split('\n')`
merges two events into one line, and both events fail to parse. The
`readNdjson` kernel's trailing-buffer flush would eventually catch
the last one, but every non-terminal event would be lost. This is
why the kernel comment (`lib/streaming/ndjson.ts:9-12`) explicitly
says "producers always terminate each event with '\n'" — it's a
producer-side contract.

**Part 3 — the reader kernel (`readNdjson`, 64 LOC).**

This is the load-bearing skeleton. Isolate it and the pattern is:

```
  skeleton — readNdjson (the kernel that makes NDJSON work)

  reader = body.getReader()
  decoder = new TextDecoder()
  buf = ''

  loop:
    ┌─────────────────────────────────────────────┐
    │ if cancelOn(): reader.cancel(); return      │  ← without this,
    │                                             │    unmounted consumers
    │ { value, done } = reader.read()             │    keep pulling bytes
    │ if done: break                              │
    │                                             │
    │ buf += decoder.decode(value, {stream:true}) │  ← without stream:true,
    │                                             │    multi-byte chars
    │                                             │    split across chunks
    │                                             │    become garbage
    │                                             │
    │ lines = buf.split('\n')                     │
    │ buf   = lines.pop() ?? ''                   │  ← the last piece is
    │                                             │    the INCOMPLETE tail
    │                                             │    of the next event
    │                                             │
    │ for each line: JSON.parse → onEvent         │
    └─────────────────────────────────────────────┘

  after loop:
    if buf.trim(): JSON.parse tail  ← flush the trailing buffer;
                                       no-op when producers always
                                       terminate with '\n'
```

Every part of that skeleton exists because SOMETHING would break
without it:

  → **`cancelOn()` polling** — without it, an unmounted React
    component with an in-flight NDJSON reader keeps pulling bytes
    until the server closes the stream. On slow networks this stalls
    the tab.
  → **`decoder.decode(value, {stream: true})`** — the `stream: true`
    flag tells the decoder to hold incomplete multi-byte UTF-8
    sequences across `read()` calls. Drop it and any emoji or non-
    ASCII scope name mid-buffer becomes garbage.
  → **`buf = lines.pop() ?? ''`** — after splitting on `\n`, the LAST
    piece is either an empty string (if the buffer ended on `\n`) or
    the INCOMPLETE tail of the next event. `pop()` pulls it out of
    the "process now" list back into the buffer for the next `read()`.
  → **Trailing-buffer flush after `break`** — belt-and-braces. If
    the producer ever forgets the terminal `\n`, the last event is
    still recoverable.

Real code, `lib/streaming/ndjson.ts:22-63`:

```typescript
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
    // flush trailing buffer — a no-op when the producer always
    // terminates with '\n'
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

The `onMalformed?` hook exists for exactly the observability question
this file cares about: **"a line failed to parse — do you want to
know?"** Default is silent (comment at `ndjson.ts:24-25`) because a
production consumer facing a single garbled line shouldn't blow up
the whole session; but a debug consumer can pass `console.warn` and
see every parse failure.

**Part 4 — the producer side (routes).**

The two streaming routes use the same shape. From `briefing/route.ts:182-186`:

```typescript
const stream = new ReadableStream<Uint8Array>({
  async start(controller) {
    const send = (e: BriefingEvent) =>
      controller.enqueue(encoder.encode(JSON.stringify(e) + '\n'));
    const step = (content: string) =>
      send({ type: 'reasoning_step',
             step: { id: crypto.randomUUID(), agent: 'monitoring',
                     kind: 'thought', content } });
    // ... phases + agent.scan + final `done`
  }
});

return new Response(stream, {
  headers: {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store, no-transform',
  },
});
```

**Why `no-store, no-transform`:** Vercel edge + browser HTTP caches
would otherwise happily buffer a "text-y" streaming body waiting for
"more" before flushing. The `no-transform` piece specifically blocks
gzip middleware from re-chunking the stream and holding events
back — the debugging story ("live streaming reasoning") depends on
each event arriving as it's emitted.

### Move 2 layers-and-hops — one event's journey

```
  A single tool_call_end event, wire→UI

  ┌─ aptkit ────────┐ CapabilityEvent
  │  agent loop     │ {type:'tool_call_end',toolName,durationMs,
  │                 │  result,error,timestamp}
  └────────┬────────┘
           │  hop 1: BloomingTraceSinkAdapter.emit()
           │          → this.hooks.onCapabilityEvent?.(event)
           │          → this.hooks.onToolResult?.(toolCall)
           ▼
  ┌─ route handler ─┐  onToolResult(tc) →
  │  send(e)        │    send({type:'tool_call_end',
  │                 │           toolName, agent,
  │                 │           durationMs: tc.durationMs ?? 0,
  │                 │           result: trunc(tc.result),
  │                 │           error: tc.error})
  └────────┬────────┘
           │  hop 2: JSON.stringify(e) + '\n'
           │          controller.enqueue(bytes)
           ▼
  ┌─ ReadableStream ┐  bytes queued
  └────────┬────────┘
           │  hop 3: HTTP chunked body
           │          content-type: application/x-ndjson
           ▼
  ┌─ browser fetch ─┐  res.body.getReader() → Uint8Array
  └────────┬────────┘
           │  hop 4: readNdjson kernel
           │          decode → split '\n' → JSON.parse
           ▼
  ┌─ useBriefing ───┐  onEvent(evt)
  │  Stream         │  case 'tool_call_end':
  │                 │    setTrace(t => t.map(row =>
  │                 │      row.id === tc.id
  │                 │        ? {...row, status:'done', durationMs, result}
  │                 │        : row))
  └────────┬────────┘
           │  hop 5: React re-render
           ▼
  ┌─ ToolCallBlock ─┐  status dot flips green,
  │                 │  duration label paints
  └─────────────────┘
```

Note the **`trunc(tc.result)` at hop 1**: the wire caps result bodies
at 4000 chars (`briefing/route.ts:73-77`, `agent/route.ts:99-103`).
This is deliberate — a 200KB EQL result would blow the browser reader's
buffer and freeze the tab. It's also a debugging seam: if you're
investigating a "tool returned bad data" bug from the wire, you're
seeing at most the first 4KB. The eval receipt has the same cap
(`run.eval.ts:135-136`). The full untruncated result is only ever in
memory at the aptkit boundary.

### Move 3 — the principle

**Make the wire the debugger.** If your product's job is to show
its work, the debug format and the presentation format should be the
same format. Every UI render is a replay of a wire that persists as
JSON — so any bug in the presentation can be reproduced by piping
the wire to a file. Any bug in the reasoning can be reproduced by
piping a saved wire back to the UI. The producer-consumer pair is
symmetric across dev and prod.

## Primary diagram

```
  NDJSON live trace — full loop

  ┌─────────────────────────────────────────────────────────────┐
  │ SERVER                                                       │
  │                                                              │
  │  route.ts (briefing or agent)                                │
  │    ┌───────────────────────────────────────────────┐         │
  │    │ agent.scan / .investigate / .propose          │         │
  │    │   │                                            │         │
  │    │   ▼ hooks: onText, onToolCall, onToolResult   │         │
  │    │ send(e: AgentEvent)                            │         │
  │    │   │                                            │         │
  │    │   ▼ encodeEvent = JSON.stringify(e) + '\n'     │         │
  │    │ controller.enqueue(bytes)                      │         │
  │    └───────────────────────┬───────────────────────┘         │
  │                            │                                 │
  │                     ReadableStream<Uint8Array>               │
  └─────────────────────────────┬───────────────────────────────┘
                                │
                     HTTP chunked body
             content-type: application/x-ndjson
              cache-control: no-store, no-transform
                                │
  ┌─────────────────────────────▼───────────────────────────────┐
  │ BROWSER                                                      │
  │                                                              │
  │  useBriefingStream / useInvestigation                        │
  │    ┌───────────────────────────────────────────────┐         │
  │    │ res.body.getReader()                          │         │
  │    │   │                                            │         │
  │    │   ▼                                            │         │
  │    │ readNdjson(body, onEvent, {cancelOn})          │         │
  │    │   │                                            │         │
  │    │   ▼ switch(evt.type)                           │         │
  │    │     case 'reasoning_step': append TraceItem    │         │
  │    │     case 'tool_call_start': append TraceItem   │         │
  │    │     case 'tool_call_end': patch matching row   │         │
  │    │     case 'insight': append InsightCard         │         │
  │    │     case 'error': setStatus('error')           │         │
  │    │     case 'done': setStatus('loaded')           │         │
  │    └───────────────────────┬───────────────────────┘         │
  │                            │                                 │
  │                        TraceItem[] state                     │
  │                            │                                 │
  │                            ▼                                 │
  │           StatusLog → ReasoningTrace → ToolCallBlock         │
  └──────────────────────────────────────────────────────────────┘
```

## Elaborate

**Where this pattern comes from.** NDJSON has been "the boring
answer" for line-delimited event streams since jsonl.org codified
it in 2010, and it predates Server-Sent Events in some usage patterns.
It's what `docker logs`, `kubectl get -w`, and every "structured log
line" pipeline you've touched already speaks. blooming picks it over
SSE because (1) it's plain `fetch()` on the client — no `EventSource`,
no auto-reconnect surprise, (2) the format survives being piped to a
file and re-read as-is, and (3) it composes with the request-lifetime
`AbortSignal` naturally.

**Cousins that solve the same problem differently.**

  → **SSE** — same wire shape plus `event:` framing and browser-native
    reconnect. blooming would need to fight `EventSource`'s auto-
    retry on the alpha-server's revoked-token 401.
  → **WebSockets** — bidirectional. Overkill; this stream is one-way
    server→client only.
  → **gRPC server-streaming** — heavier stack, harder to pipe to a
    file, and Next.js edge runtime doesn't play nicely with it.

**Adjacent debugging patterns in this repo:** the phase log
(`02-per-phase-request-summary.md`) is the "what happened between
first line and last line" complement to the wire. Together they tell
you WHERE latency lives (the phase log) and WHY (the wire).

## Interview defense

**Q1 · "What's the load-bearing part of an NDJSON reader
implementation people forget?"**

**Model answer.** The trailing-buffer restore after `split('\n')`.
When you `buf.split('\n')`, the LAST element is either an empty
string (buffer ended on newline) or the INCOMPLETE tail of the next
event. If you process all N elements in the array, you either try
to `JSON.parse('')` or you mangle the next event. The fix is one
line — `buf = lines.pop() ?? ''` — and it's the piece that turns a
chunk-oriented reader into a line-oriented reader. Anchor:
`lib/streaming/ndjson.ts:43`.

```
  Why the trailing-buffer restore matters

  chunk 1: '{"a":1}\n{"b":2'      (event 2 incomplete)
  chunk 2: '}\n{"c":3}\n'

  after chunk 1, naive:
    lines = ['{"a":1}', '{"b":2']
    → JSON.parse('{"b":2') THROWS

  after chunk 1, kernel:
    lines = ['{"a":1}', '{"b":2']
    buf   = lines.pop() = '{"b":2'
    → parse only '{"a":1}'; hold the rest

  after chunk 2:
    buf = '{"b":2' + '}\n{"c":3}\n' = '{"b":2}\n{"c":3}\n'
    lines = ['{"b":2}', '{"c":3}', '']
    buf   = lines.pop() = ''
    → parse '{"b":2}' and '{"c":3}'
```

**Q2 · "You have a bug where the UI shows a stale reasoning step.
How do you locate the failure?"**

**Model answer.** The wire is the source of truth. First save
`curl -s ... > trace.ndjson` and grep for the offending line — is
the wire correct? If yes, the bug is in the reducer (the switch on
`evt.type` in `useBriefingStream.ts:250-290`) or in React state
handling. If the wire is wrong, walk upstream: check
`BloomingTraceSinkAdapter.emit()` (`aptkit-adapters.ts:143-174`) —
does it forward the right event? Check the aptkit trace sink — did
the underlying agent emit the CapabilityEvent you expected? The
wire is the seam between "reasoning bug" and "UI bug." Anchor: the
`readNdjson` + `AgentEvent` pair.

**Q3 · "Why NDJSON over Server-Sent Events?"**

**Model answer.** SSE has an ergonomic browser API (`EventSource`)
but two disadvantages for this system: (1) `EventSource`'s auto-
reconnect on failure fights the alpha-server revoked-token flow — we
have to manually reset auth and reload, and SSE's built-in retry
would keep firing 401s. NDJSON with `fetch()` is under our full
control. (2) The wire format is line-delimited JSON, no `event:` /
`data:` framing — so you can pipe the wire to a file and read it
back with the same reader, no format changes. That symmetry is the
whole debugging story: replay the wire, get the same UI.

## See also

- `02-per-phase-request-summary.md` — the "what happened between
  events" complement
- `03-capability-trace-receipts.md` — how the wire (plus the
  underlying aptkit events) becomes a receipt
