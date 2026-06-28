# RFC 02 — NDJSON over fetch stream, not SSE

**Decision:** Stream agent events to the browser as **newline-delimited JSON
(NDJSON)** over a normal `fetch` `ReadableStream`. **Not** Server-Sent Events,
**not** WebSockets. One shared 64-LOC kernel (`lib/streaming/ndjson.ts`) does
all reads; four consumer surfaces use it.

## Context

A briefing takes 30–90 seconds. During that window the agent emits a stream
of `AgentEvent`s — `reasoning_step`, `tool_call_start`, `tool_call_end`,
`insight`, `diagnosis`, `recommendation`, `done`, `error`. The UI surfaces
each one as it lands (the `StatusLog` sidebar streams the trace; the feed
column hydrates insight cards as they arrive).

The framework question is **what protocol carries these events**. Three real
options were on the table: SSE (`EventSource`), WebSockets, or NDJSON over a
plain `fetch()` ReadableStream.

This is one of those decisions where the "default Next.js answer" (SSE,
because `EventSource` is purpose-built) loses to a different default. NDJSON
won.

## Goals

  → **Bidirectional cancellation.** The route layer (`req.signal`) AND the
    browser (`reader.cancel()`) both need to be able to abort an in-flight
    stream mid-flight without leaking the Anthropic + MCP calls behind it.
  → **One reader codepath.** Four surfaces consume streams (briefing, capture,
    investigation, chat); they should not each re-implement the read loop.
  → **No special transport.** Works through Vercel's edge proxy without
    SSE-specific configuration; works in any test runner that has `fetch`;
    survives a `vitest` environment with no WebSocket support.
  → **Each event is one self-contained JSON object.** No multi-line `data:`
    parsing, no event-name routing layer.

## Non-goals

  → **Server → client push without a request.** Not needed. Every stream is
    initiated by a `fetch()` from the browser.
  → **Client → server streaming.** The client posts a JSON body and reads a
    stream back. Half-duplex is sufficient.
  → **Reconnection with cursor / resumability.** A failed stream restarts the
    whole briefing. Acceptable because briefings are idempotent and the
    `useReconnectPolicy` hook handles the one auth-token-revoked edge case.

## The decision

One kernel, four consumers, one wire format.

```
  Streaming architecture — kernel + consumers + producers

  ┌─ Producers (Next.js route handlers) ─────────────────────────┐
  │  app/api/briefing/route.ts   (monitoring scan → insights)    │
  │  app/api/agent/route.ts      (investigation + chat)          │
  │                                                              │
  │  both emit: Content-Type: application/x-ndjson; charset=utf-8│
  │  one event per line, terminated with '\n'                    │
  └──────────────────────────────┬───────────────────────────────┘
                                 │  ReadableStream<Uint8Array>
                                 ▼
  ┌─ Kernel (lib/streaming/ndjson.ts, 64 LOC) ───────────────────┐
  │  readNdjson<E>(body, onEvent, { cancelOn?, onMalformed? })   │
  │   • reader.read() loop                                       │
  │   • TextDecoder({ stream: true })                            │
  │   • split('\n'), keep tail in buf                            │
  │   • JSON.parse → onEvent (silently skip bad lines)           │
  │   • flush trailing buf at end-of-stream                      │
  │   • poll cancelOn() between reads                            │
  └──────────────────────────────┬───────────────────────────────┘
                                 │  one event at a time
                                 ▼
  ┌─ Consumers ('use client' hooks + one component) ─────────────┐
  │  useBriefingStream.ts:288   (feed monitoring stream)         │
  │  useDemoCapture.ts:84       (dev capture flow)               │
  │  useInvestigation.ts:194    (investigation step 2 & 3)       │
  │  StreamingResponse.tsx:108  (free-form chat)                 │
  └──────────────────────────────────────────────────────────────┘
```

**Verdict-first:** the wire is `\n`-delimited JSON over a normal fetch body;
the read loop is shared; the producer side of every route is `encodeEvent` +
`stream.write(line + '\n')`. Boring on purpose.

### The load-bearing parts of the kernel

`readNdjson` is small — 64 lines — and four parts are doing real work. Drop
any one and a consumer breaks:

```ts
// lib/streaming/ndjson.ts:31-60 (load-bearing parts)
while (true) {
  if (opts?.cancelOn?.()) {           // [1] cooperative cancel
    await reader.cancel();
    return;
  }
  const { value, done } = await reader.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });   // [2] streaming decode
  const lines = buf.split('\n');
  buf = lines.pop() ?? '';            // [3] keep partial last line in buf
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    try {
      onEvent(JSON.parse(line) as E);
    } catch (err) {
      opts?.onMalformed?.(line, err); // [4] never crash on a bad line
    }
  }
}
// flush trailing buffer — no-op if producer always sends '\n'
const tail = buf.trim();
if (tail) { try { onEvent(JSON.parse(tail) as E); } catch ... }
```

**[1] `cancelOn`** — the only way an unmounted React component breaks out of
a 60-second stream. Without it the consumer leaks the fetch + the Anthropic
call behind it.

**[2] `TextDecoder({ stream: true })`** — handles a UTF-8 multi-byte
character that lands across a chunk boundary. Without `{ stream: true }`, a
non-ASCII character in a model's reasoning trace would produce a replacement
character and a malformed line.

**[3] `buf = lines.pop()`** — saves the trailing partial line into `buf` for
the next chunk. Without it, the kernel would emit incomplete JSON on every
chunk boundary that lands mid-event.

