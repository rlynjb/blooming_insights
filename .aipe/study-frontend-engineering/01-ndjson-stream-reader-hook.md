# NDJSON stream reader hook

**Subtitle:** browser-side NDJSON consumer over `fetch` + `ReadableStream` (industry-standard streaming pattern), wrapped in a React custom hook that owns a state dispatcher. Local term: the kernel (`readNdjson`); the consumers (`useBriefingStream`, `useInvestigation`, `useDemoCapture`, `StreamingResponse`).

## Zoom out, then zoom in

**Zoom out — where this concept lives.** This is the seam where server-side streaming becomes browser-side state. Every "the agent is working" thing the user sees on screen — the trace lines arriving one by one, the coverage tiles checking in one at a time, the insights popping into the feed as monitoring finishes them — crosses this boundary.

```
  Zoom out — the streaming seam, in one picture

  ┌─ UI layer (client components) ───────────────────────────────┐
  │  app/page.tsx                                                │
  │  app/investigate/[id]/page.tsx                               │
  │  app/investigate/[id]/recommend/page.tsx                     │
  │  components/chat/StreamingResponse.tsx                       │
  └──────────────────────────┬───────────────────────────────────┘
                             │  consumes return value of
  ┌─ The hook (custom hook in lib/hooks) ────────────────────────┐
  │  useBriefingStream       ← /api/briefing                     │
  │  useInvestigation        ← /api/agent?step=…                 │ ← we are here
  │  useDemoCapture          ← /api/agent (drain)                │
  │  StreamingResponse       ← /api/agent?q=…                    │
  └──────────────────────────┬───────────────────────────────────┘
                             │  delegates the parse loop to
  ┌─ The kernel (lib/streaming/ndjson.ts) ───────────────────────┐
  │  ★ readNdjson(body, onEvent, opts) ★                         │
  │  fetch → reader → TextDecoder → split('\n') → JSON.parse     │
  └──────────────────────────┬───────────────────────────────────┘
                             │  HTTP over the wire (Content-Type: ndjson)
  ┌─ The producer (app/api/*/route.ts) ──────────────────────────┐
  │  ReadableStream + encodeEvent + controller.enqueue           │
  └──────────────────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** Streaming the agent's work to the browser without WebSocket and without Server-Sent Events. You ask "is there a primitive in plain `fetch` that lets the server push lines and the browser handle them as they arrive?" — yes: a `ReadableStream` body, read chunk by chunk, with JSON-per-line as the format. Two design choices the repo made deliberately: (1) NDJSON, not SSE — because `EventSource` doesn't support custom headers (no auth) and doesn't support `POST`; (2) the parse loop is centralized so four consumers don't each ship a different `split('\n')` bug.

The question this concept answers: **how do you get streamed agent events from a serverless route to a React component's state, in a way that survives StrictMode, mid-stream cancellation, and a 30-60s budget?**

## Structure pass

Layers, axis, seams — before we touch the kernel.

### Layers

Three nested layers, named once:

```
  outer — the consumer hook (or component)
          owns useState, useEffect, lifecycle, callbacks

      inner — the kernel (readNdjson)
              owns the read/decode/split/parse loop

          innermost — the browser primitive
                      (ReadableStreamDefaultReader, TextDecoder)
```

### Axis — control flow

We trace ONE question down the layers: **who decides what happens next?**

```
  Tracing "who decides control flow" down the layers

  ┌──────────────────────────────────────────────┐
  │ outer: consumer hook                         │   → REACT decides
  │  (useEffect runs on mount; cleanup on        │     (mount, unmount,
  │   unmount; setState re-renders the tree)     │      dep-change re-fire)
  └──────────────────────────────────────────────┘
      ┌────────────────────────────────────────────┐
      │ inner: readNdjson                          │   → KERNEL decides
      │  (while(true) loop; cancelOn poll;         │     (next read,
      │   onEvent dispatch; finally releaseLock)   │      next dispatch)
      └────────────────────────────────────────────┘
          ┌──────────────────────────────────────────┐
          │ innermost: reader.read()                 │   → BROWSER decides
          │  (waits for the next byte chunk; resolves│     (network arrival)
          │   when the chunk lands or done=true)     │
          └──────────────────────────────────────────┘

  the answer flips at every altitude — that contrast IS the lesson
