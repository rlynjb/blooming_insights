# 06 — WebSockets, SSE, streaming, and realtime

## Subtitle

Long-lived response streaming (Industry standard — NDJSON over `fetch` response body, one kernel serving four consumers).

## Zoom out, then zoom in

You know how a `fetch()` normally resolves once, with a complete body? This app runs a different shape: `fetch()` resolves once (with headers), but the body is a stream — the server keeps writing bytes to it for up to 300 seconds, and the client reads them chunk-by-chunk. That's the realtime channel. No WebSockets. No Server-Sent Events (`text/event-stream`). Just NDJSON — one JSON object per newline — flowing down a standard HTTPS response body.

```
  Zoom out — the realtime channel

  ┌─ UI layer ─────────────────────────────────────────────────┐
  │  useBriefingStream / useInvestigation                      │
  │  fetch(url) → res.body.getReader()                         │
  │           ↓                                                │
  │  readNdjson(body, handle, { cancelOn })                    │
  │           ↓                                                │
  │  browser renders events as they arrive                     │
  └────────────────────────┬───────────────────────────────────┘
                           │  hop 1 UP: application/x-ndjson
                           │  { event }\n{ event }\n{ event }\n
                           │  (server keeps writing)
                           ▼
  ┌─ Service band (route) ─────────────────────────────────────┐
  │  ★ THIS FILE ★                                             │  ← we are here
  │  new ReadableStream<Uint8Array>({                          │
  │    async start(controller) {                               │
  │      // agents run; each event → controller.enqueue()      │
  │    }                                                       │
  │  })                                                        │
  └────────────────────────────────────────────────────────────┘
```

