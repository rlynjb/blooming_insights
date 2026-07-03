# readNdjson — the kernel three callers used to duplicate

Pulled complexity downward · Extracted kernel · Language-agnostic

## Zoom out — where this concept lives

You know how three components used to run their own `useEffect`
+ `fetch` + `setLoading` + `setError` boilerplate until someone
finally wrote `useAsync`? Same story, one layer lower. Three
client hooks used to run the same fetch → reader → decoder →
buffer → split → parse → dispatch loop inline. Now they hand a
`ReadableStream` + a handler to `readNdjson`, and the loop is
in one 64-LOC kernel.

```
  Zoom out — where the ndjson kernel sits

  ┌─ Component layer ────────────────────────────────────┐
  │  Feed page · Investigate page · Capture button       │
  └────────────────────────┬─────────────────────────────┘
                           │  uses
  ┌─ Hook layer ───────────▼─────────────────────────────┐
  │  useBriefingStream · useInvestigation · useDemoCapture│
  │  each: fetch(...) → pass body to readNdjson           │
  └────────────────────────┬─────────────────────────────┘
                           │  imports
  ┌─ Streaming kernel ─────▼─────────────────────────────┐
  │  ★ lib/streaming/ndjson.ts ★  (64 LOC, one function)  │ ← you are here
  │     readNdjson(body, onEvent, opts?)                  │
  └──────────────────────────────────────────────────────┘
```

Before the extraction, every hook carried its own copy of the
loop — with subtle differences that were bugs waiting to
surface (buffer flush handling, malformed-line handling,
cancellation between reads).

## Structure pass

**Layers.** Two: the hook layer (which owns fetch + state +
lifecycle) and the streaming kernel (which owns the byte-stream
loop).

**Axis: byte-stream concerns.** Above the kernel, callers deal
in *events* — they receive parsed `AgentEvent` objects and
dispatch. Below the kernel, the concerns are byte-level — reader
locks, TextDecoder streaming, buffer boundaries, malformed JSON.
The axis-answer flips at the kernel boundary: no caller touches
a byte, no kernel line dispatches an event.

**Seams.** The `readNdjson` function signature is the seam.
Three parameters — the stream, the handler, an options bag —
and every complication of the byte-stream loop sits behind it.

## How it works

### Move 1 — the mental model

**Pulling complexity downward means: move a concern from many
call sites into one owner, then hide it behind an interface
narrow enough that the concern is uneditable from outside.**
The extracted concern here is "how to read NDJSON off a fetch
body without breaking on partial-line reads, missing trailing
newlines, malformed JSON, or unmount cancellation."

```
  Kernel shape — the byte-stream loop, isolated

     input                        output
     ─────                        ──────
     body: ReadableStream         (each parsed event dispatched
     onEvent: (E) → void           to onEvent, one at a time)
     cancelOn?: () → boolean
     onMalformed?: (line, err)
                │
                ▼
     ┌──────────────────────────────────────┐
     │  reader = body.getReader()           │
     │  decoder = new TextDecoder()         │
     │  buf = ''                            │
     │                                      │
     │  loop:                               │
     │    if cancelOn(): reader.cancel; end │
     │    { value, done } = reader.read()   │
     │    if done: flush tail buf; end      │
     │    buf += decoder.decode(value)      │
     │    lines = buf.split('\n')           │
     │    buf = lines.pop()  ← tail keeper  │
     │    for line in lines:                │
     │      try: onEvent(JSON.parse(line))  │
     │      catch: onMalformed(line, err)   │
     │                                      │
     │  finally: reader.releaseLock()       │
     └──────────────────────────────────────┘
```

The skeleton has five load-bearing parts. Drop any one and the
kernel breaks in a specific, documented way:

1. **The tail keeper (`buf = lines.pop()`).** Without it, a
   chunk boundary that lands in the middle of a JSON object
   causes a parse failure. This is the classic
   "split-buffer-parse" trap that every naïve implementation
   hits.
2. **The trailing-buffer flush at end-of-stream.** Without it,
   any producer that omits the final `\n` loses the last event.
   The producers in this repo always emit `\n`, so today this
   is a no-op — but the kernel preserves the invariant for
   future producers.
3. **The `cancelOn` poll between reads.** Without it, an
   unmounted React component keeps reading until the stream
   ends, wasting memory and firing `setState` after unmount.
4. **The malformed-line swallow.** Without it, one bad JSON line
   kills the whole stream. With it, one bad line is skipped and
   the caller optionally receives it for logging.
5. **The `reader.releaseLock()` in `finally`.** Without it, an
   error mid-stream leaves the lock held and the body
   ungarbage-collectable.

None of these are optional. All five have to be right, every
time. That's why extracting into a kernel was worth doing.

