# 04 — Progressive NDJSON stream

Time-to-first-event decoupled from time-to-completion · Industry standard (NDJSON / SSE family) · Project-specific shape

## Zoom out — where this pattern lives

A live investigation takes ~100 seconds of wall-clock. If the user has to stare at a spinner for ~100s, the product feels broken even when it's working. The pattern this file teaches: stream the agent's progress as it happens, so time-to-first-event is hundreds of milliseconds while total runtime stays at ~100s. **Perceived performance** is the win, not total throughput.

```
  Zoom out — perceived perf, not actual perf

  ┌─ UI ──────────────────────────────────────────────────────────────┐
  │  page → fetch() → reader.read() loop                                │
  │  ★ first render at ~100ms ★ ← we are here (perceived perf)         │
  │  trace lines stream in as they happen                               │
  │  final answer arrives at ~100s                                      │
  └────────────────────────────────┬──────────────────────────────────┘
                                   │  HTTP (streaming response body)
  ┌─ Vercel route ─────────────────▼──────────────────────────────────┐
  │  app/api/agent/route.ts (or /briefing)                             │
  │  ReadableStream — emits AgentEvent NDJSON as the agent works        │
  └────────────────────────────────────────────────────────────────────┘
```

The mechanism is plain: a `ReadableStream` body, NDJSON-encoded events, one event per `\n`-terminated line, parsed on the client by a shared `readNdjson` kernel.

## Structure pass — layers, axis, seams

**Layers:**
- Producer — route handler emitting `AgentEvent` NDJSON
- Wire — HTTP streaming response body
- Consumer — `readNdjson` (reader + decoder + split + dispatch)
- React state — hooks that translate events into renderable state

**The axis: when does the user see something?** Trace it down the stack:

```
  Tracing "when does the user see the first signal?" across the layers

  ┌─ Producer ──────────────────────────────────────────────┐
  │  ★ on EVERY agent step, fires send(event)                │   the producer
  │    → controller.enqueue(...)                             │   commits to
  │    → bytes leave the function NOW, not at end            │   immediate emit
  └─────────────────────────────────────────────────────────┘
       ┌─────────────────────────────────────────────────────┐
       │ Wire                                                 │   the wire just
       │  HTTP body is chunked — bytes flow as enqueued       │   carries it
       └─────────────────────────────────────────────────────┘
            ┌────────────────────────────────────────────────┐
            │ Consumer                                        │   the consumer
            │  reader.read() returns whatever arrived         │   reads as it
            │  even if mid-event                              │   arrives
            └────────────────────────────────────────────────┘
                 ┌──────────────────────────────────────────┐
                 │ React state                               │  React renders
                 │  setState per dispatched event            │   each new state
                 └──────────────────────────────────────────┘
```

The seam between **producer** and **wire** is the load-bearing one. If the producer accumulates into an array and emits at the end (the standard non-streaming pattern), no amount of clever client code can recover the lost time-to-first-event. The streaming response body — `new Response(stream, ...)` with the stream still being written — is the architectural choice that enables everything below it.

## How it works

### Move 1 — the mental model

You know how `console.log` works in a long-running script: each line appears as it's logged, not all at once at the end. NDJSON streaming is the same shape over HTTP — each event line appears at the client as it's enqueued at the server. The whole pattern is just "write a `\n` after every event and don't wait to flush."

```
  NDJSON stream — the kernel

  Producer side:
    for each event in stream_of_events:
      controller.enqueue(encode(JSON.stringify(event) + '\n'))
      // continue working — bytes are already on the wire

  Wire:
    Content-Type: application/x-ndjson; charset=utf-8
    Cache-Control: no-cache, no-transform
    body: ────event1\n────event2\n──event3\n──...──

  Consumer side:
    reader = body.getReader()
    buf = ''
    while not done:
      buf += decode(read())
      lines = buf.split('\n')
      buf = lines.pop()                  ← incomplete trailing line
      for each complete line:
        dispatch(JSON.parse(line))
```

The "split on `\n` and keep the tail" is the entire trick. NDJSON is designed for the case where a network read can return half an event — the consumer just keeps the incomplete trailing line in a buffer and stitches it onto the next read.

### Move 2 — step by step

**The producer — `ReadableStream` constructor with `start(controller)`**

The route handler returns a `Response` whose body is a `ReadableStream`. The stream's `start(controller)` runs the agent work and calls `controller.enqueue(...)` for every event.

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
    // ... agent work below, calling `send(...)` as it progresses
