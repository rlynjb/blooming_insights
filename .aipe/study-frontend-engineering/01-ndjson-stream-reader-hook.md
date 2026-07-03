# NDJSON stream reader hook

## Subtitle

**NDJSON streaming consumer** · industry-standard client pattern for line-delimited server events (aka *line-oriented JSON streaming*, alongside SSE and WebSockets).

## Zoom out, then zoom in

**Zoom out — the bigger picture.** Every progressive-render surface in blooming_insights runs the same loop: `fetch()` a route handler, get back a `ReadableStream<Uint8Array>`, decode UTF-8 in streaming mode, split on `\n`, JSON.parse each line, dispatch the event, keep going until `done`. Four consumers — the feed, an investigation, the demo capture, the chat query — all need this exact loop. The kernel lives in one file so all four don't drift.

```
  Zoom out — where the NDJSON kernel sits

  ┌─ Server (Next.js route handlers) ─────────────────────────┐
  │  app/api/briefing/route.ts   →  encodeEvent() → NDJSON     │
  │  app/api/agent/route.ts      →  encodeEvent() → NDJSON     │
  └────────────────────────────────────────┬───────────────────┘
                                           │  HTTP body
                                           │  application/x-ndjson
                                           ▼
  ┌─ Client hooks / components ────────────────────────────────┐
  │  useBriefingStream                                          │
  │  useInvestigation           each calls:                     │
  │  useDemoCapture               fetch → readNdjson(body, h)   │
  │  StreamingResponse                                          │
  └────────────────────────────────────────┬───────────────────┘
                                           │
                                           ▼
                          ┌────────────────────────────┐
                          │  ★ readNdjson kernel ★     │ ← we are here
                          │  lib/streaming/ndjson.ts    │
                          │  64 LOC, one function      │
                          └────────────────────────────┘
```

**Zoom in — narrow to the concept.** The pattern is *NDJSON as a poor-man's server-push* — the server writes one line per event, the client reads one line per event, framing is a byte (`\n`). Both sides stay simple. Compare with SSE (which adds `data:` / `event:` framing and reconnect semantics you don't want here) and WebSockets (which need a whole other protocol upgrade). NDJSON over `fetch()` is the least ceremony for the "server pushes a series of typed events until done" shape.

The kernel is 64 lines because everything about the loop except the byte plumbing lives in the consumer. The consumer picks the event union type, writes the `switch`, and dispatches to `setState`. The kernel guarantees: one event per line, malformed lines don't crash, unmount cleanly cancels.

## Structure pass

Skeleton before mechanics. Layers → axis → seams.

**Layers.** Three levels, outer to inner:

```
  Layers — from producer to react state

  ┌─ outer: producer  (server route handler)          ─┐
  │   for await (const event of agentGen) yield          │
  │     encodeEvent(event) → 'JSON\n'                    │
  ├─ middle: transport / kernel  (byte-level plumbing) ─┤
  │   fetch → reader → decoder → buf.split('\n') →       │
  │   JSON.parse → onEvent(event)                        │
  ├─ inner: consumer  (react hook / component)         ─┤
  │   switch (event.type) { ... setState(...) }          │
  └──────────────────────────────────────────────────────┘
```

**Axis held constant across the layers — who owns framing?**

  - Outer (producer) — writes `JSON + '\n'`. Owns framing on the way out.
  - Middle (kernel) — reads bytes, splits on `\n`, parses. Owns framing on the way in.
  - Inner (consumer) — receives one typed event at a time. Framing is invisible.

The kernel is the only layer that KNOWS the wire format is line-delimited. Consumers don't. Producers only know "terminate with newline." Same axis, three answers, one seam.

**Seams — where framing flips.**

  - Producer → kernel: raw bytes with newlines. The framing contract is *"one line = one JSON.stringify(event)"*.
  - Kernel → consumer: typed event objects, one at a time. The framing contract is *"onEvent gets called once per successful parse."*

Both seams are load-bearing. If either party breaks its half of the contract, the other side has no way to recover — the kernel deliberately swallows malformed lines and the consumer's `switch` deliberately has a `default: break` that ignores unknown types.

## How it works

### Move 1 — the mental model