### Move 2 — the walkthrough

**The full kernel — 64 LOC including the header comment.**

```typescript
// lib/streaming/ndjson.ts:1-64
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
      buf = lines.pop() ?? '';                       // ← tail keeper
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

Annotation:
- Line 17-19 — generic over `E`. Callers pin the event type:
  `readNdjson<AgentEvent>`, `readNdjson<BriefingEvent>`. The
  kernel doesn't know the event vocabulary.
- Line 33-36 — the cancel poll before every read. `cancelOn` is
  a caller-supplied predicate; the kernel calls it once per
  chunk, and cancels the reader when it returns true.
- Line 39-40 — `decoder.decode(value, { stream: true })` — the
  `stream: true` flag tells `TextDecoder` this is a chunk in a
  stream, so multi-byte characters split across chunk
  boundaries decode correctly. Without it, you lose UTF-8
  characters at chunk edges. This is the kind of correctness
  concern every caller would have had to know.
- Line 41-42 — the split-and-tail-keeper trick. `split('\n')`
  produces N+1 pieces from N newlines; `lines.pop()` takes the
  last piece (the incomplete tail) and puts it back into `buf`
  for the next iteration. Every full line goes to the loop
  body; the incomplete tail waits.
- Line 46 — `JSON.parse` inside `try`. Malformed line → catch,
  optional callback, continue. One bad line doesn't kill the
  stream.
- Line 53-60 — the end-of-stream flush. If a producer forgot
  the terminal newline, the last event lives in `buf`; flush
  it. When producers behave (as ours do), this branch never
  fires.
- Line 62 — `reader.releaseLock()` in `finally`. Held even if
  the body throws mid-stream. Without this, the stream leaks.

**Call site 1 — `useBriefingStream`, the canonical shape.**

```typescript
// lib/hooks/useBriefingStream.ts:283-289 (abridged)
const res = await fetch(url, { signal: abort.signal });
if (!res.body) throw new Error('no body');

await readNdjson<BriefingEvent>(res.body, handle, {
  cancelOn: () => cancelledRef.current,
});
```

Annotation: the hook owns fetch + AbortController + a
cancellation ref; the kernel handles the byte loop. `cancelOn`
polls the ref between reads so React's cleanup (setting the ref
to true) breaks the loop cleanly.

**Call site 2 — `useInvestigation`, the same shape.**

```typescript
// lib/hooks/useInvestigation.ts:190-194 (abridged)
const res = await fetch(url, { method: 'POST', body: JSON.stringify(body) });
if (!res.body) throw new Error('no body');

await readNdjson<AgentEvent>(res.body, handle);
```

Annotation: no `cancelOn` here — the investigation stream is
allowed to keep running through StrictMode remount (see
context.md: "the useInvestigation hook explicitly does NOT
cancel on cleanup"). The kernel's shape supports both: the
options bag is optional, so this call site opts out of
cancellation without ceremony.

**Call site 3 — `useDemoCapture`, the smallest.**

```typescript
// lib/hooks/useDemoCapture.ts:82-84 (abridged)
const res = await fetch('/api/mcp/capture', { method: 'POST', body });
if (!res.body) throw new Error('no body');

await readNdjson<{ type?: string; message?: string }>(res.body, (evt) => {
  // capture-progress dispatch
});
```

Annotation: capture events have a different shape (`{ type?,
message? }` rather than a full `AgentEvent`), and the kernel
generic accommodates that. Same kernel, different event type,
different handler. Nothing about the kernel changed to serve
this caller.

**Before the extraction — one caller's shape.**

The kernel's header comment (`ndjson.ts:1-13`) names why it was
extracted: the "briefing effect (the canonical implementation)"
originally held all this logic inline. Two other callers grew
their own versions with subtle differences. Extracting produced
one authoritative loop; the three call sites collapsed to a
single-line each.

### Move 3 — the principle

**When N callers each hold their own copy of a non-trivial
loop, the loop is a module waiting to be born. The name for the
loop, and the interface for it, are almost always narrower than
callers first believe.** Here the interface is three arguments
and one return; the body is 45 lines of mechanical byte-stream
work. Callers used to know all 45 lines. Now they know 3
arguments and the guarantee: "hand me a body, get events
dispatched to your handler." Everything else is off the caller's
mental model.

## Primary diagram

```
  readNdjson — one kernel, three callers, five load-bearing parts

  ┌─ Feed page ──────────┐
  │ useBriefingStream    │
  │  handle              │  cancelOn: unmount ref
  └──────────┬───────────┘
             │
  ┌─ Investigate page ──┐
  │ useInvestigation     │  (no cancelOn — StrictMode survives)
  │  handle              │
  └──────────┬───────────┘
             │        ┌─────────────────────────────────────────┐
             ├───────►│  readNdjson<E>(body, onEvent, opts?)    │
             │        │                                          │
  ┌─ Capture button ───┐│  ┌── the loop ────────────────────┐  │
  │ useDemoCapture     ││  │  1. cancelOn poll?             │  │
  │  handle            ││  │  2. read → decode('stream')    │  │
  └──────────┬─────────┘│  │  3. split('\n')                │  │
             │          │  │  4. TAIL KEEPER: buf = pop()   │  │
             └─────────►│  │  5. for each full line:        │  │
                        │  │       try parse → onEvent      │  │
                        │  │       catch → onMalformed?     │  │
                        │  │  end: flush tail buf           │  │
                        │  │  finally: releaseLock()        │  │
                        │  └────────────────────────────────┘  │
                        └─────────────────────────────────────┘

  before extraction: 3 callers × ~45 LOC of loop each = ~135 LOC
  after extraction:  3 callers × 1 LOC of call each + 45 LOC kernel = ~48 LOC