```

Two things to notice:
1. `send(...)` enqueues IMMEDIATELY — the encoded bytes leave the function on the next event loop tick, not at the end of the agent's run.
2. `collected.push(e)` keeps a parallel array. That's so `saveInvestigation(insightId, collected)` at line 302 can persist the whole stream for the demo capture path. The wire stream and the persisted snapshot are the same events.

**The encoder — `encodeEvent`**

One newline per event. The contract:

```ts
// lib/mcp/events.ts (referenced by both routes)
// encodeEvent(e) → `${JSON.stringify(e)}\n`
```

The trailing `\n` is what lets the consumer split cleanly. Forget it and the consumer's buffer would never produce a complete line.

**The headers — telling intermediaries this is a stream**

```ts
// app/api/agent/route.ts:105-108
const NDJSON_HEADERS = {
  'Content-Type': 'application/x-ndjson; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
};
```

`no-transform` is the load-bearing header. Without it, an intermediate proxy might buffer the response and gzip the whole body, defeating the streaming entirely. `no-cache` tells browser caches not to store the stream. `Content-Type: application/x-ndjson` is the convention — `application/json` would be wrong because the body is not a single JSON value.

**The consumer — `readNdjson` kernel**

One reader loop, shared by every client surface (briefing, investigation, demo capture, chat). Lives at `lib/streaming/ndjson.ts`:

```ts
// lib/streaming/ndjson.ts:18-58
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
      try {
        onEvent(JSON.parse(tail) as E);
      } catch (err) {
        opts?.onMalformed?.(tail, err);
      }
    }
  } finally {
    reader.releaseLock?.();
  }
}
```

Three load-bearing details:

1. **`decoder.decode(value, { stream: true })`** — the `stream: true` flag tells `TextDecoder` to hold incomplete multi-byte UTF-8 sequences across calls. Without it, a chunk that splits a multi-byte codepoint would corrupt the buffer. UTF-8 safety as a one-flag move.

2. **`lines = buf.split('\n'); buf = lines.pop()`** — the canonical "split on `\n`, keep the incomplete tail" idiom. After `split`, the last element is whatever came after the final `\n` (empty string if the chunk ended with `\n`, otherwise the partial line). Pop it back into `buf` and process only the complete lines.

3. **`if (opts?.cancelOn?.())`** — polled between reads, not between events. The check fires every time the reader yields a chunk, which means cancellation latency is bounded by how often the producer enqueues. On a fast-streaming response, that's milliseconds; on a slow one (waiting for an agent), the cancel might wait until the next event arrives. Real-world UI: by the time the user navigates away, the next event usually arrives within seconds and the cancel lands.

Execution trace — a chunk arrives mid-event:

```
  chunk 1 arrives:  '{"type":"reasoning_step","step":{"id":"abc","agent":"diagnostic","ki'
  buf = chunk 1
  lines = buf.split('\n') = ['{"type":"reasoning_step",...,"ki']
  buf = lines.pop() = '{"type":"reasoning_step",...,"ki'
  no complete lines → no dispatch

  chunk 2 arrives:  'nd":"thought","content":"..."}}\n{"type":"tool_call_start","toolNam'
  buf = chunk 1 + chunk 2 = '{"type":...,"kind":"thought",...}}\n{"type":"tool_call_start","toolNam'
  lines = buf.split('\n') = ['{"type":...,"kind":"thought",...}}', '{"type":"tool_call_start","toolNam']
  buf = lines.pop() = '{"type":"tool_call_start","toolNam'
  complete line 0 → JSON.parse → dispatch the reasoning_step

  chunk 3 arrives:  'e":"execute_analytics_eql","agent":"diagnostic"}\n'
  buf = '{"type":"tool_call_start",...,"agent":"diagnostic"}\n'
  lines = ['{"type":"tool_call_start",...,"agent":"diagnostic"}', '']
  buf = lines.pop() = ''
  complete line 0 → JSON.parse → dispatch the tool_call_start
```

The buffer holds incomplete state across reads. The dispatch only fires when a `\n` has arrived. This is how the consumer survives chunk boundaries that don't align to event boundaries — which is **most of the time** on a real network.

**The React glue — `useBriefingStream` / `useInvestigation`**

Two hooks consume the kernel. `useBriefingStream` (`lib/hooks/useBriefingStream.ts`) is the feed; `useInvestigation` (`lib/hooks/useInvestigation.ts`) is the investigation page. Both share the same shape: `fetch → readNdjson(body, onEvent) → setState per dispatched event`.

```ts
// lib/hooks/useInvestigation.ts (cited)
// NOTE: we deliberately do NOT cancel the fetch on effect cleanup. React
// StrictMode (dev) mounts → cleans up → re-mounts; cancelling on the first
// cleanup, with the started-guard blocking the re-mount, aborted the stream
// and left the logs empty. The started-guard prevents a double fetch; the
// in-flight run simply completes (setState after unmount is a safe no-op).
```

That comment is the production-scar tissue. The naive React pattern (cancel on cleanup) fights StrictMode's mount/cleanup/mount sequence — the cleanup cancels the fetch, the re-mount is blocked by the started-guard, and the stream is dead. The fix is to NOT cancel on cleanup; let the stream complete; rely on `setState` after unmount being a no-op (React tolerates this). The kernel itself doesn't enforce this — it offers `cancelOn?` for callers that want it — but the hooks chose not to use it for this exact reason.

**The replay path — the same kernel for demo mode**

The demo path doesn't even talk to the agent; it reads the captured `lib/state/demo-investigations.json` and replays the same events through the same `controller.enqueue` mechanism, with a `setTimeout(180)` between each:

```ts
// app/api/agent/route.ts:103,128-141
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