```

### Seams

Two boundaries where the axis-answer flips.

```
  Two seams worth studying

  REACT decides  ═══════════════ KERNEL decides
        │             ▲             │
        │             │             ▼
        │       seam 1: cancelOn / cleanup latch
        │       (the consumer hands the kernel
        │        a closure to poll; cleanup
        │        flips its source-of-truth)
        │
        ▼
  KERNEL decides  ═══════════════ BROWSER decides
                        ▲             │
                        │             ▼
                  seam 2: reader.read() awaits
                  (the kernel surrenders control
                   until the network resumes it)
```

Seam 1 (`cancelOn`) is the one this pattern earns its keep on — it's how `useBriefingStream` cancels cleanly when the user toggles `demo → live-bloomreach` mid-stream. Seam 2 is the browser primitive doing what it always does.

With the skeleton named, hand off to How it works.

## How it works

The load-bearing block. We'll build the pattern (Move 1), walk the kernel and the consumer hook part by part (Move 2), and end with the principle (Move 3).

### Move 1 — the mental model

You know how a `fetch()` returns a `Response` with a `.json()` method that buffers the whole body and parses it once? This is the same `fetch`, but the body is treated as an async iterable of bytes. You ask for one chunk at a time, decode it to text, accumulate a buffer, split on `\n`, parse each complete line as JSON, and dispatch each parsed event to a handler. The body never gets buffered in full — by the time the last line arrives, the first one has been on screen for thirty seconds.

```
  The pattern — one frame

  ┌─────────────────────────────────────────────────────────────┐
  │                                                             │
  │   ┌──────┐    chunk    ┌─────────┐   text   ┌────────────┐ │
  │   │ body │ ──────────► │ decoder │ ───────► │ buffer     │ │
  │   └──────┘   (bytes)   └─────────┘          │ "...\n.."  │ │
  │      ▲                                       └─────┬──────┘ │
  │      │                                             │        │
  │      │ read() resumes              split('\n')     ▼        │
  │      │ when next chunk lands       ┌─────┐  ┌────────────┐ │
  │      └──────────────────────────── │lines│  │ buf = tail │ │
  │                                    └──┬──┘  └────────────┘ │
  │                                       │                     │
  │                                       │ for each line:      │
  │                                       │   JSON.parse(line)  │
  │                                       │   onEvent(parsed)   │
  │                                       │                     │
  │                                       ▼                     │
  │                              ┌──────────────────┐           │
  │                              │ React: setState  │           │
  │                              │ → re-render row  │           │
  │                              └──────────────────┘           │
  │                                                             │
  │   loop until reader says done=true, or cancelOn() === true │
  │                                                             │
  └─────────────────────────────────────────────────────────────┘
```

That's the kernel. The hook around it does the rest.

### Move 2 — step by step

The pattern has an irreducible kernel (Move 2 variant — load-bearing skeleton): a `while(true)` loop, a buffer, a split-and-parse, a cancellation poll, and a `finally` release. Strip any one and the pattern loses something specific. Then we walk the consumer hook around it.

#### The kernel — `readNdjson` (lib/streaming/ndjson.ts:17-64)

Five irreducible parts. Pseudocode first, then the real code side-by-side.

```
  Pseudocode — the irreducible kernel

  function readNdjson(body, onEvent, opts):
    reader  = body.getReader()                 // ⓐ acquire the lock
    decoder = new TextDecoder()
    buf     = ""

    try:
      loop:
        if opts.cancelOn?.():                   // ⓑ cancellation check
          reader.cancel()
          return

        {value, done} = await reader.read()    // ⓒ wait for next chunk
        if done: break

        buf = buf + decoder.decode(value, {stream: true})
        lines = buf.split("\n")
        buf   = lines.pop() ?? ""              // ⓓ tail = last (incomplete) line

        for raw in lines:
          line = raw.trim()
          if line is empty: continue
          try:
            onEvent(JSON.parse(line))          // ⓔ dispatch
          catch err:
            opts.onMalformed?.(line, err)

      // flush trailing buffer (no-op when producer always ends with \n)
      tail = buf.trim()
      if tail:
        try: onEvent(JSON.parse(tail))
        catch err: opts.onMalformed?.(tail, err)

    finally:
      reader.releaseLock()                     // ⓕ always release
