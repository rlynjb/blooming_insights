# NDJSON stream reader hook

**Streaming response consumer / newline-delimited JSON parser** — Industry standard (as a pattern; the specific kernel is project-specific).

## Zoom out, then zoom in

You've written `fetch()` a thousand times. `res.json()` reads the whole body, parses it, hands you the object. Done. For blooming insights that's the wrong shape — the *entire product pitch* is that the user watches the agent think. If the UI waits for the full response, the "shows its work" surface is dead.

```
  Zoom out — where the NDJSON reader hook lives

  ┌─ Browser ────────────────────────────────────────────────┐
  │  React 19 client                                         │
  │   ┌─ useBriefingStream ─────────────────────────────┐    │
  │   │  fetch → ★ readNdjson ★ → handle(evt) → setState│    │
  │   └─────────────────────────────────────────────────┘    │
  │   ┌─ useInvestigation ──────────────────────────────┐    │
  │   │  fetch → ★ readNdjson ★ → handle(evt) → setState│    │
  │   └─────────────────────────────────────────────────┘    │
  │   ┌─ StreamingResponse ─────────────────────────────┐    │
  │   │  fetch → ★ readNdjson ★ → handle(evt) → setState│    │
  │   └─────────────────────────────────────────────────┘    │
  │   ┌─ useDemoCapture ────────────────────────────────┐    │
  │   │  fetch → ★ readNdjson ★ → drain until 'done'    │    │
  │   └─────────────────────────────────────────────────┘    │
  └────────────────────────┬─────────────────────────────────┘
                           │  HTTP response body as ReadableStream<Uint8Array>
                           │  content-type: application/x-ndjson
  ┌─ Next.js API route ────▼─────────────────────────────────┐
  │  /api/briefing · /api/agent                              │
  │  writes JSON.stringify(event) + '\n' per NDJSON line     │
  └──────────────────────────────────────────────────────────┘
```

**Zoom in — the concept.** The response body is a `ReadableStream<Uint8Array>`. You read it as bytes, decode to UTF-8, split on `\n`, `JSON.parse` each line, and call a handler for each event as it arrives. That's the pattern the industry calls **NDJSON** (newline-delimited JSON). The kernel is 40 lines of loop. This file is about how those 40 lines carry four separate user-facing surfaces without duplicating themselves.

## The structure pass

Layers — the reader sits between HTTP and React state:

```
  Three layers, one axis (control), two seams

  ┌─ HTTP body ──────────────────────────────┐  bytes-in, in order
  │  ReadableStream<Uint8Array>              │  producer decides pace
  └──────────────┬───────────────────────────┘
                 │  seam A — bytes → strings → events
                 │  the ★ readNdjson ★ kernel
                 ▼
  ┌─ Event handler ──────────────────────────┐  ONE event at a time
  │  onEvent(evt): switch (evt.type) { ... } │  hook decides state shape
  └──────────────┬───────────────────────────┘
                 │  seam B — events → setState calls
                 ▼
  ┌─ React state ────────────────────────────┐  UI reflects each event
  │  useState arrays that grow with the      │  React decides commit timing
  │  stream (traceItems, insights, coverage) │
  └──────────────────────────────────────────┘
```

**Axis: control.** Trace it top to bottom.
- HTTP body — the **server** decides when the next chunk lands.
- `readNdjson` — the **kernel** decides when to break out (via the `cancelOn` callback the caller passes).
- Handler — the **hook** decides which events matter and how they mutate state.
- React state — **React** decides when the commit runs.

The axis flips at every seam. That's what makes seam A load-bearing: bytes go in, discrete events come out. Anyone who wants to consume the stream differently (e.g. `useDemoCapture` which only cares about `done` and `error`) swaps the handler and gets the same parse guarantees.

## How it works

### Move 1 — the mental model

You know how a `fetch()` response has a `.json()` method that reads the whole body and parses it once? `readNdjson` is the same idea, but instead of *one* parse it does *N* parses — one per newline-terminated JSON object in the body — and calls a handler for each. The producer writes `{event1}\n{event2}\n{event3}\n`; the consumer sees `handle(event1)`, `handle(event2)`, `handle(event3)` in order, as bytes arrive.

