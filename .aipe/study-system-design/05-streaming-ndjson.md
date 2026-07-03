# 05 — Streaming NDJSON

**Industry name:** newline-delimited JSON event stream over HTTP `ReadableStream`. *Type: Industry standard.*

## Zoom out, then zoom in

The product's pitch is "an analyst that shows its work" — every
reasoning step, every tool call, every intermediate result
streams to the UI as it happens. The transport is Newline-
Delimited JSON (NDJSON) over a plain `ReadableStream`. No
Server-Sent Events, no WebSocket, no long-poll. One kernel on
the client parses every stream; one discriminated union
(`AgentEvent`) is the contract on the wire.

```
  Zoom out — where streaming NDJSON sits

  ┌─ UI layer ──────────────────────────────────────────────┐
  │  useBriefingStream · useInvestigation · capture handler │
  │  QueryBox chat surface                                  │
  │     ↑                                                   │
  │     │  readNdjson kernel dispatches to event handler    │
  └─────┼───────────────────────────────────────────────────┘
        │  application/x-ndjson · chunked transfer
  ┌─ Service layer ─────────────────────────────────────────┐
  │  /api/briefing · /api/agent · /api/mcp/capture           │
  │  emit line-by-line via ReadableStream.enqueue           │
  └─────────────────────────────────────────────────────────┘
```

**Zoom in.** The pattern is a producer/consumer contract on a
byte stream. One producer shape (`encodeEvent(e) = JSON + '\n'`),
one consumer kernel (`readNdjson`), one event union
(`AgentEvent`). Four different UI consumers and four different
route producers all use the same three pieces.

## Structure pass

Two layers (producer / consumer), one axis: **what does each
side own about the frame boundary?**

```
  Axis "who owns the frame boundary?" — trace it across the wire

  ┌─ Producer (route handler) ────────────────────────────┐
  │ owns:  encodeEvent(e) = JSON.stringify(e) + '\n'      │
  │        commit-to-stream boundary (no send before)     │
  │        terminal {type:'done'} or {type:'error'}       │
  └──────────────────────┬────────────────────────────────┘
                         │  seam: bytes on the wire,
                         │  buffered, chunked, terminated by '\n'
  ┌─ Consumer (client) ──▼────────────────────────────────┐
  │ owns:  TextDecoder({stream:true}) buffering           │
  │        split('\n'), pop() trailing partial, JSON.parse│
  │        cancelOn poll to break out on unmount          │
  │        malformed-line skip (silent by default)        │
  └───────────────────────────────────────────────────────┘
```

The seam is the `\n` byte. Above it, the producer terminates
every event with a newline. Below it, the consumer buffers on
chunk boundaries and only parses complete lines. This is a
tiny contract — a single byte — but it's what makes the whole
thing tractable.

## How it works

### Move 1 — the mental model

You've done `for await (const chunk of response.body)` and had
to handle a chunk that ended mid-JSON. Same problem, cleanly
solved with a delimiter. The producer promises "every event
ends with `\n`"; the consumer buffers and splits. Anything
between newlines is one complete event.

```
  Pattern — one kernel, N handlers

              ┌─ ReadableStream ─┐
              │  bytes ── \n ──  │
              │  bytes ── \n ──  │
              │  bytes  (partial)│  ← stays in buffer
              └────────┬─────────┘
                       │
                       ▼
              ┌─ readNdjson kernel ─┐
              │  decode, buffer,    │
              │  split('\n'),       │
              │  parse each line    │
              └────────┬────────────┘
                       │  onEvent(event)
              ┌────────┼────────────┐
              ▼        ▼            ▼
          feed hook  investigation  capture
          (updates    (streams the  (persists to
           anomaly    trace to      demo snapshot)
           cards)     StatusLog)
```

### Move 2 — step by step

**Part 1: the producer's shape.** One helper — six lines —
encodes every event.