```

Now what breaks when each part is missing:

- **ⓐ `getReader()`.** Without acquiring the reader's lock, two consumers of the same body would race. With it, the kernel owns the body until `releaseLock`.
- **ⓑ `cancelOn` poll.** Drop this and a mode toggle mid-stream leaks the running fetch. The consumer hook's `useEffect` cleanup runs, but the reader keeps consuming bytes and calling `onEvent` on stale state setters. `useBriefingStream` flips a ref on cleanup; the kernel polls that ref between reads.
- **ⓒ `await reader.read()`.** This is the suspension point — the JS event loop is free to do anything else while the kernel waits. The whole "the user sees the trace fill in" effect depends on this being awaited, not buffered.
- **ⓓ tail buffer.** Chunks arrive on arbitrary byte boundaries; a single `\n`-terminated event can split across two `read()` calls. The tail buffer holds the incomplete fragment until the next chunk completes it. Drop this and you'd get `JSON.parse` errors on the fragment.
- **ⓔ `JSON.parse + onEvent`.** The hand-off. Each parsed event goes straight to the consumer's dispatcher. The consumer never sees a partial event.
- **ⓕ `releaseLock`.** In `finally` so a `throw` inside the loop still releases. Without it, the response body is permanently locked and a second `getReader()` on the same response would throw.

**Skeleton vs hardening.** The kernel is the five parts above. The `onMalformed` callback (default silent) and the trailing-buffer flush are optional hardening — the header comment names this explicitly: "Producers always terminate each event with '\n', so in practice the trailing-buffer flush is a no-op — but keeping it preserves the correct shape for any future producer that omits the terminal newline."

Real code, annotated:

```ts
// lib/streaming/ndjson.ts:17-64
export async function readNdjson<E>(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: E) => void,
  opts?: {
    cancelOn?: () => boolean;          // ⓑ polled between reads
    onMalformed?: (line: string, err: unknown) => void;
  },
): Promise<void> {
  const reader = body.getReader();      // ⓐ acquire the lock
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      if (opts?.cancelOn?.()) {         // ⓑ cancellation check
        await reader.cancel();
        return;
      }
      const { value, done } = await reader.read();   // ⓒ suspend
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';          // ⓓ tail = last (incomplete) line
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        try {
          onEvent(JSON.parse(line) as E);   // ⓔ dispatch
        } catch (err) {
          opts?.onMalformed?.(line, err);
        }
      }
    }
    // flush trailing buffer — a no-op when producer always terminates with '\n'
    const tail = buf.trim();
    if (tail) {
      try { onEvent(JSON.parse(tail) as E); }
      catch (err) { opts?.onMalformed?.(tail, err); }
    }
  } finally {
    reader.releaseLock();               // ⓕ always release
  }
}
```

That's 64 lines, four consumers. Every other file in this pattern is a hook or component that calls `readNdjson(res.body, handle, opts?)` and supplies the dispatcher.

#### The consumer hook — `useBriefingStream` (lib/hooks/useBriefingStream.ts:103-313)

The consumer brings the React lifecycle, the state slots, the fetch, the 9-case dispatcher, the cancellation latch, and the callbacks for the composition with `useReconnectPolicy`. The pattern is the same in `useInvestigation` and `StreamingResponse`; we'll walk the briefing one for grounding.

**The state slots — what gets re-rendered when an event arrives.**

```ts
// lib/hooks/useBriefingStream.ts:108-120
const [status, setStatus]               = useState<FeedStatus>('loading');
const [insights, setInsights]           = useState<Insight[]>([]);
const [workspace, setWorkspace]         = useState<...>(undefined);
const [errorMessage, setErrorMessage]   = useState('');
const [demoSuffix, setDemoSuffix]       = useState('');
const [stepStatus, setStepStatus]       = useState('');
const [queryCount, setQueryCount]       = useState(0);
const [traceItems, setTraceItems]       = useState<TraceItem[]>([]);
const [coverage, setCoverage]           = useState<CoverageReport>([]);
```

Nine slots. Each NDJSON event case updates exactly one or two of them. The page reads all nine off the hook's return value.

**The cancellation latch — `cancelledRef` (lib/hooks/useBriefingStream.ts:130-152).**

```ts
const cancelledRef = useRef(false);

