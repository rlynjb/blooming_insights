# 02 — the streaming kernel (`readNdjson`)

## Subtitle

Pulled-complexity-down · shared kernel · the smallest deep module — *Industry standard (newline-delimited JSON streaming)*.

## Zoom out — where this kernel lives

The kernel sits between the route handlers (which produce NDJSON over `ReadableStream`) and the four UI surfaces that consume it. Each surface does something different with the parsed events; what they all share is the `fetch → reader → decode → split('\n') → parse → handle` loop. That loop lives in one file.

```
  Zoom out — readNdjson in the streaming pipeline

  ┌─ UI consumers (4 of them) ───────────────────────────────────────┐
  │  useBriefingStream   useInvestigation   useDemoCapture           │
  │  StreamingResponse                                                │
  │                  each calls readNdjson(body, onEvent)             │
  └────────────────────────────┬─────────────────────────────────────┘
                               │  one shared kernel call
  ┌─ The kernel (★ THIS CONCEPT ★) ─────────▼───────────────────────┐
  │  readNdjson(body, onEvent, {cancelOn, onMalformed})              │ ← we are here
  │  64 LOC · ~10-line public type · 4 consumers                    │
  └────────────────────────────┬─────────────────────────────────────┘
                               │  reads from ReadableStream<Uint8Array>
  ┌─ Route handlers (producers) ─────────────▼───────────────────────┐
  │  /api/briefing · /api/agent · the demo replay path               │
  │     each writes encodeEvent(e) → controller.enqueue(...)         │
  └──────────────────────────────────────────────────────────────────┘
```

## Zoom in — what it is

You know how a `for` loop over `await response.body.getReader().read()` chunks always ends up the same shape — buffer + decode + split + parse + dispatch + bail-on-cancel? Yeah. This is that loop, named once, called four times.

The industry name is **newline-delimited JSON streaming** (NDJSON). The kernel pattern this implements is **pulling complexity down** — moving a repeated mechanism out of every caller and into one tested module. Every caller becomes a single function call with a dispatch table; the kernel owns the byte-level dance.

**The role-words for "kernel inside a deep module":**

```
  kernel    the smallest piece of logic that is still the pattern
            → readNdjson (the byte-level loop)
  consumer  code that calls the kernel
            → useBriefingStream, useInvestigation, useDemoCapture,
              StreamingResponse
  hook      the consumer's plug-in: one function per event
            → onEvent (mandatory) · onMalformed · cancelOn (optional)
  contract  the implicit promise the kernel + producers share
            → "every event is one JSON object terminated by '\n'"
```

## Structure pass — layers · axes · seams

Two layers: the **byte layer** (chunks, the decoder, the buffer, the split) and the **event layer** (parsed JSON objects dispatched to a callback). One axis to trace down the stack: **who owns the buffer?**

```
  Trace "who owns the unflushed bytes?" down the layers

  ┌─ consumer (e.g. useBriefingStream) ───────┐
  │  owns: the parsed-event handler, the      │
  │        cancelled-ref latch, UI state      │
  └────────────────────┬──────────────────────┘
                       │  the consumer DOESN'T see bytes
                       ▼
  ┌─ kernel (readNdjson) ─────────────────────┐
  │  owns: buf (the unflushed-bytes string)   │ ← the buffer is here
  │  owns: the decoder, the reader, the       │
  │        try/finally that releases the lock │
  └────────────────────┬──────────────────────┘
                       │  the kernel DOESN'T see Response
                       ▼
  ┌─ runtime (Web Streams API) ───────────────┐
  │  owns: the underlying ReadableStream      │
  │        and its chunk delivery             │
  └────────────────────────────────────────────┘
```

The load-bearing seam is **kernel ↔ consumer**. What flips across it: chunk-level vs event-level. Above the seam the consumer thinks "I got a `reasoning_step` event, push it onto state." Below the seam the kernel thinks "I got 4096 bytes, append to buf, split on \n, parse each, callback each." Neither side knows the other's vocabulary.

## How it works

### Move 1 — the mental model

