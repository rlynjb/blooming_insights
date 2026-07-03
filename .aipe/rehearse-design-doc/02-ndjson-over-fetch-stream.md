# RFC-02 — NDJSON over `fetch` stream, not SSE

**Decision in one line:** Stream agent events as newline-delimited JSON over `fetch` + `ReadableStream`, consumed by one 64-line `readNdjson` kernel — not Server-Sent Events, not WebSockets.

---

## Context

blooming insights streams four different things back to the browser:

1. Monitoring reasoning + insights as they're discovered (`/api/briefing`)
2. Diagnostic reasoning + evidence as it's assembled (`/api/agent?step=diagnose`)
3. Recommendation reasoning + cards (`/api/agent?step=recommend`)
4. Free-form chat replies (`/api/agent` in query mode)

All four are one-way (server → client), all four benefit from partial progress being rendered as it arrives (the "shows its work" pitch), and none of them need a persistent bidirectional channel. Each is a request that starts, streams events, and ends.

The transport had to satisfy three constraints:

- **Structured events, not text chunks.** The UI needs typed `AgentEvent`s (`reasoning_step`, `tool_call_start`, `insight`, `diagnosis`, etc.), not tokens.
- **Framing that survives partial reads.** The consumer might read one byte or a full response; whatever the framing is, event boundaries have to be recoverable.
- **Works with an off-the-shelf Vercel function.** No sticky sessions, no long-lived TCP hijack, no proxy hostile to `text/event-stream` heartbeats.

---

## Decision

Producers emit newline-terminated JSON on a `ReadableStream`. Consumers use `fetch` + a single kernel (`readNdjson`) that reads bytes, splits on `\n`, and dispatches each parsed object to an `onEvent` callback.

```
The kernel — the loop the whole app depends on

  fetch(url)
      │  Response with body: ReadableStream<Uint8Array>
      ▼
  ┌─────────────────────────────────────────────┐
  │  reader = body.getReader()                   │
  │  decoder = new TextDecoder()                 │
  │  buf = ''                                    │
  │                                              │
  │  loop:                                       │
  │    if cancelOn() → cancel + return            │
  │    { value, done } = await reader.read()     │
  │    if done → flush trailing buf, break        │
  │    buf += decoder.decode(value, {stream:1})  │
  │    lines = buf.split('\n')                   │
  │    buf = lines.pop()                         │  ← last line = incomplete
  │    for line in lines:                        │
  │       if line empty: continue                 │
  │       try: onEvent(JSON.parse(line))         │
  │       catch: onMalformed(line, err)          │
  └─────────────────────────────────────────────┘
```

That whole loop is 64 lines at `lib/streaming/ndjson.ts`. Four client-side surfaces call into it:

- `lib/hooks/useBriefingStream.ts` — the feed's monitoring stream
- `lib/hooks/useInvestigation.ts` — the investigate pages' diagnostic + recommendation streams
- `lib/hooks/useDemoCapture.ts` — the dev-only "capture this as demo" runner
- `components/chat/StreamingResponse.tsx` — the `QueryBox` free-form chat surface

The producer side matches: routes build `AgentEvent`s and write them through `encodeEvent()` which appends `\n`. The typed event contract lives in `lib/mcp/events.ts` (`reasoning_step | tool_call_start | tool_call_end | insight | diagnosis | recommendation | done | error`) and is the "must not change" surface both producers and consumers depend on.

---

## Alternatives considered

**(a) Server-Sent Events (SSE).** The classic browser-native "server → client stream" transport, with `EventSource` doing framing and reconnection for you. Loses on three counts. First, `EventSource` doesn't support custom headers, which matters because auth for the Bloomreach flow lives in headers/cookies attached to `fetch` calls. Second, SSE's framing (`data: {...}\n\n`) is heavier than NDJSON and forces you to strip the `data:` prefix on the way in — you end up writing the same parse loop anyway, just with more boilerplate. Third, SSE's built-in reconnect fights the "revoked tokens" recovery model — reconnecting silently on a dead token is worse than failing loudly and prompting a re-auth.

**(b) WebSockets.** A persistent bidirectional channel. Loses because every stream in this app is a request/response pattern: click a button, run one investigation, close the stream. Bidirectional buys nothing. Vercel serverless is also not a natural WebSocket host — you'd add a separate socket server or move to a different runtime. Cost with no matching capability.

**(c) Plain JSON with polling.** Fetch a status endpoint every 500ms. Loses immediately on UX — the whole product pitch is "watch the agent think," and polling turns that into a stuttery status board. Also worse on cost: N polls per investigation, each spinning up a serverless function.

---

## Consequences

**What this buys:**
- **One kernel, four consumers.** Every streaming surface reads through the same 64-line function. When the framing needs to change (it hasn't in months), one file changes.
- **No framework lock-in.** The consumer is `fetch` + `TextDecoder` + `split('\n')`. No React-specific runtime, no `use()` hook coupling, no SSE polyfill. Works from a Node script, a Cypress test, a curl-through-jq pipeline.
- **Malformed lines are recoverable.** The kernel's `try { JSON.parse } catch { onMalformed }` path means one broken event doesn't kill the stream. Producers can't cause a client crash by emitting a partial line.
- **Cancellation is honest.** The `cancelOn` poll runs before each read, so an unmounted consumer breaks out cleanly — no orphan reads holding the stream open until the server closes it.

**What it costs:**
- **No automatic reconnect.** SSE gives you free reconnect-on-drop; we don't. Deliberate. Reconnecting a stream whose token has been revoked would just re-fail; the recovery path (see the "auto-reconnect" logic in the feed page — `invalid_token` triggers auth reset + one reload) is smarter than a naive re-open.
- **Producers must terminate each event with `\n`.** If a producer forgets the newline, the last event sits in the trailing buffer until end-of-stream. The kernel flushes on end (a defensive move: `if (tail) onEvent(JSON.parse(tail))`), so no data is lost — but the UX is a delayed final event. This constraint is documented at the top of `lib/streaming/ndjson.ts`.
- **The event contract is load-bearing.** `AgentEvent` shape is called out in the "what must not change" section of the project context precisely because both sides depend on it. Adding a field is safe; renaming or removing one is a breaking change touching every consumer.

**What the reviewer will push on:**
> "Why not just use SSE? It's browser-standard."

The framing that holds: "SSE is one transport shape; NDJSON over fetch is another. We picked the one where I control the framing byte-for-byte, don't fight the auth model, and don't inherit `EventSource`'s reconnect semantics. The kernel is 64 lines — smaller than the SSE-parsing wrapper we'd have to write anyway to get typed events."

---

## Open questions

- **Server-side back-pressure.** The current kernel reads as fast as the producer writes. If the browser stalls (backgrounded tab, slow device), the producer's `ReadableStream.enqueue` calls don't yet honor the reader's `desiredSize`. This has not caused a user-visible issue because the events are small and the streams are short-lived (~5min max on `/api/agent`). Worth revisiting if streams get chattier.
- **HTTP/2 vs HTTP/3 fetch streams.** Vercel serves over HTTP/2 today; some proxies buffer streams by default. Not a live bug — but if a corporate proxy ever surfaces "streams don't arrive until they end," the fix is to flush more aggressively on the producer side, not to change transports.