useEffect(() => {
  if (!ready) return;
  // reset on every effect run so a mode flip starts fresh
  cancelledRef.current = false;
  // ... fetch + readNdjson ...
  return () => {
    cancelledRef.current = true;       // cleanup flips it
  };
}, [mode, ready]);
```

The kernel polls this via `cancelOn: () => cancelledRef.current` at line 288. When the user toggles `demo → live-bloomreach`, the effect cleanup runs, flips the ref, the kernel sees `true` between its next two reads, calls `reader.cancel()`, returns. The new effect run resets the ref and starts a fresh fetch.

**The dispatcher — the 9-case switch (lib/hooks/useBriefingStream.ts:204-286).** The shape is:

```ts
const handle = (evt: BriefingEvent) => {
  switch (evt.type) {
    case 'workspace':       setWorkspace(evt.workspace); break;
    case 'coverage_item':   setCoverage((prev) => ...);   break;   // append/dedupe
    case 'coverage':        setCoverage(evt.coverage);    break;
    case 'tool_call_start': setQueryCount((n) => n + 1);
                            setTraceItems((prev) => [...prev, { kind: 'tool', ... }]);
                            break;
    case 'reasoning_step':  setStepStatus(content);
                            setTraceItems((prev) => [...prev, { kind: 'step', ... }]);
                            break;
    case 'tool_call_end':   setTraceItems((prev) => /* mutate the last running tool */);
                            break;
    case 'insight':         collected.push(evt.insight); break;
    case 'done':            setInsights(collected); stashInsights(collected);
                            callbacksRef.current?.onStreamComplete?.();
                            setStatus(collected.length === 0 ? 'empty' : 'loaded');
                            break;
    case 'error': {
      const msg = evt.message ?? 'something went wrong';
      if (callbacksRef.current?.onAuthError?.(msg)) return;   // delegate auth
      setErrorMessage(msg); setStatus('error'); break;
    }
  }
};
```

The interesting move is `case 'error'`: the dispatcher *delegates* the auth-shaped error case to a callback the page provides (`reconnectPolicy.handle`). If the callback returns `true`, it took the error — bail. Otherwise, surface it normally. That's the composition seam between this hook and `useReconnectPolicy`.

**The call site — where the kernel meets the consumer.**

```ts
// lib/hooks/useBriefingStream.ts:288
await readNdjson<BriefingEvent>(
  res.body,
  handle,
  { cancelOn: () => cancelledRef.current },
);
```

One line. The kernel does the loop; the hook owns the React layer.

#### The flow — layers-and-hops

What happens over the wire and across the layers, hop by hop, when the user toggles `demo → live-bloomreach`.

```
  Layers-and-hops — one round trip, briefing stream

  ┌─ Client / React ───┐    hop 1: setMode('live-bloomreach')   ┌─ Client / React ───┐
  │ app/page.tsx       │ ──────────────────────────────────────► │ useBriefingStream  │
  │  switchMode()      │    (deps [mode, ready] change           │  cleanup → effect  │
  └────────────────────┘     → cleanup → re-run effect)          └──────────┬─────────┘
                                                                            │
                                                                            │ hop 2: fetch(/api/briefing?mode=live-bloomreach)
                                                                            ▼
                                                                  ┌─ Network ─────────┐
                                                                  │  HTTP GET         │
                                                                  └──────────┬────────┘
                                                                             │ hop 3: ReadableStream body
                                                                             ▼
                                                                  ┌─ Server / Next ───┐
                                                                  │ app/api/briefing  │
                                                                  │  /route.ts        │
                                                                  │  controller       │
                                                                  │  .enqueue(line\n) │
                                                                  └──────────┬────────┘
                                                                             │ hop 4: bytes (one chunk per agent event)
                                                                             ▼
  ┌─ Browser primitive ┐                                          ┌─ Client / kernel ──┐
  │ TCP / fetch reader │ ◄────────────────────────────────────── │ readNdjson         │
  │                    │    hop 5: reader.read() resolves         │  loop body         │
  └──────────┬─────────┘                                          └──────────┬─────────┘
             │                                                                │ hop 6: JSON.parse(line)
             │                                                                ▼
             │                                                      ┌─ Client / hook ────┐
             │                                                      │ handle(evt) switch │
             │                                                      │  setState(…)       │
             │                                                      └──────────┬─────────┘
             │                                                                 │ hop 7: re-render
             │                                                                 ▼
             │                                                       ┌─ Client / React ──┐
             │                                                       │ ReasoningTrace    │
             │                                                       │ appends one row   │
             │                                                       └───────────────────┘
             │                                                                 │
             └─── hops 5-7 repeat for every event until done=true ─────────────┘