Zoom in — this file walks the streaming pattern. The `readNdjson` kernel that four consumer hooks share. Why NDJSON was picked over SSE and WebSockets. The `useReconnectPolicy` layer that handles revoked-token reconnection (the poor-man's resumable-stream story). What's `not yet exercised`.

## Structure pass

**Layers:**
- Route writer (opens `ReadableStream`, enqueues bytes)
- Wire (HTTPS response body, chunked transfer, kept unbuffered by `no-transform`)
- Client reader (`readNdjson` kernel — `fetch → reader → TextDecoder → buffer → split → JSON.parse → handle`)
- Consumer hook (dispatches events into React state)

**Axis — STATE (who's holding the loop's progress?):**

```
  "who holds the accumulating state?" — traced

  Route writer     → holds the ReadableStream controller;
                      also holds `collected: AgentEvent[]`
                      for later caching (the diagnose+recommend
                      combined run gets saved to disk)
      seam #1: bytes on the wire (no state, just newline-delimited JSON)
  Client reader    → holds `buf: string` between chunks
                      to reassemble partial lines
      seam #2: JSON parse per newline
  Consumer hook    → holds React state — insights[],
                      coverage[], traceItems[], etc.

  state accumulates in three places for the same stream —
  route's collected[], client's buf, hook's React state
```

**Seams:**
- Seam #1 — the wire itself carries no state. Each byte read is orphaned until it reaches a `\n`.
- Seam #2 — the JSON.parse boundary. Malformed lines are silently dropped (`onMalformed?.(...)`), which is the app's forward-compat story.

## How it works

### Move 1 — the mental model

Think of it like a `console.log()` on the server that the browser can subscribe to. The server keeps calling something equivalent to `stream.write(JSON.stringify(event) + '\n')` as an agent makes progress. The browser reads bytes, splits on `\n`, JSON.parses each line, and dispatches to a handler. The stream lives until the server closes it or the client aborts.

```
  The pattern — one kernel, four consumers

  producer (route):
    controller.enqueue(encoder.encode(JSON.stringify(evt) + '\n'))
    // ...loops...
    controller.close()

  wire:
    {"type":"workspace",...}\n
    {"type":"coverage_item",...}\n
    {"type":"tool_call_start",...}\n
    {"type":"tool_call_end",...}\n
    {"type":"insight",...}\n
    {"type":"done"}\n

  consumer (readNdjson kernel):
    while (!done) {
      chunk = await reader.read()
      buf += decoder.decode(chunk)
      lines = buf.split('\n')
      buf = lines.pop()  // partial line at end
      for (line of lines) if (line) handle(JSON.parse(line))
    }
    if (buf.trim()) handle(JSON.parse(buf))  // flush trailing
```

The load-bearing part of this pattern: **buffering across chunks.** TCP doesn't guarantee that each `chunk` from `reader.read()` ends on a newline. A single event's JSON might arrive split across two chunks. The `buf = lines.pop()` line is what handles that — save the trailing partial line, prepend it to the next chunk's decoded string.

### Move 2 — the walkthrough

#### The producer side — writing NDJSON in the route

The route opens a `ReadableStream<Uint8Array>` and stashes the controller. Every progress event from the agent loop calls `send(evt)`, which encodes the JSON plus a newline and enqueues bytes. From `app/api/agent/route.ts:188-201`:

```ts
const encoder = new TextEncoder();
const stream = new ReadableStream<Uint8Array>({
  async start(controller) {
    const collected: AgentEvent[] = [];
    const send = (e: AgentEvent) => {
      collected.push(e);
      controller.enqueue(encoder.encode(encodeEvent(e)));
    };
    // ... agent loop calls send(...) for each event ...
    controller.close();  // in finally
  },
});
return new Response(stream, { headers: NDJSON_HEADERS });
```

`encodeEvent(e)` (from `lib/mcp/events.ts`) is just `JSON.stringify(e) + '\n'`. That's the entire wire format — nothing fancier.

**Two producer-side details worth naming:**

**`collected` builds up in parallel.** The route stashes every event into a local array as well as enqueuing it. This lets the combined run (when `step == null`) save the full event sequence to disk for later demo replay:

```ts
// app/api/agent/route.ts:305-307
send({ type: 'done' });
// Only the combined run (capture) is cached to disk; the split steps are
// handed off via the client's sessionStorage.
if (step == null) saveInvestigation(insightId!, collected);
```

The stream is "live and captured" — the client sees events in real-time, and the same events land on disk for replay. Same producer, two consumers.

**Client cancellation propagates.** The route watches `req.signal.aborted` at coarse phase boundaries (bootstrap, listTools, each agent phase) AND threads the signal into every async layer. If the client closes the tab, the signal fires, in-flight MCP calls abort, and the route's catch swallows the AbortError without emitting an error event (no consumer to read it).

```ts
// app/api/agent/route.ts:313-315
if (e instanceof DOMException && e.name === 'AbortError') {
  return;
}
```

#### The consumer side — the `readNdjson` kernel

One kernel serves four hooks: `useBriefingStream`, `useInvestigation`, `useDemoCapture`, and the debug page's tool call. Consolidating the loop into one place means fixes land everywhere. From `lib/streaming/ndjson.ts:17-64`:

```ts
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
    reader.releaseLock();
  }
}
```

Walk it one part at a time:

**The kernel skeleton — what breaks when each part goes missing:**

1. `getReader()` — grabs the stream's reader lock. Without releasing it (`finally { reader.releaseLock() }`), a second consumer trying to read the same body would throw immediately.
2. `TextDecoder` with `stream: true` — decodes UTF-8 bytes across chunks. Without `stream: true`, a multi-byte character split across two chunks (which can happen with emoji or non-ASCII text) would decode as replacement characters.
3. `buf += decode(value)` + `buf.split('\n')` + `buf = lines.pop()` — the buffering pattern. Save the trailing partial line for the next chunk. **Without this, a JSON event split across chunks would fail to parse.** This is the load-bearing correctness detail.
4. `cancelOn` polled between reads — cooperative cancellation. Without it, an unmounted React consumer would keep processing bytes until the stream naturally ended, which could be minutes.
5. Malformed-line handler (default silent) — forward compatibility. **Without silent skipping of malformed lines, one bad line would abort the whole stream.**
6. Trailing-buffer flush at end-of-stream — handles producers that don't end with `\n`. In this repo they always do (`encodeEvent` adds it), so this is defensive belt-and-braces.

```
  readNdjson kernel — the skeleton parts

  ┌─ getReader / releaseLock  ← without: second consumer can't read
  │
  ├─ TextDecoder(stream:true) ← without: multibyte chars corrupt
  │
  ├─ buf accumulation        ← without: split events fail to parse
  │  buf.split('\n')             LOAD-BEARING CORRECTNESS
  │  buf = lines.pop()
  │
  ├─ cancelOn polling        ← without: unmounted consumer keeps reading
  │
  ├─ silent malformed skip   ← without: one bad line kills the stream
  │
  └─ trailing buffer flush   ← without: producer omitting \n loses last event
```

#### One consumer walked — `useBriefingStream`

The hook opens `fetch`, dispatches on `Content-Type` (JSON snapshot vs NDJSON stream), and for the NDJSON path calls `readNdjson` with a handler that dispatches on event type. From `lib/hooks/useBriefingStream.ts:213-299`:

```ts
const handle = (evt: BriefingEvent) => {
  switch (evt.type) {
    case 'workspace':
      setWorkspace(evt.workspace);
      break;
    case 'coverage_item':
      setCoverage((prev) =>
        prev.some((c) => c.category === evt.item.category) ? prev : [...prev, evt.item],
      );
      break;
    case 'coverage':
      setCoverage(evt.coverage);
      break;
    case 'tool_call_start':
      setQueryCount((n) => n + 1);
      setTraceItems((prev) => [
        ...prev,
        { kind: 'tool', id: crypto.randomUUID(), toolName: evt.toolName, status: 'running', ts: Date.now() },
      ]);
      break;
    // ... (reasoning_step, tool_call_end, insight, done, error) ...
  }
};

await readNdjson<BriefingEvent>(res.body, handle, { cancelOn: () => cancelledRef.current });
```

The consumer's job is just "map wire events to React state updates." The kernel handles the byte-level correctness; the hook handles the semantic dispatch.

#### The reconnect story — no resumable stream, just a full retry

NDJSON over `fetch` has no built-in resume semantics. If the connection drops mid-stream, the client doesn't have a way to say "give me events from position N onwards." It has to open a fresh `fetch` from scratch.

For most failures this is fine (an error event → user sees the error), but for one specific failure — the alpha Bloomreach server revoking its OAuth token mid-session — the app auto-reconnects. From `lib/hooks/useReconnectPolicy.ts:33-45`:

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

The flow when a revoked-token error surfaces as an NDJSON `error` event:

1. `useBriefingStream`'s handler sees `case 'error':` and calls `callbacks.onAuthError(msg)`.
2. `useBriefingStream`'s consumer passes `reconnectPolicy.handle` as `onAuthError`.
3. `handle(msg)` checks `isAuthErrorAuto` (long regex — auto path). If it matches, and this is the first attempt this session, set a `sessionStorage['bi:reconnecting']` flag, `POST /api/mcp/reset` to clear server-side auth state, then `window.location.href = '/'` to reload the app.
4. On reload, the missing auth triggers the OAuth flow.

The one-shot guard (`sessionStorage['bi:reconnecting']`) prevents an infinite reload loop if the reconnect itself fails.

```
  Revoked-token reconnect flow

  stream event: { type: 'error', message: 'invalid_token: ...' }
      │
      ▼
  handle(evt) → callbacks.onAuthError(msg)
      │
      ▼
  reconnectPolicy.handle(msg):
    if isAuthErrorAuto(msg) && !sessionStorage['bi:reconnecting']:
      set sessionStorage['bi:reconnecting'] = '1'
      fetch('/api/mcp/reset', { method: 'POST' })
      window.location.href = '/'
      return true  ← caller bails
      │
      ▼
  page reloads → OAuth flow fires → user re-auths (or sees IdP consent)
      │
      ▼
  new stream opens → clearFlag() on 'done' event
```

This is the **poor-man's resumable-stream** — the app fakes resume by opening a fresh session and restarting the whole request. Not free, but predictable and works with any HTTPS infrastructure.

#### Why NDJSON — the alternatives ranked

**Why not WebSockets.** Vercel's standard Node runtime doesn't support them. Moving to a different runtime (or self-hosting) would introduce operational complexity (connection lifecycle management, load-balancer sticky-sessions, backpressure semantics). WebSockets would matter if you needed bidirectional messages after the initial request; this app only needs server → client push during an in-flight request, which is what a chunked response body already gives you.

**Why not Server-Sent Events.** SSE would work — same fetch-based streaming, same Vercel-Node-compatible transport. The wire format is different (`event: name\ndata: {...}\n\n` with blank-line delimiters). For a single stream serving structured events, NDJSON is simpler: one line = one event, no `event:` / `data:` framing overhead. The kernel is also smaller (no double-newline delimiter parsing). If the app needed named event types with EventSource's built-in `addEventListener('name', ...)` dispatch, SSE would be more ergonomic — but the type-tagged JSON pattern (`evt.type === 'coverage'`) covers the same need in the app's existing switch statement.

**Why not long-polling.** Would require repeated request/response cycles, each paying a full TCP+TLS handshake plus cookie transmission. NDJSON reuses one socket for the whole stream, which is strictly better on latency and cost.

```
  Ranked alternatives — NDJSON won

  NDJSON over fetch     ✓ ← chosen
    + works on Vercel Node runtime
    + one open socket per stream
    + one kernel, four consumers
    + wire format = JSON per line (trivial)
    - no built-in resume (fake it with retry)

  SSE (text/event-stream)
    + also works on Vercel
    + built-in retry semantics (browser-managed)
    + named events → addEventListener dispatch
    - framing overhead (event: / data: / blank line)
    - only one stream per EventSource connection

  WebSockets
    + bidirectional
    + persistent connection outlives request
    - NOT supported on Vercel standard tier
    - overkill for server-push-only
    - complex lifecycle (heartbeat, reconnect)

  Long-polling
    + universal HTTP support
    - each poll pays handshake + cookie
    - strictly worse than NDJSON
```

### Move 3 — the principle

**The smallest correct thing that keeps working is worth more than the most powerful thing that mostly works.** NDJSON over fetch is a five-line producer, a 40-line consumer kernel, one HTTPS response body — and it survives every environment this app runs in (Vercel Node, local dev, tests). WebSockets would be more powerful for what you can do; NDJSON is more powerful for what won't break. For a server-push-only channel behind a request/response boundary, the smallest option is the right one.

## Primary diagram

```
  Streaming — one shape, four consumers, one recovery path

  ┌─ Route (producer) ─────────────────────────────────────────┐
  │                                                            │
  │  new ReadableStream<Uint8Array>({                          │
  │    async start(controller) {                               │
  │      const collected: AgentEvent[] = [];                   │
  │      const send = (e) => {                                 │
  │        collected.push(e);                                  │
  │        controller.enqueue(encoder.encode(                  │
  │          JSON.stringify(e) + '\n'                          │
  │        ));                                                 │
  │      };                                                    │
  │                                                            │
  │      // agent loop calls send(...) as events fire          │
  │      send({ type: 'workspace', ... });                     │
  │      send({ type: 'coverage_item', ... });                 │
  │      send({ type: 'reasoning_step', ... });                │
  │      send({ type: 'tool_call_start', ... });               │
  │      send({ type: 'tool_call_end', ... });                 │
  │      send({ type: 'insight', ... });                       │
  │      send({ type: 'done' });                               │
  │                                                            │
  │      // saveInvestigation(id, collected) — capture to disk │
  │      controller.close();                                   │
  │    }                                                       │
  │  })                                                        │
  │                                                            │
  │  Response headers:                                         │
  │    Content-Type: application/x-ndjson; charset=utf-8       │
  │    Cache-Control: no-cache, no-transform                   │
  └────────────────────────┬───────────────────────────────────┘
                           │  chunked transfer
                           │  { event }\n{ event }\n{ event }\n
                           │  (server keeps writing)
                           ▼
  ┌─ Wire ─────────────────────────────────────────────────────┐
  │  bytes flow chunk-by-chunk; no state on the wire itself    │
  └────────────────────────┬───────────────────────────────────┘
                           ▼
  ┌─ Client — readNdjson kernel (lib/streaming/ndjson.ts) ─────┐
  │                                                            │
  │  reader = body.getReader()                                 │
  │  decoder = new TextDecoder()                               │
  │  buf = ''                                                  │
  │  while (true):                                             │
  │    if cancelOn?.(): reader.cancel(); return;               │
  │    { value, done } = await reader.read()                   │
  │    if done: break                                          │
  │    buf += decoder.decode(value, { stream: true })          │
  │    lines = buf.split('\n')                                 │
  │    buf = lines.pop() ?? ''       ← save partial line       │
  │    for line of lines:                                      │
  │      if !line.trim(): continue                             │
  │      try: onEvent(JSON.parse(line))                        │
  │      catch: opts.onMalformed?.(line, err) ← silent skip    │
  │  // flush trailing buffer                                  │
  │  if buf.trim(): try onEvent(JSON.parse(buf))               │
  └────────────────────────┬───────────────────────────────────┘
                           ▼
  ┌─ Four consumers ───────────────────────────────────────────┐
  │                                                            │
  │  useBriefingStream       → briefing feed                   │
  │  useInvestigation        → per-anomaly investigation       │
  │  useDemoCapture          → snapshot capture flow           │
  │  debug page tool call    → introspection UI                │
  │                                                            │
  │  each dispatches its event union → React state updates     │
  │                                                            │
  └────────────────────────┬───────────────────────────────────┘
                           │
                           ▼ (if evt.type === 'error' with auth-shaped msg)
  ┌─ useReconnectPolicy (recovery path) ───────────────────────┐
  │                                                            │
  │  1. long regex match on msg                                │
  │  2. one-shot guard via sessionStorage flag                 │
  │  3. POST /api/mcp/reset (clear server auth state)          │
  │  4. window.location.href = '/' → full page reload          │
  │  5. missing auth → OAuth flow → new stream opens           │
  │                                                            │
  │  the poor-man's resumable-stream: fresh request, no resume │
  └────────────────────────────────────────────────────────────┘
```

## Elaborate

**Where this pattern comes from.** NDJSON's ancestor is Twitter's Streaming API (2010-ish) — a chunked HTTP response body carrying one JSON tweet per line. It became a broader pattern once `fetch` gained streaming response bodies (2016-ish). The load-bearing insight is that HTTP's chunked-transfer-encoding is already a stream; a JSON-per-line format is the simplest way to frame events on top of it. No new protocol needed.

**Why one kernel serves four consumers matters.** The four hooks (`useBriefingStream`, `useInvestigation`, `useDemoCapture`, debug page tool-call handler) each need the exact same byte-level loop. Duplicating it means a bug in one place (say, forgetting `stream: true` on the TextDecoder) landing in one consumer while the other three work. Consolidating means fixes land everywhere at once. The kernel is 40 lines and covers every consumer's needs; the discipline is worth the modest overhead of the callback-based API.

**On the reconnect regex divergence.** `useReconnectPolicy` intentionally keeps two regexes — the long one for automatic reconnection (NDJSON error handler), the short one for the manual "reconnect" button. The long one includes `invalid_token` and `reconnect`; the short one doesn't. The divergence is a known latent bug (the button should match everything the auto path matches), but unifying them requires manual verification against live Bloomreach responses, which isn't a lightweight change. The hook comment names this explicitly.

**What's not exercised.** SSE (`text/event-stream` with `EventSource`). WebSockets. Server push over HTTP/2. Resumable streams (would need a client-tracked `last-event-id` and server-side event log). Backpressure (writes are unbounded — the route trusts the client to consume fast enough; a slow reader would fill Node's write buffer but not deadlock, because the events are relatively small).

