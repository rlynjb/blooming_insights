# streaming-ndjson

## Newline-delimited JSON streaming (industry standard)

The wire format every dynamic surface in this app uses. One framing rule (`\n` terminates an event), one shared kernel (`readNdjson` in `lib/streaming/ndjson.ts`, 64 LOC), one typed event union (`AgentEvent`), four streaming consumers (briefing, investigation, capture loop, query). Producers always terminate with `\n`; the kernel splits on `\n` and `JSON.parse` each line.

## Zoom out — where this pattern lives

The streaming pattern is the *wire format* — the contract between the route's `ReadableStream` body and the hook's `readNdjson` consumer.

```
  Zoom out — NDJSON as the wire between routes and hooks

  ┌─ UI layer ─────────────────────────────────────────────────────────┐
  │  useBriefingStream      useInvestigation      useDemoCapture        │
  │     │                          │                       │            │
  │     └────── all use ────────── readNdjson ─────────────┘            │
  │                                    │                                 │
  │                                    │  fetch() + reader.read()        │
  └────────────────────────────────────┼─────────────────────────────────┘
                                       │  HTTP, content-type: application/x-ndjson
  ┌─ Service layer ───────────────────▼─────────────────────────────────┐
  │  ★ NDJSON STREAMING ★                                                │ ← we are here
  │   /api/briefing  /api/agent  /api/mcp/capture-demo  ...              │
  │     ReadableStream<Uint8Array> body                                  │
  │     controller.enqueue(encoder.encode(JSON.stringify(evt) + '\n'))   │
  │     AgentEvent (lib/mcp/events.ts) — typed wire contract             │
  └─────────────────────────────────────────────────────────────────────┘
```

## Structure pass

Three layers carry this pattern: the **producer** layer (the route emitting events), the **wire** layer (the framing rule `\n`), the **consumer** layer (the hook running `readNdjson`). One axis worth tracing: **who owns the framing?**

```
  Axis: who is responsible for the '\n' framing?

  ┌─ producer (route) ─────┐    encodes JSON + '\n', always
  │  encodeEvent(e) →       │   ═════╪═════►
  │  JSON.stringify(e)+'\n'│
  └────────────────────────┘
       ┌─ wire (HTTP body) ────────┐    just bytes; no semantics
       │  chunked transfer encoding│
       │  application/x-ndjson      │
       └────────────────────────────┘
            ┌─ consumer (readNdjson) ┐    splits on '\n'
            │  TextDecoder + buffer  │    parses each line
            │  + buf.split('\n')     │
            └────────────────────────┘
```