A line-oriented protocol like NDJSON is the universal "newline-terminated record" stream — same idea as `tail -f log.txt | jq`. Chunks arrive at arbitrary byte boundaries (a 100-byte event might land split across two `read()` calls); you keep an unflushed-buffer string, split it on `\n` whenever a new chunk arrives, parse each complete line, and stash whatever's left until next time.

Here's the literal kernel shape:

```
  The NDJSON read loop — six moving parts, one minimal kernel

       ┌──────────────────────────────────────────────────┐
       │  loop:                                            │
       │    poll cancelOn() → if true, cancel + return     │  ← part A (cancel check)
       │    read one chunk                                 │  ← part B (the I/O)
       │    if done → break                                │  ← part C (termination)
       │    buf += decode(chunk)                            │  ← part D (the decoder)
       │    lines = buf.split('\n')                         │  ← part E (the split)
       │    buf = lines.pop()                               │  ← part F (the residual)
       │    for each line in lines:                         │
       │       try { onEvent(JSON.parse(line)) }            │  ← part G (the dispatch)
       │       catch { onMalformed(line, err) }             │
       │  flush trailing buf (no-op if producer always \n)  │  ← part H (the flush)
       │  release reader lock (always)                      │  ← part I (cleanup)
```

Nine moving parts in the kernel, none of them in the consumers. Drop the residual buffer (F) and you split a 100-byte event that arrived in two 50-byte chunks into two malformed JSON parses. Drop the cancel check (A) and React StrictMode plus an unmounted hook keeps the fetch alive until the route's 300s budget. Drop the cleanup (I) and the next reader on the same body throws.

### Move 2 — the step-by-step walkthrough

#### Part 1 — the kernel itself (the load-bearing skeleton)

This is the whole kernel. 48 lines of body, 5 lines of public type. The file-level comment names exactly what the kernel hides — the shape was lifted out of `useBriefingStream`'s canonical implementation:

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
  const reader = body.getReader();                       // part B / I — owns the lock
  const decoder = new TextDecoder();
  let buf = '';                                          // part F — the unflushed residual

  try {
    while (true) {
      if (opts?.cancelOn?.()) {                          // part A — cooperative cancel
        await reader.cancel();
        return;
      }
      const { value, done } = await reader.read();
      if (done) break;                                   // part C — stream ended
      buf += decoder.decode(value, { stream: true });    // part D — stream:true keeps partial UTF-8 bytes
      const lines = buf.split('\n');                     // part E — split on the delimiter
      buf = lines.pop() ?? '';                           // part F — last piece may be partial; stash it
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        try {
          onEvent(JSON.parse(line) as E);                // part G — dispatch to the consumer
        } catch (err) {
          opts?.onMalformed?.(line, err);                // silent by default
        }
      }
    }
    // part H — flush trailing buffer; no-op when the producer always terminates with '\n'
    const tail = buf.trim();
    if (tail) {
      try {
        onEvent(JSON.parse(tail) as E);
      } catch (err) {
        opts?.onMalformed?.(tail, err);
      }
    }
  } finally {
    reader.releaseLock();                                // part I — always release, even on throw
  }
}
```

Now name each part by **what breaks when it's missing.** This is the AOSD test for what's load-bearing:

  → **Drop the residual (F).** A 100-byte event arriving in two 50-byte chunks parses as two malformed lines. Streaming under load becomes silently lossy.
  → **Drop the cancel check (A).** When a React component unmounts mid-stream, the fetch keeps running until the route's 300s budget. The route burns Anthropic + MCP budget on a stream nobody is reading.
  → **Drop the `stream: true` flag on `decoder.decode` (D).** A multi-byte UTF-8 character that lands across a chunk boundary becomes a replacement character (U+FFFD). Every emoji in a streamed log line breaks.
  → **Drop the `try { JSON.parse } catch { onMalformed }` (G).** One malformed line crashes the entire stream — the consumer's `setState` calls stop firing mid-briefing.
  → **Drop the `finally { reader.releaseLock() }` (I).** A throw inside `onEvent` leaves the body locked. The next consumer that tries to read it throws.
  → **Drop the trailing-buffer flush (H).** A producer that omits the terminal newline silently drops its last event. Today's producers all terminate (`encodeEvent` in `lib/mcp/events.ts:15-17` always appends `'\n'`), so the flush is a no-op for the *current* contract — but it preserves correctness if a future producer ever forgets.

That's the load-bearing skeleton. Everything else (the `cancelOn` and `onMalformed` hooks) is **optional hardening** — useful for the briefing hook, optional for `StreamingResponse`'s simpler case.

#### Part 2 — the producer side (the implicit contract)

The kernel works because every producer obeys the same contract: one JSON object per line, terminated by `\n`. The contract has one home:

```ts
// lib/mcp/events.ts:15-17
export function encodeEvent(e: AgentEvent): string {
  return JSON.stringify(e) + '\n';                       // ← the contract: one event, one line
}
```

And the producers — `/api/briefing/route.ts:193-194` and `/api/agent/route.ts:187-190` — both write through `encodeEvent`:

```ts
// app/api/agent/route.ts:187-190
const send = (e: AgentEvent) => {
  collected.push(e);
  controller.enqueue(encoder.encode(encodeEvent(e)));    // ← one event per write, always with '\n'
};
```

The contract isn't enforced by the kernel — it's enforced by *every producer writing through `encodeEvent`*. That's a discipline, not a guarantee. The kernel's trailing-buffer flush (part H) is the safety net for the day someone bypasses `encodeEvent`.

#### Part 3 — the four consumers (the payoff)

Now the value. Compare what *each* consumer would look like without the kernel vs what it actually is.

**Without the kernel**, every consumer would carry the loop. **With** the kernel, each is one function call:

```
  Comparison — what each consumer USED to be vs what it is now

  ─── before (the loop inlined, ~25 LOC per consumer) ──────────────
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      if (cancelledRef.current) { await reader.cancel(); return; }
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        try { handle(JSON.parse(line)); } catch { /* skip */ }
      }
    }
  } finally { reader.releaseLock(); }

  ─── after (one call, per consumer) ───────────────────────────────
  await readNdjson<BriefingEvent>(res.body, handle, {
    cancelOn: () => cancelledRef.current,
  });