```

Every hop is labelled. The kernel sits at hop 5-6; the consumer hook owns hop 7.

#### Move 2.5 — the two StrictMode adaptations

The pattern has a Phase A reality you can't skip: React 19 + `reactStrictMode` mounts every component twice in dev. The same kernel is consumed by two hooks that face *different* lifecycle pressures, and each one adapts differently. This is comparison territory.

```
  Comparison — two consumers, two StrictMode strategies

  ┌─ useBriefingStream ─────────────────────┐  ┌─ useInvestigation ────────────────────┐
  │                                         │  │                                       │
  │  cancelledRef = useRef(false)           │  │  startedRef = useRef(false)           │
  │                                         │  │                                       │
  │  useEffect(() => {                      │  │  useEffect(() => {                    │
  │    cancelledRef.current = false         │  │    if (startedRef.current) return     │
  │    // ... fetch + readNdjson({          │  │    startedRef.current = true          │
  │    //   cancelOn: () =>                 │  │    // ... fetch + readNdjson(...)     │
  │    //     cancelledRef.current })       │  │    // NO cleanup of the in-flight     │
  │    return () => {                       │  │    //    fetch — deliberate          │
  │      cancelledRef.current = true        │  │  }, [id, step])                       │
  │    }                                    │  │                                       │
  │  }, [mode, ready])                      │  │                                       │
  │                                         │  │                                       │
  │  Why: the briefing SHOULD re-fetch      │  │  Why: an investigation should run     │
  │  when mode toggles. Cleanup must        │  │  exactly once per mount. The         │
  │  cancel the previous run. The kernel    │  │  StrictMode double-mount would       │
  │  polls between reads and cancels        │  │  cancel + restart + race. Started-    │
  │  cleanly when it sees the ref flip.     │  │  guard makes the effect idempotent.   │
  │                                         │  │                                       │
  │  Cancel mid-stream: yes                 │  │  Cancel mid-stream: no                │
  │  Re-fire on dep change: yes             │  │  Re-fire on dep change: no            │
  └─────────────────────────────────────────┘  └───────────────────────────────────────┘