```

## Elaborate

The pattern is called *extract method* at the smallest scale
(Fowler) and *pulled complexity downward* at the module scale
(Ousterhout). What ties them together: the *client* of the
extracted code is measured in fewer concerns after extraction
than before. It's not just "less code at the top" — it's "less
knowledge required at the top."

The specific shape here is a *streaming reader*, which shows up
everywhere with byte streams: HTTP response bodies, WebSocket
frames, file reads, subprocess output. Every language's standard
library has a version. The load-bearing concerns don't change —
partial reads at boundaries, multi-byte encoding across chunks,
end-of-stream flush, cancellation. Every naïve implementation
gets at least one of them wrong.

Where this repo pushes on the pattern: the kernel is language-
level (a plain async function) rather than framework-level (a
React hook or a class). That means it's usable in Node contexts
too — the same kernel could parse NDJSON from a subprocess or a
socket. Nothing in `readNdjson` knows about React or Next.js.
Keeping it that low means the pattern doesn't leak framework
choices upward.

The `cancelOn` design is worth naming: it's polled *between
reads*, not while a read is pending. That means cancellation
latency is bounded by the size of the current chunk — a 30-second
read gets 30 seconds of latency before cancel. A stricter design
would use `AbortSignal.reason` and cancel the reader
immediately, but this shape is simpler and matches what the
callers need (React unmount cleanup, which tolerates a few
milliseconds).

## Interview defense

**Q: What's the load-bearing part people forget?**
The tail keeper — `buf = lines.pop() ?? ''`. `split('\n')` on a
string like `'{"a":1}\n{"b":' + chunkBoundary` produces
`['{"a":1}', '{"b":']`. The first is a complete line; the
second is the incomplete start of the next line. `pop()` takes
the tail off, and the next chunk gets prepended to it. Skip this
line and you get a `JSON.parse` failure on every chunk boundary,
which for a fast stream is 100% of your events.

Second load-bearing part: `TextDecoder` with `stream: true`.
Multi-byte UTF-8 characters (any emoji, any non-ASCII text) can
split across chunk boundaries. Without the stream flag, decoding
each chunk in isolation replaces the split bytes with a
replacement character. Anthropic streaming responses contain
plenty of non-ASCII text.

**Q: How is this different from a mock?**
The kernel doesn't invert control the way a decorator or a mock
would. It's a *utility* — the callers still own their event
shapes, their fetch calls, and their lifecycle. What moved is
just the byte loop. The relationship is more like `Array.prototype.map`
than like React middleware: a shared helper that owns one narrow
concern.

**Q: Why not a Web Stream `pipeThrough` with a `TransformStream`?**
Because the callers don't want a transformed stream — they want
events dispatched to a handler synchronously. A `TransformStream`
would produce another `ReadableStream` and each caller would
still have to read from it. Same problem, one layer added. The
imperative `readNdjson(body, onEvent)` shape matches what the
hook layer actually needs.

**Q: What would you do differently?**
Add a `signal: AbortSignal` option alongside `cancelOn`. Today
callers use `AbortController` on the fetch to abort the request
and `cancelOn` polling to break the loop. Both are correct
mechanisms; carrying both feels like two axes for one job. A
signal-first API is more idiomatic in modern Node/browser code.
Not urgent — the current shape works and the callers are
consistent — but that's the next iteration.

## See also

- `01-datasource-port.md` — the DataSource port is a deep module
  at a higher altitude. Both patterns illustrate hiding under a
  narrow interface.
- `04-optional-hooks.md` — the options bag pattern used by
  `readNdjson`'s `opts?` argument.
- `.aipe/read-aposd/` — the book chapter on pulling complexity
  downward.