The producer owns the framing; the wire owns nothing semantic; the consumer trusts the framing. The seam where this could break is the wire: a malformed line (a chunk that arrived mid-event without a terminating newline) is the most common bug. The consumer handles it by buffering the trailing partial line and prepending it to the next chunk — and by silently skipping a parse failure (so one bad event doesn't tear down the whole stream). → see Move 2's `step-by-step` for how.

## How it works

### Move 1 — the mental model

You've used `fetch` with `await res.json()`. The browser buffers the whole response body, then `JSON.parse` it once. NDJSON is the same idea, run incrementally: the body is *many* JSONs separated by newlines, and the reader parses each one as it arrives. The output is a sequence of events, not a single object.

```
  The pattern: many JSONs, one per line, framed by \n

  wire bytes:    {"type":"workspace","workspace":{…}}\n
                 {"type":"reasoning_step","step":{…}}\n
                 {"type":"tool_call_start","toolName":"execute_analytics_eql",…}\n
                 {"type":"tool_call_end","toolName":"execute_analytics_eql",…}\n
                 {"type":"insight","insight":{…}}\n
                 …
                 {"type":"done"}\n

  consumer:      for each line:
                   JSON.parse(line) → AgentEvent
                   handle(event)
```

Two properties matter. (a) Events are *independent* — each line is a complete JSON object; you don't have to wait for the next line to make sense of this one. (b) Events are *progressive* — the consumer can render as it reads; nothing requires waiting for the stream to end.

### Move 2 — the step-by-step walkthrough

#### the typed wire contract — `AgentEvent`

The whole wire is one TypeScript union:

```ts
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
```

Eight cases. `type` is the discriminator. Producers and consumers agree on this union — TypeScript will catch a missing case in either direction at compile time. Briefing-specific extensions (`workspace`, `coverage_item`, `coverage`) are declared locally in the briefing route as a *superset* of `AgentEvent`, so investigation and chat surfaces stay on the shared contract while briefing can have its own opening events. The shared union is the contract; the local supersets are scoped variations.

The producer-side helper is one line:

```ts
// lib/mcp/events.ts:14-17
export function encodeEvent(e: AgentEvent): string {
  return JSON.stringify(e) + '\n';
}
```

That's the framing rule, in code. Every producer either calls `encodeEvent(e)` or inlines the same `JSON.stringify(e) + '\n'`. The `\n` is the contract — the consumer cannot split without it.

#### the producer — route enqueues into a ReadableStream

```ts
// app/api/briefing/route.ts:190-200
const encoder = new TextEncoder();
const stream = new ReadableStream<Uint8Array>({
  async start(controller) {
    const send = (e: BriefingEvent) =>
      controller.enqueue(encoder.encode(JSON.stringify(e) + '\n'));
    …
```

Three layers compose here. (a) `JSON.stringify(e) + '\n'` produces a string. (b) `TextEncoder.encode` produces a `Uint8Array`. (c) `controller.enqueue(...)` hands the bytes to the framework, which writes them as a chunk on the wire. The browser side reads bytes; the kernel decodes them; the contract holds.

The response opts make the streaming explicit:

```ts
// app/api/briefing/route.ts:330-334
return new Response(stream, {
  headers: {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store, no-transform',
  },
});
```

`application/x-ndjson` is the registered media type; `no-store, no-transform` prevents any caching proxy from buffering or chunk-rewriting. The latter is load-bearing on networks with intermediate proxies that re-frame chunks.

#### the kernel — `readNdjson`, 64 LOC, the whole pattern

This is the *only* NDJSON parser in the codebase. Four streaming surfaces consume it.

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
      if (opts?.cancelOn?.()) {
        await reader.cancel();
        return;
      }
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';                        // last line might be partial
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        try {
          onEvent(JSON.parse(line) as E);
        } catch (err) {
          opts?.onMalformed?.(line, err);             // silent by default
        }
      }
    }
    // flush trailing buffer — no-op when the producer always terminates with '\n'
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

Six load-bearing pieces inside 64 LOC:

1. **`TextDecoder({ stream: true })`** — handles multi-byte UTF-8 characters that span chunk boundaries. Without `{ stream: true }`, a JSON containing a multi-byte char split across two reads would corrupt the string.
2. **`buf = lines.pop() ?? ''`** — `split('\n')` produces N parts from N-1 newlines; the last part is *either* an empty string (if the chunk ended on `\n`) or a partial event (if it didn't). Pop it back into `buf` so the next read prepends it.
3. **`if (!line) continue`** — empty lines are ignored. A producer that emitted `\n\n` by mistake wouldn't crash the parser.
4. **`try { onEvent(JSON.parse(line)) } catch ...`** — a single malformed event does not tear down the whole stream. Default behavior is silent; the optional `onMalformed` hook lets a caller log.
5. **The trailing-buffer flush** — if the producer omits the final `\n`, the last event would otherwise stay in `buf` and never be parsed. This branch flushes it after the stream ends. In practice all producers in this repo terminate with `\n`, so this is a no-op, but keeping it preserves the contract for any future producer.
6. **`opts.cancelOn` polled between reads** — the consumer can break out cleanly without waiting for the next chunk. `useBriefingStream` passes a `cancelOn: () => cancelledRef.current` so unmount or mode-flip aborts within one read cycle.

```
  Pattern — the kernel's loop

  ┌─ loop ─────────────────────────────────────────────────────────────┐
  │  read chunk → decode (streaming UTF-8)                              │
  │     │                                                                │
  │     ▼                                                                │
  │  buf += text                                                         │
  │     │                                                                │
  │     ▼                                                                │
  │  lines = buf.split('\n')                                             │
  │  buf   = lines.pop()         ← keep partial tail for next read       │
  │     │                                                                │
  │     ▼                                                                │
  │  for each non-empty line:                                            │
  │    try JSON.parse → onEvent(event)                                   │
  │    catch         → onMalformed(line, err)  // silent by default      │
  │     │                                                                │
  │     ▼                                                                │
  │  poll cancelOn() → cancel + return if true                           │
  │     │                                                                │
  │     ▼                                                                │
  │  (loop until done) → flush trailing buf if any                       │
  └──────────────────────────────────────────────────────────────────────┘
```

#### execution trace — one chunk split across two reads

A concrete walkthrough of why the partial-tail handling matters.

```
  Execution trace — partial event spanning two chunks

  state: buf = ''

  ── read 1 ──
  value (bytes): {"type":"insi
  decode:        '{"type":"insi'
  buf:           '{"type":"insi'
  lines:         ['{"type":"insi']                 // no '\n' anywhere
  pop:           buf = '{"type":"insi', lines = []
  for: nothing to parse

  ── read 2 ──
  value (bytes): ght","insight":{"id":"a1"}}\n{"type":"done"}\n
  decode:        'ght","insight":{"id":"a1"}}\n{"type":"done"}\n'
  buf:           '{"type":"insight","insight":{"id":"a1"}}\n{"type":"done"}\n'
  lines:         ['{"type":"insight","insight":{"id":"a1"}}', '{"type":"done"}', '']
  pop:           buf = '', lines = ['{"type":"insight",…}', '{"type":"done"}']
  for:
    line 1: parse → { type: 'insight', insight: { id: 'a1' } } → onEvent
    line 2: parse → { type: 'done' } → onEvent

  ── read 3 ──
  done = true → break
  flush: buf = '' → nothing to flush
  return
```

This is the bug the partial-tail handling prevents: chunk boundaries are arbitrary; the parser must not assume one event per chunk.

#### the four consumers

```ts
// lib/hooks/useBriefingStream.ts:288
await readNdjson<BriefingEvent>(res.body, handle, { cancelOn: () => cancelledRef.current });
```

```ts
// lib/hooks/useInvestigation.ts (uses the same kernel; reads `bi:diag:<id>`-handoff and emits per-step events)
…readNdjson<AgentEvent>(res.body!, (evt) => { … });
```

```ts
// lib/hooks/useDemoCapture.ts — captures the briefing + each investigation into the snapshot file
…readNdjson(…);
```

```ts
// components/chat/StreamingResponse.tsx (or query hook) — free-form chat surface, same kernel
…readNdjson(…);
```

All four use the same parser. The producer always terminates with `\n`. The contract holds.

```
  Layers-and-hops — four consumers, one kernel, one wire contract

  ┌─ briefing ─┐  ┌─ investigation ┐  ┌─ capture ─┐  ┌─ chat ─┐
  │ hook       │  │ hook            │  │ loop      │  │ hook   │
  └─────┬──────┘  └────────┬───────┘  └─────┬─────┘  └───┬────┘
        │                  │                │            │
        │  all consume      │                │            │
        ▼                   ▼                ▼            ▼
                  ┌─ lib/streaming/ndjson.ts ─┐
                  │  readNdjson<E>(body, …)   │
                  └─────────────┬──────────────┘
                                │  reads bytes from ReadableStream
                                ▼
                  ┌─ HTTP wire (NDJSON) ──────┐
                  │  application/x-ndjson      │
                  │  one JSON per line         │
                  │  '\n' terminates every     │
                  └─────────────┬──────────────┘
                                │  produced by:
            ┌───────────────────┼───────────────────┐
            ▼                   ▼                   ▼
    /api/briefing         /api/agent          /api/mcp/capture-demo
    encodeEvent(e)        encodeEvent(e)      encodeEvent(e)
```

### Move 3 — the principle

NDJSON is *the simplest streaming format that still has structure*. Compared to Server-Sent Events: no event-type discriminator at the transport layer, no `Last-Event-ID` reconnect semantics, no protocol overhead. Compared to WebSockets: no socket lifecycle to manage, no bidirectional channel, no upgrade handshake. Compared to gRPC streaming: no schema, no codegen, no transport coupling. The cost is that you write the framing and the reconnect yourself.

The transferable lesson: pick the wire format that minimizes coupling. NDJSON over `fetch` works in any browser, any test runner, any HTTP client; it requires no library on either side. A 64-LOC kernel — buffer + split + parse — is the entire client; the typed union (`AgentEvent`) is the entire schema. When the producer is your own route and the consumer is your own hook, the format should be the thinnest thing that gets the bytes across with structure.

## Primary diagram

```
  streaming-ndjson — full picture

  ┌─ Producers ────────────────────────────────────────────────────────────┐
  │                                                                         │
  │  app/api/briefing/route.ts                                              │
  │    const send = (e) => controller.enqueue(encoder.encode(JSON.stringify(e)+'\n'))│
  │    Response(stream, { 'content-type': 'application/x-ndjson; charset=utf-8' })│
  │                                                                         │
  │  app/api/agent/route.ts                same encode pattern              │
  │  app/api/mcp/capture-demo/route.ts     same encode pattern              │
  │                                                                         │
  │  lib/mcp/events.ts                                                      │
  │    encodeEvent(e: AgentEvent) → JSON.stringify(e) + '\n'                │
  │    decodeEvent(line)         → JSON.parse(line) as AgentEvent           │
  │    type AgentEvent = reasoning_step | tool_call_start | tool_call_end   │
  │                   | insight | diagnosis | recommendation | done | error │
  └────────────────────────────┬────────────────────────────────────────────┘
                               │
  ┌─ Wire ────────────────────▼─────────────────────────────────────────────┐
  │  HTTP/1.1 chunked transfer encoding                                      │
  │  content-type: application/x-ndjson; charset=utf-8                       │
  │  cache-control: no-store, no-transform   ← prevents intermediate re-frame│
  └────────────────────────────┬────────────────────────────────────────────┘
                               │
  ┌─ Kernel ──────────────────▼─────────────────────────────────────────────┐
  │  lib/streaming/ndjson.ts (64 LOC)                                        │
  │  readNdjson<E>(body, onEvent, { cancelOn, onMalformed })                 │
  │    reader = body.getReader()                                             │
  │    decoder = new TextDecoder()                                           │
  │    buf = ''                                                              │
  │    loop:                                                                 │
  │      if cancelOn() → reader.cancel(); return                             │
  │      read chunk; buf += decoder.decode(value, { stream: true })           │
  │      lines = buf.split('\n'); buf = lines.pop() ?? ''                    │
  │      for each non-empty line:                                            │
  │        try JSON.parse → onEvent                                          │
  │        catch         → onMalformed (silent default)                      │
  │    on end: flush trailing buf (no-op when producer always terminates)    │
  └────────────────────────────┬────────────────────────────────────────────┘
                               │
  ┌─ Consumers ───────────────▼─────────────────────────────────────────────┐
  │                                                                          │
  │  useBriefingStream      9-case switch:                                   │
  │   (313 LOC)              workspace / coverage_item / coverage /          │
  │                          tool_call_start / reasoning_step /              │
  │                          tool_call_end / insight / done / error          │
  │                                                                          │
  │  useInvestigation       step-filtered: diagnose vs recommend             │
  │   (202 LOC)              writes diagnosis to sessionStorage handoff       │
  │                                                                          │
  │  useDemoCapture         dev-only: captures live trace + insights →       │
  │   (146 LOC)              writes lib/state/demo-*.json                    │
  │                                                                          │
  │  StreamingResponse      free-form chat surface (live-only)               │
  │  (chat component)                                                        │
  └─────────────────────────────────────────────────────────────────────────┘
```

## Elaborate

**Why not Server-Sent Events.** SSE has event-type framing and automatic reconnect with `Last-Event-ID`. Both are wrong here. The event-type framing is redundant — our events already carry `type` in the JSON payload, and the wire is one parser, not a per-type dispatch. The automatic reconnect is *actively harmful*: a reconnect mid-scan would either re-run the scan (duplicating work + cost) or skip events the resumed stream doesn't know about. The hand-rolled NDJSON + `useReconnectPolicy` gives us explicit control over when to reconnect (only on auth-shaped errors, once per session, after a full reset). → see `02-auth-boundary.md`.

**Why not WebSockets.** WebSockets buy bidirectional streaming and lower per-message overhead. Neither matters here — the wire is one-way (route → UI), and the messages are JSON (the per-event overhead is `JSON.stringify`, not protocol framing). The cost of WebSockets is the socket lifecycle: connection upgrade, ping/pong, reconnect logic, framework support. Vercel's serverless functions don't support long-lived WebSockets in the default runtime, so adding them would force a runtime change (Edge or a different platform) for no win.

**The malformed-line policy.** Silent by default, with an optional hook. The reasoning: a single corrupted line is almost always a transient wire issue (a CDN re-framing artifact, an unfortunate test fixture). Crashing the whole stream on one bad line would turn a recoverable hiccup into a fatal error. Logging the bad line via `onMalformed` is available when a caller wants to surface it; in production, callers don't pass the hook, which is the explicit decision to swallow.

**The forward-compat shape.** New event types can be added to `AgentEvent` (or to a local superset like `BriefingEvent`) without breaking existing consumers — TypeScript's exhaustive-switch warnings appear at compile time in the consumer, the runtime ignores unknown event types silently (the `switch` falls through, no `default` throws). The dual rule: existing event types' *required* fields must not change; optional fields can grow. The data-model fields on `Insight` / `Anomaly` / `Diagnosis` / `Recommendation` are kept optional for the same reason (so older demo snapshots still validate).

## Interview defense

**Q: Why NDJSON over Server-Sent Events or WebSockets?**

> NDJSON is the thinnest format that still has structure. SSE has features I don't want — its `Last-Event-ID` reconnect would either duplicate the agent scan or skip events; the event-type framing is redundant when the JSON already carries `type`. WebSockets are heavier — connection lifecycle, bidirectional channel I don't need, and Vercel's default serverless runtime doesn't support long-lived sockets. NDJSON over `fetch` works in any browser, requires no library, and the entire kernel is 64 lines. The producer terminates every event with `\n`; the consumer splits on `\n` and `JSON.parse` each line. That's the whole protocol.

```
  format comparison

  NDJSON   ──► 64-LOC kernel, plain fetch, no library
  SSE      ──► event-type framing (redundant), auto-reconnect (harmful here)
  WebSocket ─► socket lifecycle, bidirectional (unused), runtime change
  gRPC     ──► schema, codegen, transport coupling
```

**Anchor:** `lib/streaming/ndjson.ts:17-64`, `lib/mcp/events.ts:4-12`.

**Q: What's the load-bearing skeleton of `readNdjson`? What breaks if I remove a piece?**

> The kernel is four parts: the read loop, the buffer that survives chunk boundaries, the split-and-pop on `\n`, and the try/catch around `JSON.parse`. The buffer (`buf` initialized to `''`, prepended to each new chunk's decoded text) is the part most people forget — without it, an event split across two TCP chunks would be parsed as two malformed lines instead of one valid event. The `lines.pop()` after `split('\n')` is the partner: it keeps the last (possibly partial) line in the buffer for the next read. The try/catch around `JSON.parse` is what makes a single bad line a logged-and-skipped event instead of a stream-killing throw. The `cancelOn` poll is hardening — useful but not load-bearing for correctness.

```
  the kernel

  let buf = ''                              ← survives chunk boundaries
  read chunk → buf += decode(chunk)
  lines = buf.split('\n')
  buf = lines.pop() ?? ''                   ← keep partial tail
  for each non-empty line:
    try JSON.parse → onEvent                 ← per-event isolation
    catch         → onMalformed (silent)

  hardening (not the kernel):
    cancelOn poll, trailing-buffer flush, TextDecoder({stream:true})
```

**Anchor:** `lib/streaming/ndjson.ts:30-50`.

**Q: How does the producer guarantee the consumer can parse what arrives?**

> The producer ALWAYS terminates each event with `\n`. The `encodeEvent` helper in `lib/mcp/events.ts` literally returns `JSON.stringify(e) + '\n'`, and every inline `controller.enqueue(...)` follows the same shape. The contract on the wire is: every newline marks a complete JSON object; everything between two newlines is a parseable JSON. The consumer trusts this. If a future producer ever omitted the final `\n`, the kernel's trailing-buffer flush would still emit the last event from `buf` on stream end — but that's a safety net, not the contract. The intent is "always terminate," documented in the kernel's header comment: "Producers always terminate each event with '\n', so in practice the trailing-buffer flush is a no-op."

```
  the contract

  producer:   JSON.stringify(event) + '\n'    ← always
  wire:       chunked bytes, framing-agnostic
  consumer:   split('\n'), parse each line     ← assumes the contract holds

  safety net (not the contract):
    consumer flushes trailing buf on stream end
```

**Anchor:** `lib/mcp/events.ts:14-17`, `app/api/briefing/route.ts:193-194`, `lib/streaming/ndjson.ts:52-60`.

## See also

- `01-request-flow.md` — how the briefing route emits events into the wire
- `04-aptkit-primitive-boundary.md` — the trace sink that produces tool_call_start / tool_call_end
- `05-framework-runtime-only.md` — `ReadableStream` as a `Response` body is the runtime feature this stands on
- `08-demo-replay-as-reliability.md` — the demo branch produces NDJSON from a static snapshot, identically
