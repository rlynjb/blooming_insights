# WebSockets, SSE, streaming, and realtime

*Realtime transports (Industry standard)* — long-lived connections,
streaming, and reconnect logic. This repo's answer: **NDJSON over
`fetch`** — one choice, one kernel, one reconnect policy, and no
WebSockets or SSE anywhere.

## Zoom out — where this concept lives

Every "live" surface in this app streams the same way: the route
constructs a `ReadableStream`, writes NDJSON lines into it, and the
browser consumes it with `fetch` + a stream reader. There is no
`EventSource`, no `WebSocket`, no `socket.io`. One kernel
(`readNdjson`) handles the browser side; one helper (`encodeEvent`)
handles the server side; and one hook (`useReconnectPolicy`) handles
the alpha-server token-revocation dance.

```
  Zoom out — where realtime lives in this repo

  ┌─ Browser hooks ──────────────────────────────────────────────┐
  │  useBriefingStream, useInvestigation, StreamingResponse       │
  │  ★ ALL SHARE ONE KERNEL: readNdjson ★                         │
  └───────────────────────┬──────────────────────────────────────┘
                          │  fetch → response.body (ReadableStream)
                          │  chunked transfer, HTTP/1.1 or HTTP/2 stream
                          ▼
  ┌─ Route (Node) ───────────────────────────────────────────────┐
  │  new ReadableStream({ start(controller) { …                   │
  │    controller.enqueue(encodeEvent(e))                          │
  │  } })                                                          │
  │  headers: Content-Type: application/x-ndjson; no-store         │
  └──────────────────────────────────────────────────────────────┘
```

That's it. One transport choice, applied everywhere.

## The structure pass

The axis: **who owns reconnect, and what triggers it?** Different
realtime transports answer this differently, and the choice here is
deliberate.

```
  Axis: "who reconnects when the connection breaks?"

  ┌──────────────────────────────────────────┐
  │ EventSource / SSE                        │  → BROWSER decides
  │ (auto-reconnect built into the API)     │    (fires on close)
  └──────────────────────────────────────────┘
      ┌──────────────────────────────────────┐
      │ WebSocket                            │  → APP decides
      │ (no auto-reconnect; app must wrap)   │    (usually a hook)
      └──────────────────────────────────────┘
          ┌──────────────────────────────────┐
          │ NDJSON over fetch (this repo)   │  → APP decides
          │ (no auto-reconnect; useReconnect │    with policy hook,
          │  Policy owns it)                  │    fired on 'error' event
          └──────────────────────────────────┘
```