The 180ms isn't a measurement floor; it's a **perceived-performance choice**. Without it, the entire replay would flush in one tick and the user would see the final state immediately — not "the agent working in real time." The pause makes the replay legible. The briefing route uses `140ms` for the same reason (`app/api/briefing/route.ts:25`). The two numbers differ because the briefing has more events to get through (coverage grid + monitoring trace + insights) and a shorter delay keeps the total replay tolerable.

### Move 3 — the principle

Perceived performance is a different axis than actual performance. A 100-second job that streams the first signal in 100 milliseconds feels faster than a 30-second job that shows nothing until completion. The skeleton: **enqueue as you work, terminate every event with a delimiter, give the consumer a buffer that survives chunk boundaries.** Newlines aren't sacred — SSE uses `\n\n`, gRPC streaming uses length-prefixed frames — but the shape is the same: a delimiter that lets a partial chunk be safe.

The deeper principle: **the wire is a stream, not a transaction.** Treating it as a transaction (build a response, send it) is what makes long-running APIs feel broken. Treating it as a stream costs you almost nothing (the `controller.enqueue` API is a few lines) and buys you the user's continued attention.

## Primary diagram

The full pattern in one frame.

```
  Progressive NDJSON stream — producer to consumer

  ┌─ Producer (Vercel route) ──────────────────────────────────────────────┐
  │                                                                          │
  │  new ReadableStream({                                                    │
  │    async start(controller) {                                             │
  │      const send = (e) => controller.enqueue(encode(JSON(e) + '\n'))     │
  │                                                                          │
  │      for each agent step:                                                │
  │        send({ type: 'reasoning_step', step: {...} })   ─┐               │
  │        ... do work ...                                   │ bytes leave   │
  │        send({ type: 'tool_call_start', ... })            │ the function  │
  │        ... await callTool ...                            │ AS EACH       │
  │        send({ type: 'tool_call_end', ... })              │ send() fires  │
  │      send({ type: 'done' })                             ─┘               │
  │    }                                                                     │
  │  })                                                                      │
  │                                                                          │
  │  Headers: Content-Type: application/x-ndjson                             │
  │           Cache-Control: no-cache, no-transform                          │
  └────────────────────────────────────┬───────────────────────────────────┘
                                       │  chunks flow as enqueued
  ┌─ Wire ─────────────────────────────▼───────────────────────────────────┐
  │  body: ────event1\n────event2\n──event3\n──event4\n──...                │
  │         (chunk boundaries don't align to event boundaries — that's fine) │
  └────────────────────────────────────┬───────────────────────────────────┘
                                       │
  ┌─ Consumer (lib/streaming/ndjson.ts) ▼──────────────────────────────────┐
  │                                                                          │
  │  reader = body.getReader()                                               │
  │  buf = ''                                                                │
  │  while not done:                                                         │
  │    if cancelOn?(): reader.cancel(); return                               │
  │    chunk = await reader.read()                                           │
  │    buf += decode(chunk, { stream: true })   ← UTF-8 safe across chunks  │
  │    lines = buf.split('\n')                                               │
  │    buf = lines.pop()                         ← incomplete trailing line  │
  │    for each line:                                                        │
  │      onEvent(JSON.parse(line))               ← dispatch                  │
  │  flush trailing buf (no-op if producer terminated with \n)               │
  │                                                                          │
  └────────────────────────────────────┬───────────────────────────────────┘
                                       │
  ┌─ React state (useBriefingStream, useInvestigation) ─────────────────────┐
  │  onEvent dispatcher: setState per type                                   │
  │  → React renders the new state                                           │
  │  → user sees progress in real time                                       │
  └─────────────────────────────────────────────────────────────────────────┘
```

## Elaborate

