# RFC 02 — NDJSON over `fetch` stream, with a shared kernel

**One-line summary.** Streaming transport is newline-delimited JSON over a `ReadableStream`, consumed via `fetch` + a stream reader; one 64-LOC kernel (`readNdjson` at `lib/streaming/ndjson.ts`) is shared by all four streaming surfaces.

---

## Context

The product's central artifact is a multi-agent reasoning trace. The browser needs to see *each step* as it happens — every "thought," every tool call start/end, every emitted insight or diagnosis. A request/response shape was off the table from day one: a live briefing runs 30–90s, and a black-box loading spinner for that long is not the product.

Four surfaces in the app all need that "open a stream, parse events as they arrive, dispatch them, clean up when the consumer leaves" loop:

- **`useBriefingStream`** (`lib/hooks/useBriefingStream.ts:288`) — the monitoring stream that fills the feed.
- **`useInvestigation`** (`lib/hooks/useInvestigation.ts:194`) — diagnostic + recommendation streams on `/investigate/[id]` and `/recommend`.
- **`useDemoCapture`** (`lib/hooks/useDemoCapture.ts:84`) — the dev-only "capture as snapshot" flow.
- **`StreamingResponse`** (`components/chat/StreamingResponse.tsx:108`) — the free-form Q&A surface from `QueryBox`.

Each one is reading the same byte stream produced by the same `encodeEvent` helper on the route side. Four near-identical reader loops were the smell that triggered the kernel extraction. The earlier shape (separate ad-hoc readers in each hook) drifted: one would forget to flush the trailing buffer, another would silently lose a malformed line, a third would not cancel cleanly on unmount.

---

## Decision

**Transport: newline-delimited JSON (NDJSON) over a `ReadableStream`, written from a Vercel route as `Uint8Array` chunks and consumed in the browser via `fetch() → res.body.getReader() → TextDecoder → buffer.split('\n') → JSON.parse → handle(event)`.**

The route side encodes each `AgentEvent` with `encodeEvent` from `lib/mcp/events.ts` — always terminated by `\n`. The client side runs the shared kernel:

```
  The readNdjson kernel — one loop, four consumers

  ┌─ Vercel route (/api/briefing, /api/agent) ──────────┐
  │  encodeEvent(event)  →  controller.enqueue(bytes)    │
  │  one JSON object + '\n' per event                    │
  └─────────────────────────┬────────────────────────────┘
                            │  Uint8Array chunks
                            │  over a fetch() body
                            ▼
  ┌─ Browser ────────────────────────────────────────────┐
  │  readNdjson<E>(body, onEvent, { cancelOn? })          │
  │    1. reader.read() → { value, done }                 │
  │    2. decoder.decode(value, { stream: true })         │
  │    3. buf += text;  lines = buf.split('\n')           │
  │    4. buf = lines.pop()   (trailing partial line)     │
  │    5. for each line: try JSON.parse → onEvent(evt)    │
  │    6. on done: flush trailing buf (no-op in practice) │
  │    7. between reads: poll cancelOn() → reader.cancel  │
  └─────────────────────────┬────────────────────────────┘
                            │  one shape, four consumers:
       ┌────────────────────┼────────────────────┬──────────────────────┐
       ▼                    ▼                    ▼                      ▼
  useBriefingStream    useInvestigation    useDemoCapture       StreamingResponse
  (feed)               (diagnose +         (dev-only capture)    (free-form Q&A)
                        recommend)
```

**The kernel is 64 LOC, including comments.** Generic over the event type `E`. It does five things and refuses to do anything else:

1. **Decode incrementally** — `TextDecoder` with `{ stream: true }` so multi-byte UTF-8 boundaries that fall in the middle of a chunk don't corrupt.
2. **Buffer + split** — accumulate text, split on `\n`, pop the trailing partial line back into the buffer for the next chunk.
3. **Parse line-by-line, malformed-tolerant** — `JSON.parse` per line; on throw, call `opts.onMalformed?.(line, err)` (default silent) and keep going. One bad line never poisons the stream.
4. **Flush on done** — try the trailing buffer one final time. In practice this is a no-op because every producer terminates with `\n`, but the shape is correct for any future producer that omits the terminal newline.
5. **Cancel on demand** — poll `opts.cancelOn?.()` between reads; if it returns true, `await reader.cancel()` and return. This is what lets `useBriefingStream` cancel cleanly when the consumer unmounts, without leaking the reader.