```

The header comment on `useInvestigation.ts:33-37` names the bug that produced this split: *"cancelling on the first cleanup, with the started-guard blocking the re-mount, aborted the stream and left the logs empty."* The pattern doesn't dictate either choice — it provides the `cancelOn` hook and lets the consumer pick its lifecycle strategy.

### Move 3 — the principle

**Pull the parse loop down to a kernel; let consumers own the lifecycle.** The principle generalizes past NDJSON: any time you have N callers doing the same `read → decode → split → parse → dispatch` loop, the lifecycle policies (cancel? restart? idempotent?) differ but the loop body is the same. Centralize the loop, parametrize the cancellation hook, leave the dispatcher and the React state to the caller. The 64-line kernel is what makes the four consumers tractable; without it, each one would re-implement the buffer-split bug.

The cross-cutting version: **don't bake lifecycle into a kernel; expose the cancellation signal and let lifecycle live one layer up.** Fetch with `AbortSignal`, generators with `try/return`, observables with `unsubscribe`, this pattern with `cancelOn` — same shape every time.

## Primary diagram

The full pattern, end to end, one frame.

```
  NDJSON stream reader hook — the whole pattern

  ┌─ UI ────────────────────────────────────────────────────────────────────┐
  │  page.tsx                       investigate/[id]/page.tsx               │
  │   { insights, traceItems,        { items, diagnosis, complete, error }  │
  │     coverage, status, ... }       = useInvestigation(id, 'diagnose')    │
  │   = useBriefingStream(mode,                                             │
  │       ready, { onAuthError,      ReasoningTrace items={items}           │
  │                onStreamComplete })  └─ re-renders on every appended row │
  └────────────────────────────────────────┬────────────────────────────────┘
                                           │
  ┌─ Hook (useState ×N, useEffect, useRef) ▼────────────────────────────────┐
  │  useEffect(() => {                                                      │
  │    cancelledRef.current = false                                         │
  │    (async () => {                                                       │
  │      res = await fetch(url)                                             │
  │      if (auth | error) handle → return                                  │
  │                                                                         │
  │      const handle = (evt) => {                                          │
  │        switch (evt.type) {                                              │
  │          case 'reasoning_step': setTraceItems(p => [...p, step])        │
  │          case 'tool_call_start': setQueryCount(n => n + 1); setTrace... │
  │          case 'tool_call_end':   setTraceItems(p => replaceRunning(p))  │
  │          case 'insight':         collected.push(insight)                │
  │          case 'done':            setInsights(collected); onStreamComp() │
  │          case 'error':           if (onAuthError(msg)) return;          │
  │                                  setError(msg); setStatus('error')      │
  │        }                                                                │
  │      }                                                                  │
  │                                                                         │
  │      await readNdjson(res.body, handle,                                 │
  │                       { cancelOn: () => cancelledRef.current })         │
  │    })()                                                                 │
  │    return () => { cancelledRef.current = true }                         │
  │  }, [mode, ready])                                                      │
  └────────────────────────────────────────┬────────────────────────────────┘
                                           │
  ┌─ Kernel (lib/streaming/ndjson.ts) ─────▼────────────────────────────────┐
  │  reader  = body.getReader()                                             │
  │  decoder = new TextDecoder()                                            │
  │  buf     = ''                                                           │
  │  try {                                                                  │
  │    while (true) {                                                       │
  │      if (cancelOn?.()) { await reader.cancel(); return }                │
  │      { value, done } = await reader.read()                              │
  │      if (done) break                                                    │
  │      buf += decoder.decode(value, { stream: true })                     │
  │      lines = buf.split('\n');  buf = lines.pop() ?? ''                  │
  │      for (raw of lines) {                                               │
  │        line = raw.trim(); if (!line) continue                           │
  │        try { onEvent(JSON.parse(line)) } catch (e) { onMalformed?.(.) } │
  │      }                                                                  │
  │    }                                                                    │
  │    // flush trailing tail (no-op when producer ends with \n)            │
  │  } finally { reader.releaseLock() }                                     │
  └────────────────────────────────────────┬────────────────────────────────┘
                                           │ HTTP, Content-Type: application/x-ndjson
  ┌─ Server (Next route handler) ──────────▼────────────────────────────────┐
  │  return new Response(                                                   │
  │    new ReadableStream<Uint8Array>({                                     │
  │      async start(controller) {                                          │
  │        for await (const evt of runAgentLoop(...)) {                     │
  │          controller.enqueue(encoder.encode(encodeEvent(evt)))           │
  │        }                                                                │
  │        controller.close()                                               │
  │      }                                                                  │
  │    }),                                                                  │
  │    { headers: { 'content-type': 'application/x-ndjson' } }              │
  │  )                                                                      │
  └─────────────────────────────────────────────────────────────────────────┘