The seam that matters: when the alpha Bloomreach server revokes an
OAuth token mid-briefing, the stream doesn't die — it emits an `error`
NDJSON event with an auth-shaped message. The reconnect policy hook
matches the message and fires a one-shot `/api/mcp/reset` + reload.
That's the app-owned reconnect that SSE's built-in retry couldn't
handle (it doesn't know how to run an OAuth reset).

## How it works

### Move 1 — the mental model

You've built a `fetch()` before and read the response body. `fetch()`
returns a `Response` with `.body`, which is a `ReadableStream<Uint8Array>`.
Normally you call `res.json()` and it drains the whole body first.
But you can also read it *while* the server is still writing — one
chunk at a time. Combine that with the NDJSON convention (one JSON
object per line, `\n` terminated) and you have a streaming protocol
that uses nothing beyond `fetch`.

```
  The pattern — NDJSON kernel

    ┌─ server ─────────────┐            ┌─ client ────────────┐
    │  producer writes:    │  chunked   │  reader reads:      │
    │                      │  transfer  │                     │
    │  {"type":"a"}\n      │ ──────────►│  buf += chunk       │
    │                      │            │  lines = buf.split(\n)
    │  {"type":"b"}\n      │ ──────────►│  buf = lines.pop()  │
    │                      │            │  for line: JSON.parse│
    │  {"type":"done"}\n   │ ──────────►│                     │
    │                      │            │  onEvent(each)      │
    └──────────────────────┘            └─────────────────────┘

  the split-on-\n + keep-partial-in-buffer is the whole kernel
```

### Move 2 — the load-bearing skeleton

**Isolate the kernel.** The smallest thing that is still the pattern:

```
  NDJSON kernel — the four irreducible parts

    while (true):
      chunk ← reader.read()               ← 1. keep reading
      if done: break
      buffer ← buffer + decode(chunk)      ← 2. accumulate
      lines ← buffer.split('\n')           ← 3. slice on newline
      buffer ← lines.pop()                 ← 4. keep partial line
      for each complete line:
        onEvent(JSON.parse(line))
```

**Name each part by what breaks when missing:**

  - Drop the loop and you read one chunk and stop, losing everything after.
  - Drop the buffer accumulation and a JSON object split across two
    chunks parses as two malformed halves.
  - Drop the `\n` split and you can't know where one event ends and
    the next begins.
  - Drop the `pop()` of the partial line and you try to `JSON.parse` an
    incomplete `{"type":"reasoning_step","step":{"…` and throw on
    every read.

The real kernel — `lib/streaming/ndjson.ts:32-64`:

```ts
  while (true) {
    if (opts?.cancelOn?.()) {
      await reader.cancel();
      return;
    }
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';               // ← 4. keep partial line for next read
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      try {
        onEvent(JSON.parse(line) as E);
      } catch (err) {
        opts?.onMalformed?.(line, err);   // silent by default
      }
    }
  }
  // flush trailing buffer — a no-op when the producer always terminates with '\n'
  const tail = buf.trim();
  if (tail) {
    try { onEvent(JSON.parse(tail) as E); }
    catch (err) { opts?.onMalformed?.(tail, err); }
  }
```

**Separate skeleton from hardening.**

  - Kernel: the four steps above.
  - Hardening layered on top:
    - `cancelOn()` polling (client-side unmount cancel)
    - `onMalformed` callback (defaults to silent skip)
    - Trailing buffer flush at end-of-stream (defensive, mostly no-op
      because `encodeEvent` always terminates with `\n`)
    - `TextDecoder` with `stream: true` (handles multi-byte UTF-8
      split across chunks)

The interview payoff: naming the partial-line-carry-over as
load-bearing signals you've *built* a streaming parser, not just used
one. Every naive implementation forgets step 4 and produces mysterious
half-parsed events at the boundaries.

#### The producer side — one line at a time, always

`lib/mcp/events.ts:14-17`:

```ts
  export function encodeEvent(e: AgentEvent): string {
    return JSON.stringify(e) + '\n';
  }
```

Called at every emission point in the routes — one JSON object per line,
always terminated with `\n`. The comment in `ndjson.ts:10-13` notes:

> Producers (briefing + agent routes via `encodeEvent`) always
> terminate each event with '\n', so in practice the trailing-buffer
> flush is a no-op — but keeping it preserves the correct shape for
> any future producer that omits the terminal newline.

That's a defensive kernel — works even if some future producer
forgets the terminator.

#### The reconnect policy — one-shot, fires on auth-shaped errors

This is where the app-owned reconnect lives. Instead of trying to
detect connection-level disconnects (SSE would do that automatically),
the route *always* returns a graceful `{ type: 'error', message: … }`
NDJSON event on a caught throw
(`briefing/route.ts:294-302`, `agent/route.ts:308-316`), and the
client policy inspects the message text.

`lib/hooks/useReconnectPolicy.ts:33-45`:

```ts
  const AUTH_ERROR_RE_AUTO = /invalid_token|unauthor|forbidden|401|session expired|reconnect/i;
  const AUTH_ERROR_RE_BUTTON = /unauthor|forbidden|401|session expired/i;
  const FLAG_KEY = 'bi:reconnecting';

  export function isAuthErrorAuto(msg: string): boolean {
    return AUTH_ERROR_RE_AUTO.test(msg);
  }

  export function isAuthErrorButton(msg: string): boolean {
    return AUTH_ERROR_RE_BUTTON.test(msg);
  }
```

The `handle` function runs the one-shot logic
(`useReconnectPolicy.ts:84-111`):

```ts
  const handle = useCallback(
    (msg: string): boolean => {
      if (!isAuthErrorAuto(msg)) return false;
      if (typeof window === 'undefined') return false;
      let alreadyTried = false;
      try { alreadyTried = sessionStorage.getItem(FLAG_KEY) === '1'; } catch {}
      if (alreadyTried) {
        try { sessionStorage.removeItem(FLAG_KEY); } catch {}
        return false;   // give up — user must click reconnect
      }
      try { sessionStorage.setItem(FLAG_KEY, '1'); } catch {}
      fireReset();      // POST /api/mcp/reset then window.location.href = '/'
      return true;
    },
    [fireReset],
  );
```

Layers-and-hops for the auto-reconnect:

```
  Auto-reconnect on token revocation

  ┌─ Route ────────────────────────────────────────────┐
  │  callTool → HTTP 401 invalid_token                  │
  │  catch → send({type:'error', message: '…invalid_token…'})│
  └────────────────────┬───────────────────────────────┘
                       │ NDJSON: {"type":"error","message":"…invalid_token…"}
                       ▼
  ┌─ Client hook (useBriefingStream) ──────────────────┐
  │  case 'error': callbacksRef.current?.onAuthError?  │
  │  (msg) → reconnectPolicy.handle(msg)                │
  └────────────────────┬───────────────────────────────┘
                       │
                       ▼
  ┌─ Reconnect policy ─────────────────────────────────┐
  │  matches /invalid_token|unauthor|…/                 │
  │  first time this session? YES:                     │
  │  ├─ setItem('bi:reconnecting', '1') (guard)         │
  │  └─ POST /api/mcp/reset                            │
  │     → window.location.href = '/'                    │
  └────────────────────┬───────────────────────────────┘
                       │
                       ▼
  ┌─ Reload / (page.tsx) ──────────────────────────────┐
  │  bi:mode still 'live' → fresh briefing              │
  │  auth already reset → connectMcp returns authUrl    │
  │  → OAuth roundtrip → back to feed with fresh tokens │
  └────────────────────────────────────────────────────┘

  On the SECOND consecutive failure, the flag is set — handle()
  returns false and the UI shows the manual "reconnect" button
  instead of looping.
```

The one-shot guard is what stops an infinite reload loop when auth is
genuinely broken (e.g. the user revoked access from the Bloomreach
side). First attempt: auto-reconnect. Second attempt (guard already
set): fall through to the manual button.

### Move 2.5 — why NDJSON over fetch, not SSE or WebSocket

This is a *chosen* transport. The alternatives were considered; each
has a reason it was rejected.

```
  Transport comparison — three options, one chosen

  ┌──────────────┬──────────────────────┬──────────────────────────┐
  │ transport    │ what you get free     │ why not chosen           │
  ├──────────────┼──────────────────────┼──────────────────────────┤
  │ NDJSON over  │ - AbortSignal-native  │ ★ CHOSEN — cancellation, │
  │ fetch        │ - Cookie-attached     │ auth path, and demo/live │
  │ (this repo)  │ - branchable          │ branch all work with the │
  │              │  Content-Type          │ same fetch primitive     │
  ├──────────────┼──────────────────────┼──────────────────────────┤
  │ SSE          │ - auto-reconnect      │ - `.close()` isn't       │
  │ (EventSource)│ - Last-Event-ID       │   AbortSignal-composed   │
  │              │ - retry: hint          │ - auto-reconnect fights  │
  │              │                       │   the auth-reset policy  │
  │              │                       │ - Content-Type is fixed  │
  │              │                       │   text/event-stream       │
  ├──────────────┼──────────────────────┼──────────────────────────┤
  │ WebSocket    │ - bidirectional       │ - overkill for one-way   │
  │              │ - full-duplex frames  │   agent → UI              │
  │              │                       │ - Cookie handling in WS  │
  │              │                       │   upgrade is finicky      │
  │              │                       │ - would need a separate  │
  │              │                       │   auth pathway            │
  └──────────────┴──────────────────────┴──────────────────────────┘
```

The single biggest reason: cancellation composes. The client cancels
via `cancelledRef.current = true`, `readNdjson` cancels the reader,
the fetch's request signal fires `AbortError` on the server, and every
in-flight upstream call (Bloomreach, Anthropic) picks up the abort via
their composed signals. Same primitive end-to-end. SSE gives you
`.close()`, but that doesn't compose into your upstream `AbortController`s.

### Move 3 — the principle

If your realtime need is *one-way, cancellation-first, cookie-auth'd*,
NDJSON over fetch is the simplest thing that works. Reach for SSE when
you want the browser to handle reconnect for you (and you can live
with its auto-retry). Reach for WebSocket when you actually need
bidirectional frames.

## Primary diagram

```
  Primary — the NDJSON pipeline end to end

  ┌─ Route ────────────────────────────────────────────────────────┐
  │  encodeEvent(e) = JSON.stringify(e) + '\n'                      │
  │  new ReadableStream({                                           │
  │    async start(controller) {                                    │
  │      const send = (e) => controller.enqueue(                    │
  │        encoder.encode(encodeEvent(e)))                          │
  │      try {                                                      │
  │        send({type:'workspace', …})                              │
  │        send({type:'reasoning_step', …})                         │
  │        // … many events over ~50-100s …                          │
  │        send({type:'done'})                                      │
  │      } catch (e) {                                              │
  │        if (e instanceof DOMException && e.name === 'AbortError')│
  │          return                                                 │
  │        send({type:'error', message: …})                         │
  │      } finally {                                                │
  │        controller.close()                                       │
  │      }                                                          │
  │    }                                                            │
  │  })                                                             │
  └───────────────────────────┬────────────────────────────────────┘
                              │  chunked HTTPS response body
                              ▼
  ┌─ Client kernel (readNdjson) ───────────────────────────────────┐
  │  reader = res.body.getReader()                                  │
  │  buf = ''                                                       │
  │  loop:                                                          │
  │    if cancelOn(): reader.cancel(); return                       │
  │    { value, done } = reader.read()                              │
  │    if done: flush(buf); break                                   │
  │    buf += decode(value)                                         │
  │    lines = buf.split('\n')                                      │
  │    buf = lines.pop()                                            │
  │    for line: onEvent(JSON.parse(line))                          │
  └───────────────────────────┬────────────────────────────────────┘
                              │  dispatched events
                              ▼
  ┌─ Hook state (useBriefingStream / useInvestigation) ────────────┐
  │  switch (evt.type) {                                            │
  │    case 'reasoning_step': setStepStatus(evt.step.content)       │
  │    case 'tool_call_start': setQueryCount(n => n+1)              │
  │    case 'tool_call_end':   setTraceItems(update running → done) │
  │    case 'insight':         collected.push(evt.insight)          │
  │    case 'done':            setInsights(collected)               │
  │    case 'error':           reconnectPolicy.handle(msg) ?? show  │
  │  }                                                              │
  └────────────────────────────────────────────────────────────────┘
```

## Elaborate

The `TextDecoder` with `stream: true` matters and is easy to miss.
UTF-8 multi-byte characters (emojis, non-ASCII text) can split across
chunk boundaries. Without `{ stream: true }`, decoding a chunk that
ends mid-character produces a replacement character `�`. With
`{ stream: true }`, the decoder buffers the trailing partial bytes and
prepends them to the next chunk.

The "trailing buffer flush" at end-of-stream (`ndjson.ts:53-60`)
handles the theoretical case where a producer forgets the terminal
`\n`. Not exercised — but the guard is cheap and prevents a whole
class of future bug.

The reconnect policy's *two regex variants* are explicitly not
unified. `useReconnectPolicy.ts:15-30` notes:

> Unifying them would require manual verification against the live
> Bloomreach server, which is not available in the current session.
> There IS a latent bug worth flagging (the button regex is missing
> `invalid_token` and `reconnect` matches) — filed as a future concern.

That's an example of *pragmatic scoping* — the strict-preservation
lift keeps behavior identical, and the risk is documented rather than
"fixed" without verification.

## Interview defense

**Q: You're streaming from the server to the browser. Why NDJSON over
fetch and not Server-Sent Events?**

  Verdict first: cancellation composes with the rest of the app's
  AbortSignal machinery, and the auth-reset dance can't be
  auto-reconnected the way SSE would try to do.

```
  answer sketch — composition wins

  fetch's ReadableStream          EventSource
  ────────────────────           ────────────
  cancel via AbortSignal          cancel via .close()
  composes with upstream           doesn't compose
  AbortController naturally        with server-side signals
  ↓
  one abort at the client
  cancels every hop in flight
```

  Anchor: `lib/streaming/ndjson.ts:32-51`,
  `useBriefingStream.ts:288-299` (composition with `cancelledRef`).

**Q: Talk me through the NDJSON parser. Where does it typically go
wrong?**

  Verdict first: the load-bearing part everyone forgets is *carrying
  the partial final line between reads*.

```
  parser sketch — one detail matters more than the rest

  buf += decode(chunk)
  lines = buf.split('\n')
  buf = lines.pop() ←── this. the partial final line survives to the next read.
  for line in lines: JSON.parse

  drop the pop() and every JSON that spans a chunk boundary throws.
```

  Anchor: `lib/streaming/ndjson.ts:40-41`.

**Q: The Bloomreach server revokes OAuth tokens after a few minutes.
How does the app handle a token expiry mid-stream?**

  Direct: the route catches the `invalid_token` from the transport and
  sends an NDJSON `error` event with the message. The client's
  reconnect policy inspects the message text — if it matches
  `/invalid_token|unauthor|forbidden|401|…/`, it fires a one-shot
  `POST /api/mcp/reset` + full-page reload. The one-shot guard is a
  `bi:reconnecting` flag in sessionStorage so a second consecutive
  failure falls through to a manual "reconnect" button instead of
  looping.

  Anchor: `lib/hooks/useReconnectPolicy.ts:33-111`.

## See also

  - `05-http-semantics-caching-and-cors.md` — the Content-Type branch
  - `07-timeouts-retries-pooling-and-backpressure.md` — the AbortSignal
    composition that makes cancellation end-to-end
  - `.aipe/study-frontend-engineering/` — the client hooks + StrictMode