**Producers (route handlers) are intentionally NOT a shared abstraction.** Each route composes `encodeEvent` directly into its own `controller.enqueue`. The reason: the producer's logic is "what events do I emit, in what order, with what data" — different per route. The consumer's logic is "read bytes, parse lines, dispatch" — identical everywhere. Only the identical part got the abstraction.

---

## Alternatives considered

### Server-Sent Events (SSE) over `EventSource`

The textbook server-push transport. `EventSource` handles reconnection, parses `data:` lines, fires `onmessage` for you.

**Why it lost.** Three things:

1. **Vercel functions and `EventSource` have a credentials problem.** `EventSource` does not send cookies cross-origin without `withCredentials`, and the auth path runs through encrypted cookies. The path of least resistance for "use the same fetch with the same cookie story" is `fetch` + reader.
2. **The retry / reconnect behavior of `EventSource` is wrong for this product.** A long-running 60s briefing that drops mid-stream should NOT auto-reconnect — it should surface as a failure and let the user re-run. `EventSource`'s built-in reconnect would silently re-trigger the agents.
3. **`fetch` + reader is the same primitive in the browser and in Node.** Tests can drive the same kernel with a `ReadableStream` constructed from a fixture — no `EventSource` polyfill, no separate consumer code path for the test environment.

### WebSockets

Bidirectional, classic for "live" anything.

**Why it lost.** Overshoot. Nothing flows from client to server *during* a briefing — the user fires a request, the server streams the reasoning trace, the request ends. That's a half-duplex problem. WebSockets would add a separate connection lifecycle, separate infrastructure on Vercel (Edge or external), and a separate auth handshake. Zero feature payoff.

### Polling (`GET /briefing/:id/events?since=...`)

The boring option. Open every 500ms, ship deltas.

**Why it lost.** The briefing is 30–90s of dense reasoning steps. Polling either feels jerky (1-second poll) or hammers the server (250ms poll), and either way you've put a queryable "events since cursor" surface on the server that doesn't otherwise exist. A push transport is the right shape; the only question was which one.

---

## Consequences

**What this cost — owned, not apologized for:**

- **No middlebox knows what an NDJSON stream is.** SSE has a `text/event-stream` content type that CDNs, proxies, and browser devtools recognize. NDJSON over `application/x-ndjson` (or `application/octet-stream`) doesn't get the "streaming" treatment automatically — a misbehaving proxy could buffer the whole response. This is why the route handlers set explicit no-buffer headers and Vercel is the deploy target (it handles streaming fetch responses cleanly).
- **No built-in reconnect.** If the browser drops the connection mid-stream, the kernel sees `done` and exits. The hook above it is responsible for deciding whether to surface an error or re-fetch. That's a choice the product wants (see "why SSE lost" above), but it does mean every consumer has to think about cancellation and error states explicitly.
- **Four call sites are still four call sites.** The kernel collapsed the *parsing* loop. The fetch setup, the headers, the cleanup wiring, and the error-toast story are still per-consumer. The shared abstraction is precisely the part that benefits — no more, no less.

**What this bought:**

- **One bug, fixed once.** The pre-extraction shape had a "what if a chunk arrives with no trailing newline" bug that bit one hook but not the others. Now the answer is in `readNdjson` and it's the same answer everywhere.
- **Malformed-tolerant by construction.** A bad JSON line throws, gets passed to `onMalformed` (or swallowed), and the next line still parses. Production never breaks because the agent emitted a slightly-off-shape event.
- **Generic over event type.** Each consumer types its `E` parameter explicitly — `BriefingEvent`, `AgentEvent`, a capture-progress shape — and the kernel doesn't care. No central enum to keep in sync with four consumers' expectations.
- **The kernel survives a transport change.** If NDJSON ever needs to become SSE (some future deploy target's quirk), `readNdjson` is the obvious swap point. Today nothing in the four consumers reaches past the kernel into the byte layer.

---

## Open Questions

- **Should the kernel grow a default `onMalformed` that logs?** Today the default is silent. A `console.warn`-by-default would catch producer bugs faster in dev but add noise in prod. The clean fix is a single `NODE_ENV`-aware default, not a per-call override at four sites.
- **Is the `cancelOn` polling the right API?** It's a function that gets called every loop iteration. An `AbortSignal` parameter would be more idiomatic with the rest of the codebase (the route handlers already accept `signal`). The current shape works; the swap is mechanical when it's worth doing.
- **At what stream length does NDJSON start losing to a chunked binary protocol?** Today's longest stream is ~90s of small JSON events — well below any pressure point. If a future surface streams MB-scale data (it doesn't today), the parse-per-line cost is real and the kernel would want a Worker.