```

## Elaborate

**Where this pattern comes from.** NDJSON ("newline-delimited JSON") is the simplest streaming protocol over HTTP that doesn't require a new transport: one JSON object per line, `\n` as the delimiter, `Content-Type: application/x-ndjson` on the response. It predates SSE in industry use (log shipping, ETL feeds, Elasticsearch `_bulk`) and remains the lingua franca when you need a stream over plain `fetch`. The browser-side recipe — `body.getReader() + TextDecoder + split('\n') + JSON.parse` — is the canonical browser implementation of an NDJSON consumer.

**Why not Server-Sent Events.** SSE has a built-in browser API (`EventSource`) and would have eliminated the kernel. Two blockers in this repo: `EventSource` doesn't support custom headers (so OAuth bearer tokens can't be sent), and it doesn't support `POST` (the chat surface uses `GET` with `?q=`, but a future mutation would have to switch). NDJSON over `fetch` is the strictly more general choice.

**Why not a query library.** React Query / SWR / TanStack Query are *request-shaped* — they assume a request returns a value. Streaming agent events don't fit: the value arrives over thirty seconds, in pieces, with a 9-case dispatcher. A query library would either buffer the stream (defeating the point) or be used as a thin wrapper around the same fetch+reader loop. The kernel hits the ceiling first.

**What this pattern doesn't solve, and what it punts to a neighbor.**
- Backpressure — the kernel doesn't push back if React is slow to re-render. `study-performance-engineering` would measure this.
- Reconnection — if the connection drops mid-stream, the kernel resolves and the consumer surfaces "stream ended." `useReconnectPolicy` handles the auth-revoked case; a true mid-stream reconnect would be a new layer.
- Wire-format evolution — adding a tenth `BriefingEvent` case means updating the producer, the consumer's switch, and the type union. There's no schema versioning. The contract is the TypeScript union (`useBriefingStream.ts:36-45`).
- Ordering / dedup — the kernel assumes the producer's order is the truth. No `eventId`, no replay.

**See also.** The producer side (`app/api/briefing/route.ts:80-208`, `app/api/agent/route.ts:105-344`) builds the `ReadableStream` with `encodeEvent`. The route comments name the budget — `maxDuration = 300` on Vercel — that bounds the stream's lifetime. The wire contract (`AgentEvent` union in `lib/mcp/events.ts`, `BriefingEvent` union in `useBriefingStream.ts:36-45`) is the agreement between producer and consumer; *that's* the seam that must not change (see the project context's "what must not change" list).

## Interview defense

**Q: Why NDJSON over Server-Sent Events?**

A — *the diagram you sketch while you answer:*

```
  Why NDJSON, not SSE

  SSE (EventSource)                NDJSON (fetch + reader)
  ─────────────────                ───────────────────────
  built-in browser API             custom 64-line kernel
  GET only                         GET or POST
  no custom headers                custom headers (OAuth)
  auto-reconnect                   manual reconnect
  text only                        any JSON
  one event format                 you own the format