```
  The kernel — a byte-buffer loop with one exit condition

  ┌────────────────────────────────────────────┐
  │  buf = ""                                  │
  │  loop:                                     │
  │    if cancelled → cancel reader, return    │  ← the ONE way out
  │    { value, done } = await reader.read()   │
  │    if done → break                         │
  │    buf += decode(value)                    │
  │    lines = buf.split('\n')                 │
  │    buf = lines.pop()                       │  ← keeps the incomplete tail
  │    for each line: JSON.parse → onEvent     │
  │  flush trailing buf                        │  ← in case producer omits final \n
  └────────────────────────────────────────────┘
```

The load-bearing bit is `buf = lines.pop()`. The last "line" produced by `split('\n')` is *whatever came after the last `\n` in this chunk* — which is either an empty string (the chunk ended cleanly) or a *partial* event that will finish in the next chunk. You put it back into `buf` so the next iteration's decode gets concatenated onto it and re-splits. Miss that step and every event that arrives across a chunk boundary gets silently dropped.

### Move 2 — the walkthrough

#### Sub-move A — the byte reader and the decoder

`ReadableStream<Uint8Array>` gives you a reader. Each `read()` returns `{ value: Uint8Array | undefined, done: boolean }`. `TextDecoder` with `{ stream: true }` handles UTF-8 code points that span chunk boundaries — one 4-byte UTF-8 character split across two chunks won't corrupt.

```
  Layers-and-hops — bytes to events, one chunk at a time

  ┌─ HTTP body ────┐  hop 1: reader.read()      ┌─ decoder ──────┐
  │ ReadableStream │ ─────────────────────────► │  TextDecoder   │
  │ <Uint8Array>   │                             │  { stream:true}│
  └────────────────┘                             └────────┬───────┘
                                                          │ hop 2: decode(value)
                                                          ▼
                                                ┌─ string buffer ┐
                                                │  buf += chunk  │
                                                └────────┬───────┘
                                                          │ hop 3: split('\n')
                                                          ▼
                                                ┌─ event dispatch┐
                                                │  onEvent(evt)  │
                                                └────────────────┘
```

The reader from `body.getReader()` locks the stream — only one reader at a time. `releaseLock()` in `finally` cleans up so the stream can be cancelled by whoever holds the body next.

**The actual code, side by side with what each part does** (`lib/streaming/ndjson.ts:14-64`):

```ts
export async function readNdjson<E>(
  body: ReadableStream<Uint8Array>,           // ← the response body
  onEvent: (event: E) => void,                // ← the caller's dispatch
  opts?: {
    cancelOn?: () => boolean;                 // ← polled between reads
    onMalformed?: (line: string, err: unknown) => void;  // ← silent by default
  },
): Promise<void> {
  const reader = body.getReader();            // ← locks the stream
  const decoder = new TextDecoder();          // ← UTF-8, streaming mode
  let buf = '';
  try {
    while (true) {
      if (opts?.cancelOn?.()) {               // ← the ONE exit condition
        await reader.cancel();                //   caller flipped a ref
        return;
      }
      const { value, done } = await reader.read();
      if (done) break;                        // ← producer said "no more"
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';                // ← keep incomplete tail
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;                  // ← skip blank lines
        try {
          onEvent(JSON.parse(line) as E);
        } catch (err) {
          opts?.onMalformed?.(line, err);     // ← silent unless caller cares
        }
      }
    }
    // flush trailing buffer (no-op when producer terminates with '\n')
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

Three details worth calling out because they're where identical-looking implementations get subtly wrong:

- **`{ stream: true }` on the decoder** — required. Without it, a UTF-8 code point split across chunk boundaries gets replaced with `U+FFFD`.
- **`lines.pop() ?? ''`** — the incomplete-tail step. This is the one every newcomer forgets; drop it and multi-chunk events silently vanish.
- **The flush-after-loop block** — belt and suspenders. The producer here always writes a terminal `\n` (see `lib/mcp/events.ts` per project context), so the tail is empty. But keeping it means the reader is correct against any producer that omits the final newline.

#### Sub-move B — the cancellation seam

The `cancelOn` callback polled between reads is how React tells the reader to stop. `useBriefingStream` writes to a ref on effect cleanup; the reader polls that ref before each `read()` and bails.

Compare with the naive alternative (`AbortController`):

```
  Comparison — cancellation via ref vs AbortController

  ┌─ ref-based (this repo)   ┐    ┌─ AbortController (alt)      ┐
  │ effect body:              │    │ effect body:                │
  │   cancelledRef.current    │    │   const c = new AbortCtrl() │
  │     = false               │    │   fetch(url, { signal:c.si })│
  │   fetch(url) →             │    │   await readNdjson(res.body,│
  │   readNdjson(res.body,     │    │     handle,                 │
  │     handle,                │    │     { signal: c.signal })   │
  │     { cancelOn: () =>      │    │                             │
  │       cancelledRef.current})│    │ cleanup:                    │
  │                           │    │   c.abort()                 │
  │ cleanup:                  │    │ → fetch throws AbortError   │
  │   cancelledRef.current    │    │   readNdjson mid-flight     │
  │     = true                │    │   throws too                │
  └──────────────────────────┘    └────────────────────────────┘
      one flag, no exception          throwing exception per unmount
      polled between reads            requires try/catch on caller