**[4] silent skip on JSON.parse error** — a malformed line cannot kill the
stream. The model occasionally emits something the producer fails to wrap
cleanly; the kernel survives.

The four consumer hooks (`useBriefingStream`, `useDemoCapture`,
`useInvestigation`, `StreamingResponse`) all share this kernel. Before the
extraction, three of them re-implemented the same loop with subtle
differences — one forgot the `stream: true` flag and produced UTF-8 corruption
in the trace panel.

## Alternatives considered

### Alternative A — Server-Sent Events (`EventSource`)

The "purpose-built" answer. `EventSource` is in every browser, has automatic
reconnection, has a built-in `data:` / `event:` format.

**Why it lost:** Three things.

  1. **`EventSource` cannot send headers, a request body, or a POST.** Every
     briefing carries inputs (selected categories, project ID, capture flag).
     Posting them as query params blows up URL length and pollutes Vercel
     access logs. We'd need `fetch()` for the trigger and `EventSource` for
     the stream — two channels, one logical operation.
  2. **`EventSource` cannot be cancelled from the server side cleanly.** The
     browser holds the connection; closing it server-side surfaces as a
     network error. With `fetch` + `req.signal`, route cancellation is a
     first-class concern.
  3. **The `data:` multi-line format is harder to parse than NDJSON.** Every
     event becomes a multi-line block ending in `\n\n` instead of a single
     line ending in `\n`. The kernel above doubles in size to handle it.

If the browser was the only constraint, SSE would still be a reasonable
choice. The combination of "we want POST + we want clean route-side
cancellation + we don't need auto-reconnect" is what tipped it.

### Alternative B — WebSockets

Bidirectional, full-duplex, robust.

**Why it lost:** Massive overkill. The product is half-duplex (POST in,
stream out). WebSockets on Vercel serverless require an upgrade path that
fights the platform. Adding a WebSocket layer for something a `fetch()` does
cleanly is an architectural tax with no return.

### Alternative C — Buffered JSON response (no streaming)

Wait for the whole briefing, return a single JSON blob.

**Why it lost:** The product *is* the streamed reasoning. The pitch — "an
analyst that shows its work" — depends on the user seeing the trace land in
real time. A buffered response also blows the 300s Vercel route budget for
slow briefings.

## Tradeoffs accepted

  → **No auto-reconnect.** `EventSource` reconnects for free; `fetch` does
    not. On a connection drop the user has to retry. The `useReconnectPolicy`
    hook handles the one common case (`invalid_token` mid-stream → reset auth
    + reload once). Other drops need a manual retry.
  → **No standard browser tooling for "watch a stream."** A developer using
    DevTools sees the request hanging in the network tab; SSE has a dedicated
    EventStream tab. Mitigated by `console.log` in the consumer hooks during
    dev.
  → **Producer must always terminate with `\n`.** Documented in
    `lib/streaming/ndjson.ts:11-13`. The kernel's trailing-buffer flush
    survives a missing terminal newline, but every producer in the codebase
    enforces it via the shared `encodeEvent` helper.
  → **Schema versioning is a manual concern.** No SSE-style `event:` field
    prefix. The `AgentEvent` discriminated union (`lib/mcp/events.ts`) is
    the contract; the producer and consumer must agree on the shape.

## Risks & mitigations

| Risk | Mitigation |
|------|------------|
| A consumer forgets `cancelOn` and leaks the fetch on unmount | Three of four consumers pass it; `useInvestigation` deliberately doesn't (the comment in `lib/hooks/useInvestigation.ts` explains: survives StrictMode re-mount; the in-flight investigation completes and writes to `sessionStorage`). |
| The 30s per-call MCP timeout doesn't compose with the stream's outer signal | It does — `lib/mcp/transport.ts:131` composes `req.signal` with `AbortSignal.timeout(30_000)` via `composeSignals`, so whichever fires first wins. |
| A new event type is added on the producer side but not in `AgentEvent` | TypeScript catches it in the consumer's exhaustive switch; CI fails the build. |
| Vercel proxy buffers the response and the browser sees one big chunk | Setting `Content-Type: application/x-ndjson` and disabling proxy buffering via the standard `Cache-Control: no-store` works; verified in production. |

## Rollout / migration

Already shipped. The extraction of `lib/streaming/ndjson.ts` from the
duplicated read loops in four hooks was a single PR; covered by
`test/streaming/ndjson.test.ts` (the kernel itself) and by integration tests
in each consumer.

The four consumers migrated one at a time. Each was a mechanical refactor:
delete the local loop, import `readNdjson`, pass the event handler.

## Open questions

  → **Should we add a back-pressure signal in the kernel?** Today the
    consumer can fall behind on `JSON.parse` if the producer flushes a burst
    of events. In practice agents emit slowly enough that this never
    materializes; if it did, the fix is a bounded queue in front of
    `onEvent`.
  → **Schema versioning on `AgentEvent`.** When the union grows a new
    variant, old consumers will hit the default branch and either silently
    drop the event or surface "unknown event type." Today the second is
    correct for dev and the first is correct for prod; the policy isn't
    encoded in the kernel.
  → **Should the kernel surface `onMalformed` by default in dev?** Today
    it's opt-in (silent default). A dev-mode opt-in via `process.env.NODE_ENV`
    would catch producer/consumer drift earlier.

---

**Coach note:** The strongest framing for this decision is *"NDJSON is what
SSE would be if you stripped out everything except the part that matters: one
event per line."* That sentence holds against the "why not just use SSE"
pushback better than any list of incidental advantages.
