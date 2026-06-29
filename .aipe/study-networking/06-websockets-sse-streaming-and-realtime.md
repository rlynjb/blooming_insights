# 06 · WebSockets, SSE, streaming, and realtime

## Subtitle

Long-lived connections and realtime delivery — Industry standard (the family); NDJSON over fetch (this repo's pick).

## Zoom out, then zoom in

The product is realtime in feeling but unidirectional in shape — the agent talks, the browser listens. Three options on the table for that shape: WebSocket, Server-Sent Events (SSE), or just-stream-over-fetch. This repo picks the third, with newline-delimited JSON (NDJSON) as the framing. The hook that consumes it — the briefing-stream hook (`useBriefingStream`) — and the one kernel that parses it — `readNdjson` (`lib/streaming/ndjson.ts:17`) — are the load-bearing pieces.

```
  Zoom out — where realtime lives

  ┌─ UI layer ──────────────────────────────────────────────────┐
  │  hooks read the stream:                                      │
  │   useBriefingStream     → drives the feed                    │
  │   useInvestigation      → drives the diagnose/recommend page │
  │   StreamingResponse     → drives the chat answer             │
  │  ★ all three call ONE kernel ★ → readNdjson()                │
  └─────────────────────────────────────────────────────────────┘
                            │   ★ THIS CONCEPT ★
                            │   fetch + ReadableStream + NDJSON
                            ▼
  ┌─ Service layer ─────────────────────────────────────────────┐
  │  routes write the stream:                                    │
  │   /api/briefing  /api/agent                                  │
  │   ReadableStream<Uint8Array> · controller.enqueue per event  │
  │   Content-Type: application/x-ndjson; charset=utf-8          │
  └─────────────────────────────────────────────────────────────┘
```

The whole "an analyst that shows its work" pitch is downstream of this one technical choice. The reasoning trace, the tool calls, the insights — all of it rides over a single fetch that stays open for ~30 seconds. There's no fallback, no second transport, no upgrade path.

## Structure pass

  - **Layers** — the transport (HTTPS chunked transfer), the framing (NDJSON = one JSON object per line), the parser (`readNdjson` kernel), the event dispatcher (per-hook `switch (e.type)`), the UI update (React `setState`).
  - **Axis traced — "what gets one wire's worth of work and what gets pushed elsewhere?"** Hold across the framing options:
      - **WebSocket** would give bidirectional + framing + heartbeats + auto-reconnect-able subprotocols. The app needs none of those — except framing, which NDJSON provides over plain HTTP.
      - **SSE** would give server-push, automatic reconnection, last-event-ID resumption. The app deliberately doesn't want auto-reconnect (the reconnect policy is custom and one-shot) and doesn't need resumption (a new briefing run starts fresh).
      - **NDJSON over fetch** gives framing, abort via `AbortSignal`, full header control (cookies for auth, custom cache directives), binary safety. Exactly the surface area needed; nothing more.
  - **Seams** — two of them, both load-bearing:
      1. **The `AgentEvent` contract** (`lib/mcp/events.ts:4-12`) — what writer and reader both speak.
      2. **The `readNdjson` kernel** (`lib/streaming/ndjson.ts:17`) — one parser shared by three consumer hooks. Change it, all three break; fix it once, all three benefit.

## How it works

### Move 1 — the mental model

Think of the streaming response as one `fetch()` whose body is a long string the server keeps writing into. The client reads chunks of bytes as they arrive, splits them on `'\n'`, parses each line as JSON, and dispatches. That's it. There's no protocol upgrade, no framing layer, no special headers — just HTTP with the response held open.

```
  Pattern — the NDJSON streaming kernel

  fetch(url) ─► response                          server side
     │                                            ───────────
     ▼                                            new ReadableStream({
  res.body.getReader()                              start(controller) {
     │                                                while (work to do):
     ▼                                                  controller.enqueue(
  loop:                                                   encoder.encode(
    {value, done} = read()                                  JSON.stringify(e) + '\n'
    if done: break                                        ))
    buf += decode(value)                                controller.close()
    lines = buf.split('\n')                           }
    buf = lines.pop()       ← keep the trailing  })
    for line in lines:
      try: parse + dispatch
      catch: skip silently
  flush(buf)
```

The bit a lot of streaming-newcomers get wrong is the trailing-buffer dance: a single network read can split a JSON line in the middle. So you keep the unterminated tail in a buffer, append the next chunk, re-split, and only emit on `\n`. The kernel in `lib/streaming/ndjson.ts` does exactly that.

### Move 2 — the moving parts

#### The kernel — `readNdjson`

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
      if (opts?.cancelOn?.()) {             // ← polled between reads; lets the
        await reader.cancel();              //    consumer break out cleanly
        return;
      }
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });   // ← streaming decode:
      const lines = buf.split('\n');                    //   handles multi-byte
      buf = lines.pop() ?? '';                          //   chars split across
      for (const raw of lines) {                        //   reads
        const line = raw.trim();
        if (!line) continue;
        try {
          onEvent(JSON.parse(line) as E);
        } catch (err) {
          opts?.onMalformed?.(line, err);   // ← default: silent skip
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

Six parts. Pull any of them and something breaks:

  - **`getReader()` + `releaseLock()` in `finally`** — the lock is exclusive; not releasing it means the next attempt to read the body throws. The `finally` makes the cleanup unconditional.
  - **`TextDecoder` with `{ stream: true }`** — UTF-8 multi-byte characters can split across reads (a 3-byte glyph at byte 1023-1025 spans two chunks). `{ stream: true }` tells the decoder to buffer the incomplete tail.
  - **`buf += ... ; split('\n'); buf = lines.pop()`** — the canonical "keep the tail" trick. The last element of `split('\n')` is whatever came after the last newline — which is either an empty string (terminator present) or an unterminated line.
  - **Silent skip on `JSON.parse` throw** — a malformed line shouldn't kill the whole stream. The `onMalformed` callback exists for observability if you want it.
  - **`cancelOn` polled between reads** — a consumer that unmounts (React effect cleanup) can flip a `cancelledRef` and the loop exits at the next read boundary instead of hanging.
  - **Trailing-buffer flush** — handles producers that don't terminate the last event with `\n`. Today's producers (the routes' `send` helpers) always append `\n`, so it's a no-op — but it's correct shape for any future producer.

The whole kernel is about 50 lines. Three different hooks call into it; without it, each would re-implement the read/decode/split/parse dance and they'd drift apart.

#### The writer side — what the route does

```ts
// app/api/briefing/route.ts:191-194 (write side)
const stream = new ReadableStream<Uint8Array>({
  async start(controller) {
    const send = (e: BriefingEvent) =>
      controller.enqueue(encoder.encode(JSON.stringify(e) + '\n'));   // ← one event per enqueue
```

That `+ '\n'` is the framing. `encoder.encode(...)` turns the string into bytes; `controller.enqueue(...)` hands them to the runtime's HTTP layer, which writes them as a chunked-transfer chunk. No framing protocol; just newlines.

Both streaming routes share this shape. The `encodeEvent` helper in `lib/mcp/events.ts:15` exists for the `/api/agent` route to use the same convention:

```ts
// lib/mcp/events.ts:15-17
export function encodeEvent(e: AgentEvent): string {
  return JSON.stringify(e) + '\n';
}
```

#### The contract — `AgentEvent`

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

Discriminated union. The `type` field is the discriminator; downstream `switch` statements get exhaustive type narrowing. Both `/api/briefing` and `/api/agent` write this (briefing extends it with `workspace` and `coverage_item`/`coverage` variants); both `useBriefingStream` and `useInvestigation` read it.

#### The consumer — how the hooks dispatch

```ts
// lib/hooks/useInvestigation.ts:98-152 (excerpt)
const handle = (e: AgentEvent) => {
  switch (e.type) {
    case 'reasoning_step':       // append to items
    case 'tool_call_start':      // append a running tool to items
    case 'tool_call_end':        // mark the matching running tool as done
    case 'diagnosis':            // setDiagnosis
    case 'recommendation':       // append to recommendations
    case 'done':                 // setComplete(true); stash to sessionStorage
    case 'error':                // setError(e.message)
  }
};
```

The dispatcher is per-hook; the kernel is shared. This is the right partition — the parsing is generic; the *meaning* of each event is page-specific.

#### Cancellation through the stream

The cancellation story spans both sides:

```
  Layers-and-hops — cancellation propagation

  ┌─ Browser ──────────────────┐         ┌─ Route handler ────────────────┐
  │ user navigates away         │         │  req.signal (AbortSignal)       │
  │  → React effect cleanup     │         │     ▲                           │
  │  → cancelledRef.current=true│         │     │ fires when client         │
  │                             │         │     │ closes the connection     │
  │ next readNdjson loop iter:  │         │                                 │
  │  cancelOn() → true           │ ──TCP─►│  agent loop polls               │
  │  reader.cancel()             │  FIN    │  req.signal.throwIfAborted()    │
  │  → fetch sends FIN          │         │  at coarse boundaries           │
  └─────────────────────────────┘         │  → throws AbortError            │
                                          │  → controller.close()           │
                                          │  → finally: dispose + log       │
                                          └─────────────────────────────────┘
```

The `cancelOn` polling is intentionally between-reads, not mid-read. A `reader.read()` that's already waiting on bytes from the network won't return until either bytes arrive or the underlying fetch is aborted — calling `cancel()` from outside achieves that.

Note the subtle bit in `useInvestigation`: it deliberately does NOT cancel on cleanup (`useInvestigation.ts:33-37`). React StrictMode mounts-unmounts-remounts; cancelling on the first cleanup left the stream half-consumed. The `startedRef` guard prevents the double-mount from starting a second fetch; the first one completes and `setState` after unmount is a safe no-op.

#### Why not WebSocket

```
  WebSocket gives                 NDJSON-over-fetch gives
  ───────────────                 ───────────────────────
  bidirectional                   unidirectional (which is what we need)
  framing                         framing (via \n)
  binary frames                   binary-safe (Uint8Array)
  ping/pong heartbeats            HTTP keepalive (free, lower-level)
  auto-reconnect protocols        deliberately custom reconnect policy
  separate auth handshake         cookie auth on the fetch (free)
  no header control after handshake full HTTP header control
  needs Upgrade negotiation       runs on existing HTTPS
```

For a chat or collaborative-editing product, the bidirectional + framing + heartbeats are worth the upgrade complexity. For a "stream me a transcript" product, you're paying for capabilities you don't use.

#### Why not SSE

```
  SSE gives                       NDJSON-over-fetch gives
  ─────────                       ───────────────────────
  EventSource API in browser      fetch() — full header control
  auto-reconnect with             one-shot, controlled reconnect via the
    last-event-id                   custom useReconnectPolicy hook
  text-only (UTF-8)               binary-safe (Uint8Array)
  GET only, no POST headers       any method, custom headers
  fixed framing (event/data/id)   any framing you want (\n)
  no AbortController support       AbortSignal works natively
  built-in CORS sensitivity       same-origin = no CORS at all
```

The deal-breaker is `EventSource` not supporting custom headers (or the AbortSignal API), combined with the auto-reconnect behavior being wrong for this app (the Bloomreach token revokes after minutes; we want to redirect to OAuth, not silently retry).

### Move 3 — the principle

The right realtime transport is the smallest one that satisfies the actual interaction shape. "Realtime" is a feeling, not a protocol — it's produced by keeping ONE response open long enough to write multiple meaningful events into it. If your interaction is unidirectional, a streaming HTTP response is enough. WebSocket and SSE are answers to harder questions; reach for them only when the questions actually exist.

## Primary diagram

```
  Full streaming surface — one frame

  ┌─ Browser ────────────────────────────────────────────────────────┐
  │  useBriefingStream  /  useInvestigation  /  StreamingResponse    │
  │                                                                   │
  │  fetch(url, {…})                                                  │
  │   ├─ res.status === 401  →  redirect to authUrl                   │
  │   ├─ res.status !== 200  →  surface error                         │
  │   ├─ content-type != ndjson  →  parse as JSON (demo path)         │
  │   └─ content-type == ndjson  →  readNdjson(res.body, handle, …)   │
  │                                                                   │
  │  readNdjson kernel (lib/streaming/ndjson.ts:17)                   │
  │    getReader → loop {                                             │
  │      cancelOn? → cancel + return                                  │
  │      read → decode(stream:true) → buf + '\n' split                │
  │      JSON.parse each line → onEvent(event)                        │
  │      malformed → silent skip (or onMalformed callback)            │
  │    } → flush tail → releaseLock                                   │
  │                                                                   │
  │  handle(event) — per-hook switch (e.type):                        │
  │    reasoning_step | tool_call_start | tool_call_end |             │
  │    insight | diagnosis | recommendation | done | error            │
  │                                                                   │
  └──────────────────────────┬───────────────────────────────────────┘
                             │ HTTPS chunked transfer
                             │ Content-Type: application/x-ndjson
                             │ Cache-Control: no-store, no-transform
                             ▼
  ┌─ Route handler (/api/briefing, /api/agent) ──────────────────────┐
  │  new ReadableStream({ start(controller) {                        │
  │    send = (e) => controller.enqueue(                              │
  │              encoder.encode(JSON.stringify(e) + '\n'))            │
  │    try {                                                          │
  │      … many send(…) calls over ~30s …                             │
  │      send({type:'done'})                                          │
  │    } catch (e) { send({type:'error', message: ...}) }             │
  │    finally { dispose; log; controller.close() }                   │
  │  }})                                                              │
  └──────────────────────────────────────────────────────────────────┘
```

## Elaborate

The choice of NDJSON over alternatives is one of the more defensible architecture decisions in this repo, because it falls out of the actual requirements rather than from "the cool kids use WebSockets." The requirements are:

  - Unidirectional (agent → browser).
  - Authenticated via cookies (already same-origin, no token gymnastics).
  - Cancellable (user navigates away, route should stop work).
  - Tolerant of mid-stream parse errors (a malformed event shouldn't kill the connection).
  - Compatible with React's effect/cleanup model (StrictMode double-mount).

NDJSON over fetch satisfies all five with no extra infrastructure, no library, no protocol handshake. The 50-line kernel in `lib/streaming/ndjson.ts` is the entire transport layer.

The piece worth dwelling on: the `cancelOn` polling pattern. Most engineers reach for `AbortController` as the cancellation primitive (it's the modern idiom). But `AbortController` only cancels the *fetch* — once you have the body's `ReadableStream`, you need a separate mechanism to break out of the read loop, which is what `cancelOn` provides. Wiring them both is correct: `AbortController` cancels the network round-trip (so the server sees a FIN and can clean up); `cancelOn` cancels the local read loop (so the consumer hook stops calling `setState` after unmount). The repo only uses `cancelOn` because `useBriefingStream` doesn't pass an `AbortSignal` to the fetch — but if it did, both would compose.

Future work the repo doesn't do but could: an `AgentEvent` schema validator (Zod or similar) at the parse boundary so a malformed-but-parseable line gets caught at the dispatcher rather than later when a `setState` reads a missing field. Today the discriminated-union `switch` covers known types and the `default` case ignores unknown ones — fine for now, would matter if the contract grew externally-versioned consumers.

## Interview defense

**Q: Why NDJSON and not WebSocket or SSE?**

```
   shape needed                  WebSocket     SSE       NDJSON-over-fetch
   ────────────                  ─────────     ───       ─────────────────
   unidirectional                ✓ (overkill)  ✓         ✓
   custom headers (auth cookies) ✗ (handshake) ✗ (GET)   ✓
   AbortSignal cancellation       partial        ✗         ✓
   custom reconnect policy        manual         fights you ✓
   binary-safe                    ✓             ✗          ✓
   no protocol upgrade            ✗              ✓         ✓
```

**Anchor:** every "✓" SSE or WebSocket would give comes with a capability we don't use; every capability NDJSON has, we use.

**Q: What's the load-bearing part of the streaming kernel?**

The trailing-buffer split. `buf = lines.pop()` keeps the unterminated tail across reads. Without it, any JSON object that happens to span a chunk boundary fails to parse and gets silently dropped — which would manifest as "the third tool call is missing about 5% of the time and we can't reproduce it." Plus `TextDecoder({ stream: true })` for the multi-byte UTF-8 equivalent at the byte level.

**Q: What happens when the user closes the tab mid-stream?**

```
   browser closes tab
       ↓
   underlying TCP/HTTP connection FIN
       ↓
   route's req.signal fires
       ↓
   route hits req.signal.throwIfAborted() at next phase boundary
       ↓
   throws AbortError → handler skips error event → finally runs
       ↓
   dispose + log + controller.close()
```

On the client, the read loop is already gone (the React effect unmounted). On the server, the route cleans up budget-tracking, then closes the stream gracefully.

## See also

  - `01-network-map.md` — for where the streaming wire sits in the overall topology.
  - `05-http-semantics-caching-and-cors.md` — for the headers (`Content-Type: application/x-ndjson`, `Cache-Control: no-transform`) that make the stream work in practice.
  - `07-timeouts-retries-pooling-and-backpressure.md` — for how the route bounds the work that runs while the stream is open.