You know how `fetch()` gives you a response with a `.body` that's a `ReadableStream<Uint8Array>`? Normally you'd `res.text()` or `res.json()` and read it all at once. The moment you want *progressive* rendering — server sends event 1, you render it, then event 2, you render it — you can't wait for the full body. You have to consume chunks as they arrive.

The pattern is a loop with four moves per iteration: **read a chunk → decode to string → split on line boundary → parse each complete line as a JSON event and dispatch it**. The chunk boundary and the line boundary are NOT the same — one chunk from `reader.read()` can contain half a line, one full line, or two-and-a-half lines. The buffer holds the "half-line at the end" between iterations until the next chunk arrives.

```
  Pattern — chunk-in / event-out loop with a buffer for partial lines

    chunks from reader          buffer state             events emitted
    ─────────────────           ────────────             ──────────────
    "{\"type\":\"work"        → "{\"type\":\"work"     →  (none)
    "space\"}\n{\"typ"        → "{\"type\":\"workspace\"}\n{\"typ"
                                                        →  {type:"workspace",…}
                                → "{\"typ"
    "e\":\"insight\"}\n{"     → "{\"type\":\"insight\"}\n{"
                                                        →  {type:"insight",…}
                                → "{"
    "\"type\":\"done\"}\n"    → "{\"type\":\"done\"}\n" →  {type:"done"}
                                → ""

  the buffer accumulates half-lines; \n draws the boundary; parse per line
```

That's the kernel. Everything else is hardening.

### Move 2 — the step-by-step walkthrough

The load-bearing part is the kernel skeleton — I'll use the Move-2-variant. Isolate the irreducible core; name each part by what breaks if it's missing.

#### The skeleton — five parts

```
  Skeleton — the NDJSON reader loop, minimum viable

    1. reader     = body.getReader()      // the async byte source
    2. decoder    = new TextDecoder()      // UTF-8, streaming mode
    3. buf        = ''                     // holds partial trailing line
    4. loop:
         chunk = await reader.read()
         if chunk.done: break
         buf += decoder.decode(chunk.value, { stream: true })
         [complete, partial] = buf.split('\n') with last held back
         buf = partial
         for each line in complete:
           if line.trim(): onEvent(JSON.parse(line))
    5. flush:  if buf.trim(): onEvent(JSON.parse(buf))
```

  1. **reader** — the async byte-pull. `body.getReader()` locks the stream to this reader; `reader.read()` returns `{ value, done }`. If we don't hold this ref, we can't pull chunks.

  2. **decoder** — UTF-8 aware, **streaming mode**. `new TextDecoder()` with `.decode(bytes, { stream: true })` correctly handles multi-byte characters that span chunk boundaries. Drop `{ stream: true }` and a UTF-8 character split across two chunks becomes garbage.

  3. **buf** — the string buffer that holds the trailing partial line between iterations. Drop this and any line that arrives split across two chunks becomes two invalid JSON strings — both fail to parse and both events are lost.

  4. **split-with-holdback** — `buf.split('\n')` returns all lines; `lines.pop()` grabs the last (which may be empty or a partial), assigns it back to `buf`, and iterates the completed lines. Drop the holdback and you'd process the partial as a complete line → parse fails → lost event.

  5. **flush** — when the reader signals `done`, any bytes left in `buf` are a final line the producer didn't terminate with `\n`. In practice the producers always terminate, so this is a no-op; keeping it means a future producer that omits the final newline still works.

**What breaks if any part is missing:** malformed multi-byte characters (no streaming decode), lost events on chunk boundaries (no buffer), lost events on chunk boundaries but different flavor (no holdback), lost final event (no flush).

**What's hardening layered on top, NOT skeleton:**

  - `cancelOn` polling — for the React unmount case (mode toggle mid-stream). Not required to correctly parse; required to not leak a reader on a hot code path.
  - `onMalformed` callback — for observability. The kernel silently skips a bad line by default; the callback lets you log it. Not required for correctness.
  - `try/finally reader.releaseLock()` — cleanup discipline. Not part of the parse.

#### The kernel — real code, side by side

The whole thing is 64 lines. Here's the load-bearing 30, annotated.