**Streaming Anthropic responses.** The route currently uses `messages.create` (non-streaming) — the full response comes back in one call, and the route emits its own `reasoning_step` events based on the completed content. If the app wanted the model's thinking to stream token-by-token, it could switch to `messages.stream` and forward each token as an event. Not exercised yet; would be a natural extension.

## Interview defense

**Q: You picked NDJSON over SSE and WebSockets — walk me through why.**

Three constraints:

1. Vercel's standard Node runtime doesn't support WebSockets. Rules them out unless we move off Vercel.
2. The channel is server → client only, during an in-flight request. Bidirectional persistence (what WebSockets buy you) isn't needed.
3. The wire needs to be simple enough that one 40-line kernel serves all four consumers (briefing, investigation, capture, debug).

NDJSON over fetch response bodies: 5-line producer (`controller.enqueue(encoder.encode(JSON.stringify(e) + '\n'))`), 40-line consumer kernel, works on every Vercel runtime, no framing overhead.

SSE would work too — same fetch-based streaming — but adds `event:` / `data:` / blank-line delimiters for zero benefit when we're already type-tagging JSON with `evt.type`. And EventSource's built-in retry, while nice, is orthogonal to our OAuth-revocation reconnect case (which needs a full re-auth, not a resume).

**Q: What's the load-bearing part of the readNdjson kernel that people forget?**