```ts
// lib/mcp/events.ts:1-22
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

The union is discriminated by `type`. Every downstream branch
narrows on it. Adding a new event shape means one line in the
union and one handler branch on every consumer.

Inside a route handler, the producer looks like:

```ts
// app/api/briefing/route.ts:196-199  (skeleton)
const encoder = new TextEncoder();
const stream = new ReadableStream<Uint8Array>({
  async start(controller) {
    const send = (e: BriefingEvent) =>
      controller.enqueue(encoder.encode(JSON.stringify(e) + '\n'));
    // ... send(step), send(insight), ... , send({type:'done'})
  }
});
```

`send` closes over `controller` and stringifies-plus-terminates
per call. Backpressure is Node's job; the route doesn't manage
it explicitly.

**Part 2: the consumer kernel — `readNdjson`.** One function,
four callers. The load-bearing skeleton in ~30 lines:

```ts
// lib/streaming/ndjson.ts:17-64
export async function readNdjson<E>(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: E) => void,
  opts?: { cancelOn?: () => boolean; onMalformed?: (line: string, err: unknown) => void },
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      if (opts?.cancelOn?.()) { await reader.cancel(); return; }
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';               // ← trailing partial stays
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        try { onEvent(JSON.parse(line) as E); }
        catch (err) { opts?.onMalformed?.(line, err); }
      }
    }
    // flush trailing buffer — no-op when producer always terminates with '\n'
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

### Move 2 variant — the load-bearing skeleton

Strip the kernel to the minimum that still IS the pattern:

1. **Reader + decoder + buffer.** Reader owns byte pulls;
   decoder owns UTF-8 stateful decoding across chunks; buffer
   owns "leftover text after the last newline."
2. **Split on `\n`, pop the tail.** `split()` gives you N+1
   pieces where N is the number of newlines; `pop()` moves the
   last piece (partial or empty) back to the buffer for the
   next round.
3. **Parse each complete line.** Skip blanks (idle keepalive
   chunks); catch parse errors per-line (don't let one bad line
   kill the stream).
4. **Flush the tail at end-of-stream.** If the producer forgot
   to terminate the last event, the trailing buffer holds it.
5. **Cancel-on-signal.** Poll `cancelOn()` between reads so an
   unmounted React component can break out cleanly.

What breaks if any part is missing:

- Drop the `stream: true` on `TextDecoder.decode` → multi-byte
  UTF-8 characters that straddle a chunk boundary get corrupted.
- Drop the trailing-buffer flush → a producer that omits the
  final newline loses its last event silently.
- Drop the per-line try/catch → one malformed line kills the
  reader, and every subsequent event is lost.
- Drop the `cancelOn` poll → an unmounted component keeps the
  reader alive, holding the fetch open, wasting the MCP quota.

Optional hardening, none of it the kernel:

- The `onMalformed` callback for observability.
- `releaseLock()` in a `finally` (belt-and-suspenders on
  cancel).

**Part 3: four consumers, one kernel.**

```
  Layers-and-hops — one kernel, four callers

  ┌─ producers ──────────┐
  │ /api/briefing        │
  │ /api/agent           │
  │ /api/mcp/capture     │
  │ query streaming      │
  └──────────┬───────────┘
             │  application/x-ndjson
             ▼
  ┌─ readNdjson kernel ──┐
  │  same 30 lines       │
  │  for all consumers   │
  └──────────┬───────────┘
             │
    ┌────────┼────────────────────────┐
    ▼        ▼          ▼             ▼
  feed    investigation capture   chat surface
  hook    hook          handler   (QueryBox +
                                   StreamingResponse)
```

Every consumer's `onEvent` is a `switch (event.type)` block.
The feed hook cares about `insight` and `workspace`; the
investigation hook cares about `reasoning_step` and
`diagnosis` / `recommendation`; the capture handler stashes
raw events into a JSON payload for the committed snapshot.

**Part 4: cancellation is honest.** The `cancelOn` poll in
`useInvestigation` returns `true` when the hook has been
unmounted long enough that we're sure it's not a StrictMode
double-mount (this is the "stashes result in sessionStorage
so step 3 hydrates instantly; survives StrictMode by NOT
cancelling in-flight fetch on cleanup" behavior called out in
the project context). The kernel calls `reader.cancel()` on
the ReadableStream, which propagates back through fetch and
tears down the underlying HTTP request.

### Move 3 — the principle

Streaming protocols pay for themselves when the client can act
on partial state. NDJSON is the plainest form: any stack that
can do HTTP chunked transfer can produce it; any client that
can read bytes can consume it. When your product's UX depends
on showing work-in-progress, NDJSON is almost always a better
default than SSE or WebSocket — no framing headers, no
handshake, and one plain function on each side. The
temptation is to reach for `EventSource` because it's designed
for streaming; the reason not to is that `EventSource` doesn't
support `POST` bodies, and everything else it gives you (auto-
reconnect, retry ID) you either don't want or can build.