```typescript
// lib/streaming/ndjson.ts:17-64
export async function readNdjson<E>(                     // (1) E = consumer's event union
  body: ReadableStream<Uint8Array>,                       //     forcing the consumer to name it
  onEvent: (event: E) => void,                            //     dispatch callback
  opts?: {
    cancelOn?: () => boolean;                             // (2) unmount escape hatch
    onMalformed?: (line: string, err: unknown) => void;   //     observability seam
  },
): Promise<void> {
  const reader = body.getReader();                        // (3) lock the stream
  const decoder = new TextDecoder();                      //     UTF-8 default
  let buf = '';                                           //     buffer for partial lines
  try {
    while (true) {
      if (opts?.cancelOn?.()) {                           // (4) poll BEFORE the next read
        await reader.cancel();                            //     — otherwise we wait on a chunk
        return;                                           //     that may never come
      }
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });     // (5) streaming decode = safe UTF-8
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';                            // (6) hold the trailing partial line
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;                              //     blank line = keep-alive, skip
        try {
          onEvent(JSON.parse(line) as E);                 // (7) trust the consumer's E
        } catch (err) {
          opts?.onMalformed?.(line, err);                 //     bad line = report + skip
        }
      }
    }
    const tail = buf.trim();                              // (8) flush any un-terminated final line
    if (tail) {
      try { onEvent(JSON.parse(tail) as E); }
      catch (err) { opts?.onMalformed?.(tail, err); }
    }
  } finally {
    reader.releaseLock();                                 // (9) release the lock, always
  }
}
```

**Line-by-line read of the load-bearing bits:**

  - `(1)` The generic `E` is the consumer's event union. `useBriefingStream` calls `readNdjson<BriefingEvent>(…)` (see `lib/hooks/useBriefingStream.ts:299`); `useInvestigation` calls `readNdjson<AgentEvent>(…)` (see `lib/hooks/useInvestigation.ts:205`). The kernel doesn't know the shape; the consumer does.
  - `(2)` `cancelOn` polled between reads is the React unmount contract. The hook wraps a ref: `cancelOn: () => cancelledRef.current` (`lib/hooks/useBriefingStream.ts:299`). Effect cleanup flips the ref.
  - `(4)` Polling *before* the next `reader.read()` matters. If you polled after, you'd block on a chunk that might never come (the producer could be idle) and the unmount would never take effect.
  - `(5)` `{ stream: true }` is the whole ballgame for UTF-8 correctness across chunk boundaries.
  - `(6)` `lines.pop() ?? ''` is the holdback move. When `buf` ends with `\n`, `pop()` returns `''`, buf resets to empty, and we've processed every complete line. When it doesn't, `pop()` returns the partial that we keep for next iteration.
  - `(7)` `as E` is trust — the kernel assumes the producer emits shapes that match the consumer's union. If they diverge, the consumer's `switch(e.type)` `default: break` swallows the mismatch. Not runtime-validated in the kernel because that's the consumer's job.

#### How the consumer dispatches — layers-and-hops

Once the kernel calls `onEvent(event)`, the consumer's job is to translate an event into a `setState`. Here's the hop from wire to React state:

```
  Layers-and-hops — one NDJSON line from server to React re-render

  ┌─ Server route ──────────────────┐   hop 1: JSON.stringify(event) + '\n'
  │  yield encodeEvent(event)        │ ─────────────────────────────────────►
  └──────────────────────────────────┘
                                          hop 2: HTTP body chunk (bytes over TCP)
                                          ─────────────────────────────────────►
  ┌─ Browser network stack ─────────┐
  │  fetch() → res.body              │   hop 3: ReadableStream chunk delivery
  │  (ReadableStream<Uint8Array>)    │ ─────────────────────────────────────►
  └──────────────────────────────────┘
                                          hop 4: reader.read() → { value, done }
                                          ─────────────────────────────────────►
  ┌─ readNdjson kernel ─────────────┐
  │  decoder.decode + split + parse  │   hop 5: onEvent(parsedEvent)
  │  lib/streaming/ndjson.ts:39-49   │ ─────────────────────────────────────►
  └──────────────────────────────────┘
                                          hop 6: switch(evt.type) → setState(...)
                                          ─────────────────────────────────────►
  ┌─ Consumer hook (useBriefingStream)┐
  │  handle(evt) at ...:215-297      │   hop 7: React schedules re-render
  │  setInsights / setCoverage / ... │ ─────────────────────────────────────►
  └──────────────────────────────────┘
                                          hop 8: reconciler renders leaves
                                          ─────────────────────────────────────►
  ┌─ UI (CoverageGrid, ReasoningTrace)┐
  │  new tile fades in, trace grows   │
  └──────────────────────────────────┘
```