The buffering across chunks — `buf += decode(chunk); lines = buf.split('\n'); buf = lines.pop()`. TCP doesn't guarantee that each chunk from `reader.read()` ends on a newline, so a single event's JSON can arrive split across two chunks. If you naively parse each chunk without accumulating a buffer, you'd get JSON parse errors on split events.

The other half is `TextDecoder({ stream: true })` — without it, a multi-byte UTF-8 character split across chunks decodes as replacement characters. Both details together are what make the kernel robust; skipping either one gives you a stream that works most of the time and fails weirdly under load.

Anchor: `lib/streaming/ndjson.ts:17-64`.

**Q: How does the app handle the alpha Bloomreach server revoking your OAuth token mid-session?**

The revocation surfaces as an NDJSON `error` event with a message matching `/invalid_token|unauthor|forbidden|401|session expired|reconnect/i`. `useReconnectPolicy.handle(msg)`:

1. Checks the regex.
2. Checks a `sessionStorage['bi:reconnecting']` one-shot guard so we don't infinite-loop.
3. `POST /api/mcp/reset` clears the server-side auth state.
4. `window.location.href = '/'` triggers a full page reload.
5. On reload, the OAuth flow fires again, user re-auths (or gets consented silently if the IdP still remembers them).

This is a full "poor-man's resumable stream" — no server-side event log, no `last-event-id`, just fresh request from scratch. Works because our streams are short (seconds to minutes) and the alternative (implementing proper resumable streaming) is much larger surface area for one specific alpha-server quirk.

Anchor: `lib/hooks/useReconnectPolicy.ts:33-111`.

## See also

- `05-http-semantics-caching-and-cors.md` — the `Content-Type` dispatch and `no-cache, no-transform` that keep the stream intact
- `03-tcp-udp-connections-and-sockets.md` — why the inbound socket stays open for the whole stream
- `07-timeouts-retries-pooling-and-backpressure.md` — how per-call timeouts on the outbound side let the inbound stream close gracefully