**Why NDJSON instead of SSE.** Server-Sent Events is the W3C standard for this exact use case, with a built-in browser API (`EventSource`). Why not use it here? Three reasons named in the project context: (1) `EventSource` cannot send a POST or custom headers, so authenticated/parameterized requests don't fit; (2) `fetch` + a reader gives us `AbortSignal` propagation that `EventSource` lacks; (3) NDJSON is simpler — one event per line, parse one JSON value per line, done. SSE's `event:` / `data:` / `retry:` field syntax adds complexity we don't need.

**Why not WebSockets.** Wrong shape for the use case. WebSockets are bidirectional and long-lived; here, the client makes one request and the server streams one response. HTTP streaming gives us all the lifecycle hooks (request signal, response headers, status codes) that a WebSocket would force us to reinvent.

**The encoder/decoder symmetry.** `encodeEvent(e)` is one line: `JSON.stringify(e) + '\n'`. `readNdjson` is the inverse: read, split on `\n`, `JSON.parse`. Keep the symmetry strict — the producer terminates every event with `\n`; the consumer expects that. The kernel handles a non-terminated trailing line as a defensive flush, but in practice it's always empty because the producer is disciplined.

**Where this pattern comes from.** NDJSON is a documented convention (https://github.com/ndjson/ndjson-spec). Variants exist as JSONL (JSON Lines) and JSONStream. The shared idea: a delimiter-separated stream of JSON values, optimized for line-oriented tooling (`grep`, `jq -c`, log pipelines). HTTP streaming is the older primitive — chunked transfer encoding has been in HTTP/1.1 since the spec. The combination "HTTP streaming + NDJSON" is what LLM APIs (Anthropic's streaming, OpenAI's streaming) standardized on for the same reason: long-running responses with intermediate signal.

**Adjacent guides.**
- The `ReadableStream` API and `AbortSignal` composition are foundation material in `study-runtime-systems`.
- The `AgentEvent` contract (the wire shape) is detailed in `study-system-design` → request flow.
- The React StrictMode interaction is the kind of production scar that belongs in `study-frontend-engineering`.

## Interview defense

> **"Why stream when you could just return JSON at the end?"**

```
  Two designs, same total runtime, different UX

  Transaction (return JSON at end):
    user clicks  →  ████████████████████████ ~100s spinner  →  result
                                                               (one shot)

  Stream (this design):
    user clicks  →  ▓ ~100ms first event
                    ▓▓▓ events stream as agent works
                    ▓▓▓▓▓▓▓ trace lines, tool calls, results
                    ████████████████████ done at ~100s
```

The user sees the agent working in real time. Time-to-first-event is hundreds of milliseconds even when total runtime is ~100s. Total runtime is unchanged — the agent does the same work — but the perceived experience is completely different. A 100-second spinner reads as "broken." A 100-second stream reads as "thinking." The trace IS the product (the user sees not just the answer but how it was reached), and the trace only works if it streams. Anchor: `app/api/agent/route.ts:183-195` for the producer; `lib/streaming/ndjson.ts:18-58` for the consumer kernel.

> **"What's the load-bearing part of the consumer kernel people forget?"**

The chunk-boundary buffer — `lines = buf.split('\n'); buf = lines.pop()`. Network reads don't align to event boundaries. A 1KB chunk can land mid-event, with half of one event at the start and half of another at the end. If the consumer just `JSON.parse`s each chunk, it dies on the first cross-boundary chunk. The split-and-keep-the-tail idiom is what makes the consumer survive real networks. Plus `TextDecoder({stream: true})` for the UTF-8-safe equivalent on the byte side. Anchor: `lib/streaming/ndjson.ts:37-40` — that three-line block is the entire trick.

> **"How do you handle the user navigating away mid-stream?"**

The consumer polls `cancelOn?()` between reads — when it returns true (the React effect cleanup decided to bail), the reader cancels and the loop exits. On the server side, Next.js exposes the client cancel as `req.signal`, which I thread into every async layer (Anthropic, MCP) via `AbortSignal.any`. So a closed tab cancels the in-flight model call AND the in-flight MCP call. One detail though: the React hooks deliberately do NOT cancel on effect cleanup, because StrictMode's mount/cleanup/mount sequence would kill the stream on the first cleanup before the re-mount can rejoin. The kernel offers `cancelOn?` as an opt-in; the hooks chose not to use it for that reason. The trade is that an unmounted component's pending `setState` becomes a no-op (React tolerates this). Anchor: `lib/hooks/useInvestigation.ts` (the comment block in the effect), and `lib/streaming/ndjson.ts:32-35` for the kernel's cancel poll.

## See also

- `01-vercel-route-budget.md` — the route-level budget the stream runs inside
- `02-mcp-spacing-and-retry.md` — the per-call latencies the stream surfaces in real time
- `03-ttl-cache-no-cache-on-error.md` — cached events skip the live stream entirely
- `audit.md` → `latency-throughput-and-tail-behavior` lens