Every hop is named. The kernel owns hops 4-5. The consumer owns hops 6-7.

#### The consumer's `switch` — real code

Both consumers dispatch on `event.type`. Here's the briefing consumer, trimmed to the setState shape (full source at `lib/hooks/useBriefingStream.ts:215-297`):

```typescript
const handle = (evt: BriefingEvent) => {
  switch (evt.type) {
    case 'workspace':
      setWorkspace(evt.workspace);                        // ← first event, header data
      break;
    case 'coverage_item':
      setCoverage((prev) =>                               // ← accumulator: one tile at a time
        prev.some((c) => c.category === evt.item.category)
          ? prev
          : [...prev, evt.item],
      );
      break;
    case 'tool_call_start':
      setQueryCount((n) => n + 1);
      setTraceItems((prev) => [...prev, { kind: 'tool', id: crypto.randomUUID(),
                                          toolName: evt.toolName, status: 'running',
                                          ts: Date.now() }]);
      break;
    case 'tool_call_end':
      setTraceItems((prev) => {                            // ← find the matching 'running' tool,
        const next = [...prev];                            //   flip to 'done'
        for (let i = next.length - 1; i >= 0; i--) {
          if (next[i].kind === 'tool' && next[i].toolName === evt.toolName
              && next[i].status === 'running') {
            next[i] = { ...next[i], status: 'done', durationMs: evt.durationMs,
                        result: evt.result, error: evt.error };
            break;
          }
        }
        return next;
      });
      break;
    case 'insight':
      collected.push(evt.insight);                         // ← accumulate; publish at 'done'
      break;
    case 'done':
      setInsights(collected);                              // ← final publish
      callbacksRef.current?.onStreamComplete?.();
      setStatus(collected.length === 0 ? 'empty' : 'loaded');
      break;
    case 'error':
      if (callbacksRef.current?.onAuthError?.(evt.message)) return; // ← policy composes in
      setErrorMessage(evt.message);
      setStatus('error');
      break;
  }
};
await readNdjson<BriefingEvent>(res.body, handle, { cancelOn: () => cancelledRef.current });
```

The consumer decides accumulate-vs-publish per event type. `coverage_item` accumulates progressively (each tile appears as it arrives); `insight` accumulates in a closure-scoped `collected: Insight[]` and publishes at `done` — because insights render only when all coverage is in.

That's the whole seam. Kernel: 64 LOC, four consumers. Consumer's switch: N cases, one setState per case.

### Move 3 — the principle

**Frame boundaries belong to one layer.** The NDJSON kernel is the only piece of code that knows the wire format is line-delimited. Producers know "terminate with newline"; consumers know "your `onEvent` gets called once per typed event." No consumer parses framing; no consumer buffers; no consumer decodes. If you push framing knowledge into consumers, you rebuild ~250 LOC of the same buggy loop four times, and one of them will forget `{ stream: true }` and someone will file "emoji breaks the trace."

The generalization: whenever N surfaces share a wire protocol, put the protocol in one file with a callback contract. The consumers become dispatchers, not parsers.

## Primary diagram

The full picture, all layers, every hop named. This is the visual to return to.