```

The deciding factor here was custom headers — the OAuth bearer needs to ride on the request. SSE's auto-reconnect is genuinely nice; we trade it for the flexibility. The kernel is 64 lines, so we paid for the trade.

*Anchor:* the kernel is `lib/streaming/ndjson.ts`; the comment names this as "the canonical implementation."

---

**Q: Walk me through the kernel from memory. What's the part people forget?**

A — *the diagram:*

```
  The kernel — five irreducible parts

      ⓐ getReader()      → acquire the lock
      ⓑ cancelOn poll    → check the cancellation hook
      ⓒ reader.read()    → await the next chunk
      ⓓ split('\n') / buf.pop()  → tail buffer for partial lines
      ⓔ JSON.parse + onEvent     → dispatch
      ⓕ finally releaseLock      → always release
```

The load-bearing part people forget is **ⓓ — the tail buffer.** Bytes arrive on arbitrary boundaries; a single event can split across two `read()` calls. Without `buf = lines.pop() ?? ''` holding the incomplete fragment, you get `JSON.parse` errors on a half-line. Most "broken NDJSON parser" bugs are this exact mistake.

*Anchor:* `lib/streaming/ndjson.ts:40-41` is where the tail is captured.

---

**Q: You said you don't cancel the fetch on cleanup in `useInvestigation`. Defend that.**

A — *the diagram:*

```
  Two consumers, two StrictMode strategies

  useBriefingStream    useInvestigation
  ─────────────────    ────────────────
  cancel on cleanup    DO NOT cancel on cleanup
  cancelOn polled      startedRef guard
  ↑                    ↑
  briefing re-fires    investigation runs once
  when mode toggles    per mount, no race

  Why no cancel for investigation:
    StrictMode dev double-mount + startedRef
    + cancel on cleanup = aborted stream,
    re-mount blocked by guard, empty logs.
    The bug shipped once; this is the fix.
```

The lifecycle pressure on the two hooks is different. The briefing hook re-fetches when `mode` toggles, so cleanup MUST cancel. The investigation runs once per mount; cleanup cancelling the first mount aborts the stream while the started-guard blocks the re-mount from restarting it. So we don't cancel — `setState` after unmount is a safe no-op in React.

*Anchor:* `lib/hooks/useInvestigation.ts:33-37` and `:48-49`; comment names the bug.

---

**Q: What's the cost of unmemoized re-renders on `ReasoningTrace`?**

A — *the diagram:*

```
  Per-event render cost

  one NDJSON event arrives
       │
       ▼
  setItems(p => [...p, item])    O(1) state update
       │
       ▼
  ReasoningTrace re-renders      O(n) — full items.map()
       │
       ▼
  one new row mounts             O(1) DOM insertion
  n-1 keyed rows short-circuit   O(n) reconciliation, no DOM
```

Today: tens of trace items per investigation, the re-render cost is invisible. At a hundred-plus items it'd start showing in a profiler — the keys short-circuit DOM reconciliation but the JSX re-render is still O(n). Fix shape: `React.memo` on the row component or virtualization. Not yet a problem; named as the next bottleneck.

*Anchor:* `components/investigation/ReasoningTrace.tsx:52-107`.

## See also

- `02-progressive-skeleton-with-stepper.md` — what the dispatched events DO once they land in state. The pattern that turns the stream into a UI that feels alive.
- `audit.md` → `data-fetching-and-cache` — the lens-level finding for "no client query library; four streaming surfaces share the kernel."
- `audit.md` → `rendering-and-reactivity` — the StrictMode adaptations recorded at the lens level.
- Neighbor: `study-networking` — the wire format and HTTP/1.1 chunked-encoding semantics on the actual transport. This file owns the browser-side consumer; the network owns the bytes.
- Neighbor: `study-runtime-systems` — the event loop and the `await reader.read()` suspension point. This file owns the React layer; the runtime owns the scheduler.
- Neighbor: `study-system-design` — the `AgentEvent` / `BriefingEvent` contract as a system seam; the cache-as-architecture question (why sessionStorage, not memory).