```

The ref approach is chosen because a React StrictMode double-mount (dev only) fires an immediate cleanup, and `useInvestigation` deliberately does NOT cancel on cleanup — the comment at `useInvestigation.ts:33-37` explains: cancelling on the first StrictMode cleanup, combined with the `startedRef` guard blocking the re-mount, left the logs empty. So the ref pattern gives each caller the choice: pass a `cancelOn` (like `useBriefingStream`), or omit it (like `useInvestigation`).

`useBriefingStream.ts:130-152` and its cleanup at line 297-299:

```ts
const cancelledRef = useRef(false);

useEffect(() => {
  // ...
  cancelledRef.current = false;                     // ← reset for THIS run
  // ...
  await readNdjson<BriefingEvent>(
    res.body,
    handle,
    { cancelOn: () => cancelledRef.current },       // ← polled between reads
  );
  // ...
  return () => {
    cancelledRef.current = true;                    // ← flip on unmount / re-run
  };
}, [mode, ready]);
```

#### Sub-move C — the four consumers, one kernel

Each of the four call sites wraps `readNdjson` with a different `onEvent` handler. Same kernel; different event vocabulary.

```
  Four consumers of the same kernel

  ┌─ readNdjson ──────────────────────────────────────────────┐
  │  generic over event type E                                 │
  │  parses lines, calls onEvent(E)                            │
  └──────────────────────────┬─────────────────────────────────┘
                             │
        ┌────────────────────┼────────────────────┬────────────────────┐
        │                    │                    │                    │
  ┌─────▼─────┐        ┌─────▼─────┐        ┌─────▼─────┐        ┌─────▼─────┐
  │ Briefing  │        │ Investig- │        │ Streaming │        │ DemoCap-  │
  │  Event    │        │  ation    │        │  Response │        │  ture     │
  │           │        │  (Agent   │        │  (Agent   │        │           │
  │ workspace │        │   Event)  │        │   Event)  │        │ Only      │
  │ coverage_ │        │           │        │           │        │  cares    │
  │  item     │        │ reasoning │        │ reasoning │        │  about    │
  │ coverage  │        │  _step    │        │  _step    │        │  done +   │
  │ tool_call │        │ tool_call │        │ tool_call │        │  error    │
  │  _start   │        │  _start   │        │  _start   │        │           │
  │ tool_call │        │ tool_call │        │ tool_call │        │           │
  │  _end     │        │  _end     │        │  _end     │        │           │
  │ reasoning │        │ diagnosis │        │ done      │        │           │
  │  _step    │        │ recommen- │        │ error     │        │           │
  │ insight   │        │  dation   │        │           │        │           │
  │ done      │        │ done      │        │           │        │           │
  │ error     │        │ error     │        │           │        │           │
  └───────────┘        └───────────┘        └───────────┘        └───────────┘
   9 cases              7 cases              5 cases             2 cases