```
  NDJSON stream reader — from server yield to React re-render

  ┌─ SERVER ROUTE ────────────────────────────────────────────────────┐
  │ app/api/briefing/route.ts    app/api/agent/route.ts               │
  │                                                                   │
  │  for await event of stream:                                       │
  │    yield JSON.stringify(event) + '\n'   ── one line per event ── │
  └───────────────────────────────┬───────────────────────────────────┘
                                  │ HTTP stream, Content-Type: application/x-ndjson
                                  ▼
  ┌─ CLIENT FETCH ────────────────────────────────────────────────────┐
  │ const res = await fetch(url, {                                    │
  │   headers: mcpHeader ? { [BI_MCP_CONFIG_HEADER]: mcpHeader } : {} │
  │ });                                                               │
  │ // res.body: ReadableStream<Uint8Array>                           │
  └───────────────────────────────┬───────────────────────────────────┘
                                  │
                                  ▼
  ┌─ readNdjson KERNEL ───────────────────────────────────────────────┐
  │ lib/streaming/ndjson.ts:17-64                                      │
  │                                                                    │
  │   loop until done:                                                 │
  │     if cancelOn() → reader.cancel(); return                        │
  │     chunk = reader.read()                                          │
  │     buf += decoder.decode(chunk, { stream: true })                 │
  │     lines = buf.split('\n'); buf = lines.pop()                     │
  │     for line in lines: onEvent(JSON.parse(line))                   │
  │   flush trailing buf                                               │
  │   reader.releaseLock()                                             │
  └───────────────────────────────┬───────────────────────────────────┘
                                  │  onEvent(typedEvent)
                                  ▼
  ┌─ CONSUMER DISPATCH ───────────────────────────────────────────────┐
  │ useBriefingStream:215-297     useInvestigation:99-153              │
  │                                                                    │
  │   switch (evt.type):                                               │
  │     workspace       → setWorkspace                                 │
  │     coverage_item   → setCoverage(prev => [...prev, item])         │
  │     tool_call_start → setTraceItems(prev => [...prev, running])   │
  │     tool_call_end   → setTraceItems(prev => [flip running→done])  │
  │     reasoning_step  → setStepStatus + setTraceItems                │
  │     insight         → collected.push                               │
  │     done            → setInsights(collected) + setStatus           │
  │     error           → onAuthError callback OR setStatus('error')   │
  └───────────────────────────────┬───────────────────────────────────┘
                                  │  setState triggers re-render
                                  ▼
  ┌─ REACT UI ────────────────────────────────────────────────────────┐
  │  CoverageGrid tile appears                                        │
  │  ReasoningTrace item fades in                                     │
  │  InsightCard renders at 'done'                                    │
  │  ProcessStepper monitors state via mapped fetch status            │
  └────────────────────────────────────────────────────────────────────┘
```

## Elaborate

**Where this pattern comes from.** NDJSON (Newline-Delimited JSON) is a de facto convention popular since around 2013, before SSE and long before WebSocket streaming became one-line browser APIs. Its virtue is byte-simplicity — one line = one JSON — with no protocol on top. The consumer needs a `\n` splitter and a JSON parser. That's it.

**Alternatives you'd reach for in a different context.**

  - **SSE (Server-Sent Events).** The browser's `EventSource` handles framing, retry, and reconnect for you. But it forces `Content-Type: text/event-stream`, a `data: ` prefix per line, and mandatory `\n\n` between events; you also lose the ability to send Bearer tokens on the connection (EventSource can't set custom headers pre-2024 across all browsers). NDJSON over `fetch()` avoids all of that.
  - **WebSockets.** Bidirectional, full protocol upgrade, needs a server on the other side that speaks WS. Overkill for a unidirectional "server pushes events until done" flow.
  - **JSON-RPC streaming.** More structured, but more ceremony. NDJSON is one primitive short of that.

**How it connects to adjacent concepts.**

  - The React unmount cleanup problem — see `useReconnectPolicy` and the StrictMode note at `lib/hooks/useInvestigation.ts:32-38`. The `cancelOn` polling in the kernel is what makes the mode-toggle case work.
  - The event union type is a discriminated union with `type` as the discriminator — a classic TS pattern (`BriefingEvent` at `lib/hooks/useBriefingStream.ts:37-46`, `AgentEvent` at `lib/mcp/events`).
  - Wire-format semantics (why NDJSON, not SSE) belong to `study-networking`.

**What to read next.** `02-progressive-skeleton-with-stepper.md` — how the events dispatched here progressively fill in the UI. `03-settings-modal-with-localstorage-persistence.md` — how the fetch header is populated per request.

## Interview defense

### Q1 — Why NDJSON over `fetch()` instead of SSE or WebSocket?