```

The actual call sites:

```ts
// lib/hooks/useBriefingStream.ts:288
await readNdjson<BriefingEvent>(res.body, handle, { cancelOn: () => cancelledRef.current });

// lib/hooks/useInvestigation.ts:194
await readNdjson<AgentEvent>(res.body, handle);

// lib/hooks/useDemoCapture.ts:84
await readNdjson<{ type?: string; message?: string }>(res.body, (evt) => { ... });

// (StreamingResponse uses the same kernel via its own fetch path)
```

Each call passes only what's different — the typed event union, the dispatcher, and whether cancellation matters. The byte-level dance is the same in all four; it lives in one place.

#### Part 4 — the layers-and-hops, end to end

```
  Layers-and-hops — a single event from agent to UI state

  ┌─ MCP server (Bloomreach) ──┐
  │  result of EQL query        │
  └──────────────┬──────────────┘
                 │  HTTPS + OAuth
  ┌─ adapter ────▼──────────────┐
  │  BloomreachDataSource       │   ← caches, retries, returns {result, durationMs, fromCache}
  └──────────────┬──────────────┘
                 │  result envelope
  ┌─ agent ──────▼──────────────┐
  │  MonitoringAgent.scan       │
  │    hooks.onToolResult(tc)   │   ← AptKit bridge fires CapabilityEvent → hook
  └──────────────┬──────────────┘
                 │  ToolCall
  ┌─ route ──────▼──────────────┐
  │  /api/briefing send(...)    │
  │    encodeEvent(e)           │   ← one JSON object + '\n'
  │    controller.enqueue       │
  └──────────────┬──────────────┘
                 │  bytes over ReadableStream
  ┌─ kernel ─────▼──────────────┐
  │  readNdjson(body, handle)   │   ← decode + split + parse + dispatch
  │    onEvent(parsedEvent)     │
  └──────────────┬──────────────┘
                 │  parsed AgentEvent
  ┌─ consumer ───▼──────────────┐
  │  useBriefingStream handle() │
  │    switch (evt.type) { ... }│   ← UI state update
  │      setTraceItems(...)     │
  └─────────────────────────────┘