```

- `useBriefingStream.ts:288` — 9-case switch over `BriefingEvent` (`workspace`, `coverage_item`, `coverage`, `tool_call_start`, `tool_call_end`, `reasoning_step`, `insight`, `done`, `error`).
- `useInvestigation.ts:194` — 7-case switch over `AgentEvent` (adds `diagnosis` and `recommendation`, drops `workspace` and `coverage_*`).
- `StreamingResponse.tsx:108` — 5-case switch (the free-form Q&A only needs `reasoning_step` for trace + the coordinator's `conclusion` for the answer, `tool_call_start`/`end` for tools, `done`, `error`).
- `useDemoCapture.ts:84` — the loosest consumer: `evt.type === 'done'` / `'error'` — that's it. The kernel gives you generic type inference, so the caller can narrow to just what it needs.

The load-bearing test: strip `readNdjson` and you re-write this loop four times. Each rewrite has the same three subtle-bugs-waiting-to-happen (incomplete tail, UTF-8 boundaries, cancellation seam). Centralizing the kernel is why the whole surface is stable at 221 passing tests without integration tests on every consumer.

### Move 3 — the principle

**Bytes-to-events belongs in one function, not four.** The reader-decoder-buffer-split-parse loop is a *kernel* in the load-bearing-skeleton sense — remove any part and the pattern breaks. Isolating it once and letting four surfaces reach for it is what a **deep module** in the Ousterhout sense looks like in a frontend codebase: shallow interface (three parameters — body, onEvent, opts), deep implementation (the UTF-8 boundary handling, the trailing-tail flush, the malformed-line silence). That's `readNdjson`.

## Primary diagram — recap

The kernel, its two seams, and where it sits in the request-response flow.

```
  The full pattern — one kernel, one exit condition, four handlers

  ┌─ Producer (Next.js API route) ─────────────────────────────┐
  │  writes: JSON.stringify(event) + '\n' per event            │
  │  content-type: application/x-ndjson                        │
  └────────────────────────┬───────────────────────────────────┘
                           │  HTTP body (streamed)
                           │  ReadableStream<Uint8Array>
                           ▼
  ┌─ readNdjson<E> — lib/streaming/ndjson.ts:14-64 ────────────┐
  │  reader = body.getReader()                                 │
  │  decoder = new TextDecoder()                               │
  │  buf = ""                                                  │
  │  loop {                                                    │
  │    if cancelOn?.() → cancel + return                       │
  │    { value, done } = await reader.read()                   │
  │    if done → break                                         │
  │    buf += decoder.decode(value, { stream: true })          │
  │    lines = buf.split('\n')                                 │
  │    buf = lines.pop() ?? ''      ← the incomplete tail      │
  │    for line in lines: onEvent(JSON.parse(line))            │
  │  }                                                         │
  │  flush(buf)                                                │
  └────────────────────────┬───────────────────────────────────┘
                           │  onEvent(evt: E)  — one at a time
                           ▼
  ┌─ Four consumers, four handlers ────────────────────────────┐
  │                                                             │
  │  useBriefingStream       →  9-case switch → setState * N   │
  │  useInvestigation        →  7-case switch → setState * N   │
  │  StreamingResponse       →  5-case switch → setState * N   │
  │  useDemoCapture          →  2-case switch → return result  │
  │                                                             │
  └─────────────────────────────────────────────────────────────┘