Custom headers on the request (we send an `x-bi-mcp-config` header to override server env from the UI). `EventSource` couldn't set that until very recent browser versions and still ships with retry / reconnect semantics we don't want here. WebSocket is a full protocol upgrade for a unidirectional flow. NDJSON over `fetch()` is 64 lines of client code, no protocol upgrade, and works with any auth header you can put on a normal request.

```
  Choice tree — which streaming transport

  ┌─ need bidirectional? ──── yes ──── WebSocket
  │                            │
  │                            no
  │                            ▼
  ┌─ need reconnect built-in? ─ yes ─── SSE
  │                            │
  │                            no
  │                            ▼
  ┌─ need custom headers? ──── yes ─── NDJSON over fetch  ← we are here
  │                            │
  │                            no
  │                            ▼
  └─ NDJSON or SSE, both fine
```

**Anchor.** The header we send: `lib/hooks/useBriefingStream.ts:166-169`. Header definition: `lib/mcp/config.ts:37`.

### Q2 — The load-bearing part everyone forgets

**The buffer that holds the partial trailing line between reads.** A chunk from `reader.read()` doesn't line up with `\n`. Drop the buffer and any event that arrives split across two chunks disappears. The kernel keeps `buf` in the loop closure, `split('\n')`, `pop()` the last piece back into `buf`. Third mechanism — one line explains what breaks.

```
  Skeleton part people forget — the trailing-line buffer

    chunk1: "{\"type\":\"in"
    chunk2: "sight\"}\n"

    WITHOUT buffer:  parse("{\"type\":\"in")    ← throws, event lost
                     parse("sight\"}")          ← throws, event lost

    WITH buffer:    buf = "{\"type\":\"in"
                    buf += "sight\"}\n"
                    lines = ["{\"type\":\"insight\"}", ""]
                    buf = "";  parse("{\"type\":\"insight\"}") ✓
```

**Anchor.** `lib/streaming/ndjson.ts:39-41` (`buf.split('\n'); buf = lines.pop() ?? ''`).

### Q3 — What does `{ stream: true }` on `TextDecoder.decode` do?

Handles UTF-8 characters that span chunk boundaries. If a 4-byte emoji arrives 2 bytes in chunk N and 2 bytes in chunk N+1, `decode(bytes)` without `stream: true` would emit a replacement character (garbage) at the boundary. With `stream: true` the decoder holds the trailing incomplete sequence and prepends it to the next chunk.

```
  TextDecoder streaming mode — multi-byte characters at chunk boundaries

              [ chunk N ]                    [ chunk N+1 ]
    bytes:    ...{"content":"👀"          × wait that's 4 bytes
              ...{"content":"[F0][9F]     [91][80]"}\n

    decode(chunk N, { stream: true })  →  '...{"content":"'  ← holds F0 9F
    decode(chunk N+1, { stream: true })→  '👀"}\n'           ← prepends held
                                                                bytes, emits full
```

**Anchor.** `lib/streaming/ndjson.ts:39` (`buf += decoder.decode(value, { stream: true })`).

### Q4 — Why poll `cancelOn` *before* `reader.read()` instead of after?

If the producer goes idle, `reader.read()` blocks. You can't cancel from inside a pending read; you'd have to wait for the next chunk to arrive. Polling before means we get one guaranteed opportunity per iteration to notice "the effect cleaned up, bail out now." The cleanup flips a ref; the next loop iteration sees it and calls `reader.cancel()` explicitly.

```
  Cancellation ordering — why check first

    iteration N:
      check cancelOn?          ← this is the load-bearing check
        yes → reader.cancel(); return  (clean exit, no leak)
        no  → continue
      await reader.read()      ← may block indefinitely
      process chunk
```

**Anchor.** `lib/streaming/ndjson.ts:33-36`. The consumer's flip: `lib/hooks/useBriefingStream.ts:308-310`.

## See also

  - `02-progressive-skeleton-with-stepper.md` — what the consumer does with the events once the kernel dispatches them.
  - `03-settings-modal-with-localstorage-persistence.md` — how the fetch header is populated to override server env per request.
  - `audit.md` → `data-fetching-and-cache` lens — the fuller picture of the client-side data plumbing.
  - Cross-guide: wire-format semantics, HTTP framing, backpressure → `study-networking`.
  - Cross-guide: streaming transport at the system level (why streaming at all) → `study-system-design`.