## Primary diagram

```
  NDJSON streaming — recap end to end

  ┌─ Route handler ─────────────────────────────────────┐
  │  const stream = new ReadableStream({                │
  │    async start(controller) {                        │
  │      const send = (e) =>                            │
  │        controller.enqueue(encoder.encode(           │
  │          JSON.stringify(e) + '\n'));                │
  │      send({type:'reasoning_step',...});             │
  │      send({type:'tool_call_start',...});            │
  │      send({type:'tool_call_end',...});              │
  │      send({type:'insight',...});                    │
  │      send({type:'done'});                           │
  │    }                                                │
  │  });                                                │
  │  return new Response(stream, { headers: {           │
  │    'content-type': 'application/x-ndjson' } });     │
  └────────────────────┬────────────────────────────────┘
                       │  chunked HTTP · terminated per '\n'
  ┌─ Browser fetch ────▼────────────────────────────────┐
  │  const res = await fetch(url, {                     │
  │    signal, headers: { [BI_MCP_CONFIG_HEADER]: ...}  │
  │  });                                                │
  │  await readNdjson(res.body, (event) => {            │
  │    switch (event.type) {                            │
  │      case 'reasoning_step': setTrace(...); break;   │
  │      case 'insight':        setInsights(...); break;│
  │      case 'done':           setDone(true); break;   │
  │      case 'error':          setError(...); break;   │
  │    }                                                │
  │  }, { cancelOn: () => cancelled.current });         │
  └─────────────────────────────────────────────────────┘
```

## Elaborate

NDJSON is a specification about as long as this paragraph:
"one JSON value per line, `\n` terminated, no wrapping array."
It's used everywhere — Elasticsearch's `_bulk` API, `docker
logs --format=json`, the JSON Lines format for ML datasets,
OpenAI's `stream: true` for chat completions (they use SSE-
wrapped JSON, but same idea).

The interesting failure mode this kernel handles cleanly is
UTF-8 chunk-boundary straddle. `TextDecoder` with `{ stream:
true }` maintains state across `.decode()` calls, so a 3-byte
character split across two chunks decodes correctly. Drop the
`stream: true` and you get replacement characters on the
boundary.

Where you'd reach for something else: (1) binary payloads (use
CBOR or MessagePack instead), (2) bidirectional streaming (use
WebSocket), (3) auto-reconnect with resume semantics (use SSE
with `retry:` and `id:`).

## Interview defense

**Q: Why NDJSON over SSE?**

A: Three reasons. First, SSE doesn't support `POST` bodies —
this app's streaming endpoints take non-trivial input, so
`EventSource` is out. Second, SSE's auto-reconnect isn't
useful when the tokens can revoke mid-stream (an in-band retry
would re-authorize, which SSE doesn't help with anyway).
Third, NDJSON is one function of framing on each side; SSE is
a whole event-source protocol for the same job.

**Q: What's the one part everyone forgets in the reader loop?**

A: The trailing buffer flush at end-of-stream. If the producer
ever forgets the final `\n`, everything after the last newline
stays in `buf` and never gets parsed. The flush after the
loop is the safety net. It's a no-op with disciplined
producers, but the discipline isn't enforced anywhere — one
buggy producer and you lose the last event silently.

**Q: How does cancellation actually reach the MCP server?**

A: The React hook holds an `AbortController`; its signal is
passed to `fetch(url, { signal })`. When the component unmounts
(with the cancel guard passed), the hook calls `abort()`. That
aborts the fetch, which cancels the underlying HTTP request,
which the Next route sees via `req.signal.aborted`. The route
handler was already threading `req.signal` into
`dataSource.callTool({ signal })`, which threads it into the
MCP transport's `fetch`. Cancellation propagates end-to-end.

**Q: Why is malformed-line handling silent by default?**

A: Because a producer bug is worth logging, but a corrupt
network chunk shouldn't kill the whole stream. The default
skips the line and continues; consumers that want observability
pass an `onMalformed` callback. Fail-quiet as a default, but
observable if you want it.

## See also

- `01-request-flow.md` — the wider request path this stream
  rides on
- `04-aptkit-agent-primitive-boundary.md` — where AptKit's
  `CapabilityEvent` gets translated into `AgentEvent` NDJSON
- `07-demo-replay-as-reliability.md` — the capture handler is
  a consumer of the same kernel