```

## Elaborate

**Where NDJSON came from and why not SSE / WebSocket.**

NDJSON is a settled convention (see `ndjson.org`, `jsonlines.org`) — it predates the modern streaming APIs and is popular because every language can `split('\n')` and `JSON.parse`. The alternatives:

- **Server-Sent Events (`EventSource`)** — the classic browser API for server push. Auto-reconnect built in, event IDs, retry policy. Cons: text-only, no headers control (no auth headers on the initial request in most browsers), one direction, HTTP/1.1 opens six connections max per origin.
- **WebSocket** — bidirectional, framed, browser-supported. Cons: separate protocol upgrade, no built-in JSON framing, requires a server that speaks WS. Overkill for a one-way stream.
- **Fetch + ReadableStream + NDJSON** — this repo. HTTP/2 friendly, standard `fetch()` semantics (auth headers, cookies, CORS, `Response` cancellation), any framing you want. Cons: you own the parsing loop and the reconnect policy.

The repo picks the fetch+NDJSON path for two concrete reasons: (1) the auto-reconnect policy in `useReconnectPolicy` is bespoke (auth-shaped error → reset endpoint → full reload) — SSE's built-in retry doesn't help; (2) the "demo vs live" branching depends on `content-type` (`useBriefingStream.ts:187` — plain JSON vs NDJSON) which is trivial with `fetch` and awkward with `EventSource`.

**Where the pattern connects to adjacent concepts.**

- **Reactive streams / RxJS observables** — same idea, dressed up. `readNdjson` is essentially a hand-rolled `Observable<E>` with a `subscribe(onEvent)` shaped as a callback. The repo doesn't pull in RxJS because the four call sites don't need operator composition (`filter`, `map`, `merge`); each handler is a switch statement.
- **Async iterators** — you could write `readNdjson` as `async function* readNdjson(): AsyncIterable<E>` and consume with `for await`. This repo chose the callback shape because it composes cleaner with `switch` inside a `useEffect` and doesn't require awaiting the iterator's `next()` inside a React lifecycle.
- **Backpressure** — `ReadableStream` supports it via the reader's implicit pull-based model (each `read()` requests one chunk). The kernel here is naturally backpressured — if the handler is slow, the next `read()` doesn't fire until the handler returns. Cross-link: `study-runtime-systems` for how this composes with the event loop.

## Interview defense

**Q: Walk me through how the streaming trace on the feed gets from Anthropic to the DOM.**

Diagram you sketch:

```
  ┌─ Claude ──┐  events   ┌─ /api/briefing ─┐  NDJSON  ┌─ browser ─┐
  │  agent    │─────────► │  agent loop      │────────► │ readNdjson│
  │  loop     │           │  encodeEvent()   │  stream  │  onEvent  │
  └───────────┘           │  + '\n' per line │          │  → setState│
                          └──────────────────┘          │  → React  │
                                                        │    diff    │
                                                        │  → DOM    │
                                                        └───────────┘
```

Answer, in order: Anthropic streams tokens to the agent loop in the API route. The loop writes each `AgentEvent` (`reasoning_step`, `tool_call_start`, etc.) to the response body as `JSON.stringify(event) + '\n'` — that's the NDJSON framing. On the browser, `useBriefingStream` fires `fetch()`, gets a `ReadableStream` body, hands it to `readNdjson`. The kernel loops on `reader.read()`, decodes UTF-8, splits on newline, JSON.parses each line, calls the hook's `handle(evt)` — a `switch` over 9 event types. Each case does one `setState`; React reconciles. The trace grows one item at a time, visible.

The load-bearing part people forget: the `buf = lines.pop() ?? ''` line. That's the incomplete-tail handling. Chunks arrive at arbitrary byte boundaries — an event's JSON can start in chunk N and finish in chunk N+1. You keep the tail, prepend it to the next decode, re-split. Drop that line and events that straddle chunk boundaries silently vanish. Anchor: `lib/streaming/ndjson.ts:42`.

**Q: Why not `EventSource`?**

Two reasons specific to this app. First, the auto-reconnect policy has to hit `/api/mcp/reset` (server clears the encrypted-cookie OAuth store), then reload the whole page — SSE's built-in retry can't do the reset step. Second, the demo path serves plain JSON, and the same hook needs to branch on `content-type`; `EventSource` locks you into `text/event-stream`. `fetch()` gives me both.

**Q: What happens if the connection drops mid-stream?**

`await reader.read()` throws. The caller's `try/catch` in `useBriefingStream.ts:289` catches it. If the effect wasn't cancelled (`cancelledRef.current === false`), the error goes to `setErrorMessage` + `setStatus('error')`. The user sees the last message. There's no automatic retry — the "auto-reconnect" flow is triggered by an `invalid_token`-shaped **application** error, not by a network failure. That's honest: a real network flake shows the user "connection dropped" and lets them reload. A revoked OAuth token is a business-level condition that gets its own handling.

## See also

- `02-progressive-skeleton-with-stepper.md` — the *consumers* of the stream, from the UI side: how each event maps to a visible state change and how the stepper / skeleton / status log stay coordinated.
- `audit.md` — the state-architecture lens for where the parsed events end up (`useState` slices, `sessionStorage`) and the frontend-red-flags lens for the missing `aria-live` on the trace.
- `study-networking` — wire-level: keep-alive, chunked encoding, HTTP/2 stream multiplexing, why the response stays open.
- `study-runtime-systems` — event-loop level: how `await reader.read()` yields and where microtasks slot in relative to the handler's `setState` calls.
- `study-software-design` — deep-module analysis of `readNdjson` as an APOSD example: shallow interface, deep implementation.