```

The kernel sits exactly between the route layer and the consumer hook. The producer's job ends at `controller.enqueue(bytes)`; the consumer's job starts at `setTraceItems(...)`. The kernel owns the gap.

### Move 3 — the principle

**The right place for a knob is inside the module that has enough information to make it itself.** That's the AOSD definition of pulling-complexity-down. The kernel knows about chunks, buffers, and decoders — the consumer doesn't, and shouldn't. The consumer knows about UI state — the kernel doesn't, and shouldn't.

The principle generalises: any time you find yourself writing the same 20-line `for await (const chunk of ...)` loop in three places, the loop is asking to be a kernel. The win isn't deduplication for its own sake — it's that *one place can be the canonical owner of the cancel semantics, the malformed-line policy, the trailing-buffer flush.* When the policy changes (e.g. "log malformed lines instead of swallowing"), one file changes and all four consumers inherit it.

The other principle: the kernel is **small enough to read in one sitting** (48 lines). Pulling complexity down isn't about hiding hundreds of lines behind a one-line call; it's about isolating a tightly-scoped mechanism so the bytes-and-buffers concern doesn't crowd the consumer's UI-state concern. Two short, sharply-bounded modules beat one long, mixed-concerns one.

## Primary diagram

The kernel + its four consumers + the producer contract, in one frame:

```
  ┌─ Producer contract (lives in lib/mcp/events.ts) ─────────────────┐
  │  encodeEvent(e: AgentEvent): string                              │
  │    = JSON.stringify(e) + '\n'                                    │
  │  ↑ every producer writes through this; the kernel trusts it      │
  └──────────────────────────────┬───────────────────────────────────┘
                                 │
  ┌─ Producers (4 of them) ──────▼───────────────────────────────────┐
  │  app/api/briefing/route.ts (live + demo replay paths)            │
  │  app/api/agent/route.ts                                          │
  │  app/api/agent/route.ts (free-form query branch)                 │
  │  /api/briefing demo-replay branch                                │
  └──────────────────────────────┬───────────────────────────────────┘
                                 │  bytes over ReadableStream<Uint8Array>
                                 │
                       ┌─────────▼─────────┐
                       │   readNdjson<E>   │
                       │  (THE KERNEL)     │
                       │   64 LOC          │
                       │   9 moving parts  │
                       │   3-arg surface   │
                       └─┬─────────────────┘
                         │   one onEvent callback per consumer
        ┌────────────────┼─────────────────────────────────────┐
        ▼                ▼                ▼                    ▼
  ┌──────────────┐ ┌───────────────┐ ┌────────────────┐ ┌──────────────────┐
  │useBriefing   │ │useInvestigation│ │useDemoCapture │ │StreamingResponse│
  │Stream        │ │                │ │                │ │                  │
  │ (briefings)  │ │ (per-insight)  │ │ (capture loop) │ │ (free-form q&a)  │
  │ 9-case       │ │ 7-case         │ │ 2-case         │ │ chunked text     │
  │ dispatcher   │ │ dispatcher     │ │ done/error     │ │ append           │
  └──────────────┘ └───────────────┘ └────────────────┘ └──────────────────┘
```

## Elaborate

Newline-delimited JSON (NDJSON) is one of the simplest streaming-record formats — each record is a self-contained JSON value, terminated by `\n`. It's the same shape as JSON Lines (JSONL), and similar in spirit to Server-Sent Events (SSE) but without the `event:`/`data:`/`id:` framing. The choice between NDJSON and SSE is a small one — NDJSON is easier to consume from a vanilla `fetch + getReader()`; SSE needs `EventSource`, which doesn't support custom headers (a problem for auth-token flows).

The repo's choice: **NDJSON over `fetch + ReadableStream`** because:

  1. it composes with the route handler's `new Response(stream, ...)` cleanly,
  2. the consumer is `fetch + getReader()` which works in every modern runtime,
  3. there's no need for the SSE `event:` discriminator — the JSON object itself carries `type: "..."`.

The kernel pattern (one tested loop, many typed dispatchers) generalises beyond NDJSON. The same shape appears for SSE consumers, for WebSocket message handlers, for chunked file readers. Any time you find yourself writing the consumer-side of a streamed protocol, the kernel + dispatcher pattern is the move: the kernel owns the wire shape; the dispatcher owns the message semantics.

For the conceptual depth on pulling complexity down, read `.aipe/read-aposd/part-2/07-pull-complexity-down.md`. The principle is the same; the worked example here is one of the smallest in the AOSD book's terms — high payoff per line moved.

## Interview defense

### Q1: "Why bother extracting a 48-line kernel? The loop isn't that hard to write."

```
  the test: count the consumers, then count the parts that go wrong

  consumers:                       4 (briefing, investigation, capture,
                                       streaming response)
  parts that go wrong silently:    5 (residual buffer, UTF-8 across
                                       boundaries, cancel after unmount,
                                       reader-lock leak, malformed JSON)

  cost without kernel:  4 × ~25 LOC = 100 LOC of duplicated loop
                         5 silent failure modes × 4 consumers = 20 chances to
                         get one of them subtly wrong
  cost with kernel:     1 × 48 LOC = 48 LOC, tested once
```

It's not about LOC. It's about the number of *subtle* failure modes — the residual buffer, the UTF-8 split, the cancel-after-unmount, the reader-lock leak. Each one is silent the first time you forget it. Four consumers × five subtle modes = twenty chances to get one wrong. One kernel × five subtle modes = one place to get them all right.

**Anchor:** the kernel isn't about deduplication; it's about the canonical owner of the silent failure modes.

### Q2: "If you removed the trailing-buffer flush, what would happen?"

```
  the flush in isolation

  producer  ──► writes: '{"type":"insight",...}\n{"type":"done"}'
                                                  ↑ no trailing '\n'
  kernel    ──► reads chunks, splits on '\n':
                  ['{"type":"insight",...}', '{"type":"done"}']
                  lines.pop() = '{"type":"done"}' → stashed in buf
  loop ends ──► without flush: the 'done' event is dropped
                with    flush: the 'done' event is parsed + dispatched
```

Nothing today — every producer in the repo terminates with `\n` (the contract lives in `encodeEvent` in `lib/mcp/events.ts`). The flush is preserved as a *correctness invariant for future producers*: the day someone bypasses `encodeEvent` and writes a raw event without the terminal newline, the flush dispatches it instead of silently dropping it. **The flush is hardening, not part of the load-bearing kernel.** Naming the difference matters — it's the AOSD distinction between the skeleton and optional hardening.

**Anchor:** the flush is the safety net for the day someone forgets `encodeEvent`.

### Q3: "What's the implicit contract between the kernel and the producers?"

```
  the contract — what each side promises

  Producer promises:
    1. every event is a single JSON object  (no nested newlines inside string values?
                                              JSON spec disallows raw \n in strings, so this is safe)
    2. every event is followed by '\n'      (encodeEvent enforces; flush is the safety net)
    3. the stream ends when there's no more (no special "end marker"; relies on { done: true })

  Kernel promises:
    1. one onEvent call per JSON object     (never partial; never duplicate)
    2. malformed lines never throw upward   (silently skipped or routed to onMalformed)
    3. cancellation is cooperative          (cancelOn polled between reads, never mid-parse)
    4. the reader lock is always released   (try/finally)
```

The contract isn't typed; it isn't enforced by the runtime. It's a discipline. The kernel trusts producers; producers trust the kernel. The trailing-buffer flush exists because that trust is incomplete (a future producer might forget); the `try { JSON.parse } catch { onMalformed }` exists for the same reason on the parse side (a bug in a producer that emits a half-formed JSON shouldn't crash every consumer's stream).

**Anchor:** every event is one JSON object terminated by '\n', and the kernel is what trusts that.

## See also

  → `00-overview.md` — where the kernel sits in the streaming pipeline.
  → `audit.md` — lens 5 (pull-complexity-downward) names this as the cleanest example.
  → `01-port-and-adapter-data-source.md` — the other deep module in the repo.
  → `.aipe/read-aposd/part-2/07-pull-complexity-down.md` — the conceptual chapter.
  → `.aipe/read-aposd/part-2/03-deep-modules.md` — why a 48-line module can be deep.
